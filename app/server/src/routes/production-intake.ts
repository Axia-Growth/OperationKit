/**
 * Production issue intake routes (obj 901771). Mounted at /api/production-intake.
 *
 *   POST   /signal        a monitor / error tracker posts here. Auth = the source's
 *                         intake token (X-Intake-Token header, Authorization: Bearer
 *                         opi_…, or ?token= for vendors that only take a URL). The
 *                         workspace and project come from the TOKEN, never the body.
 *   POST   /report        a signed-in person pastes a report / log (browser or JWT).
 *   GET    /signals       recent signals in the caller's workspaces.
 *   GET    /signals/:id   one signal with its full evidence (linked from the card).
 *   GET    /sources       webhook sources (admin).
 *   POST   /sources       create one; the token is returned ONCE (admin, browser cookie).
 *   DELETE /sources/:id   revoke (admin, browser cookie).
 *
 * The card a signal files is a bug card with `origin = 'production-issue'`.
 * Nothing here merges, deploys, restarts, or touches DNS / Cloudflare; the card
 * itself is refused by every bot or background merge path (see
 * services/production-intake.ts → isProductionIssueCard).
 * Docs: docs/wiki/Production-Issue-Intake.md.
 */
import { Router, type Request, type Response } from 'express'
import express from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import { workspaceExists } from '../services/workspaces.js'
import { broadcast } from '../ws/index.js'
import { defaultAgentForWorkspace } from './objectives-helpers.js'
import {
  INTAKE_TOKEN_PREFIX,
  createIntakeSource,
  ingestProductionSignal,
  listIntakeSources,
  normalizePastedReport,
  normalizeSignal,
  resolveIntakeToken,
  revokeIntakeSource,
  touchIntakeSource,
  type IngestResult,
} from '../services/production-intake.js'

const router: Router = Router()

const PROJECT_RE = /^[A-Za-z0-9._-]{1,100}$/

// UptimeRobot and some older monitors post form-encoded bodies.
const formParser = express.urlencoded({ extended: false, limit: '256kb' })

function tokenFrom(req: Request): string | null {
  const h = req.headers['x-intake-token']
  if (typeof h === 'string' && h.trim()) return h.trim()
  const auth = req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith(`Bearer ${INTAKE_TOKEN_PREFIX}`)) return auth.slice(7).trim()
  const q = req.query.token
  return typeof q === 'string' && q.trim() ? q.trim() : null
}

/** The signed-in admin, in the browser (never an API key, a card token or a bearer JWT). */
function isAdminBrowser(req: AuthRequest): boolean {
  return req.user?.role === 'admin' && req.authVia === 'session' && !req.agentKey && !req.sessionFile && authenticatedViaCookie(req)
}

/** Workspaces the caller may read signals in; null = all (admin). */
function readableWorkspaces(req: AuthRequest): string[] | null {
  if (req.sessionFile) return [req.sessionFile.workspace]
  if (req.user?.role === 'admin') return null
  return req.user ? getUserWorkspaces(req.user.id).map(w => w.workspace) : []
}

function canUseWorkspace(req: AuthRequest, workspace: string): boolean {
  const ws = readableWorkspaces(req)
  return ws === null || ws.includes(workspace)
}

function afterIngest(result: IngestResult, autoStart: boolean): void {
  if (!result.objective_id) return
  try {
    const obj = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(result.objective_id)
    if (obj) broadcast({ type: 'objective_updated', payload: obj as never })
  } catch {
    /* broadcast is best effort */
  }
  if (result.outcome === 'filed' && autoStart) void startProductionCard(result.objective_id)
}

/**
 * Start a freshly filed card through the same internal status PATCH a routine
 * uses (session cap, duplicate guard and spawn behave as for any card). Only for
 * a source an admin created with auto_start on. It starts a WORKER, which can at
 * most open a PR: merging stays a person's action. Never throws.
 */
async function startProductionCard(objectiveId: number): Promise<void> {
  try {
    const [{ noteStartReason }, { internalApiHeaders }] = await Promise.all([
      import('../services/session-start-reasons.js'),
      import('../lib/internal-api-headers.js'),
    ])
    noteStartReason(objectiveId, 'production_signal', 'production-intake')
    const port = parseInt(process.env.PORT || '3002', 10)
    const resp = await fetch(`http://127.0.0.1:${port}/api/internal/objectives/${objectiveId}/status`, {
      method: 'PATCH',
      headers: internalApiHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ status: 'working', reason: 'production signal', actor: 'production-intake' }),
    })
    if (!resp.ok) console.warn(`[production-intake] card #${objectiveId} filed but not started: ${resp.status} ${(await resp.text()).slice(0, 200)}`)
  } catch (err) {
    console.warn(`[production-intake] card #${objectiveId} start errored:`, err instanceof Error ? err.message : err)
  }
}

function statusFor(r: IngestResult): number {
  if (r.outcome === 'filed') return 201
  if (r.outcome === 'failed') return 500
  // appended / ignored / rate_limited / disabled are recorded and final: a 2xx so a
  // monitor does not retry-storm the same alert.
  return 200
}

// POST /api/production-intake/signal — token-authenticated webhook.
router.post('/signal', formParser, (req: Request, res: Response) => {
  const db = getDb()
  const source = resolveIntakeToken(db, tokenFrom(req))
  if (!source) {
    res.status(401).json({ error: 'Missing, unknown or revoked intake token. Create one in Settings → Integrations → Production issues.' })
    return
  }
  touchIntakeSource(db, source.id)
  const norm = normalizeSignal(req.body)
  if (!norm.ok) {
    res.status(400).json({ error: norm.error })
    return
  }
  const result = ingestProductionSignal(db, {
    workspace: source.workspace,
    project: source.project,
    sourceId: source.id,
    sourceName: source.name,
    via: 'webhook',
    signal: norm.signal,
    raw: req.body,
    reportedBy: source.created_by,
    agentContext: defaultAgentForWorkspace(source.workspace),
  })
  afterIngest(result, !!source.auto_start)
  res.status(statusFor(result)).json({ ok: result.outcome !== 'failed', ...result })
})

// POST /api/production-intake/report — a person pastes a report.
router.post('/report', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.sessionFile || req.agentKey) {
    res.status(403).json({ error: 'A person files a pasted production report. Cards and API keys use POST /api/objectives.' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  if (!workspace || !workspaceExists(workspace)) {
    res.status(400).json({ error: 'workspace is required and must exist.' })
    return
  }
  if (!canUseWorkspace(req, workspace)) {
    res.status(403).json({ error: `You are not a member of workspace "${workspace}".` })
    return
  }
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null
  if (project && !PROJECT_RE.test(project)) {
    res.status(400).json({ error: 'project must be letters, digits, dot, dash or underscore.' })
    return
  }
  const norm = normalizePastedReport(body)
  if (!norm.ok) {
    res.status(400).json({ error: norm.error })
    return
  }
  const db = getDb()
  const result = ingestProductionSignal(db, {
    workspace,
    project,
    sourceId: null,
    sourceName: null,
    via: 'pasted',
    signal: norm.signal,
    raw: typeof body.text === 'string' ? body.text : null,
    reportedBy: req.user?.id ?? null,
    agentContext: defaultAgentForWorkspace(workspace),
  })
  afterIngest(result, false)
  res.status(statusFor(result)).json({ ok: result.outcome !== 'failed', ...result })
})

const SIGNAL_LIST_COLUMNS =
  'id, source_id, workspace, project, via, vendor, fingerprint, severity, title, environment, service, url, occurred_at, received_at, outcome, outcome_reason, objective_id'

// GET /api/production-intake/signals?workspace=&limit=
router.get('/signals', requireAuth, (req: AuthRequest, res: Response) => {
  const allowed = readableWorkspaces(req)
  const requested = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null
  if (requested && allowed && !allowed.includes(requested)) {
    res.status(403).json({ error: `You cannot read workspace "${requested}".` })
    return
  }
  const scope = requested ? [requested] : allowed
  if (scope && scope.length === 0) {
    res.json({ signals: [] })
    return
  }
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200)
  const where = scope ? `WHERE workspace IN (${scope.map(() => '?').join(',')})` : ''
  const rows = getDb()
    .prepare(`SELECT ${SIGNAL_LIST_COLUMNS} FROM production_signals ${where} ORDER BY id DESC LIMIT ?`)
    .all(...(scope ?? []), limit)
  res.json({ signals: rows })
})

// GET /api/production-intake/signals/:id — full evidence (the card links here).
router.get('/signals/:id', requireAuth, (req: AuthRequest, res: Response) => {
  const id = parseInt(String(req.params.id), 10)
  const row = Number.isFinite(id)
    ? (getDb().prepare('SELECT * FROM production_signals WHERE id = ?').get(id) as Record<string, unknown> | undefined)
    : undefined
  // Out of scope reads as not found: it does not say whether the signal exists elsewhere.
  if (!row || !canUseWorkspace(req, String(row.workspace))) {
    res.status(404).json({ error: 'Signal not found' })
    return
  }
  let evidence: unknown = null
  try {
    evidence = JSON.parse(String(row.evidence_json ?? '{}'))
  } catch {
    evidence = null
  }
  const { evidence_json: _e, ...rest } = row
  res.json({ signal: { ...rest, evidence } })
})

// GET /api/production-intake/sources?workspace=
router.get('/sources', requireAuth, (req: AuthRequest, res: Response) => {
  if (req.user?.role !== 'admin' || req.agentKey || req.sessionFile) {
    res.status(403).json({ error: 'Admins only.' })
    return
  }
  const ws = typeof req.query.workspace === 'string' && req.query.workspace ? [req.query.workspace] : null
  res.json({ sources: listIntakeSources(getDb(), ws) })
})

// POST /api/production-intake/sources { workspace, name, project?, auto_start? }
router.post('/sources', requireAuth, (req: AuthRequest, res: Response) => {
  if (!isAdminBrowser(req)) {
    res.status(403).json({ error: 'Only an admin signed in to the app in the browser can create an intake webhook.', code: 'admin_browser_only' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const workspace = typeof body.workspace === 'string' ? body.workspace.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 100) : ''
  const project = typeof body.project === 'string' && body.project.trim() ? body.project.trim() : null
  if (!workspace || !workspaceExists(workspace)) {
    res.status(400).json({ error: 'workspace is required and must exist.' })
    return
  }
  if (!name) {
    res.status(400).json({ error: 'name is required (for example "Sentry - storefront").' })
    return
  }
  if (project && !PROJECT_RE.test(project)) {
    res.status(400).json({ error: 'project must be letters, digits, dot, dash or underscore.' })
    return
  }
  const { source, token } = createIntakeSource(getDb(), {
    workspace,
    name,
    project,
    autoStart: body.auto_start === true || body.auto_start === 1 || body.auto_start === '1',
    createdBy: req.user?.id ?? null,
  })
  res.status(201).json({
    source,
    token,
    path: '/api/production-intake/signal',
    note: 'Copy the token now: it is not shown again. Send it as the X-Intake-Token header, as Authorization: Bearer <token>, or as ?token=<token> on the URL.',
  })
})

// DELETE /api/production-intake/sources/:id
router.delete('/sources/:id', requireAuth, (req: AuthRequest, res: Response) => {
  if (!isAdminBrowser(req)) {
    res.status(403).json({ error: 'Only an admin signed in to the app in the browser can revoke an intake webhook.', code: 'admin_browser_only' })
    return
  }
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isFinite(id) || !revokeIntakeSource(getDb(), id)) {
    res.status(404).json({ error: 'Source not found or already revoked' })
    return
  }
  res.json({ ok: true })
})

export default router
