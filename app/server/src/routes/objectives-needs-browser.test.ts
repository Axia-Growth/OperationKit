/**
 * obj 901075 — there is no per-card browser switch any more: every worker gets
 * the locked-down browser (see services/card-browser-spawn.test.ts). Over the
 * REAL routes and a real temp DB, `needs_browser` is now inert: never stored,
 * never serialised, never a 400 or 403.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-needs-browser-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-needs-browser-xxxx'

const { initDb, getDb } = await import('../db/index.js')
const { seedLegacyWorkspaces } = await import('../__fixtures__/legacy-workspaces.js')
const { agentKeyGuard } = await import('../middleware/agent-key-guard.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')

const ADMIN_ID = 1
let server: http.Server
let baseUrl: string
const cookie = () => `token=${jwt.sign({ id: ADMIN_ID, username: 'admin', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

async function call(method: string, p: string, body?: unknown, internal = false) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!internal) headers.Cookie = cookie()
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text()
  let json: any = null // eslint-disable-line @typescript-eslint/no-explicit-any
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}
const stored = (id: number) => (getDb().prepare('SELECT needs_browser FROM objectives WHERE id = ?').get(id) as { needs_browser: number }).needs_browser

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  await seedLegacyWorkspaces(getDb())
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'admin', 'x', 'admin')`).run(ADMIN_ID)
  getDb().prepare(`INSERT INTO settings (key, value) VALUES ('duplicate_guard_enabled', '0') ON CONFLICT(key) DO UPDATE SET value = '0'`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use(agentKeyGuard)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalRouter)
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()) })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  try { getDb().close() } catch { /* ignore */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('POST/PUT /api/objectives: needs_browser is ignored', () => {
  it('create with needs_browser true/false/garbage = 201 and nothing stored or echoed', async () => {
    for (const v of [true, false, 'yes', 1]) {
      const r = await call('POST', '/api/objectives', { title: `nb ignored ${String(v)}`, workspace: 'example', needs_browser: v })
      expect(r.status).toBe(201)
      expect(stored(r.json.id)).toBe(0)
      expect(r.json).not.toHaveProperty('needs_browser')
      const got = await call('GET', `/api/objectives/${r.json.id}`)
      expect(got.json).not.toHaveProperty('needs_browser')
    }
  })

  it('update with needs_browser is a 200 no-op', async () => {
    const r = await call('POST', '/api/objectives', { title: 'nb update', workspace: 'example' })
    const id = r.json.id
    expect((await call('PUT', `/api/objectives/${id}`, { needs_browser: true })).status).toBe(200)
    expect(stored(id)).toBe(0)
    expect((await call('PUT', `/api/objectives/${id}`, { needs_browser: 'yes' })).status).toBe(200)
    expect(stored(id)).toBe(0)
  })
})

describe('POST /api/internal/objectives: needs_browser accepted for old callers, then ignored', () => {
  it('201, never a 400 for an "unsupported field", never stored', async () => {
    const r = await call('POST', '/api/internal/objectives', [
      { title: 'nb internal on', needs_browser: true },
      { title: 'nb internal garbage', needs_browser: 'true' },
      { title: 'nb internal none' },
    ], true)
    expect(r.status).toBe(201)
    for (const o of r.json.objectives as Array<{ id: number }>) expect(stored(o.id)).toBe(0)
  })
})
