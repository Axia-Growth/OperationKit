/**
 * card-browser-session.ts — the sanctioned way a CARD's browser signs in to
 * this install's own public site (obj 901106).
 *
 * ## Why this exists
 *
 * A worker card's browser (lib/card-browser.ts) is allowed to open the
 * install's public URL, and only that. On an install behind Cloudflare Access
 * (the operator droplet is), the first response is a 302 to
 * `<team>.cloudflareaccess.com`: a sign-in for PEOPLE. The egress guard refuses
 * that hop, so Chromium reports ERR_TUNNEL_CONNECTION_FAILED and a bot cannot
 * audit the live site at all. Even past Access, the app itself wants a login.
 *
 * Opening the guard to the Access login, or handing the card a shared admin
 * cookie / a Shared secret, would each be a hole. Instead a card asks the
 * control plane — with the `CC_SESSION_TOKEN` it already holds — for a
 * short-lived pair of cookies for the public host:
 *
 *   1. `CF_Authorization` — obtained BY THE CONTROL PLANE with the install's
 *      Cloudflare Access service token (`CARD_BROWSER_CF_ACCESS_CLIENT_ID` /
 *      `_SECRET`, install env, never sent to the card). The card gets only the
 *      Access session cookie Cloudflare issues for that one application, which
 *      expires on Access's own clock. No service token configured → no Access
 *      cookie, and the response says so (status `not_configured`).
 *   2. `token` — a CARD BROWSER session (`ccb_…`), NOT a login JWT:
 *        * HMAC'd under its own label, so it cannot be replayed as a login JWT
 *          or a session token, and a card cannot forge one (JWT_SECRET is
 *          stripped from every session env);
 *        * short-lived (default 30 min, max 60);
 *        * bound to ONE card and re-checked against the LIVE objective row on
 *          every request: a card that has left `working` / `ai_review` loses it;
 *        * READ-ONLY: GET/HEAD/OPTIONS only (plus logout) — an audit views the
 *          site, it never acts through it;
 *        * de-escalated AND membership-free: role `member` with a SYNTHETIC
 *          user id (`-objectiveId`) that matches no users / user_workspaces /
 *          objective_assignees / created_by / assigned_user_id row, so no
 *          membership check can pass through the acting user. The acting user
 *          is kept on the principal for the audit log only;
 *        * confined to an explicit ROUTE ALLOWLIST (CARD_BROWSER_GET_ROUTES):
 *          the handful of reads the board needs to render, each scoped to the
 *          card's ONE workspace. Everything else (secrets broker, settings,
 *          users, api keys, agent keys, costs, shell, assistant, mcp, agent chat …)
 *          is a 403 before any handler runs. requireAdmin refuses it too.
 *
 * Kill switch: `settings.card_browser_sign_in = '0'` (or env
 * `CC_CARD_BROWSER_SIGN_IN=0`). The egress guard is unchanged: 3002, the
 * internal API, metadata and private ranges stay blocked.
 */
import crypto from 'node:crypto'
import type Database from 'better-sqlite3'
import type { User } from '@operationkit/shared'
import { getJwtSecret } from '../middleware/auth.js'

export const CARD_BROWSER_SESSION_PREFIX = 'ccb_'
export const CARD_BROWSER_SIGN_IN_FLAG = 'card_browser_sign_in'
export const DEFAULT_CARD_BROWSER_TTL_MS = 30 * 60 * 1000
export const MAX_CARD_BROWSER_TTL_MS = 60 * 60 * 1000
export const MIN_CARD_BROWSER_TTL_MS = 60 * 1000
/** A card browser session lives only while its card is running. */
export const CARD_BROWSER_LIVE_STATUSES = ['working', 'ai_review'] as const

export interface CardBrowserClaims {
  objectiveId: number
  actingUserId: number | null
  /** Bot slug the card works as (`owner_bot` / `agent_context`), or null. */
  bot: string | null
  expiresAt: number
}

function key(): Buffer {
  return crypto.createHmac('sha256', getJwtSecret()).update('cc-card-browser-session-v1').digest()
}

function sign(payload: string): string {
  return crypto.createHmac('sha256', key()).update(payload).digest('base64url')
}

export function clampCardBrowserTtl(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? ms : DEFAULT_CARD_BROWSER_TTL_MS
  return Math.min(MAX_CARD_BROWSER_TTL_MS, Math.max(MIN_CARD_BROWSER_TTL_MS, Math.round(n)))
}

export function mintCardBrowserSession(
  claims: Omit<CardBrowserClaims, 'expiresAt'>,
  now = Date.now(),
  ttlMs = DEFAULT_CARD_BROWSER_TTL_MS,
): { token: string; expiresAt: number } {
  const expiresAt = now + clampCardBrowserTtl(ttlMs)
  const payload = Buffer.from(
    JSON.stringify({ o: claims.objectiveId, u: claims.actingUserId, b: claims.bot, e: expiresAt }),
  ).toString('base64url')
  return { token: `${CARD_BROWSER_SESSION_PREFIX}${payload}.${sign(payload)}`, expiresAt }
}

export function isCardBrowserSessionToken(token: string | undefined | null): boolean {
  return typeof token === 'string' && token.startsWith(CARD_BROWSER_SESSION_PREFIX)
}

export function verifyCardBrowserSession(token: string | undefined | null, now = Date.now()): CardBrowserClaims | null {
  if (!isCardBrowserSessionToken(token)) return null
  const body = (token as string).slice(CARD_BROWSER_SESSION_PREFIX.length)
  const dot = body.indexOf('.')
  if (dot <= 0) return null
  const payload = body.slice(0, dot)
  const mac = Buffer.from(body.slice(dot + 1))
  const expected = Buffer.from(sign(payload))
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { o: unknown; u: unknown; b: unknown; e: unknown }
    if (typeof p.o !== 'number' || typeof p.e !== 'number' || p.e < now) return null
    return {
      objectiveId: p.o,
      actingUserId: typeof p.u === 'number' ? p.u : null,
      bot: typeof p.b === 'string' && p.b ? p.b : null,
      expiresAt: p.e,
    }
  } catch {
    return null
  }
}

/** Default ON; `'0'` in settings or `CC_CARD_BROWSER_SIGN_IN=0` turns it off. */
export function cardBrowserSignInEnabled(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CC_CARD_BROWSER_SIGN_IN !== undefined && /^(0|off|false|no)$/i.test(env.CC_CARD_BROWSER_SIGN_IN.trim())) return false
  if (!db) return true
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(CARD_BROWSER_SIGN_IN_FLAG) as { value: string } | undefined
    return !(row && String(row.value).trim() === '0')
  } catch {
    return true
  }
}

/**
 * The ONLY API reads a card browser session may make (obj 901106 review). Each
 * one is workspace-scoped for this principal:
 *   - /api/auth/me      → reports the card's ONE workspace, never the acting user's row
 *   - /api/workspaces   → just the card's workspace
 *   - /api/objectives, /api/objectives/:id → the cards of the card's ONE
 *     workspace (obj 901145), narrowed — never widened — to what the acting
 *     user may see there (see CardBrowserPrincipal.ownOnlyUserId). Any other
 *     workspace is [] / 403
 *   - /api/docs/*, /api/files/* → sessionFileWorkspace() pins them to the card's
 *     workspace, exactly like a CC_SESSION_TOKEN caller, and they are refused
 *     outright while the install has session KB access switched off
 *     (sessionKbAccessEnabled, obj 901145)
 * Anything not listed is refused. Add a route here only with a test that it is
 * scoped to the card's workspace.
 */
export const CARD_BROWSER_GET_ROUTES: readonly RegExp[] = [
  /^\/api\/auth\/me$/,
  /^\/api\/workspaces$/,
  /^\/api\/objectives$/,
  /^\/api\/objectives\/\d+$/,
  /^\/api\/docs\/(tree|file|search|related)$/,
  /^\/api\/files\/(search|stat|download)$/,
]

// The URL is request input, so trailing '/'s are trimmed with a backwards scan:
// a `/\/+$/` replace is quadratic on "////…x" (CodeQL js/polynomial-redos, obj 901148).
function pathOf(originalUrl: string): string {
  const p = originalUrl.split('?')[0].split('#')[0] || '/'
  let end = p.length
  while (end > 0 && p.charCodeAt(end - 1) === 47 /* '/' */) end--
  return p.slice(0, end) || '/'
}

/** The knowledge-base reads; gated on the install's session KB flag too. */
export const CARD_BROWSER_KB_ROUTES: readonly RegExp[] = [
  /^\/api\/docs(\/|$)/,
  /^\/api\/files(\/|$)/,
]

export type CardBrowserRequestVerdict =
  | { ok: true }
  | { ok: false; code: 'card_browser_read_only' | 'card_browser_route_not_allowed' | 'session_kb_disabled'; error: string }

/**
 * What a card browser session may do: view the allowlisted reads, and log out.
 * `kbAccess` is the install's session KB flag (sessionKbAccessEnabled): when it
 * is off, a card browser cannot read the knowledge base either — the same rule
 * a CC_SESSION_TOKEN caller gets (obj 901145).
 */
export function cardBrowserRequestVerdict(
  method: string,
  originalUrl: string,
  opts: { kbAccess?: boolean } = {},
): CardBrowserRequestVerdict {
  const m = method.toUpperCase()
  const p = pathOf(originalUrl)
  if (m === 'POST' && p === '/api/auth/logout') return { ok: true }
  if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS') {
    return { ok: false, code: 'card_browser_read_only', error: 'A card browser session is read-only' }
  }
  if (CARD_BROWSER_GET_ROUTES.some((re) => re.test(p))) {
    if (opts.kbAccess === false && CARD_BROWSER_KB_ROUTES.some((re) => re.test(p))) {
      return { ok: false, code: 'session_kb_disabled', error: 'Session knowledge-base access is disabled on this install' }
    }
    return { ok: true }
  }
  return { ok: false, code: 'card_browser_route_not_allowed', error: 'A card browser session cannot read this route' }
}

export function cardBrowserRequestAllowed(method: string, originalUrl: string): boolean {
  return cardBrowserRequestVerdict(method, originalUrl).ok
}

/**
 * The user id a card browser principal carries: negative, so it can never equal
 * a real users.id (SQLite rowids are positive) and no membership, ownership or
 * assignment row can match it.
 */
export function cardBrowserSyntheticUserId(objectiveId: number): number {
  return -Math.abs(Math.trunc(objectiveId)) || -1
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export interface CardBrowserPrincipal {
  /** Synthetic, membership-free identity (see cardBrowserSyntheticUserId). */
  user: User
  /** The card's acting user — for the audit log ONLY, never for an access check. */
  actingUserId: number | null
  objectiveId: number
  workspace: string
  /**
   * obj 901145: the card list is the card's workspace, NARROWED to what the
   * acting user may see there. null = every card in the workspace (no acting
   * user, an admin, or a member with objective_visibility 'all'). A number =
   * only cards that user created / is assigned to ('own' visibility). It can
   * only ever shrink the view; it never adds a workspace.
   */
  ownOnlyUserId: number | null
  bot: string | null
  expiresAt: number
}

export type CardBrowserResolution =
  | { ok: true; principal: CardBrowserPrincipal }
  | { ok: false; status: number; code: string; error: string }

interface ObjectiveRow {
  id: number
  status: string
  workspace: string | null
  agent_context?: string | null
  owner_bot?: string | null
}

/** The bot a card works as: `owner_bot` first, then `agent_context`. */
export function cardBotSlug(row: Pick<ObjectiveRow, 'agent_context' | 'owner_bot'>): string | null {
  for (const v of [row.owner_bot, row.agent_context]) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (s && SLUG.test(s)) return s
  }
  return null
}

function loadObjective(db: Database.Database, id: number): ObjectiveRow | undefined {
  const cols = new Set((db.prepare('PRAGMA table_info(objectives)').all() as { name: string }[]).map((c) => c.name))
  const extra = ['agent_context', 'owner_bot'].filter((c) => cols.has(c))
  return db
    .prepare(`SELECT id, status, workspace${extra.map((c) => `, ${c}`).join('')} FROM objectives WHERE id = ?`)
    .get(id) as ObjectiveRow | undefined
}

/**
 * Everything the card must be for a card-browser session to be minted or
 * honoured. Shared by the mint route and requireAuth, so both refuse the same
 * cards for the same reasons.
 */
export function checkCardForBrowserSession(
  db: Database.Database,
  objectiveId: number,
  actingUserId: number | null,
):
  | { ok: true; objective: ObjectiveRow; workspace: string; user: { id: number; username: string; role: string } | null }
  | { ok: false; status: number; code: string; error: string } {
  const objective = loadObjective(db, objectiveId)
  if (!objective) return { ok: false, status: 401, code: 'card_gone', error: 'The card behind this browser session no longer exists' }
  if (!(CARD_BROWSER_LIVE_STATUSES as readonly string[]).includes(objective.status)) {
    return { ok: false, status: 401, code: 'card_not_running', error: `Card #${objectiveId} is not running (status ${objective.status}); its browser session has ended` }
  }
  const workspace = (objective.workspace || '').trim()
  if (!workspace || !SLUG.test(workspace)) {
    return { ok: false, status: 403, code: 'no_workspace', error: 'This card has no workspace, so its browser has no scope' }
  }
  type UserRow = { id: number; username: string; role: string }
  let user: UserRow | null = null
  if (actingUserId != null) {
    user = (db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(actingUserId) as UserRow | undefined) ?? null
    if (!user) return { ok: false, status: 401, code: 'acting_user_gone', error: 'The card\'s acting user no longer exists' }
    if (user.role !== 'admin') {
      const member = db.prepare('SELECT 1 FROM user_workspaces WHERE user_id = ? AND workspace = ?').get(user.id, workspace)
      if (!member) return { ok: false, status: 403, code: 'workspace_forbidden', error: `No access to workspace '${workspace}'` }
    }
  }
  return { ok: true, objective, workspace, user }
}

export function cardBrowserUsername(objectiveId: number, bot: string | null): string {
  return bot ? `bot:${bot} (card #${objectiveId})` : `card #${objectiveId}`
}

/** See CardBrowserPrincipal.ownOnlyUserId. */
export function cardBrowserOwnOnlyUserId(
  db: Database.Database,
  user: { id: number; role: string } | null,
  workspace: string,
): number | null {
  if (!user || user.role === 'admin') return null
  const row = db
    .prepare('SELECT objective_visibility FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(user.id, workspace) as { objective_visibility?: string | null } | undefined
  return row?.objective_visibility === 'all' ? null : user.id
}

/** requireAuth's half: token → de-escalated, card-bound principal. */
export function resolveCardBrowserSession(db: Database.Database, token: string, now = Date.now()): CardBrowserResolution {
  const claims = verifyCardBrowserSession(token, now)
  if (!claims) return { ok: false, status: 401, code: 'bad_card_browser_session', error: 'Invalid or expired card browser session' }
  if (!cardBrowserSignInEnabled(db)) {
    return { ok: false, status: 401, code: 'card_browser_sign_in_disabled', error: 'Card browser sign-in is switched off on this install' }
  }
  const card = checkCardForBrowserSession(db, claims.objectiveId, claims.actingUserId)
  if (!card.ok) return card
  return {
    ok: true,
    principal: {
      // De-escalated and membership-free: never 'admin', and never the acting
      // user's id, so no user_workspaces / ownership row can widen the scope.
      user: { id: cardBrowserSyntheticUserId(claims.objectiveId), username: cardBrowserUsername(claims.objectiveId, claims.bot), role: 'member' } as User,
      actingUserId: card.user?.id ?? null,
      objectiveId: claims.objectiveId,
      workspace: card.workspace,
      ownOnlyUserId: cardBrowserOwnOnlyUserId(db, card.user, card.workspace),
      bot: claims.bot,
      expiresAt: claims.expiresAt,
    },
  }
}

// ── Cloudflare Access (control-plane side only) ─────────────────────────────

export type CfAccessExchange =
  | { status: 'ok'; cookie: { name: string; value: string; expiresAt: number | null } }
  | { status: 'not_configured'; reason: string }
  | { status: 'not_behind_access'; reason: string }
  | { status: 'failed'; reason: string }

export const CF_ACCESS_CLIENT_ID_ENV = 'CARD_BROWSER_CF_ACCESS_CLIENT_ID'
export const CF_ACCESS_CLIENT_SECRET_ENV = 'CARD_BROWSER_CF_ACCESS_CLIENT_SECRET'

/** Parse one Set-Cookie line into name/value/expiry. Exported for tests. */
export function parseSetCookie(line: string, now = Date.now()): { name: string; value: string; expiresAt: number | null } | null {
  const parts = line.split(';').map((p) => p.trim())
  const first = parts.shift() || ''
  const eq = first.indexOf('=')
  if (eq <= 0) return null
  const name = first.slice(0, eq).trim()
  const value = first.slice(eq + 1).trim()
  let expiresAt: number | null = null
  for (const attr of parts) {
    const [k, ...rest] = attr.split('=')
    const v = rest.join('=')
    if (/^max-age$/i.test(k.trim()) && /^-?\d+$/.test(v.trim())) expiresAt = now + Number(v.trim()) * 1000
    else if (/^expires$/i.test(k.trim()) && expiresAt === null) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) expiresAt = t
    }
  }
  return { name, value, expiresAt }
}

function setCookieLines(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const raw = headers.get('set-cookie')
  return raw ? raw.split(/,(?=\s*[A-Za-z0-9_-]+=)/) : []
}

/**
 * Trade the install's Access service token for the Access session cookie of
 * the public application. The service token never leaves the control plane;
 * the card receives only the resulting `CF_Authorization` cookie.
 */
export async function exchangeCfAccessServiceToken(
  publicUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<CfAccessExchange> {
  const id = (env[CF_ACCESS_CLIENT_ID_ENV] || '').trim()
  const secret = (env[CF_ACCESS_CLIENT_SECRET_ENV] || '').trim()
  if (!id || !secret) {
    return {
      status: 'not_configured',
      reason: `no Cloudflare Access service token on this install (${CF_ACCESS_CLIENT_ID_ENV} / ${CF_ACCESS_CLIENT_SECRET_ENV} unset)`,
    }
  }
  let res: Response
  try {
    res = await fetchImpl(new URL('/api/health', publicUrl).toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    return { status: 'failed', reason: `could not reach ${publicUrl}: ${(err as Error).message}` }
  }
  for (const line of setCookieLines(res.headers)) {
    const c = parseSetCookie(line, now)
    if (c && c.name === 'CF_Authorization' && c.value) return { status: 'ok', cookie: c }
  }
  const location = res.headers.get('location') || ''
  if (res.status >= 300 && res.status < 400 && /cloudflareaccess\.com/i.test(location)) {
    return {
      status: 'failed',
      reason:
        'Cloudflare Access did not accept the service token for this application (it redirected to the login page). ' +
        'The Access application needs a Service Auth policy that includes this token.',
    }
  }
  if (res.status === 401 || res.status === 403) {
    return { status: 'failed', reason: `Cloudflare Access refused the service token (HTTP ${res.status})` }
  }
  return { status: 'not_behind_access', reason: `no Access cookie issued (HTTP ${res.status}); the site does not appear to be behind Cloudflare Access` }
}

// ── Cookies for the browser context ─────────────────────────────────────────

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'Lax' | 'Strict' | 'None'
}

/** Playwright `context.addCookies()` shape, host-only on the public host. */
export function buildCardBrowserCookies(
  publicUrl: string,
  app: { token: string; expiresAt: number },
  cf: CfAccessExchange,
): BrowserCookie[] {
  const u = new URL(publicUrl)
  const secure = u.protocol === 'https:'
  const base = { domain: u.hostname, path: '/', httpOnly: true, secure, sameSite: 'Lax' as const }
  const out: BrowserCookie[] = [{ ...base, name: 'token', value: app.token, expires: Math.floor(app.expiresAt / 1000) }]
  if (cf.status === 'ok') {
    // Never outlive the app session we are handing out alongside it.
    const exp = Math.min(cf.cookie.expiresAt ?? app.expiresAt, app.expiresAt)
    out.push({ ...base, name: cf.cookie.name, value: cf.cookie.value, expires: Math.floor(exp / 1000) })
  }
  return out
}
