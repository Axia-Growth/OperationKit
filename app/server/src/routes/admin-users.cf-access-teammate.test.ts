/**
 * obj 900023 — "Add your team from the UI", end to end through the real routes.
 *
 * The install default is a name-by-name list (ACCESS_ALLOWED_EMAILS). With the
 * Cloudflare sign-in sync token, adding a teammate in Settings → Users adds
 * exactly that ONE {email} entry to the install's "Allowed people" policy, and
 * deleting them removes it. The app never writes an email_domain rule.
 *
 * Most of this file runs on an install that ALREADY set the optional, older
 * ACCESS_ALLOWED_EMAIL_DOMAIN, to prove that keeps working (read-only). Cloudflare
 * is a fake here; nothing reaches a real account.
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

const TMP_DB = path.join(os.tmpdir(), `cc-admin-users-teammate-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-admin-users-teammate'

const TEAM = 'acme.cloudflareaccess.com'
const AUD = 'aud-tag-teammate-test'
const ISS = `https://${TEAM}`
const ACCOUNT = 'abc123def4567890abc123def4567890'
const FAKE_TOKEN = ['fake', 'access', 'edit', 'credential', 'xyz'].join('-')

const { initDb, getDb } = await import('../db/index.js')
const { default: authRouter } = await import('./auth.js')
const { default: adminUsersRouter } = await import('./admin-users.js')
const { CfAccessVerifier, cfAccessConfig, setCfAccessVerifierForTests } = await import('../lib/cf-access.js')
const { CfAccessPolicyClient, DEFAULT_POLICY_NAME } = await import('../lib/cf-access-policy.js')
const { setCfAccessPolicyClientForTests, clearCfAccessStatusCache } = await import('../services/cf-access-user-sync.js')

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const certs = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' }] }

/** A Cloudflare Access assertion for `email`, as the Cloudflare door would send it. */
function accessJwt(email: string) {
  return jwt.sign({ email }, privateKey, { algorithm: 'RS256', keyid: 'k1', audience: [AUD], issuer: ISS, expiresIn: 600 })
}

/** Fake Cloudflare policy API: one app, an "Allowed people" policy and the verify robot. */
function fakeCloudflare(include: Array<Record<string, unknown>>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = []
  const people: Record<string, unknown> = { id: 'pol-people', name: DEFAULT_POLICY_NAME, decision: 'allow', precedence: 1, include }
  const robot = { id: 'pol-robot', name: 'Install verify robot', decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: 'svc' } }] }
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    if (method === 'GET' && url.endsWith('/policies')) return { ok: true, status: 200, json: async () => ({ success: true, result: [people, robot] }) }
    if (method === 'PUT' && url.includes('/policies/pol-people')) { Object.assign(people, body); return { ok: true, status: 200, json: async () => ({ success: true, result: people }) } }
    if (method === 'PUT') return { ok: false, status: 500, json: async () => ({ success: false }) }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: 'app-1', aud: AUD }] }) }
  }
  const client = new CfAccessPolicyClient({
    accountId: ACCOUNT, apiToken: FAKE_TOKEN, aud: AUD, appId: 'app-1', policyName: DEFAULT_POLICY_NAME, protectedEmails: [],
  }, fetchImpl as never)
  return { calls, people, robot, client }
}

let server: http.Server
let baseUrl: string
let adminCookie: string
const logs: string[] = []

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare('INSERT INTO users (username, password_hash, role, email) VALUES (?, ?, ?, ?)')
    .run('admin', bcrypt.hashSync('correct-horse-battery', 4), 'admin', 'alex.partner@example-capital.com')

  // What install/cloudflare.sh records for an install that set the optional domain.
  process.env.OK_CF_ACCESS_TEAM = TEAM
  process.env.OK_CF_ACCESS_AUD = AUD
  process.env.OK_CF_ACCESS_ALLOWED_DOMAIN = 'example-capital.com'
  setCfAccessVerifierForTests(new CfAccessVerifier(cfAccessConfig()!, async () => ({ ok: true, status: 200, json: async () => certs })))

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/auth', authRouter)
  app.use('/api/admin/users', adminUsersRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`

  const res = await cfSignIn('alex.partner@example-capital.com')
  expect(res.status).toBe(200)
  adminCookie = cookieOf(res)!

  for (const m of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')) })
  }
})

afterAll(async () => {
  vi.restoreAllMocks()
  setCfAccessVerifierForTests(null)
  setCfAccessPolicyClientForTests(null)
  for (const k of ['OK_CF_ACCESS_TEAM', 'OK_CF_ACCESS_AUD', 'OK_CF_ACCESS_ALLOWED_DOMAIN']) delete process.env[k]
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(`${TMP_DB}${s}`)) fs.unlinkSync(`${TMP_DB}${s}`)
})

afterEach(() => { setCfAccessPolicyClientForTests(null); clearCfAccessStatusCache() })

function cfSignIn(email: string) {
  return fetch(`${baseUrl}/api/auth/cloudflare-access`, { method: 'POST', headers: { 'Cf-Access-Jwt-Assertion': accessJwt(email) } })
}
function cookieOf(res: Response): string | null {
  const m = (res.headers.get('set-cookie') || '').match(/(?:^|,\s*)token=([^;]+)/)
  return m && m[1] ? `token=${m[1]}` : null
}
function admin(method: string, p: string, body?: unknown) {
  return fetch(`${baseUrl}/api/admin/users${p}`, {
    method,
    headers: { cookie: adminCookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
}
async function statusOf(username: string) {
  const res = await admin('GET', '')
  expect(res.status).toBe(200)
  const text = await res.text()
  const users = JSON.parse(text) as Array<{ username: string; cloudflare_access?: { status: string; detail: string } }>
  return { access: users.find(u => u.username === username)?.cloudflare_access, text }
}

describe('an install that already set the optional domain rule, no token on the server', () => {
  it('an admin adds a teammate in Settings → Users and they can sign in with no other step', async () => {
    setCfAccessPolicyClientForTests(null) // no Cloudflare token at all

    // Before: they pass the Cloudflare door (domain rule) but the app has no account.
    const before = await cfSignIn('new.hire@example-capital.com')
    expect(before.status).toBe(403)
    expect((await before.json()).code).toBe('no_account')

    // The one step: the admin adds them.
    const created = await admin('POST', '', { username: 'newhire', password: 'temp-password-123', role: 'member', email: 'New.Hire@example-capital.com' })
    expect(created.status).toBe(201)

    // The Users tab says so…
    expect((await statusOf('newhire')).access).toEqual({ status: 'can_sign_in', detail: 'allowed_by_domain' })

    // …and it is true: their Cloudflare identity now opens the app as them.
    const after = await cfSignIn('new.hire@example-capital.com')
    expect(after.status).toBe(200)
    expect((await after.json()).user.username).toBe('newhire')
  })

  it('an outside address shows "blocked at Cloudflare" with a reason, not an error', async () => {
    setCfAccessPolicyClientForTests(null)
    const created = await admin('POST', '', { username: 'adviser', password: 'temp-password-123', email: 'adviser@other-firm.com' })
    expect(created.status).toBe(201)
    expect((await statusOf('adviser')).access).toEqual({ status: 'blocked', detail: 'sync_not_configured' })
  })

  it('deleting the user shuts them out again', async () => {
    const list = await (await admin('GET', '')).json() as Array<{ id: number; username: string }>
    const id = list.find(u => u.username === 'newhire')!.id
    expect((await admin('DELETE', `/${id}`)).status).toBe(200)
    const res = await cfSignIn('new.hire@example-capital.com')
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('no_account')
  })
})

describe('the email-list default: sync token on the server, no domain rule', () => {
  it('adding a teammate adds exactly their one {email} entry, and the app never writes an email_domain rule', async () => {
    const savedDomain = process.env.OK_CF_ACCESS_ALLOWED_DOMAIN
    delete process.env.OK_CF_ACCESS_ALLOWED_DOMAIN
    try {
      const alex = { email: { email: 'alex.partner@example-capital.com' } }
      const cf = fakeCloudflare([alex])
      setCfAccessPolicyClientForTests(cf.client)

      const created = await admin('POST', '', { username: 'listmate', password: 'temp-password-123', email: 'List.Mate@Example-Capital.com' })
      expect(created.status).toBe(201)
      expect(cf.people.include).toEqual([alex, { email: { email: 'list.mate@example-capital.com' } }])
      expect((await statusOf('listmate')).access).toEqual({ status: 'can_sign_in', detail: 'allowed_directly' })

      const id = (await created.json()).id as number
      expect((await admin('DELETE', `/${id}`)).status).toBe(200)
      expect(cf.people.include).toEqual([alex])

      const writes = cf.calls.filter(c => c.method !== 'GET')
      expect(writes.length).toBeGreaterThan(0)
      for (const w of writes) {
        const inc = ((w.body as { include?: Array<Record<string, unknown>> } | undefined)?.include) ?? []
        expect(inc.some(r => 'email_domain' in r)).toBe(false)
      }
    } finally {
      process.env.OK_CF_ACCESS_ALLOWED_DOMAIN = savedDomain
    }
  })
})

describe('sync token on an install that set the optional domain rule', () => {
  it('creating an out-of-domain user adds exactly that email to "Allowed people"; deleting removes it', async () => {
    const cf = fakeCloudflare([{ email_domain: { domain: 'example-capital.com' } }])
    setCfAccessPolicyClientForTests(cf.client)

    const created = await admin('POST', '', { username: 'partner', password: 'temp-password-123', email: 'partner@outside.org' })
    expect(created.status).toBe(201)
    expect(cf.people.include).toEqual([{ email_domain: { domain: 'example-capital.com' } }, { email: { email: 'partner@outside.org' } }])
    expect((await statusOf('partner')).access).toEqual({ status: 'can_sign_in', detail: 'allowed_directly' })

    const id = (await created.json()).id as number
    expect((await admin('DELETE', `/${id}`)).status).toBe(200)
    expect(cf.people.include).toEqual([{ email_domain: { domain: 'example-capital.com' } }])

    // Only the people policy was ever written — never the verify robot, never another app.
    const writes = cf.calls.filter(c => c.method !== 'GET')
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.url).toMatch(/\/access\/apps\/app-1\/policies\/pol-people$/)
    expect(cf.robot.include).toEqual([{ service_token: { token_id: 'svc' } }])
  })

  it('a company-domain user causes no Cloudflare write at all (the domain rule already covers them)', async () => {
    const cf = fakeCloudflare([{ email_domain: { domain: 'example-capital.com' } }])
    setCfAccessPolicyClientForTests(cf.client)
    const created = await admin('POST', '', { username: 'colleague', password: 'temp-password-123', email: 'colleague@example-capital.com' })
    expect(created.status).toBe(201)
    expect(cf.calls.filter(c => c.method !== 'GET')).toHaveLength(0)
  })

  it('the token value never appears in a response body or a log line', async () => {
    const cf = fakeCloudflare([])
    setCfAccessPolicyClientForTests(cf.client)
    const created = await admin('POST', '', { username: 'tokencheck', password: 'temp-password-123', email: 'tc@outside.org' })
    expect(await created.text()).not.toContain(FAKE_TOKEN)
    expect((await statusOf('tokencheck')).text).not.toContain(FAKE_TOKEN)
    expect(logs.join('\n')).not.toContain(FAKE_TOKEN)
  })
})
