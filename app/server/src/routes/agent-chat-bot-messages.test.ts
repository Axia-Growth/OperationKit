// Bot-to-bot threads in the Bots UI (obj 900859): GET /api/agent-chat/bot-conversations[/:id].
//
// The person-facing read path. What must hold:
//   - an admin sees every workspace's threads;
//   - a member sees only threads in workspaces they belong to, and a thread in
//     another workspace is a 404 — the same answer as one that does not exist;
//   - an agent API key (a remote bot) cannot read these at all (403);
//   - an unauthenticated caller gets 401.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

process.env.JWT_SECRET = 'test-secret-bot-messages-route-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-messages-route-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-messages-route-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { createAgentKey } = await import('../lib/agent-keys.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const { sendBotMessage } = await import('../services/agent-chat/bot-messaging.js')

const ADMIN = 1
const ALICE = 2 // ops
const BOB = 3 // finance

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

let server: http.Server
let baseUrl: string
let agentKey = ''
let opsId = 0
let financeId = 0

function tokenFor(id: number, role: string) {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(p: string, opts: { as?: number; role?: string; key?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.key) headers.Authorization = `Bearer ${opts.key}`
  else if (opts.as) headers.Cookie = `token=${tokenFor(opts.as, opts.role ?? 'member')}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { headers })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

const BOTS = [
  { slug: 'alpha', name: 'Alpha' },
  { slug: 'beta', name: 'Beta' },
  { slug: 'gamma', name: 'Gamma' },
  { slug: 'delta', name: 'Delta' },
]

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'user1', 'x', 'admin'), (2, 'user2', 'x', 'member'), (3, 'user3', 'x', 'member')`).run()
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('finance', 'Finance')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (2, 'ops', 'member'), (3, 'finance', 'member')`).run()
  for (const [slug, ws] of [['alpha', 'ops'], ['beta', 'ops'], ['gamma', 'finance'], ['delta', 'finance']]) grantBotWorkspace(slug, ws, 'test')

  opsId = sendBotMessage({ from: BOTS[0], userId: ALICE, to: 'beta', defaultWorkspace: 'ops', text: 'ops plan: ship friday', bots: BOTS, origin: null }).conversation.id
  financeId = sendBotMessage({ from: BOTS[2], userId: BOB, to: 'delta', defaultWorkspace: 'finance', text: 'finance SECRET payroll', bots: BOTS, origin: null }).conversation.id

  const k = createAgentKey({ id: ADMIN, role: 'admin' }, { label: 'remote-bot' })
  if (!k.ok) throw new Error(k.error)
  agentKey = k.key.token

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

describe('GET /bot-conversations', () => {
  it('an admin sees every workspace', async () => {
    const r = await call('/bot-conversations', { as: ADMIN, role: 'admin' })
    expect(r.status).toBe(200)
    expect(r.json.conversations.map((c: Loose) => c.id).sort()).toEqual([opsId, financeId].sort())
  })

  it('a member sees only their own workspaces', async () => {
    const alice = await call('/bot-conversations', { as: ALICE })
    expect(alice.json.conversations.map((c: Loose) => c.id)).toEqual([opsId])
    expect(JSON.stringify(alice.json)).not.toContain('payroll')
    const bob = await call('/bot-conversations', { as: BOB })
    expect(bob.json.conversations.map((c: Loose) => c.id)).toEqual([financeId])
  })

  it('narrows to one bot with ?bot=', async () => {
    const r = await call('/bot-conversations?bot=gamma', { as: ADMIN, role: 'admin' })
    expect(r.json.conversations.map((c: Loose) => c.id)).toEqual([financeId])
    expect((await call('/bot-conversations?bot=../etc', { as: ADMIN, role: 'admin' })).status).toBe(400)
  })

  it('an agent API key is refused, and no session is a 401', async () => {
    expect((await call('/bot-conversations', { key: agentKey })).status).toBe(403)
    expect((await call('/bot-conversations')).status).toBe(401)
  })
})

describe('GET /bot-conversations/:id', () => {
  it('a member opens a thread in their workspace with every entry', async () => {
    const r = await call(`/bot-conversations/${opsId}`, { as: ALICE })
    expect(r.status).toBe(200)
    expect(r.json.conversation).toMatchObject({ id: opsId, workspace: 'ops', initiator_slug: 'alpha', recipient_slug: 'beta' })
    expect(r.json.messages).toHaveLength(1)
    expect(r.json.messages[0]).toMatchObject({ kind: 'message', from_slug: 'alpha', to_slug: 'beta', body: 'ops plan: ship friday', status: 'pending', sent_for: 'user2' })
  })

  it('a thread in another workspace is a 404, exactly like one that does not exist', async () => {
    const other = await call(`/bot-conversations/${financeId}`, { as: ALICE })
    const missing = await call('/bot-conversations/999999', { as: ALICE })
    expect(other.status).toBe(404)
    expect(missing.status).toBe(404)
    expect(other.json).toEqual(missing.json)
  })

  it('an admin opens any thread; an agent key opens none', async () => {
    expect((await call(`/bot-conversations/${financeId}`, { as: ADMIN, role: 'admin' })).status).toBe(200)
    expect((await call(`/bot-conversations/${opsId}`, { key: agentKey })).status).toBe(403)
  })
})
