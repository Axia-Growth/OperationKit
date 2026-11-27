/**
 * obj 901771 — /api/production-intake routes.
 *
 *  - POST /signal needs a live intake token (header, bearer or ?token=); the
 *    workspace and project come from the token, never the body.
 *  - UptimeRobot's form-encoded body works.
 *  - POST /report: a signed-in member of the workspace; not an outsider.
 *  - Sources: created / revoked only by an admin in the browser (cookie). An
 *    admin bearer JWT and a member are refused. The token is shown once.
 *  - GET /signals/:id: another workspace's signal reads as not found.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-production-intake-routes'
const TMP_DB = path.join(os.tmpdir(), `cc-production-intake-routes-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// The auto-start PATCH must never reach a real server from a test.
process.env.PORT = '1'

const { initDb, getDb } = await import('../db/index.js')
const { createWorkspace } = await import('../services/workspaces.js')
const { default: router } = await import('./production-intake.js')

const ADMIN = 1
const MEMBER = 2
const OUTSIDER = 3
const WS = 'acme'
const OTHER = 'globex'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''

const jwtFor = (id: number, role: string) => jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(
  method: string,
  p: string,
  opts: { cookieAs?: [number, string]; bearer?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  let body: string | undefined
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(opts.form).toString()
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  if (opts.cookieAs) headers.Cookie = `token=${jwtFor(opts.cookieAs[0], opts.cookieAs[1])}`
  const res = await fetch(`${baseUrl}/api/production-intake${p}`, { method, headers, body })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

async function newSource(body: Record<string, unknown> = { workspace: WS, name: 'Sentry - shop', project: 'storefront' }) {
  const r = await call('POST', '/sources', { cookieAs: [ADMIN, 'admin'], body })
  expect(r.status).toBe(201)
  return r.json as { source: { id: number; workspace: string }; token: string }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(MEMBER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(OUTSIDER)
  createWorkspace({ slug: WS, name: 'Acme', default_agent_pool: ['general'] })
  createWorkspace({ slug: OTHER, name: 'Globex', default_agent_pool: ['general'] })
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')").run(MEMBER, WS)
  db.prepare("INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')").run(OUTSIDER, OTHER)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/production-intake', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server?.close()
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(`${TMP_DB}${s}`) } catch { /* gone */ }
  }
})

beforeEach(() => {
  getDb().exec("DELETE FROM production_signals; DELETE FROM production_intake_sources; DELETE FROM objectives WHERE origin = 'production-issue'")
})

describe('POST /signal', () => {
  it('401 without a token, with an unknown token, and with a revoked one', async () => {
    expect((await call('POST', '/signal', { body: { title: 'x' } })).status).toBe(401)
    expect((await call('POST', '/signal', { body: { title: 'x' }, headers: { 'X-Intake-Token': 'opi_nope' } })).status).toBe(401)
    const { source, token } = await newSource()
    expect((await call('DELETE', `/sources/${source.id}`, { cookieAs: [ADMIN, 'admin'] })).status).toBe(200)
    expect((await call('POST', '/signal', { body: { title: 'x' }, headers: { 'X-Intake-Token': token } })).status).toBe(401)
  })

  it('files a card in the TOKEN workspace and project, whatever the body says', async () => {
    const { token } = await newSource()
    const r = await call('POST', '/signal', {
      headers: { 'X-Intake-Token': token },
      body: { title: 'Checkout 500', workspace: OTHER, project: 'evil', severity: 'critical' },
    })
    expect(r.status).toBe(201)
    expect(r.json).toMatchObject({ ok: true, outcome: 'filed' })
    const c = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(r.json.objective_id) as Loose
    expect(c).toMatchObject({ workspace: WS, project: 'storefront', origin: 'production-issue', type: 'bug', create_pr: 1, status: 'queue' })
    expect(String(c.description)).toContain('from "Sentry - shop"')
  })

  it('accepts the token as a bearer and as ?token=, and UptimeRobot form bodies', async () => {
    const { token } = await newSource()
    const bearer = await call('POST', '/signal', { bearer: token, body: { title: 'API slow', fingerprint: 'slow' } })
    expect(bearer.status).toBe(201)
    const repeat = await call('POST', `/signal?token=${encodeURIComponent(token)}`, { body: { title: 'API slow', fingerprint: 'slow' } })
    expect(repeat.status).toBe(200)
    expect(repeat.json).toMatchObject({ outcome: 'appended', objective_id: bearer.json.objective_id })
    const ur = await call('POST', `/signal?token=${encodeURIComponent(token)}`, {
      form: { monitorID: '42', monitorFriendlyName: 'Shop', monitorURL: 'https://shop.example.com', alertType: '1', alertTypeFriendlyName: 'Down', alertDetails: 'HTTP 503' },
    })
    expect(ur.status).toBe(201)
    const sig = getDb().prepare('SELECT vendor, severity FROM production_signals WHERE id = ?').get(ur.json.signal_id) as Loose
    expect(sig).toMatchObject({ vendor: 'uptimerobot', severity: 'critical' })
  })

  it('400 on a body with nothing to file', async () => {
    const { token } = await newSource()
    const r = await call('POST', '/signal', { headers: { 'X-Intake-Token': token }, body: { foo: 'bar' } })
    expect(r.status).toBe(400)
    expect(r.json.error).toMatch(/title/)
  })
})

describe('POST /report (pasted)', () => {
  it('a member of the workspace files a card; an outsider is refused', async () => {
    const ok = await call('POST', '/report', { cookieAs: [MEMBER, 'member'], body: { workspace: WS, text: 'Orders page is blank\nError: chunk failed', environment: 'production' } })
    expect(ok.status).toBe(201)
    const c = getDb().prepare('SELECT created_by, title FROM objectives WHERE id = ?').get(ok.json.objective_id) as Loose
    expect(c.created_by).toBe(MEMBER)
    expect(c.title).toBe('Production issue: Orders page is blank')
    const no = await call('POST', '/report', { cookieAs: [OUTSIDER, 'member'], body: { workspace: WS, text: 'x' } })
    expect(no.status).toBe(403)
    expect((await call('POST', '/report', { body: { workspace: WS, text: 'x' } })).status).toBe(401)
    expect((await call('POST', '/report', { cookieAs: [ADMIN, 'admin'], body: { workspace: 'nope', text: 'x' } })).status).toBe(400)
  })
})

describe('sources: admin in the browser only', () => {
  it('refuses a member, and an admin using a bearer JWT', async () => {
    const body = { workspace: WS, name: 'x' }
    expect((await call('POST', '/sources', { cookieAs: [MEMBER, 'member'], body })).status).toBe(403)
    expect((await call('POST', '/sources', { bearer: jwtFor(ADMIN, 'admin'), body })).status).toBe(403)
    const { source } = await newSource()
    expect((await call('DELETE', `/sources/${source.id}`, { bearer: jwtFor(ADMIN, 'admin') })).status).toBe(403)
    expect((await call('GET', '/sources', { cookieAs: [MEMBER, 'member'] })).status).toBe(403)
  })

  it('shows the token once; the list never carries it', async () => {
    const { token } = await newSource()
    expect(token).toMatch(/^opi_/)
    const list = await call('GET', '/sources', { cookieAs: [ADMIN, 'admin'] })
    expect(list.status).toBe(200)
    expect(list.json.sources).toHaveLength(1)
    expect(JSON.stringify(list.json)).not.toContain(token)
    expect(list.json.sources[0].token_hash).toBeUndefined()
  })

  it('validates workspace, name and project', async () => {
    const admin: [number, string] = [ADMIN, 'admin']
    expect((await call('POST', '/sources', { cookieAs: admin, body: { workspace: 'nope', name: 'x' } })).status).toBe(400)
    expect((await call('POST', '/sources', { cookieAs: admin, body: { workspace: WS } })).status).toBe(400)
    expect((await call('POST', '/sources', { cookieAs: admin, body: { workspace: WS, name: 'x', project: '../etc' } })).status).toBe(400)
  })
})

describe('reading signals', () => {
  it('a member reads their workspace; another workspace is not found', async () => {
    const { token } = await newSource()
    const r = await call('POST', '/signal', { headers: { 'X-Intake-Token': token }, body: { title: 'Boom', message: 'stack here' } })
    const mine = await call('GET', `/signals/${r.json.signal_id}`, { cookieAs: [MEMBER, 'member'] })
    expect(mine.status).toBe(200)
    expect(mine.json.signal.evidence.message).toBe('stack here')
    expect((await call('GET', `/signals/${r.json.signal_id}`, { cookieAs: [OUTSIDER, 'member'] })).status).toBe(404)
    const list = await call('GET', '/signals', { cookieAs: [OUTSIDER, 'member'] })
    expect(list.json.signals).toEqual([])
    expect((await call('GET', `/signals?workspace=${WS}`, { cookieAs: [OUTSIDER, 'member'] })).status).toBe(403)
    const adminList = await call('GET', '/signals', { cookieAs: [ADMIN, 'admin'] })
    expect(adminList.json.signals).toHaveLength(1)
  })
})
