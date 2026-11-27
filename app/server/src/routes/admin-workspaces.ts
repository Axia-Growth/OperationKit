import { Router } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import {
  type GrantWorkspaceRequest,
  type ObjectiveVisibility,
  type UserRole,
  type WorkspaceMembership,
} from '@operationkit/shared'
import {
  archiveWorkspace,
  createWorkspace,
  getWorkspace,
  listWorkspaces,
  softDeleteArchivedWorkspace,
  undeleteWorkspace,
  updateWorkspace,
  workspaceExists,
} from '../services/workspaces.js'
import {
  createWorkspaceRepo,
  deleteWorkspaceRepo,
  getWorkspaceRepo,
  listWorkspaceRepos,
  updateWorkspaceRepo,
} from '../services/workspace-repos.js'
import { codeHealthStatus, disableCodeHealthForRepo, setCodeHealthJob } from '../services/code-health.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  connectGithub,
  connectPosthog,
  deleteIntegration,
  listGithubOrgRepos,
  listIntegrations,
} from '../services/workspace-integrations.js'
import { listPosthogBotDevItems } from '../services/dev-items.js'
import { upsertWorkspacesJsonProject } from '../services/workspaces-json.js'
import { ensureRepoCredentialHelper } from '../services/repo-git-auth.js'
import { vaultPathConflict } from '../lib/kb-workspace-scope.js'
import type { IntegrationKind } from '@operationkit/shared'

const router = Router()
router.use(requireAuth, requireAdmin)

/**
 * After a repo is registered (or its path changes): record it in workspaces.json
 * so session spawns resolve it, and give the checkout a repo-local
 * `!gh auth git-credential` helper so https pushes from sessions authenticate.
 * Both best-effort — registration itself never fails on them.
 */
function syncRegisteredRepo(workspace: string, name: string, repoPath: string): void {
  try { upsertWorkspacesJsonProject({ workspace, name, repoPath }) } catch (err) {
    console.warn('[admin-workspaces] workspaces.json sync failed:', (err as Error).message)
  }
  try { ensureRepoCredentialHelper(repoPath) } catch { /* best-effort */ }
}

function isValidWorkspace(ws: unknown): ws is string {
  return typeof ws === 'string' && workspaceExists(ws)
}

/**
 * Read `vault_path` from a request body for workspace `slug` (obj 901152).
 * `undefined` = not sent. `null` (or a blank string) clears it. Anything else
 * must be an absolute path that is this workspace's OWN folder: one that
 * overlaps the knowledge base root or another live workspace's folder (inside
 * it, equal to it or containing it) is a 400 naming the other workspace. The
 * scope rule (`workspaceVaultRoot`) applies the same check, so a row saved
 * before this validation is refused at read time too.
 */
function parseVaultPath(
  value: unknown,
  slug: string,
  res: import('express').Response,
): { ok: true; value: string | null | undefined } | { ok: false } {
  if (value === undefined) return { ok: true, value: undefined }
  if (value === null) return { ok: true, value: null }
  if (typeof value !== 'string') {
    res.status(400).json({ error: 'vault_path must be a string or null', code: 'vault_path_invalid' })
    return { ok: false }
  }
  const trimmed = value.trim()
  if (!trimmed) return { ok: true, value: null }
  const conflict = vaultPathConflict(slug, trimmed)
  if (conflict) {
    res.status(400).json({
      error: conflict.kind === 'invalid'
        ? conflict.message
        : `${conflict.message}. A workspace's vault_path must be its own folder, not shared with or nested in another workspace's notes.`,
      code: conflict.kind === 'invalid' ? 'vault_path_invalid' : 'vault_path_overlap',
      conflict,
    })
    return { ok: false }
  }
  return { ok: true, value: trimmed }
}

// GET /api/admin/workspaces — full list including archived (admin view).
// Deleted workspaces (obj 900870) are left out unless `?include_deleted=1`,
// which is how an admin finds one to undelete.
router.get('/', (req: AuthRequest, res) => {
  const includeDeleted = req.query.include_deleted === '1' || req.query.include_deleted === 'true'
  res.json(listWorkspaces({ includeArchived: true, includeDeleted }))
})

function parseStringArray(value: unknown, field: string, res: import('express').Response): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    res.status(400).json({ error: `${field} must be an array of strings` })
    return null
  }
  return value as string[]
}

// POST /api/admin/workspaces — create a new workspace
router.post('/', (req: AuthRequest, res) => {
  const body = req.body as Record<string, unknown>
  const slug = typeof body.slug === 'string' ? body.slug.trim() : ''
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
    res.status(400).json({ error: 'slug must be 2-41 chars: lowercase alnum + hyphens' })
    return
  }
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  if (workspaceExists(slug)) {
    const deleted = !!getWorkspace(slug)?.deleted_at
    res.status(409).json({
      error: deleted
        ? `Workspace '${slug}' was deleted and is kept for recovery — undelete it instead of creating a new one`
        : `Workspace '${slug}' already exists`,
    })
    return
  }
  const readRoots = parseStringArray(body.doc_read_roots, 'doc_read_roots', res)
  if (readRoots === null) return
  const writeRoots = parseStringArray(body.doc_write_roots, 'doc_write_roots', res)
  if (writeRoots === null) return
  const agentPool = parseStringArray(body.default_agent_pool, 'default_agent_pool', res)
  if (agentPool === null) return
  const vault = parseVaultPath(body.vault_path, slug, res)
  if (!vault.ok) return

  const ws = createWorkspace({
    slug,
    name,
    short_label: typeof body.short_label === 'string' ? body.short_label : null,
    badge_color: typeof body.badge_color === 'string' ? body.badge_color : null,
    vault_path: vault.value ?? null,
    doc_read_roots: readRoots,
    doc_write_roots: writeRoots,
    default_agent_pool: agentPool,
    sort_order: typeof body.sort_order === 'number' ? body.sort_order : 0,
  })
  res.status(201).json(ws)
})

// PATCH /api/admin/workspaces/:slug — update fields
router.patch('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  const current = getWorkspace(slug)
  if (!current || current.deleted_at) {
    // A deleted workspace (obj 900870) must be undeleted before it is edited
    // or restored, so a stale tab cannot silently resurrect it.
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const patch: Parameters<typeof updateWorkspace>[1] = {}
  if (typeof body.name === 'string') patch.name = body.name.trim()
  if (body.short_label === null || typeof body.short_label === 'string') patch.short_label = body.short_label as string | null
  if (body.badge_color === null || typeof body.badge_color === 'string') patch.badge_color = body.badge_color as string | null
  const vault = parseVaultPath(body.vault_path, slug, res)
  if (!vault.ok) return
  if (vault.value !== undefined) patch.vault_path = vault.value
  if (body.doc_read_roots !== undefined) {
    const arr = parseStringArray(body.doc_read_roots, 'doc_read_roots', res)
    if (arr === null) return
    patch.doc_read_roots = arr
  }
  if (body.doc_write_roots !== undefined) {
    const arr = parseStringArray(body.doc_write_roots, 'doc_write_roots', res)
    if (arr === null) return
    patch.doc_write_roots = arr
  }
  if (body.default_agent_pool !== undefined) {
    const arr = parseStringArray(body.default_agent_pool, 'default_agent_pool', res)
    if (arr === null) return
    patch.default_agent_pool = arr
  }
  if (typeof body.sort_order === 'number') patch.sort_order = body.sort_order
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  const updated = updateWorkspace(slug, patch)
  res.json(updated)
})

// DELETE /api/admin/workspaces/:slug — soft-delete (archive)
router.delete('/:slug', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  archiveWorkspace(slug)
  res.json({ ok: true, slug, archived: true })
})

// POST /api/admin/workspaces/:slug/delete — delete an ARCHIVED workspace (obj 900870)
// body: { confirm: <slug> } — the slug typed back, so a stray call cannot delete.
//
// Soft-delete: the workspace leaves the archived list; nothing else changes.
// Its cards, secrets (workspace and Shared), repos, integrations and members
// all stay. An active workspace is refused with 409 — archive it first.
// Recover with POST /:slug/undelete.
router.post('/:slug/delete', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  const body = (req.body ?? {}) as Record<string, unknown>
  if (body.confirm !== slug) {
    res.status(400).json({ error: `confirm must equal the workspace slug '${slug}'` })
    return
  }
  const result = softDeleteArchivedWorkspace(slug, typeof req.user?.id === 'number' ? req.user.id : null)
  if (!result.ok) {
    if (result.reason === 'not_archived') {
      res.status(409).json({ error: 'Only an archived workspace can be deleted. Archive it first.', code: 'not_archived' })
    } else {
      res.status(404).json({ error: 'Workspace not found', code: result.reason })
    }
    return
  }
  console.log(`[admin-workspaces] workspace '${slug}' soft-deleted by user ${req.user?.id ?? '?'}`)
  res.json({ ok: true, slug, deleted: true, deleted_at: result.workspace.deleted_at })
})

// POST /api/admin/workspaces/:slug/undelete — recover a deleted workspace (obj 900870).
// It goes back to the archived list (still archived); Restore there makes it active.
router.post('/:slug/undelete', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  const ws = undeleteWorkspace(slug)
  if (!ws) {
    res.status(404).json({ error: 'No deleted workspace with that slug' })
    return
  }
  console.log(`[admin-workspaces] workspace '${slug}' undeleted by user ${req.user?.id ?? '?'}`)
  res.json(ws)
})

// ── Workspace repos (DB-backed, admin-managed) ──

// GET /api/admin/workspaces/:slug/repos — repos attached to a workspace
router.get('/:slug/repos', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  // obj 901770: each repo carries its code-health Job state (off unless switched on).
  res.json(listWorkspaceRepos(slug).map(r => ({ ...r, code_health: codeHealthStatus(r) })))
})

// POST /api/admin/workspaces/:slug/repos — attach a repo/project
router.post('/:slug/repos', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  const stack = parseStringArray(body.stack, 'stack', res)
  if (stack === null) return
  const github = typeof body.github === 'string' && body.github.trim() ? body.github.trim() : null
  const repo_path = typeof body.repo_path === 'string' && body.repo_path.trim() ? body.repo_path.trim() : null
  const description =
    typeof body.description === 'string' && body.description.trim() ? body.description.trim() : null
  const docs_path = typeof body.docs_path === 'string' && body.docs_path.trim() ? body.docs_path.trim() : null
  const docs_enabled = body.docs_enabled === false || body.docs_enabled === 0 ? false : true
  const repo = createWorkspaceRepo({
    workspace: slug, name, description, github, repo_path, stack, docs_path, docs_enabled,
  })
  if (repo_path) syncRegisteredRepo(slug, name, repo_path)
  res.status(201).json(repo)
})

router.patch('/:slug/repos/:id', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid repo id' })
    return
  }
  const body = req.body as Record<string, unknown>
  const patch: { docs_enabled?: boolean; docs_path?: string; repo_path?: string | null } = {}
  if (typeof body.docs_enabled === 'boolean') patch.docs_enabled = body.docs_enabled
  if (typeof body.docs_path === 'string') patch.docs_path = body.docs_path
  if (body.repo_path === null) patch.repo_path = null
  else if (typeof body.repo_path === 'string') patch.repo_path = body.repo_path
  const updated = updateWorkspaceRepo(id, slug, patch)
  if (!updated) {
    res.status(404).json({ error: 'Repo not found' })
    return
  }
  if (typeof patch.repo_path === 'string' && updated.repo_path) syncRegisteredRepo(slug, updated.name, updated.repo_path)
  res.json(updated)
})

// DELETE /api/admin/workspaces/:slug/repos/:id — detach a repo
router.delete('/:slug/repos/:id', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  if (Number.isNaN(id)) {
    res.status(400).json({ error: 'Invalid repo id' })
    return
  }
  if (!deleteWorkspaceRepo(id, slug)) {
    res.status(404).json({ error: 'Repo not found' })
    return
  }
  // obj 901770: a removed repo's code-health Job stops (history is kept).
  try { disableCodeHealthForRepo(id) } catch (err) {
    console.warn('[code-health] disable on repo removal failed:', (err as Error).message)
  }
  res.json({ ok: true, id })
})

// ── Code-health Job per repo (obj 901770, services/code-health.ts) ──

function repoInWorkspace(req: AuthRequest, res: import('express').Response) {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return null
  }
  const id = parseInt(typeof req.params.id === 'string' ? req.params.id : '', 10)
  const repo = Number.isNaN(id) ? undefined : getWorkspaceRepo(id)
  if (!repo || repo.workspace !== slug) {
    res.status(404).json({ error: 'Repo not found' })
    return null
  }
  return repo
}

// GET /api/admin/workspaces/:slug/repos/:id/code-health — the repo's Job state
router.get('/:slug/repos/:id/code-health', (req: AuthRequest, res) => {
  const repo = repoInWorkspace(req, res)
  if (!repo) return
  res.json(codeHealthStatus(repo))
})

// PUT /api/admin/workspaces/:slug/repos/:id/code-health {enabled?, cadence?}
// Switching a recurring Job on is an admin's click in the browser: an API key
// or bearer token can never schedule runs (same rule as High Agency).
router.put('/:slug/repos/:id/code-health', (req: AuthRequest, res) => {
  if (req.agentKey || !authenticatedViaCookie(req)) {
    res.status(403).json({ error: 'Only an admin signed in to the app in the browser can switch a code-health Job on or off.', code: 'cookie_admin_only' })
    return
  }
  const repo = repoInWorkspace(req, res)
  if (!repo) return
  const body = (req.body ?? {}) as Record<string, unknown>
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' })
    return
  }
  const result = setCodeHealthJob(
    repo,
    { enabled: body.enabled as boolean | undefined, cadence: body.cadence },
    { userId: req.user?.id ?? null, label: req.user?.username ? `user:${req.user.username}` : `user:${req.user?.id ?? '?'}` },
  )
  if (!result.ok) {
    res.status(400).json({ error: result.error, code: result.code })
    return
  }
  console.log(`[code-health] repo #${repo.id} (${repo.name}) → ${result.status.enabled ? `on, ${result.status.cadence}` : 'off'} by user ${req.user?.id ?? '?'}`)
  res.json(result.status)
})

// ── Workspace integrations (GitHub org + PostHog, per workspace) ──
//
// Secrets (PATs / API keys) are admin-gated (router.use above), MASKED in every
// response (services return only a last-4 fingerprint), and NEVER logged. Raw
// values live only in the workspace_integrations.config column server-side.

// GET /api/admin/workspaces/:slug/integrations — masked status for this workspace
router.get('/:slug/integrations', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  res.json(listIntegrations(slug))
})

// POST /api/admin/workspaces/:slug/integrations/github — connect a GitHub org
// body: { org, token }  (PAT with repo + read:org). Validated against GitHub.
router.post('/:slug/integrations/github', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const org = typeof body.org === 'string' ? body.org.trim() : ''
  const token = typeof body.token === 'string' ? body.token.trim() : ''
  if (!org || !token) {
    res.status(400).json({ error: 'org and token are required' })
    return
  }
  const result = await connectGithub(slug, org, token)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.status(201).json(result.integration)
})

// GET /api/admin/workspaces/:slug/integrations/github/repos — list org repos
// using the stored token (so the UI can pick one into REPOS & PROJECTS).
router.get('/:slug/integrations/github/repos', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const result = await listGithubOrgRepos(slug)
  if (result === null) {
    res.status(409).json({ error: 'GitHub is not connected for this workspace' })
    return
  }
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.json(result.repos)
})

// POST /api/admin/workspaces/:slug/integrations/posthog — connect a PostHog project
// body: { host, project_api_key, personal_api_key? }. Validated against PostHog.
router.post('/:slug/integrations/posthog', async (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const body = req.body as Record<string, unknown>
  const host = typeof body.host === 'string' ? body.host.trim() : ''
  const projectKey = typeof body.project_api_key === 'string' ? body.project_api_key.trim() : ''
  const personalKey =
    typeof body.personal_api_key === 'string' && body.personal_api_key.trim()
      ? body.personal_api_key.trim()
      : null
  if (!host || !projectKey) {
    res.status(400).json({ error: 'host and project_api_key are required' })
    return
  }
  const result = await connectPosthog(slug, host, projectKey, personalKey)
  if ('error' in result) {
    res.status(400).json({ error: result.error })
    return
  }
  res.status(201).json(result.integration)
})

// DELETE /api/admin/workspaces/:slug/integrations/:kind — disconnect
router.delete('/:slug/integrations/:kind', (req: AuthRequest, res) => {
  const slug = String(req.params.slug)
  if (!getWorkspace(slug)) {
    res.status(404).json({ error: 'Workspace not found' })
    return
  }
  const kind = String(req.params.kind)
  if (kind !== 'github' && kind !== 'posthog') {
    res.status(400).json({ error: "kind must be 'github' or 'posthog'" })
    return
  }
  if (!deleteIntegration(slug, kind as IntegrationKind)) {
    res.status(404).json({ error: 'Integration not connected' })
    return
  }
  res.json({ ok: true, slug, kind })
})

interface MembershipRow {
  user_id: number
  username: string
  workspace: string
  role: UserRole
  can_use_assistant: number
  objective_visibility: string
}

function rowToMembership(row: MembershipRow): WorkspaceMembership {
  return {
    user_id: row.user_id,
    username: row.username,
    workspace: row.workspace,
    role: row.role,
    can_use_assistant: !!row.can_use_assistant,
    objective_visibility: row.objective_visibility === 'all' ? 'all' : 'own',
  }
}

// GET /api/admin/workspaces/:workspace/users
router.get('/:workspace/users', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT uw.user_id, u.username, uw.workspace, uw.role,
              uw.can_use_assistant, uw.objective_visibility
       FROM user_workspaces uw
       JOIN users u ON u.id = uw.user_id
       WHERE uw.workspace = ?
       ORDER BY u.username`
    )
    .all(workspace) as MembershipRow[]
  res.json(rows.map(rowToMembership))
})

// POST /api/admin/workspaces/:workspace/users
// body: { user_id, role?, can_use_assistant?, objective_visibility? }
router.post('/:workspace/users', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  const body = req.body as GrantWorkspaceRequest
  const { user_id, role = 'member', can_use_assistant, objective_visibility } = body
  if (!user_id || typeof user_id !== 'number') {
    res.status(400).json({ error: 'user_id (number) required' })
    return
  }
  if (role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }
  let visibility: ObjectiveVisibility | undefined
  if (objective_visibility !== undefined) {
    if (objective_visibility !== 'own' && objective_visibility !== 'all') {
      res.status(400).json({ error: "objective_visibility must be 'own' or 'all'" })
      return
    }
    visibility = objective_visibility
  }
  const db = getDb()
  const userRow = db.prepare('SELECT id FROM users WHERE id = ?').get(user_id)
  if (!userRow) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  // Pull existing row (if any) so we can preserve fields the caller omits.
  const existing = db
    .prepare(
      `SELECT role, can_use_assistant, objective_visibility
       FROM user_workspaces WHERE user_id = ? AND workspace = ?`
    )
    .get(user_id, workspace) as
      | { role: UserRole; can_use_assistant: number; objective_visibility: string }
      | undefined

  const finalRole = role
  const finalAssistant =
    can_use_assistant !== undefined ? (can_use_assistant ? 1 : 0) : existing ? existing.can_use_assistant : 1
  const finalVisibility = visibility ?? (existing?.objective_visibility === 'all' ? 'all' : 'own')

  db.prepare(
    `INSERT INTO user_workspaces (user_id, workspace, role, can_use_assistant, objective_visibility)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, workspace) DO UPDATE SET
       role = excluded.role,
       can_use_assistant = excluded.can_use_assistant,
       objective_visibility = excluded.objective_visibility`
  ).run(user_id, workspace, finalRole, finalAssistant, finalVisibility)

  const username = (db.prepare('SELECT username FROM users WHERE id = ?').get(user_id) as { username: string }).username
  const membership: WorkspaceMembership = {
    user_id,
    username,
    workspace,
    role: finalRole,
    can_use_assistant: !!finalAssistant,
    objective_visibility: finalVisibility,
  }
  res.status(201).json(membership)
})

// DELETE /api/admin/workspaces/:workspace/users/:user_id
router.delete('/:workspace/users/:user_id', (req: AuthRequest, res) => {
  const workspace = req.params.workspace
  const userIdParam = req.params.user_id
  const userId = parseInt(typeof userIdParam === 'string' ? userIdParam : '', 10)
  if (!isValidWorkspace(workspace)) {
    res.status(400).json({ error: `Invalid workspace '${String(workspace)}'` })
    return
  }
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const db = getDb()
  const result = db
    .prepare('DELETE FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .run(userId, workspace)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Membership not found' })
    return
  }
  res.json({ ok: true })
})

// GET /api/admin/workspaces/posthog-bot-prs — list dev_items discovered by
// the posthog-bot sweep, optionally filtered by workspace.
router.get('/posthog-bot-prs', (req: AuthRequest, res) => {
  const ws = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : null
  try {
    const items = listPosthogBotDevItems(ws)
    res.json({ items })
  } catch (err) {
    res.status(500).json({ error: 'Database error' })
  }
})

export default router
