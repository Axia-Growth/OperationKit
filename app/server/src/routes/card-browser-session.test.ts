/**
 * Card browser sign-in (obj 901106).
 *
 * Boots the real auth router, the real agent-key guard and the real
 * /api/card-browser router on a throwaway DB, then drives the whole path the
 * launcher's `--sign-in` uses: card session token → minted cookies → the app
 * accepts the `token` cookie as a READ-ONLY, de-escalated, card-bound session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'

const TMP_DB = path.join(os.tmpdir(), `cc-card-browser-session-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-card-browser-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { createCardBrowserSessionRouter } = await import('./card-browser-session.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { requireAuth, requireAdmin, generateToken, verifyToken } = await import('../middleware/auth.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const lib = await import('../lib/card-browser-session.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
let server: http.Server
let baseUrl: string
// Loose JSON for field-by-field asserts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let cfResult: import('../lib/card-browser-session.js').CfAccessExchange = { status: 'not_configured', reason: 'unset' }

async function call(method: string, p: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: Loose = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

function seedCard(opts: { workspace?: string; status?: string; bot?: string | null } = {}): number {
  const r = getDb()
    .prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('audit the live site', ?, ?, ?, ?)`)
    .run(opts.bot === undefined ? 'opkit-dev' : opts.bot, opts.workspace ?? 'operationkit', ADMIN_ID, opts.status ?? 'working')
  return Number(r.lastInsertRowid)
}

function sessionHeader(objectiveId: number, actingUserId: number | null = ADMIN_ID, workspace = 'operationkit') {
  return { 'X-CC-Session-Token': mintSessionToken({ objectiveId, workspace, actingUserId }) }
}

async function mint(objectiveId: number, actingUserId: number | null = ADMIN_ID) {
  return call('POST', '/api/card-browser/session', sessionHeader(objectiveId, actingUserId))
}

function cookieHeader(cookies: Loose[]): string {
  return cookies.map((c: Loose) => `${c.name}=${c.value}`).join('; ')
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(ADMIN_ID)
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER_ID)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/auth', authRouter)
  app.use('/api/card-browser', createCardBrowserSessionRouter({
    publicUrl: () => 'https://ai.example-install.test',
    exchange: async () => cfResult,
  }))
  app.get('/api/objectives', requireAuth, (req, res) => { res.json({ ok: true, user: (req as Loose).user }) })
  app.post('/api/objectives', requireAuth, (_req, res) => { res.json({ ok: true }) })
  app.delete('/api/objectives/1', requireAuth, (_req, res) => { res.json({ ok: true }) })
  app.get('/api/admin/ping', requireAuth, requireAdmin, (_req, res) => { res.json({ ok: true }) })
  await new Promise<void>(r => { server = app.listen(0, '127.0.0.1', () => r()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(r => server.close(() => r()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

beforeEach(() => {
  getDb().prepare('DELETE FROM objectives').run()
  getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(lib.CARD_BROWSER_SIGN_IN_FLAG)
  cfResult = { status: 'not_configured', reason: 'unset' }
})

describe('POST /api/card-browser/session — minting', () => {
  it('a running card gets a host-only, httpOnly, short-lived app cookie as its bot', async () => {
    const id = seedCard()
    const r = await mint(id)
    expect(r.status).toBe(200)
    expect(r.json.public_url).toBe('https://ai.example-install.test')
    expect(r.json.identity).toEqual({ username: `bot:opkit-dev (card #${id})`, bot: 'opkit-dev', role: 'member', workspace: 'operationkit', read_only: true })
    expect(r.json.cf_access).toEqual({ status: 'not_configured', reason: 'unset' })
    expect(r.json.cookies).toHaveLength(1)
    const [c] = r.json.cookies
    expect(c).toMatchObject({ name: 'token', domain: 'ai.example-install.test', path: '/', httpOnly: true, secure: true })
    expect(c.value.startsWith('ccb_')).toBe(true)
    const ttl = c.expires * 1000 - Date.now()
    expect(ttl).toBeGreaterThan(25 * 60_000)
    expect(ttl).toBeLessThanOrEqual(30 * 60_000)
    // It is NOT a login JWT: the login verifier rejects it outright.
    expect(verifyToken(c.value)).toBeNull()
  })

  it('carries the Access cookie when the install has a service token, never past the app session', async () => {
    cfResult = { status: 'ok', cookie: { name: 'CF_Authorization', value: 'cf-jwt', expiresAt: Date.now() + 24 * 3600_000 } }
    const id = seedCard()
    const r = await mint(id)
    expect(r.status).toBe(200)
    expect(r.json.cf_access).toEqual({ status: 'ok' })
    const cf = r.json.cookies.find((c: Loose) => c.name === 'CF_Authorization')
    const app = r.json.cookies.find((c: Loose) => c.name === 'token')
    expect(cf).toMatchObject({ value: 'cf-jwt', domain: 'ai.example-install.test', httpOnly: true, secure: true })
    expect(cf.expires).toBeLessThanOrEqual(app.expires)
  })

  it('clamps the requested lifetime to at most 60 minutes', async () => {
    const id = seedCard()
    const r = await call('POST', '/api/card-browser/session', sessionHeader(id), { ttl_minutes: 600 })
    expect(r.status).toBe(200)
    expect(r.json.cookies[0].expires * 1000 - Date.now()).toBeLessThanOrEqual(60 * 60_000)
  })

  it('refuses without a card session token, with a forged one, and with a login cookie', async () => {
    expect((await call('POST', '/api/card-browser/session')).status).toBe(401)
    expect((await call('POST', '/api/card-browser/session', { 'X-CC-Session-Token': 'ccs_forged.sig' })).status).toBe(401)
    const adminCookie = `token=${generateToken({ id: ADMIN_ID, username: 'operator', role: 'admin', created_at: '' })}`
    expect((await call('POST', '/api/card-browser/session', { Cookie: adminCookie })).status).toBe(401)
  })

  it('refuses a card that is not running', async () => {
    for (const status of ['queue', 'review', 'done', 'cancelled']) {
      const id = seedCard({ status })
      const r = await mint(id)
      expect(r.status, status).toBe(401)
      expect(r.json.code).toBe('card_not_running')
    }
  })

  it('refuses when the acting member is not in the card workspace', async () => {
    const id = seedCard()
    const r = await mint(id, MEMBER_ID)
    expect(r.status).toBe(403)
    expect(r.json.code).toBe('workspace_forbidden')
  })

  it('honours the kill switch', async () => {
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, '0')`).run(lib.CARD_BROWSER_SIGN_IN_FLAG)
    const id = seedCard()
    expect((await mint(id)).status).toBe(403)
  })
})

describe('the minted cookie in the app — read-only, de-escalated, card-bound', () => {
  async function signedIn() {
    const id = seedCard()
    const r = await mint(id)
    expect(r.status).toBe(200)
    return { id, cookie: cookieHeader(r.json.cookies) }
  }

  it('signs the browser in as the card\'s bot: /api/auth/me reports a read-only member of ONE workspace', async () => {
    const { id, cookie } = await signedIn()
    const me = await call('GET', '/api/auth/me', { Cookie: cookie })
    expect(me.status).toBe(200)
    expect(me.json.role).toBe('member')
    expect(me.json.username).toBe(`bot:opkit-dev (card #${id})`)
    expect(me.json.workspaces).toEqual([{ workspace: 'operationkit', role: 'member' }])
    expect(me.json.card_browser).toMatchObject({ objective_id: id, bot: 'opkit-dev', read_only: true })
  })

  it('GET works; POST / DELETE are refused as read-only', async () => {
    const { cookie } = await signedIn()
    const get = await call('GET', '/api/objectives', { Cookie: cookie })
    expect(get.status).toBe(200)
    expect(get.json.user.role).toBe('member')
    // Membership-free: never the acting admin's id (obj 901106 review).
    expect(get.json.user.id).toBeLessThan(0)
    const post = await call('POST', '/api/objectives', { Cookie: cookie }, {})
    expect(post.status).toBe(403)
    expect(post.json.code).toBe('card_browser_read_only')
    expect((await call('DELETE', '/api/objectives/1', { Cookie: cookie })).status).toBe(403)
  })

  it('never reaches an admin endpoint, even though the acting user is an admin', async () => {
    const { cookie } = await signedIn()
    expect((await call('GET', '/api/admin/ping', { Cookie: cookie })).status).toBe(403)
  })

  it('ends the moment the card stops running', async () => {
    const { id, cookie } = await signedIn()
    getDb().prepare(`UPDATE objectives SET status = 'done' WHERE id = ?`).run(id)
    const r = await call('GET', '/api/objectives', { Cookie: cookie })
    expect(r.status).toBe(401)
    expect(r.json.code).toBe('card_not_running')
  })

  it('a tampered or expired cookie is refused', async () => {
    const { cookie } = await signedIn()
    const tampered = cookie.replace(/\.([A-Za-z0-9_-])/, (_m, ch) => `.${ch === 'A' ? 'B' : 'A'}`)
    expect((await call('GET', '/api/objectives', { Cookie: tampered })).status).toBe(401)
    const id = seedCard()
    const old = lib.mintCardBrowserSession({ objectiveId: id, actingUserId: ADMIN_ID, bot: null }, Date.now() - 2 * 3600_000)
    expect((await call('GET', '/api/objectives', { Cookie: `token=${old.token}` })).status).toBe(401)
  })

  it('the kill switch also ends sessions already handed out', async () => {
    const { cookie } = await signedIn()
    getDb().prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, '0')`).run(lib.CARD_BROWSER_SIGN_IN_FLAG)
    expect((await call('GET', '/api/objectives', { Cookie: cookie })).status).toBe(401)
  })
})

describe('Cloudflare Access service-token exchange (control plane only)', () => {
  const env = { CARD_BROWSER_CF_ACCESS_CLIENT_ID: 'id.access', CARD_BROWSER_CF_ACCESS_CLIENT_SECRET: 'shh' } as NodeJS.ProcessEnv

  it('is not_configured without a service token, and makes no request', async () => {
    let called = false
    const r = await lib.exchangeCfAccessServiceToken('https://ai.x.test', {} as NodeJS.ProcessEnv, (async () => { called = true; return new Response('') }) as typeof fetch)
    expect(r.status).toBe('not_configured')
    expect(called).toBe(false)
  })

  it('sends the service token headers to the public URL and returns only the Access cookie', async () => {
    let seen: { url: string; headers: Record<string, string>; redirect?: string } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string>, redirect: init.redirect }
      const h = new Headers()
      h.append('set-cookie', 'CF_Authorization=eyJ.cf.jwt; Max-Age=3600; Path=/; Secure; HttpOnly')
      h.append('set-cookie', 'other=1; Path=/')
      return new Response('{"ok":true}', { status: 200, headers: h })
    }) as unknown as typeof fetch
    const now = Date.now()
    const r = await lib.exchangeCfAccessServiceToken('https://ai.x.test', env, fake, now)
    expect(seen!.url).toBe('https://ai.x.test/api/health')
    expect(seen!.redirect).toBe('manual')
    expect(seen!.headers).toMatchObject({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'shh' })
    expect(r).toEqual({ status: 'ok', cookie: { name: 'CF_Authorization', value: 'eyJ.cf.jwt', expiresAt: now + 3600_000 } })
  })

  it('reports a token the Access app does not accept (redirect to the login page)', async () => {
    const fake = (async () => new Response('', { status: 302, headers: { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login/x' } })) as unknown as typeof fetch
    const r = await lib.exchangeCfAccessServiceToken('https://ai.x.test', env, fake)
    expect(r.status).toBe('failed')
    expect((r as { reason: string }).reason).toMatch(/Service Auth policy/)
  })

  it('reports a site that is not behind Access', async () => {
    const fake = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch
    expect((await lib.exchangeCfAccessServiceToken('https://ai.x.test', env, fake)).status).toBe('not_behind_access')
  })
})

describe('lib helpers', () => {
  it('only views: GET/HEAD/OPTIONS and logout', () => {
    expect(lib.cardBrowserRequestAllowed('GET', '/api/objectives')).toBe(true)
    expect(lib.cardBrowserRequestAllowed('HEAD', '/api/auth/me')).toBe(true)
    expect(lib.cardBrowserRequestAllowed('POST', '/api/auth/logout')).toBe(true)
    expect(lib.cardBrowserRequestAllowed('POST', '/api/objectives')).toBe(false)
    expect(lib.cardBrowserRequestAllowed('PATCH', '/api/objectives/1')).toBe(false)
    expect(lib.cardBrowserRequestAllowed('PUT', '/api/docs/file')).toBe(false)
  })

  it('the bot is owner_bot first, then agent_context; junk is ignored', () => {
    expect(lib.cardBotSlug({ owner_bot: 'opkit-dev', agent_context: 'cto' })).toBe('opkit-dev')
    expect(lib.cardBotSlug({ owner_bot: null, agent_context: 'cto' })).toBe('cto')
    expect(lib.cardBotSlug({ owner_bot: '../x', agent_context: '' })).toBeNull()
  })

  it('a session token cannot be passed off as a card browser session, nor the reverse', () => {
    const s = mintSessionToken({ objectiveId: 1, workspace: 'w', actingUserId: 1 })
    expect(lib.verifyCardBrowserSession(s)).toBeNull()
    expect(lib.verifyCardBrowserSession('ccb_' + s.slice(4))).toBeNull()
  })
})
