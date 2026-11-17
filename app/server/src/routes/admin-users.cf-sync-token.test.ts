/**
 * obj 900023 — the Cloudflare Access sync token entered in Settings → Users.
 *
 * Through the real routes and the real token path (no injected client):
 *   * PUT stores the token encrypted and server-only; no API ever returns it.
 *   * It takes effect on the next user save — no restart, no env var.
 *   * The account id is resolved from the token when the install never
 *     recorded OK_CF_ACCOUNT_ID, and only the app whose AUD is this install's
 *     is ever touched — never another app, never the verify robot.
 *   * A token without Access rights is a note (health: forbidden), not an error.
 *   * OK_CF_ACCESS_API_TOKEN stays as the fallback.
 *   * The token never appears in a response, a log line or a session's env.
 * Cloudflare is a fake behind a stubbed global fetch; nothing reaches a real account.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import crypto from 'crypto'
import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'

// db/index.ts's import graph reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in this test') } }))

const TMP_DB = path.join(os.tmpdir(), `cc-admin-users-cf-token-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-admin-users-cf-token'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString('base64')

const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-this-install-only'
const ISS = `https://${TEAM}`
const OTHER_ACCOUNT = 'ffff0000ffff0000ffff0000ffff0000'
const ACCOUNT = 'abc123def4567890abc123def4567890'
// Assembled at runtime so the literal never sits in source as one string.
const SETTINGS_TOKEN = ['Zx9', 'settings', 'sync', 'credential', 'ABCDEF123456'].join('_')
const ENV_TOKEN = ['Qq7', 'env', 'fallback', 'credential', '987654'].join('_')
const WEAK_TOKEN = ['Ww3', 'read', 'only', 'credential', '000111'].join('_')

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: adminUsersRouter } = await import('./admin-users.js')
const { CfAccessVerifier, cfAccessConfig, setCfAccessVerifierForTests } = await import('../lib/cf-access.js')
const { setCfAccessPolicyClientForTests, clearCfAccessStatusCache } = await import('../services/cf-access-user-sync.js')
const { CF_ACCESS_SYNC_TOKEN_KEY, resetCfAccessTokenCacheForTests } = await import('../services/cf-access-token.js')
const store = await import('../services/secrets-store.js')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const certs = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] }
function accessJwt(email: string) {
  return jwt.sign({ email }, privateKey, { algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS, expiresIn: 600 })
}

/**
 * Fake Cloudflare: two accounts the token can see. The FIRST holds a different
 * app (another site) with its own "Allowed people" policy — a trap: it must
 * never be read for writing or written. The second holds this install's app.
 */
const realFetch = globalThis.fetch
const cf = {
  calls: [] as Array<{ method: string; url: string; auth: string; body?: unknown }>,
  people: { id: 'pol-people', name: 'Allowed people', decision: 'allow', precedence: 1, include: [{ email: { email: 'alex.partner@example-capital.com' } }] as Array<Record<string, unknown>> },
  robot: { id: 'pol-robot', name: 'Install verify robot', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: 'svc' } }] },
  otherPeople: { id: 'pol-other', name: 'Allowed people', decision: 'allow', precedence: 1, include: [{ email: { email: 'someone@elsewhere.com' } }] },
}
function reply(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}
function fakeCloudflareFetch(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET'
  const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '')
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
  cf.calls.push({ method, url, auth, body })
  const p = url.replace('https://api.cloudflare.com/client/v4', '')
  if (auth === `Bearer ${WEAK_TOKEN}`) return reply(200, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] })
  if (auth !== `Bearer ${SETTINGS_TOKEN}` && auth !== `Bearer ${ENV_TOKEN}`) return reply(401, { success: false })
  if (method === 'GET' && p.startsWith('/accounts?')) return reply(200, { success: true, result: [{ id: OTHER_ACCOUNT }, { id: ACCOUNT }] })
  if (method === 'GET' && p === `/accounts/${OTHER_ACCOUNT}/access/apps`) return reply(200, { success: true, result: [{ id: 'app-other', aud: 'someone-elses-aud' }] })
  if (method === 'GET' && p === `/accounts/${ACCOUNT}/access/apps`) return reply(200, { success: true, result: [{ id: 'app-ours', aud: AUD }] })
  if (method === 'GET' && p === `/accounts/${ACCOUNT}/access/apps/app-ours/policies`) return reply(200, { success: true, result: [cf.people, cf.robot] })
  if (method === 'GET' && p === `/accounts/${OTHER_ACCOUNT}/access/apps/app-other/policies`) return reply(200, { success: true, result: [cf.otherPeople] })
  if (method === 'PUT' && p === `/accounts/${ACCOUNT}/access/apps/app-ours/policies/pol-people`) {
    Object.assign(cf.people, body)
    return reply(200, { success: true, result: cf.people })
  }
  return reply(500, { success: false, errors: [{ code: 1, message: `unexpected ${method} ${p}` }] })
}

let server: http.Server
let baseUrl: string
let adminCookie: string
let adminJwt: string
const logs: string[] = []

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run('admin', bcrypt.hashSync('correct-horse-battery', 4), 'admin', 'alex.partner@example-capital.com')

  // An EXISTING install: one login is on (team + AUD), but the installer never
  // recorded OK_CF_ACCOUNT_ID, and there is no env token.
  process.env.OK_CF_ACCESS_TEAM = TEAM
  process.env.OK_CF_ACCESS_AUD = AUD
  // The default install: a name-by-name list (ACCESS_ALLOWED_EMAILS), no domain rule.
  process.env.OK_CF_ACCESS_PROTECTED_EMAILS = 'alex.partner@example-capital.com'
  delete process.env.OK_CF_ACCESS_ALLOWED_DOMAIN
  delete process.env.OK_CF_ACCOUNT_ID
  delete process.env.OK_CF_ACCESS_API_TOKEN
  setCfAccessVerifierForTests(new CfAccessVerifier(cfAccessConfig()!, async () => ({ ok: true, status: 200, json: async () => certs })))
  setCfAccessPolicyClientForTests(undefined) // the REAL token path, not an injected client

  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith('https://api.cloudflare.com/')) return Promise.resolve(fakeCloudflareFetch(url, init))
    return realFetch(input, init)
  })

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  app.use('/api/admin/users', adminUsersRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`

  const res = await fetch(`${baseUrl}/api/auth/cloudflare-access`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': accessJwt('alex.partner@example-capital.com') } })
  expect(res.status).toBe(200)
  const m = (res.headers.get('set-cookie') || '').match(/(?:^|,\s*)token=([^;]+)/)
  adminJwt = m![1]!
  adminCookie = `token=${adminJwt}`

  for (const k of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
})

afterAll(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setCfAccessVerifierForTests(null)
  setCfAccessPolicyClientForTests(null)
  for (const k of ['OK_CF_ACCESS_TEAM', 'OK_CF_ACCESS_AUD', 'OK_CF_ACCESS_ALLOWED_DOMAIN', 'OK_CF_ACCESS_API_TOKEN']) delete process.env[k]
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
})

afterEach(() => clearCfAccessStatusCache())

const bodies: string[] = []
async function admin(method: string, p: string, body?: unknown, opts: { bearer?: boolean } = {}) {
  const res = await fetch(`${baseUrl}/api/admin/users${p}`, {
    method,
    headers: {
      ...(opts.bearer ? { Authorization: `Bearer ${adminJwt}` } : { cookie: adminCookie }),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  bodies.push(text)
  return { status: res.status, text, json: () => JSON.parse(text) }
}
async function statusOf(username: string) {
  const users = (await admin('GET', '')).json() as Array<{ username: string; cloudflare_access?: { status: string; detail: string } }>
  return users.find(u => u.username === username)?.cloudflare_access
}
const writes = () => cf.calls.filter(c => c.method !== 'GET')

describe('no token yet', () => {
  it('reports "not set up" and shows outside addresses as blocked (sync_not_configured), not an error', async () => {
    const state = await admin('GET', '/cloudflare-sync')
    expect(state.status).toBe(200)
    expect(state.json()).toEqual({ applies: true, configured: false, source: null, updated_at: null, health: null })

    const created = await admin('POST', '', { username: 'early', password: 'temp-password-123', email: 'early@outside.org' })
    expect(created.status).toBe(201)
    expect(await statusOf('early')).toEqual({ status: 'blocked', detail: 'sync_not_configured' })
    expect(cf.calls).toHaveLength(0)
  })
})

describe('saving the token in Settings', () => {
  it('only a web-UI (cookie) admin may set it; an API bearer call is refused', async () => {
    const res = await admin('PUT', '/cloudflare-sync', { token: SETTINGS_TOKEN }, { bearer: true })
    expect(res.status).toBe(403)
    expect(store.getSecret({ scopeType: 'global' }, CF_ACCESS_SYNC_TOKEN_KEY)).toBeNull()
  })

  it('rejects something that is not a token without echoing it back', async () => {
    const pasted = 'https://dash.cloudflare.com/oops my token'
    const res = await admin('PUT', '/cloudflare-sync', { token: pasted })
    expect(res.status).toBe(400)
    expect(res.text).not.toContain(pasted)
  })

  it('stores it encrypted + server-only, returns state not the value, and resolves the account from the token', async () => {
    const res = await admin('PUT', '/cloudflare-sync', { token: SETTINGS_TOKEN })
    expect(res.status).toBe(200)
    const state = res.json()
    expect(state).toMatchObject({ applies: true, configured: true, source: 'settings', health: 'ok' })
    expect(typeof state.updated_at).toBe('string')
    expect(res.text).not.toContain(SETTINGS_TOKEN)

    const row = getDb().prepare('SELECT value_encrypted, service_only FROM secrets WHERE key = ?').get(CF_ACCESS_SYNC_TOKEN_KEY) as { value_encrypted: string; service_only: number }
    expect(row.value_encrypted).not.toContain(SETTINGS_TOKEN)
    expect(row.service_only).toBe(1)

    // The account was found from the token (no OK_CF_ACCOUNT_ID on this install).
    expect(cf.calls.some(c => c.url.includes('/accounts?'))).toBe(true)
    expect(process.env.OK_CF_ACCOUNT_ID).toBeUndefined()
  })

  it('takes effect on the very next save, without a restart: an outside address is added, then removed on delete', async () => {
    cf.calls.length = 0
    const created = await admin('POST', '', { username: 'contractor', password: 'temp-password-123', email: 'Contractor@Outside.dev' })
    expect(created.status).toBe(201)
    expect(cf.people.include).toEqual([{ email: { email: 'alex.partner@example-capital.com' } }, { email: { email: 'contractor@outside.dev' } }])
    expect(await statusOf('contractor')).toEqual({ status: 'can_sign_in', detail: 'allowed_directly' })
    for (const c of cf.calls) expect(c.auth).toBe(`Bearer ${SETTINGS_TOKEN}`)

    const id = created.json().id as number
    expect((await admin('DELETE', `/${id}`)).status).toBe(200)
    expect(cf.people.include).toEqual([{ email: { email: 'alex.partner@example-capital.com' } }])
  })

  it('changing an email swaps the address in the policy', async () => {
    const created = await admin('POST', '', { username: 'adviser', password: 'temp-password-123', email: 'adviser@old-firm.com' })
    expect(cf.people.include).toContainEqual({ email: { email: 'adviser@old-firm.com' } })
    const id = created.json().id as number
    expect((await admin('PATCH', `/${id}`, { email: 'adviser@new-firm.com' })).status).toBe(200)
    const emails = cf.people.include.map(r => (r.email as { email?: string } | undefined)?.email).filter(Boolean)
    expect(emails).toEqual(['alex.partner@example-capital.com', 'adviser@new-firm.com'])
  })

  it('never wrote an email_domain rule: every write is one {email} entry at a time', () => {
    expect(writes().length).toBeGreaterThan(0)
    for (const w of writes()) {
      const inc = ((w.body as { include?: Array<Record<string, unknown>> } | undefined)?.include) ?? []
      expect(inc.some(r => 'email_domain' in r)).toBe(false)
    }
    expect(cf.people.include.some(r => 'email_domain' in r)).toBe(false)
  })

  it('never touched another app, its policy, or the verify robot', () => {
    for (const w of writes()) expect(w.url).toMatch(new RegExp(`/accounts/${ACCOUNT}/access/apps/app-ours/policies/pol-people$`))
    expect(cf.calls.some(c => c.url.includes('app-other/policies'))).toBe(false)
    expect(cf.otherPeople.include).toEqual([{ email: { email: 'someone@elsewhere.com' } }])
    expect(cf.robot.include).toEqual([{ service_token: { token_id: 'svc' } }])
  })

  it('a session never receives it: not in resolveSecrets, resolveSecretNames, or boot hydration', () => {
    expect(store.isServerOnlySecretKey(CF_ACCESS_SYNC_TOKEN_KEY)).toBe(true)
    expect(Object.keys(store.resolveSecrets({ includeServiceOnly: true }))).not.toContain(CF_ACCESS_SYNC_TOKEN_KEY)
    expect(store.resolveSecretNames()).not.toContain(CF_ACCESS_SYNC_TOKEN_KEY)
    store.hydrateProcessEnvFromSecretsStore()
    expect(process.env[CF_ACCESS_SYNC_TOKEN_KEY]).toBeUndefined()
    expect(Object.values(process.env)).not.toContain(SETTINGS_TOKEN)
  })
})

describe('a token without Access rights', () => {
  it('saves, but reports health "forbidden" as a note; user admin keeps working and nothing is written', async () => {
    const res = await admin('PUT', '/cloudflare-sync', { token: WEAK_TOKEN })
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ configured: true, source: 'settings', health: 'forbidden' })

    cf.calls.length = 0
    const created = await admin('POST', '', { username: 'blockedone', password: 'temp-password-123', email: 'blocked@outside.net' })
    expect(created.status).toBe(201)
    expect(await statusOf('blockedone')).toEqual({ status: 'blocked', detail: 'forbidden' })
    expect(writes()).toHaveLength(0)
  })
})

describe('removing the token / env fallback', () => {
  it('DELETE forgets it; with OK_CF_ACCESS_API_TOKEN set, that env token is used again', async () => {
    let res = await admin('DELETE', '/cloudflare-sync')
    expect(res.status).toBe(200)
    expect(res.json()).toMatchObject({ configured: false, source: null })
    expect(store.getSecret({ scopeType: 'global' }, CF_ACCESS_SYNC_TOKEN_KEY)).toBeNull()

    process.env.OK_CF_ACCESS_API_TOKEN = ENV_TOKEN
    resetCfAccessTokenCacheForTests()
    res = await admin('GET', '/cloudflare-sync')
    expect(res.json()).toMatchObject({ configured: true, source: 'env', health: 'ok' })
    expect(res.text).not.toContain(ENV_TOKEN)
    delete process.env.OK_CF_ACCESS_API_TOKEN
  })

  it('DELETE through an API bearer call is refused', async () => {
    expect((await admin('DELETE', '/cloudflare-sync', undefined, { bearer: true })).status).toBe(403)
  })
})

describe('no token value anywhere', () => {
  it('no response body and no log line ever carried any of the tokens', () => {
    const all = bodies.join('\n') + '\n' + logs.join('\n')
    for (const t of [SETTINGS_TOKEN, ENV_TOKEN, WEAK_TOKEN]) expect(all).not.toContain(t)
    expect(logs.some(l => l.includes('[cf-access-sync] sync token saved'))).toBe(true)
  })
})
