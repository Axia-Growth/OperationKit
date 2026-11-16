/**
 * obj 901029 — `needs_browser` on cards, over the REAL routes and a real temp DB:
 * persisted on create/update and on the internal bulk create, defaulted off,
 * serialised as a boolean, and a non-boolean is a 400 (never a silent drop).
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

describe('POST/PUT /api/objectives', () => {
  it('defaults to off (every existing card keeps no browser)', async () => {
    const r = await call('POST', '/api/objectives', { title: 'nb default', workspace: 'example' })
    expect(r.status).toBe(201)
    expect(stored(r.json.id)).toBe(0)
    expect(r.json.needs_browser === undefined || r.json.needs_browser === false).toBe(true)
  })

  it('persists needs_browser:true on create and serialises a boolean', async () => {
    const r = await call('POST', '/api/objectives', { title: 'nb create on', workspace: 'example', needs_browser: true })
    expect(r.status).toBe(201)
    expect(stored(r.json.id)).toBe(1)
    const got = await call('GET', `/api/objectives/${r.json.id}`)
    expect(got.json.needs_browser).toBe(true)
  })

  it('turns it on and off on update; an update that omits it leaves it alone', async () => {
    const r = await call('POST', '/api/objectives', { title: 'nb update', workspace: 'example' })
    const id = r.json.id
    expect((await call('PUT', `/api/objectives/${id}`, { needs_browser: true })).status).toBe(200)
    expect(stored(id)).toBe(1)
    expect((await call('PUT', `/api/objectives/${id}`, { title: 'nb update renamed' })).status).toBe(200)
    expect(stored(id)).toBe(1)
    expect((await call('PUT', `/api/objectives/${id}`, { needs_browser: false })).status).toBe(200)
    expect(stored(id)).toBe(0)
  })

  it('rejects a non-boolean with 400 on create and update', async () => {
    expect((await call('POST', '/api/objectives', { title: 'nb bad', workspace: 'example', needs_browser: 'yes' })).status).toBe(400)
    const r = await call('POST', '/api/objectives', { title: 'nb bad update', workspace: 'example' })
    expect((await call('PUT', `/api/objectives/${r.json.id}`, { needs_browser: 'yes' })).status).toBe(400)
    expect(stored(r.json.id)).toBe(0)
  })
})

describe('POST /api/internal/objectives (sessions / delegators)', () => {
  it('accepts and persists needs_browser per item', async () => {
    const r = await call('POST', '/api/internal/objectives', [
      { title: 'nb internal on', needs_browser: true },
      { title: 'nb internal off' },
    ], true)
    expect(r.status).toBe(201)
    const ids = (r.json.objectives as Array<{ id: number }>).map((o) => o.id)
    expect(stored(ids[0])).toBe(1)
    expect(stored(ids[1])).toBe(0)
  })

  it('400s a non-boolean instead of dropping it', async () => {
    const r = await call('POST', '/api/internal/objectives', [{ title: 'nb internal bad', needs_browser: 'true' }], true)
    expect(r.status).toBe(400)
    expect(String(r.json.error)).toMatch(/needs_browser must be a boolean/)
  })
})
