/**
 * obj 901393 — the "deploy on your word" switch is the owner's alone.
 *
 *  - off by default (no settings row);
 *  - GET is admin-only (the /api/admin facade);
 *  - PUT works only for the owner signed in in the browser (admin + cookie):
 *    a member, an admin bearer JWT and an agent key are all refused;
 *  - the route deploys nothing and touches no other deploy/merge setting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-admin-chat-deploy'
const TMP_DB = path.join(os.tmpdir(), `cc-admin-chat-deploy-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.PORT = '59947'

const { initDb, getDb } = await import('../db/index.js')
const { default: adminRouter } = await import('./admin.js')
const { createAgentKey } = await import('../lib/agent-keys.js')

const ADMIN = 1
const MEMBER = 2
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl = ''
let agentKey = ''

const tokenFor = (id: number, role: string) => jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, opts: { cookieAs?: [number, string]; bearer?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
  if (opts.cookieAs) headers.Cookie = `token=${tokenFor(opts.cookieAs[0], opts.cookieAs[1])}`
  const res = await fetch(`${baseUrl}/api/admin/chat-deploy`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const settingValue = (key: string) => (getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(MEMBER)
  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'outside bot' }) as Loose
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin', adminRouter)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(() => {
  server?.close()
  try { fs.unlinkSync(TMP_DB) } catch { /* gone */ }
})

describe('/api/admin/chat-deploy', () => {
  it('is off by default and the owner may manage it', async () => {
    const r = await call('GET', { cookieAs: [ADMIN, 'admin'] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ enabled: false, can_manage: true, bots: ['operation-kit-dev'], last: null })
    expect(settingValue('chat_deploy_enabled')).toBeUndefined()
  })
  it('a member cannot read or switch it', async () => {
    expect((await call('GET', { cookieAs: [MEMBER, 'member'] })).status).toBe(403)
    expect((await call('PUT', { cookieAs: [MEMBER, 'member'], body: { enabled: true } })).status).toBe(403)
    expect(settingValue('chat_deploy_enabled')).toBeUndefined()
  })
  it('an admin bearer token (not the browser) cannot switch it', async () => {
    const r = await call('PUT', { bearer: tokenFor(ADMIN, 'admin'), body: { enabled: true } })
    expect(r.status).toBe(403)
    expect(settingValue('chat_deploy_enabled')).toBeUndefined()
  })
  it('an agent key cannot switch it', async () => {
    expect(agentKey).toMatch(/^cc_live_/)
    const r = await call('PUT', { bearer: agentKey, body: { enabled: true } })
    expect([401, 403]).toContain(r.status)
    expect(settingValue('chat_deploy_enabled')).toBeUndefined()
  })
  it('the owner in the browser switches it on and off; nothing else changes', async () => {
    const autoDeploy = settingValue('auto_deploy_enabled')
    const autoMerge = settingValue('auto_merge_enabled')
    expect((await call('PUT', { cookieAs: [ADMIN, 'admin'], body: { enabled: 'yes' } })).status).toBe(400)
    const on = await call('PUT', { cookieAs: [ADMIN, 'admin'], body: { enabled: true } })
    expect(on.status).toBe(200)
    expect(on.json.enabled).toBe(true)
    expect(settingValue('chat_deploy_enabled')).toBe('1')
    const off = await call('PUT', { cookieAs: [ADMIN, 'admin'], body: { enabled: false } })
    expect(off.json.enabled).toBe(false)
    expect(settingValue('chat_deploy_enabled')).toBe('0')
    expect(settingValue('auto_deploy_enabled')).toBe(autoDeploy)
    expect(settingValue('auto_merge_enabled')).toBe(autoMerge)
  })
})
