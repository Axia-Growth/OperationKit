import { Router, type Response, type NextFunction } from 'express'
import bcrypt from 'bcrypt'
import { getDb } from '../db/index.js'
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/auth.js'
import { sendInvite, sendTempPassword } from '../services/mailer/account-emails.js'
import type { SendResult } from '../services/mailer/types.js'
import { rateLimit } from '../services/file-access.js'
import {
  cfAccessApplies,
  cfAccessStatuses,
  cfAccessSyncHealth,
  clearCfAccessStatusCache,
  syncUserAccessEmail,
  type CfAccessStatus,
} from '../services/cf-access-user-sync.js'
import {
  cfAccessTokenStatus,
  clearCfAccessToken,
  looksLikeCfToken,
  saveCfAccessToken,
} from '../services/cf-access-token.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import type {
  CfAccessSyncState,
  CreateUserRequest,
  ResetPasswordRequest,
  User,
  UserRole,
  WorkspaceMembership,
} from '@operationkit/shared'

const router = Router()
router.use(requireAuth, requireAdmin)

const BCRYPT_ROUNDS = 10

/** Create-user / reset-password calls per admin per window. Both run a bcrypt
 *  hash and can send an email, so even a signed-in admin (or a stolen admin
 *  cookie) should not be able to drive them in a tight loop. Generous enough
 *  that no human admin ever meets it. */
export const ADMIN_USER_WRITE_LIMIT = 30
const ADMIN_USER_WRITE_WINDOW_MS = 10 * 60 * 1000

function adminWriteLimited(req: AuthRequest, res: Response, next: NextFunction): void {
  const retry = rateLimit(`admin-users-write:${req.user?.id ?? 'unknown'}`, ADMIN_USER_WRITE_LIMIT, ADMIN_USER_WRITE_WINDOW_MS)
  if (retry === null) { next(); return }
  res.setHeader('Retry-After', String(retry))
  res.status(429).json({ error: 'Too many user changes. Try again in a few minutes.', retry_after: retry })
}

interface UserRow {
  id: number
  username: string
  role: UserRole
  email: string | null
  created_at: string
}

/**
 * obj 900497: outcome of the optional invite / temp-password email. `sent:false`
 * tells the UI to fall back to showing the password on screen (today's flow).
 */
function emailOutcome(r: SendResult | null): { sent: boolean; error?: string; not_configured?: boolean } {
  if (!r) return { sent: false }
  if (r.ok) return { sent: true }
  return { sent: false, error: r.error, ...(r.code === 'not_configured' ? { not_configured: true } : {}) }
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/

/**
 * The Cloudflare Access badge for one user (obj 900023). A user with no
 * sign-in email can never be matched at the Cloudflare door, so they are
 * blocked by definition — unless this install is not behind Access at all, in
 * which case there is no second door and nothing to badge.
 */
function cfAccessForUser(
  statuses: Map<string, CfAccessStatus>,
  email: string | null,
  applies: boolean,
): CfAccessStatus {
  if (!applies) return { status: 'not_applicable', detail: 'access_not_configured' }
  const key = (email || '').trim().toLowerCase()
  return statuses.get(key) ?? { status: 'blocked', detail: 'no_email' }
}

/**
 * Normalise a sign-in email (obj 720332). Behind Cloudflare Access the verified
 * Access email picks the user, so it must be unique (case-insensitive).
 * Returns { email } (null = clear) or { error }.
 */
function parseEmail(raw: unknown, selfId: number | null): { email: string | null } | { error: string; status: number } {
  if (raw === null || raw === '') return { email: null }
  if (typeof raw !== 'string' || !EMAIL.test(raw.trim())) return { error: 'email must look like name@example.com', status: 400 }
  const email = raw.trim().toLowerCase()
  const holder = getDb().prepare('SELECT id FROM users WHERE lower(trim(email)) = ? AND id != ?').get(email, selfId ?? -1)
  if (holder) return { error: 'Another user already has that email', status: 409 }
  return { email }
}

// GET /api/admin/users — list every user with their workspace memberships.
// Also carries `cloudflare_access` per user (obj 900023): behind Cloudflare
// Access the app is only the second door, so an admin needs to see whether
// Cloudflare will actually let this person in. One Cloudflare read per list.
router.get('/', async (_req: AuthRequest, res) => {
  const db = getDb()
  const users = db
    .prepare('SELECT id, username, role, email, created_at FROM users ORDER BY username')
    .all() as UserRow[]

  const memberships = db
    .prepare(
      `SELECT user_id, workspace, role, can_use_assistant, objective_visibility
       FROM user_workspaces`
    )
    .all() as Array<{
      user_id: number
      workspace: string
      role: UserRole
      can_use_assistant: number
      objective_visibility: string
    }>

  const byUser = new Map<number, WorkspaceMembership[]>()
  for (const u of users) byUser.set(u.id, [])
  for (const m of memberships) {
    const list = byUser.get(m.user_id)
    if (!list) continue
    const user = users.find(u => u.id === m.user_id)!
    list.push({
      user_id: m.user_id,
      username: user.username,
      workspace: m.workspace,
      role: m.role,
      can_use_assistant: !!m.can_use_assistant,
      objective_visibility: m.objective_visibility === 'all' ? 'all' : 'own',
    })
  }

  // Never fatal: a missing or under-scoped Cloudflare token degrades to a
  // "blocked at Cloudflare" badge, it does not break the Users screen.
  let statuses: Map<string, CfAccessStatus>
  let applies = false
  try {
    applies = cfAccessApplies()
    statuses = applies ? await cfAccessStatuses(users.map(u => u.email)) : new Map()
  } catch {
    statuses = new Map()
  }

  res.json(
    users.map(u => ({
      ...u,
      workspaces: byUser.get(u.id) ?? [],
      cloudflare_access: cfAccessForUser(statuses, u.email, applies),
    }))
  )
})

/**
 * Cloudflare sign-in sync state (obj 900023): is the install behind Access, is
 * a sync token set (and from Settings or the env), and does it work. NEVER the
 * token — there is no route that reads it back, by design.
 */
async function cfSyncState(): Promise<CfAccessSyncState> {
  const applies = cfAccessApplies()
  const token = cfAccessTokenStatus()
  if (!applies || !token.configured) {
    return { applies, configured: token.configured, source: token.source, updated_at: token.updated_at, health: null }
  }
  const health = await cfAccessSyncHealth()
  return {
    applies,
    configured: true,
    source: token.source,
    updated_at: token.updated_at,
    health: health.ok ? 'ok' : health.reason,
  }
}

/** Saving or removing the token rewrites who may open the site: web-UI admins only. */
function requireCookieAdmin(req: AuthRequest, res: Response): boolean {
  if (authenticatedViaCookie(req)) return true
  res.status(403).json({ error: 'Only an admin signed in to the web app can change the Cloudflare sync token.' })
  return false
}

// GET /api/admin/users/cloudflare-sync — status only, never the token.
router.get('/cloudflare-sync', async (_req: AuthRequest, res) => {
  try {
    res.json(await cfSyncState())
  } catch {
    res.json({ applies: false, configured: false, source: null, updated_at: null, health: null } satisfies CfAccessSyncState)
  }
})

// PUT /api/admin/users/cloudflare-sync  body: { token }
// Stores the token encrypted (secrets store, server-only) and uses it from the
// next sync on — no restart. The response carries the state, not the token.
router.put('/cloudflare-sync', adminWriteLimited, async (req: AuthRequest, res) => {
  if (!requireCookieAdmin(req, res)) return
  const token = (req.body as { token?: unknown } | undefined)?.token
  if (!looksLikeCfToken(token)) {
    // Never echo what was sent: it may be a real credential pasted wrongly.
    return res.status(400).json({ error: 'That does not look like a Cloudflare API token. Paste the token value Cloudflare showed when you created it.' })
  }
  try {
    saveCfAccessToken(token, req.user?.id ?? null)
  } catch {
    return res.status(500).json({ error: 'Could not store the token. Check that the secrets store is set up on this install.' })
  }
  clearCfAccessStatusCache()
  console.log(`[cf-access-sync] sync token saved in Settings by user ${req.user?.id ?? '?'}`)
  res.json(await cfSyncState())
})

// DELETE /api/admin/users/cloudflare-sync — forget the stored token. An
// OK_CF_ACCESS_API_TOKEN env fallback, if the installer set one, applies again.
router.delete('/cloudflare-sync', async (req: AuthRequest, res) => {
  if (!requireCookieAdmin(req, res)) return
  clearCfAccessToken(req.user?.id ?? null)
  clearCfAccessStatusCache()
  console.log(`[cf-access-sync] sync token removed in Settings by user ${req.user?.id ?? '?'}`)
  res.json(await cfSyncState())
})

// POST /api/admin/users  body: { username, password, role?, email? }
// Admin-only (router.use(requireAuth, requireAdmin)) and per-admin limited by
// adminWriteLimited (services/file-access rateLimit), which CodeQL cannot see:
// codeql[js/missing-rate-limiting] -- admin-auth route, per-admin rateLimit() middleware above
router.post('/', adminWriteLimited, async (req: AuthRequest, res) => {
  const { username, password, role = 'member', email: rawEmail } = req.body as CreateUserRequest
  const sendEmail = (req.body as { send_email?: unknown }).send_email === true

  if (!username?.trim() || typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'username and password (min 8 chars) required' })
    return
  }
  if (role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }

  const db = getDb()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username.trim())
  if (existing) {
    res.status(409).json({ error: 'Username already taken' })
    return
  }

  const parsed = rawEmail === undefined ? { email: null } : parseEmail(rawEmail, null)
  if ('error' in parsed) {
    res.status(parsed.status).json({ error: parsed.error })
    return
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const result = db
    .prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run(username.trim(), hash, role, parsed.email)

  const user = db
    .prepare('SELECT id, username, role, email, created_at FROM users WHERE id = ?')
    .get(result.lastInsertRowid) as User

  // obj 900497: email the invite (sign-in link + temp password) when asked and
  // the user has an email. A password that travelled by email must be changed
  // at first sign-in, so the account is flagged only when the send succeeded.
  let invite: SendResult | null = null
  if (sendEmail && parsed.email) {
    invite = await sendInvite({ to: parsed.email, username: user.username, tempPassword: password, invitedBy: req.user?.username })
    if (invite.ok) db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(user.id)
  }

  // obj 900023: let them through the Cloudflare door too, when this install can.
  await syncUserAccessEmail(null, parsed.email)

  res.status(201).json({ ...user, invite_email: emailOutcome(sendEmail ? invite ?? { ok: false, provider: null, code: 'invalid', error: 'This user has no email address' } : null) })
})

// POST /api/admin/users/:id/reset-password  body: { password }
// codeql[js/missing-rate-limiting] -- admin-auth route, per-admin rateLimit() middleware above
router.post('/:id/reset-password', adminWriteLimited, async (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const { password } = req.body as ResetPasswordRequest
  const sendEmail = (req.body as { send_email?: unknown }).send_email === true
  if (typeof password !== 'string' || password.length < 8) {
    res.status(400).json({ error: 'password (min 8 chars) required' })
    return
  }

  const db = getDb()
  const exists = db.prepare('SELECT id, username, email FROM users WHERE id = ?').get(userId) as { id: number; username: string; email: string | null } | undefined
  if (!exists) {
    res.status(404).json({ error: 'User not found' })
    return
  }

  const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId)

  // obj 900497: optionally email the temp password; on failure the UI shows it.
  let mail: SendResult | null = null
  if (sendEmail) {
    mail = exists.email
      ? await sendTempPassword({ to: exists.email, username: exists.username, tempPassword: password })
      : { ok: false, provider: null, code: 'invalid', error: 'This user has no email address' }
    if (mail.ok) db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?').run(userId)
  }
  res.json({ ok: true, temp_password_email: emailOutcome(mail) })
})

// DELETE /api/admin/users/:id — kill switch; cascades to user_workspaces.
// Refuses to delete the caller's own account.
router.delete('/:id', async (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  if (req.user!.id === userId) {
    res.status(400).json({ error: 'Cannot delete your own account' })
    return
  }
  const db = getDb()
  const before = db.prepare('SELECT email FROM users WHERE id = ?').get(userId) as { email: string | null } | undefined
  const result = db.prepare('DELETE FROM users WHERE id = ?').run(userId)
  if (result.changes === 0) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  // obj 900023: revoke at the Cloudflare door as well, so a deleted user is
  // actually gone rather than still able to reach the app's sign-in page.
  await syncUserAccessEmail(before?.email ?? null, null)
  res.json({ ok: true })
})

// PATCH /api/admin/users/:id  body: { role?, email? }  (email null/'' clears it)
router.patch('/:id', async (req: AuthRequest, res) => {
  const idParam = req.params.id
  const userId = parseInt(typeof idParam === 'string' ? idParam : '', 10)
  if (Number.isNaN(userId)) {
    res.status(400).json({ error: 'Invalid user_id' })
    return
  }
  const body = (req.body || {}) as { role?: UserRole; email?: string | null }
  const { role } = body
  const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email')
  if (role === undefined && !hasEmail) {
    res.status(400).json({ error: 'Nothing to change: send role and/or email' })
    return
  }
  if (role !== undefined && role !== 'admin' && role !== 'member') {
    res.status(400).json({ error: "role must be 'admin' or 'member'" })
    return
  }
  const db = getDb()
  const existing = db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as
    { id: number; email: string | null } | undefined
  if (!existing) {
    res.status(404).json({ error: 'User not found' })
    return
  }
  let emailChange: { before: string | null; after: string | null } | null = null
  if (hasEmail) {
    const parsed = parseEmail(body.email, userId)
    if ('error' in parsed) {
      res.status(parsed.status).json({ error: parsed.error })
      return
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(parsed.email, userId)
    emailChange = { before: existing.email, after: parsed.email }
  }
  if (role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, userId)
  // obj 900023: an email change moves the allow entry — the new address in, the
  // old one out — so the Cloudflare door tracks the app's idea of this person.
  if (emailChange) await syncUserAccessEmail(emailChange.before, emailChange.after)
  const user = db
    .prepare('SELECT id, username, role, email, created_at FROM users WHERE id = ?')
    .get(userId) as User
  res.json(user)
})

export default router
