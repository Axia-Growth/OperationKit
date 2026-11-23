import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * Follow-ups in the chat UI — obj 901392.
 *
 * The person sees a "Follow-up scheduled for HH:MM: <note>" line with a Cancel
 * control. The line is a stored tool row carrying `meta.followup_id`; these
 * routes give the page the follow-up's live state and take the Cancel click.
 *
 *   GET    /agents/:slug/messages         → `followups`: state of every follow-up a row in view points at
 *   GET    /agents/:slug/followups        → the caller's own follow-ups with the bot (waiting + log)
 *   DELETE /agents/:slug/followups/:id    → the person's Cancel (own, still waiting; else 404)
 */
process.env.JWT_SECRET = 'test-secret-agent-chat-followups-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-agent-chat-followups-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acf-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-acf-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_PROVIDER = 'demo'
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../db/index.js')
const { default: router } = await import('./agent-chat.js')
const { scheduleFollowup } = await import('../services/agent-chat/followups.js')
const { addMessage } = await import('../services/agent-chat/engine.js')
const { MAIN_LANE } = await import('../services/agent-chat/threads.js')

const OWNER = 2
const OTHER = 3
const SLUG = 'ok-dev'
const NOW = new Date('2026-11-18T12:00:00Z')

let server: http.Server
let baseUrl: string

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

function tokenFor(id: number, role = 'member') {
  return jwt.sign({ id, username: `user${id}`, role }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
}

async function call(method: string, p: string, opts: { as?: number; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (opts.as) headers.Cookie = `token=${tokenFor(opts.as)}`
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) })
  const text = await res.text()
  let json: Loose = null
  try { json = text ? JSON.parse(text) : null } catch { /* not json */ }
  return { status: res.status, json }
}

/** What a schedule_followup call leaves behind: the row and its chat line. */
function seed(userId: number, note: string) {
  const f = scheduleFollowup({ userId, slug: SLUG, lane: MAIN_LANE, workspace: 'operationkit', inMinutes: 10, note, hop: 1, now: NOW })
  addMessage(userId, SLUG, { role: 'tool', content: `Follow-up scheduled for 12:10: ${note}`, provider: 'demo', model: 'demo', tool_name: 'schedule_followup', meta: { ok: true, followup_id: f.id } })
  return f
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(OTHER)
  fs.mkdirSync(path.join(TMP_AGENTS, SLUG))
  fs.writeFileSync(path.join(TMP_AGENTS, SLUG, 'agent.yaml'), 'name: Operation Kit Dev\nsystem_prompt: You help.\nknowledge_folders: []\ntools: [create_objective]\ncolour: blue\nversion: 1.0.0\nauthor: Test\n')
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(() => {
  getDb().exec('DELETE FROM bot_followups; DELETE FROM agent_chat_messages;')
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('the follow-up line in the chat', () => {
  it('the bot is listed with the follow-up tool', async () => {
    const r = await call('GET', '/agents', { as: OWNER })
    const bot = (r.json.agents as Loose[]).find(a => a.slug === SLUG)
    expect(bot.effective_tools).toContain('followups')
  })

  it('GET messages carries the live state of each follow-up a line points at', async () => {
    const f = seed(OWNER, 'check card 12 and report the PR')
    const r = await call('GET', `/agents/${SLUG}/messages`, { as: OWNER })
    expect(r.status).toBe(200)
    const line = (r.json.messages as Loose[]).find(m => m.tool_name === 'schedule_followup')
    expect(line.meta.followup_id).toBe(f.id)
    expect(r.json.followups).toEqual([
      expect.objectContaining({ id: f.id, status: 'pending', note: 'check card 12 and report the PR', due_at: '2026-11-18T12:10:00Z', thread_id: null }),
    ])
  })

  it('Cancel: the person cancels their own waiting follow-up, once', async () => {
    const f = seed(OWNER, 'check')
    const r = await call('DELETE', `/agents/${SLUG}/followups/${f.id}`, { as: OWNER })
    expect(r.status).toBe(200)
    expect(r.json.followup).toMatchObject({ id: f.id, status: 'cancelled', end_reason: 'person' })
    expect((getDb().prepare('SELECT status, cancelled_by FROM bot_followups WHERE id = ?').get(f.id) as Loose)).toMatchObject({ status: 'cancelled', cancelled_by: 'person' })
    // The line now reads as cancelled, with nothing left to press.
    const after = await call('GET', `/agents/${SLUG}/messages`, { as: OWNER })
    expect(after.json.followups[0]).toMatchObject({ id: f.id, status: 'cancelled' })
    expect((await call('DELETE', `/agents/${SLUG}/followups/${f.id}`, { as: OWNER })).status).toBe(404)
  })

  it('nobody can see or cancel another person\'s follow-up', async () => {
    const f = seed(OWNER, 'private note')
    expect((await call('DELETE', `/agents/${SLUG}/followups/${f.id}`, { as: OTHER })).status).toBe(404)
    expect((getDb().prepare('SELECT status FROM bot_followups WHERE id = ?').get(f.id) as Loose).status).toBe('pending')
    const theirs = await call('GET', `/agents/${SLUG}/followups`, { as: OTHER })
    expect(theirs.json.followups).toEqual([])
    const msgs = await call('GET', `/agents/${SLUG}/messages`, { as: OTHER })
    expect(msgs.json.followups).toEqual([])
    expect((await call('DELETE', `/agents/${SLUG}/followups/abc`, { as: OWNER })).status).toBe(404)
    expect((await call('DELETE', `/agents/${SLUG}/followups/${f.id}`)).status).toBe(401)
  })

  it('GET followups is the person\'s log with this bot: waiting, fired, cancelled, dropped', async () => {
    const a = seed(OWNER, 'first')
    const b = seed(OWNER, 'second')
    const c = seed(OWNER, 'third')
    await call('DELETE', `/agents/${SLUG}/followups/${a.id}`, { as: OWNER })
    getDb().prepare("UPDATE bot_followups SET status = 'fired', fire_reason = 'due', fired_at = '2026-11-18 12:10:00', finished_at = '2026-11-18 12:10:20' WHERE id = ?").run(b.id)
    const r = await call('GET', `/agents/${SLUG}/followups`, { as: OWNER })
    expect(r.status).toBe(200)
    expect(r.json.enabled).toBe(true)
    const byId = new Map((r.json.followups as Loose[]).map(f => [f.id, f]))
    expect(byId.get(a.id)).toMatchObject({ status: 'cancelled', end_reason: 'person' })
    expect(byId.get(b.id)).toMatchObject({ status: 'fired', fire_reason: 'due', fired_at: '2026-11-18T12:10:00Z' })
    expect(byId.get(c.id)).toMatchObject({ status: 'pending' })
  })
})
