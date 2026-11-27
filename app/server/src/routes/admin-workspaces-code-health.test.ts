// Code-health Job routes (obj 901770): a repo's Job is off by default, only an
// admin in the browser (cookie) can switch it on, and an unlinked repo refuses.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

const TMP_DB = path.join(os.tmpdir(), `cc-code-health-route-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-code-health'

const { initDb, getDb } = await import('../db/index.js')
const { default: adminWorkspacesRouter } = await import('./admin-workspaces.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')

let server: http.Server
let baseUrl: string
const tok = (role: 'admin' | 'member') =>
  jwt.sign({ id: 1, username: 'tester', role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare('INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, ?, ?, ?)').run('tester', 'x', 'admin')
  invalidateWorkspacesCache()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/workspaces', adminWorkspacesRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s)
})

async function call(method: string, p: string, body?: unknown, auth: { cookie?: string; bearer?: string } = { cookie: `token=${tok('admin')}` }) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (auth.cookie) headers.Cookie = auth.cookie
  if (auth.bearer) headers.Authorization = `Bearer ${auth.bearer}`
  const res = await fetch(`${baseUrl}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

describe('code-health Job routes', () => {
  it('off by default, cookie-admin only to switch on, then on; unlinked repo refused; removal switches it off', async () => {
    expect((await call('POST', '/api/admin/workspaces', { slug: 'acme', name: 'Acme Co' })).status).toBe(201)
    const linked = await call('POST', '/api/admin/workspaces/acme/repos', { name: 'widget', github: 'acme/widget' })
    const unlinked = await call('POST', '/api/admin/workspaces/acme/repos', { name: 'notes' })
    expect(linked.status).toBe(201)

    const list = await call('GET', '/api/admin/workspaces/acme/repos')
    expect(list.status).toBe(200)
    const w = list.json.find((r: { name: string }) => r.name === 'widget')
    expect(w.code_health).toMatchObject({ enabled: false, cadence: 'weekly', routine_id: null, unavailable: null })
    expect(list.json.find((r: { name: string }) => r.name === 'notes').code_health.unavailable).toMatch(/GitHub/)

    const url = `/api/admin/workspaces/acme/repos/${linked.json.id}/code-health`
    // A bearer token (API / script) can never schedule runs.
    const bearer = await call('PUT', url, { enabled: true }, { bearer: tok('admin') })
    expect(bearer.status).toBe(403)
    expect(bearer.json.code).toBe('cookie_admin_only')
    // A member is not an admin at all.
    expect((await call('PUT', url, { enabled: true }, { cookie: `token=${tok('member')}` })).status).toBe(403)
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM routines WHERE name LIKE 'code-health:%'").get()).toEqual({ n: 0 })

    expect((await call('PUT', url, { enabled: 'yes' })).status).toBe(400)
    const on = await call('PUT', url, { enabled: true, cadence: 'daily' })
    expect(on.status).toBe(200)
    expect(on.json).toMatchObject({ enabled: true, cadence: 'daily', paused: false })
    expect(on.json.routine_id).toBeGreaterThan(0)
    expect((await call('GET', url)).json.enabled).toBe(true)

    const bad = await call('PUT', `/api/admin/workspaces/acme/repos/${unlinked.json.id}/code-health`, { enabled: true })
    expect(bad.status).toBe(400)
    expect(bad.json.code).toBe('repo_not_linked')
    expect((await call('GET', '/api/admin/workspaces/other/repos/1/code-health')).status).toBe(404)

    expect((await call('DELETE', `/api/admin/workspaces/acme/repos/${linked.json.id}`)).status).toBe(200)
    const rt = getDb().prepare('SELECT enabled FROM routines WHERE id = ?').get(on.json.routine_id) as { enabled: number }
    expect(rt.enabled).toBe(0)
  })
})
