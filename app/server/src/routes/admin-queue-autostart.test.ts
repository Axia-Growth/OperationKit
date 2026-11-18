import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901375 — the per-workspace job time limit (minutes) field on Settings →
// Platform → Queue auto-start. Mounts ONLY the admin-queue-autostart router (not
// objectives.js / session-manager), so this suite never touches node-pty.
const TMP_DB = path.join(os.tmpdir(), `cc-queue-autostart-time-limit-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-queue-autostart-time-limit'

// This suite never spawns a pty; stub it out so the module graph doesn't need
// the native build (unavailable in some sandboxes without a C toolchain).
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty not available in this test') } }))

const { initDb, getDb } = await import('../db/index.js')
const { default: adminQueueAutostartRouter } = await import('./admin-queue-autostart.js')
const { requireAuth, requireAdmin } = await import('../middleware/auth.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')

const ADMIN_ID = 1
const MEMBER_ID = 2
const WS = 'ws-time-limit'

let server: http.Server
let baseUrl: string

function token(role: 'admin' | 'member'): string {
  const id = role === 'admin' ? ADMIN_ID : MEMBER_ID
  return jwt.sign({ id, username: role, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, url: string, opts: { role?: 'admin' | 'member'; body?: unknown } = {}) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token(opts.role ?? 'admin')}` },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(ADMIN_ID, 'admin', 'admin')
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(MEMBER_ID, 'member', 'member')
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(WS, WS)
  invalidateWorkspacesCache()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', requireAuth, requireAdmin, adminQueueAutostartRouter)
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

beforeEach(() => {
  const db = getDb()
  db.prepare("DELETE FROM settings WHERE key LIKE 'job_wallclock_ceiling_ms%'").run()
  db.prepare('DELETE FROM activity_log').run()
})

describe('GET /api/admin/queue-autostart time_limits', () => {
  it('reports none when nothing is configured, workspace when set, global as fallback', async () => {
    const none = await call('GET', '/api/admin/queue-autostart')
    expect(none.status).toBe(200)
    expect(none.json.time_limits[WS]).toEqual({ minutes: null, source: 'none' })

    getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('job_wallclock_ceiling_ms', '3600000')
    const global = await call('GET', '/api/admin/queue-autostart')
    expect(global.json.time_limits[WS]).toEqual({ minutes: 60, source: 'global' })

    getDb().prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(`job_wallclock_ceiling_ms:${WS}`, '1800000')
    const ws = await call('GET', '/api/admin/queue-autostart')
    expect(ws.json.time_limits[WS]).toEqual({ minutes: 30, source: 'workspace' })
  })
})

describe('PUT /api/admin/queue-autostart/:workspace/time-limit', () => {
  it('admin saves a value in minutes; it reads back as the workspace-level ms setting', async () => {
    const res = await call('PUT', `/api/admin/queue-autostart/${WS}/time-limit`, { body: { minutes: 30 } })
    expect(res.status).toBe(200)
    expect(res.json.time_limits[WS]).toEqual({ minutes: 30, source: 'workspace' })
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`job_wallclock_ceiling_ms:${WS}`) as { value: string }
    expect(row.value).toBe('1800000')
    const log = getDb().prepare("SELECT title, detail FROM activity_log WHERE event_type = 'decision'").all()
    expect(log).toEqual([expect.objectContaining({ title: 'job_time_limit_updated' })])
  })

  it('clearing with minutes: null removes the workspace row (falls back to global/none)', async () => {
    await call('PUT', `/api/admin/queue-autostart/${WS}/time-limit`, { body: { minutes: 30 } })
    const cleared = await call('PUT', `/api/admin/queue-autostart/${WS}/time-limit`, { body: { minutes: null } })
    expect(cleared.status).toBe(200)
    expect(cleared.json.time_limits[WS]).toEqual({ minutes: null, source: 'none' })
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`job_wallclock_ceiling_ms:${WS}`)
    expect(row).toBeUndefined()
  })

  it('never writes 0 and rejects bad input with a 400', async () => {
    for (const bad of [0, -5, 1.5, 24 * 60 + 1, 'thirty', true]) {
      const res = await call('PUT', `/api/admin/queue-autostart/${WS}/time-limit`, { body: { minutes: bad } })
      expect(res.status).toBe(400)
    }
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(`job_wallclock_ceiling_ms:${WS}`)
    expect(row).toBeUndefined()
  })

  it('refuses a non-admin and an unknown workspace', async () => {
    const member = await call('PUT', `/api/admin/queue-autostart/${WS}/time-limit`, { role: 'member', body: { minutes: 30 } })
    expect(member.status).toBe(403)
    const unknown = await call('PUT', '/api/admin/queue-autostart/no-such-ws/time-limit', { body: { minutes: 30 } })
    expect(unknown.status).toBe(404)
  })
})
