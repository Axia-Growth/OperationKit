import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import type { WebSocket } from 'ws'

/*
 * Live unread badges for the Bots sidebar (obj 900866).
 *
 * A bot reply must reach the person's open tabs as a WebSocket ping right away
 * (instead of on the sidebar's 30s poll), and ONLY that person's sockets may
 * hear it: not another member, and not an admin either. The ping carries ids,
 * never message text. The unread rule itself is proved in
 * agent-chat-sidebar.test.ts; this file proves the push and its audience.
 */
const pushed = vi.hoisted(() => [] as Array<{ type: string; payload: Record<string, unknown> }>)
vi.mock('../ws/index.js', async importOriginal => {
  const real = await importOriginal<typeof import('../ws/index.js')>()
  return { ...real, broadcast: (m: { type: string; payload: Record<string, unknown> }) => { pushed.push(m) } }
})

process.env.JWT_SECRET = 'test-secret-agent-chat-sidebar-live-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-sidebar-live-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acsl-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acsl-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_PROVIDER = 'demo'
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { shouldDeliver } = await import('../ws/index.js')
const { deliverBotThreadMessages } = await import('../services/bots/bot-thread-delivery.js')

const OWNER = 2
const OTHER = 3
const ADMIN = 4

let server: http.Server
let baseUrl: string

async function call(method: string, p: string, as: number, body?: unknown) {
  const token = jwt.sign({ id: as, username: `user${as}`, role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  for (const [id, role] of [[OWNER, 'member'], [OTHER, 'member'], [ADMIN, 'admin']] as const) {
    db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)`).run(id, `user${id}`, role)
  }
  fs.mkdirSync(path.join(TMP_AGENTS, 'ops-bot'), { recursive: true })
  fs.writeFileSync(
    path.join(TMP_AGENTS, 'ops-bot', 'agent.yaml'),
    'name: Ops Bot\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
  )
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => {
  pushed.length = 0
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

const unreadPings = () => pushed.filter(m => m.type === 'agent_chat_unread')

describe('the push', () => {
  it('a bot reply through the chat path pings that person, with ids only', async () => {
    const r = await call('POST', '/agents/ops-bot/messages', OWNER, { text: 'hello' })
    expect(r.status).toBe(200)
    const pings = unreadPings()
    expect(pings.length).toBeGreaterThanOrEqual(1)
    for (const p of pings) expect(p.payload).toEqual({ user_id: OWNER, agent_slug: 'ops-bot' })
    // The person's own message is not a ping: only replies are.
    expect(JSON.stringify(pings)).not.toContain('hello')
  })

  it('a queued bot-job message delivered into the thread pings that person too', () => {
    const db = getDb()
    db.exec(`CREATE TABLE IF NOT EXISTS bot_thread_deliveries (delivery_id TEXT PRIMARY KEY, objective_id INTEGER, kind TEXT, thread_user_id INTEGER,
      thread_agent_slug TEXT, body TEXT, status TEXT, message_id INTEGER, delivered_at TEXT, last_error TEXT)`)
    db.prepare(
      `INSERT INTO bot_thread_deliveries (delivery_id, objective_id, kind, thread_user_id, thread_agent_slug, body, status)
       VALUES ('d-live-1', 1, 'done', ?, 'ops-bot', 'The job finished', 'pending')`,
    ).run(OWNER)
    expect(deliverBotThreadMessages(db).delivered).toBe(1)
    expect(unreadPings()).toEqual([{ type: 'agent_chat_unread', payload: { user_id: OWNER, agent_slug: 'ops-bot' } }])
  })
})

describe('who hears it', () => {
  const sock = (userId: number, role: 'admin' | 'member', viewedWorkspace?: string) => ({
    ws: {} as WebSocket,
    userId,
    role,
    workspaces: new Set(['operationkit']),
    viewedWorkspace,
  })
  const ping = { type: 'agent_chat_unread' as const, payload: { user_id: OWNER, agent_slug: 'ops-bot' } }

  it('reaches the person whose conversation it is', () => {
    expect(shouldDeliver(ping, sock(OWNER, 'member'))).toBe(true)
    expect(shouldDeliver(ping, sock(OWNER, 'member', 'operationkit'))).toBe(true)
  })

  it('never reaches another member or an admin', () => {
    expect(shouldDeliver(ping, sock(OTHER, 'member'))).toBe(false)
    expect(shouldDeliver(ping, sock(ADMIN, 'admin'))).toBe(false)
    expect(shouldDeliver(ping, sock(ADMIN, 'admin', 'all'))).toBe(false)
  })
})
