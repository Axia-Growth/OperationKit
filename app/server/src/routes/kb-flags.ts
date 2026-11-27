/**
 * Knowledge-gap flags (obj 901767) — mounted at /api/kb-wiki/flags, AHEAD of
 * the kb-wiki router so a card's worker can call it with its session token.
 *
 *   POST /api/kb-wiki/flags                {kind, subject, detail, page?, suggested_fix?, objective_id?, trace?, workspace?}
 *                                          → 201 {flag, reused:false} | 200 {flag, reused:true}
 *   GET  /api/kb-wiki/flags?workspace=&status=open|resolved|dismissed|all&kind=&objective_id=&after_id=&limit=&offset=
 *                                          → {flags, total, open} — oldest first, the curator's queue
 *   POST /api/kb-wiki/flags/:id/status     {status: open|resolved|dismissed, note?} (a person or an agent key; never a card token)
 *
 * Who may file:
 *   - a card's own worker (or AI reviewer) with `X-CC-Session-Token`: the
 *     workspace and card link come from the token, never the body;
 *   - anyone signed in (cookie / JWT / agent key with vault:write) who belongs
 *     to the workspace. A linked card must be in that workspace.
 *
 * Filing is NOT a wiki edit: nothing here writes a page. A worker REPORTS; it
 * cannot close flags (the busy worker must not be the curator).
 */
import { Router, type NextFunction, type Response } from 'express'
import { validateKbFlagInput, type KbFlagSource } from '@operationkit/shared'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import { getWorkspace } from '../services/workspaces.js'
import { sessionTokenFromHeaders, verifySessionToken, type SessionTokenClaims } from '../lib/session-trust.js'
import { KbFlagError, fileKbFlag, isKbFlagKind, isKbFlagStatus, listKbFlags, setKbFlagStatus, type ListKbFlagsOptions } from '../services/kb-wiki/flags.js'

interface FlagRequest extends AuthRequest {
  /** Set when the caller is a card's own session (CC_SESSION_TOKEN). */
  cardSession?: SessionTokenClaims
}

const router = Router()

/** A card's session token (scoped to one card + workspace), else normal auth. */
function sessionOrAuth(req: FlagRequest, res: Response, next: NextFunction): void {
  const token = sessionTokenFromHeaders(req.headers)
  if (token) {
    const claims = verifySessionToken(token)
    if (!claims) { res.status(401).json({ error: 'Session token is not valid' }); return }
    // Re-check the LIVE card: it must still exist in the token's workspace.
    const card = getDb().prepare('SELECT workspace FROM objectives WHERE id = ?').get(claims.objectiveId) as { workspace: string | null } | undefined
    if (!card || (card.workspace ?? '') !== claims.workspace) { res.status(403).json({ error: 'Session token is not valid for this card' }); return }
    req.cardSession = claims
    next()
    return
  }
  void requireAuth(req, res, next)
}

router.use(sessionOrAuth)

/** The workspace this request acts in. Sends the error and returns null on failure. */
function resolveWorkspace(req: FlagRequest, res: Response): string | null {
  const asked = String((req.query.workspace as string | undefined) ?? (req.body?.workspace as string | undefined) ?? '').trim()
  if (req.cardSession) {
    if (asked && asked !== req.cardSession.workspace) {
      res.status(403).json({ error: `This card works in '${req.cardSession.workspace}', not '${asked}'.` }); return null
    }
    return req.cardSession.workspace
  }
  if (!asked) { res.status(400).json({ error: 'Say which workspace (workspace is required).' }); return null }
  const row = getWorkspace(asked)
  if (!row) { res.status(404).json({ error: `There is no workspace called '${asked}'.` }); return null }
  if (req.user!.role !== 'admin' && !userHasWorkspace(req.user!.id, asked)) {
    res.status(403).json({ error: `You do not have access to the workspace '${asked}'.` }); return null
  }
  const allow = req.agentKey?.workspaces
  if (allow && !allow.includes(asked)) { res.status(403).json({ error: `This key cannot use the workspace '${asked}'.` }); return null }
  return row.slug
}

function fail(res: Response, err: unknown): void {
  if (err instanceof KbFlagError) { res.status(err.status).json({ error: err.message }); return }
  console.error('[kb-flags] route failed:', err)
  res.status(500).json({ error: 'Something went wrong with that flag.' })
}

function intQuery(v: unknown): number | undefined {
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

// POST /api/kb-wiki/flags — report a knowledge defect.
router.post('/', (req: FlagRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const b = (req.body ?? {}) as Record<string, unknown>
  const s = req.cardSession
  if (s && b.objective_id !== undefined && b.objective_id !== null && Number(b.objective_id) !== s.objectiveId) {
    res.status(403).json({ error: 'A card session can only link a flag to its own card.' }); return
  }
  const { errors, input } = validateKbFlagInput({ ...b, objective_id: s ? s.objectiveId : b.objective_id })
  if (!input) { res.status(400).json({ error: errors[0], errors }); return }
  if (!s && input.objective_id !== null) {
    const card = getDb().prepare('SELECT workspace FROM objectives WHERE id = ?').get(input.objective_id) as { workspace: string | null } | undefined
    if (!card || (card.workspace ?? '') !== ws) { res.status(404).json({ error: `Card #${input.objective_id} was not found in '${ws}'.` }); return }
  }
  let source: KbFlagSource
  let filedBy: string
  if (s) {
    source = s.readOnly ? 'reviewer' : 'worker'
    filedBy = `card #${s.objectiveId} ${s.readOnly ? 'reviewer' : 'worker'}`
  } else if (req.agentKey) {
    source = 'agent'
    filedBy = `${req.user!.username} (agent: ${req.agentKey.label})`
  } else {
    source = 'person'
    filedBy = req.user!.username
  }
  try {
    const out = fileKbFlag(getDb(), input, { workspace: ws, source, filedBy })
    res.status(out.reused ? 200 : 201).json(out)
  } catch (err) { fail(res, err) }
})

// GET /api/kb-wiki/flags — the queue (oldest first).
router.get('/', (req: FlagRequest, res) => {
  const ws = resolveWorkspace(req, res); if (!ws) return
  const q = req.query
  const status = typeof q.status === 'string' && q.status ? q.status : 'open'
  if (status !== 'all' && !isKbFlagStatus(status)) { res.status(400).json({ error: 'status must be open, resolved, dismissed or all.' }); return }
  if (q.kind !== undefined && q.kind !== '' && !isKbFlagKind(q.kind)) { res.status(400).json({ error: 'kind must be missing, wrong or stale.' }); return }
  const opts: ListKbFlagsOptions = { status: status as ListKbFlagsOptions['status'] }
  if (isKbFlagKind(q.kind)) opts.kind = q.kind
  for (const [key, field] of [['objective_id', 'objectiveId'], ['after_id', 'afterId'], ['limit', 'limit'], ['offset', 'offset']] as const) {
    const n = intQuery(q[key])
    if (Number.isNaN(n)) { res.status(400).json({ error: `${key} must be a whole number.` }); return }
    if (n !== undefined) opts[field] = n
  }
  try { res.json(listKbFlags(getDb(), ws, opts)) } catch (err) { fail(res, err) }
})

// POST /api/kb-wiki/flags/:id/status — close, dismiss or reopen. Never a card session.
router.post('/:id/status', (req: FlagRequest, res) => {
  if (req.cardSession) {
    res.status(403).json({ error: 'A card session can file flags but not close them. A person or the curator closes flags.' }); return
  }
  const ws = resolveWorkspace(req, res); if (!ws) return
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: 'That flag was not found.' }); return }
  const status = req.body?.status
  if (!isKbFlagStatus(status)) { res.status(400).json({ error: 'status must be "open", "resolved" or "dismissed".' }); return }
  const by = req.agentKey ? `${req.user!.username} (agent: ${req.agentKey.label})` : req.user!.username
  try {
    res.json({ flag: setKbFlagStatus(getDb(), ws, id, status, by, typeof req.body?.note === 'string' ? req.body.note : null) })
  } catch (err) { fail(res, err) }
})

export default router
