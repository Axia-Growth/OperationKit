import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 900909 — the card spend panel API: GET /api/objectives/:id/spend shows the
// ceiling (explicit or per-effort default), spend and projection; PUT changes the
// card's own ceiling / degrade choice, cookie owner or admin only.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-spend-route-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-spend-route'
process.env.TRANSCRIPT_DIR = TMP
delete process.env.OBJECTIVE_CEILING_HIGH_USD

// Nothing here opens a terminal; keep the native module out of the import graph.
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

const { getDb, initDb } = await import('../db/index.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { issueApiKey } = await import('../lib/api-keys.js')

const ADMIN = 1
const MEMBER = 2
const OTHER = 3
let server: http.Server
let baseUrl: string
let card: number
let foreign: number
let memberKey: string

const cookieFor = (id: number, username: string, role: string) =>
  `token=${jwt.sign({ id, username, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(p: string, auth: Record<string, string>, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/objectives${p}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers || {}) },
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'member', 'x', 'member')`).run(MEMBER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'other', 'x', 'member')`).run(OTHER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ws-a', 'member', 'all')`).run(MEMBER)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ws-a', 'member', 'all')`).run(OTHER)
  card = Number(db.prepare(
    "INSERT INTO objectives (title, workspace, created_by, status, effort, session_id) VALUES ('spend card', 'ws-a', ?, 'working', 'high', 'cc-spend-route-1')",
  ).run(MEMBER).lastInsertRowid)
  foreign = Number(db.prepare(
    "INSERT INTO objectives (title, workspace, created_by, status, effort) VALUES ('foreign', 'ws-b', ?, 'queue', 'normal')",
  ).run(ADMIN).lastInsertRowid)
  fs.writeFileSync(
    path.join(TMP, 'cc-spend-route-1.jsonl'),
    JSON.stringify({ type: 'result', usage: { input_tokens: 1 }, total_cost_usd: 12.5 }) + '\n',
  )
  memberKey = issueApiKey(MEMBER).token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('GET /api/objectives/:id/spend', () => {
  it('shows the per-effort default ceiling and measured spend', async () => {
    const r = await call(`/${card}/spend`, { Cookie: cookieFor(MEMBER, 'member', 'member') })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({
      objective_id: card,
      ceiling_usd: 150,
      ceiling_source: 'default:high',
      ceiling_is_default: true,
      spent_usd: 12.5,
      stage: 'none',
      projection_guard_enabled: true,
      spawn_guard_enabled: true,
      degrade_allowed: true,
      over_ceiling: false,
    })
  })

  it('an agent key with the workspace can read it; a foreign card is a 404', async () => {
    expect((await call(`/${card}/spend`, { Authorization: `Bearer ${memberKey}` })).status).toBe(200)
    expect((await call(`/${foreign}/spend`, { Cookie: cookieFor(MEMBER, 'member', 'member') })).status).toBe(404)
  })
})

describe('PUT /api/objectives/:id/spend', () => {
  it('the card owner signed in to the web app can set the ceiling and the degrade choice', async () => {
    const r = await call(`/${card}/spend`, { Cookie: cookieFor(MEMBER, 'member', 'member') }, {
      method: 'PUT', body: JSON.stringify({ cost_usd: 40, degrade_allowed: false }),
    })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ceiling_usd: 40, ceiling_source: 'objective', ceiling_is_default: false, degrade_allowed: false })
    const act = getDb().prepare("SELECT detail FROM activity_log WHERE objective_id = ? AND metadata LIKE '%spend_guard_ceiling_set%'").get(card) as { detail: string }
    expect(act.detail).toBe('member: cost ceiling set to $40.00; cheaper-tier fallback not allowed.')
  })

  it('an agent key, another member, and bad input are refused', async () => {
    expect((await call(`/${card}/spend`, { Authorization: `Bearer ${memberKey}` }, { method: 'PUT', body: JSON.stringify({ cost_usd: 999 }) })).status).toBe(403)
    // A member who does not own the card cannot even see it here (404), let alone change it.
    expect([403, 404]).toContain((await call(`/${card}/spend`, { Cookie: cookieFor(OTHER, 'other', 'member') }, { method: 'PUT', body: JSON.stringify({ cost_usd: 999 }) })).status)
    const owner = { Cookie: cookieFor(MEMBER, 'member', 'member') }
    for (const body of [{ cost_usd: 0 }, { cost_usd: -1 }, { cost_usd: 'lots' }, { cost_usd: 1e9 }, { degrade_allowed: 'yes' }, {}, { ceiling: 5 }]) {
      expect((await call(`/${card}/spend`, owner, { method: 'PUT', body: JSON.stringify(body) })).status).toBe(400)
    }
    // Nothing above changed the ceiling.
    expect((await call(`/${card}/spend`, owner)).json.ceiling_usd).toBe(40)
  })

  it('an admin can set any card\'s ceiling', async () => {
    const r = await call(`/${foreign}/spend`, { Cookie: cookieFor(ADMIN, 'admin', 'admin') }, { method: 'PUT', body: JSON.stringify({ cost_usd: '25.555' }) })
    expect(r.status).toBe(200)
    expect(r.json.ceiling_usd).toBe(25.56)
  })
})
