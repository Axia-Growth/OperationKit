import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * obj 901329 — a dropped chat request is NOT Stop.
 *
 * Before: POST /agents/:slug/messages aborted the turn when its HTTP response
 * closed (tab closed, reload, network blip, the client's 240s UI timeout), and
 * the turn recorded "You stopped this reply." though nobody pressed Stop.
 * Now the turn runs to the end and stores its answer; only POST /stop cancels.
 *
 * Harness copied from turn-queue.test.ts (obj 900949):
 *
 * Before: a second message in a lane with a turn running was REFUSED (409,
 * "still answering your last message") and the client locked Send. Now:
 *
 *   1. A message posted mid-turn is ACCEPTED: stored at once as a queued row
 *      (202), so nothing typed is lost.
 *   2. Every queued message is delivered after the running turn, OLDEST FIRST,
 *      and the model is handed them in exactly that order — asserted against the
 *      request body that left the process, not an internal helper.
 *   3. Stop cancels the running turn and KEEPS the queue (it is delivered next);
 *      only an explicit drop_queued discards it.
 *
 * The provider stub is a GATE: a turn sits inside it until the test releases
 * it, so "mid-turn" is a real state, not a race the test hopes to win.
 */
process.env.JWT_SECRET = 'test-secret-chat-disconnect-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-disconnect-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// The HTTP route runs the turn with process.env and the global fetch, so the
// provider key lives here and model calls are routed to the active gate below.
process.env.ANTHROPIC_API_KEY = 'k'
process.env.AGENT_CHAT_PROVIDER = 'anthropic'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-disconnect-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-disconnect-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, laneTurnState, runTurn, stopTurn, submitMessage, whenLaneIdle, isAgentChatRunning } = await import('./engine.js')
const { createThread, MAIN_LANE } = await import('./threads.js')
const { default: router } = await import('../../routes/agent-chat.js')

const OWNER = 2
const SLUG = 'helper'
const ENV = { ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv

type Body = { messages: { role: string; content: unknown }[] }

/**
 * A provider that holds every request until `release()` (or the request's
 * abort signal fires — which is how Stop reaches the provider). Each request
 * body is recorded; `arrived` resolves when the nth request is inside.
 */
const providers: { release: () => void }[] = []
let activeProvider: typeof fetch | null = null
const realFetch = globalThis.fetch
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u.startsWith('http://127.0.0.1') || !activeProvider) return realFetch(url, init)
  return activeProvider(u, init as RequestInit)
}) as typeof fetch
function gatedProvider() {
  const bodies: Body[] = []
  const self = { release: () => {} }
  providers.push(self)
  const waiters: { n: number; resolve: () => void }[] = []
  let open: (() => void)[] = []
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body
    bodies.push(body)
    for (const w of waiters.filter(x => bodies.length >= x.n)) w.resolve()
    await new Promise<void>((resolve, reject) => {
      open.push(resolve)
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
    })
    const last = body.messages.at(-1)
    return new Response(JSON.stringify({ content: [{ type: 'text', text: `answer to ${JSON.stringify(last?.content)}` }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  activeProvider = f
  return {
    fetch: f,
    bodies,
    /** Resolves once `n` requests have reached the provider. */
    arrived: (n: number) => new Promise<void>(resolve => (bodies.length >= n ? resolve() : waiters.push({ n, resolve }))),
    /** Let every request currently inside answer. */
    release: (self.release = () => { const o = open; open = []; o.forEach(r => r()) }),
  }
}

/**
 * The user text the model was handed in one request, in order. Providers may
 * merge consecutive user turns into one message with several text blocks (the
 * Anthropic adapter does), so this flattens to one entry per text block.
 */
const userLines = (b: Body) =>
  b.messages
    .filter(m => m.role === 'user')
    .flatMap(m => (typeof m.content === 'string' ? [m.content] : Array.isArray(m.content) ? m.content.filter(x => x && typeof x === 'object' && 'text' in x).map(x => String((x as { text: unknown }).text)) : [JSON.stringify(m.content)]))

const agent = () => ({ ...findAgent(SLUG)!, provider: 'anthropic' as const })
const turn = (text: string, p: ReturnType<typeof gatedProvider>, lane = MAIN_LANE) =>
  runTurn({ userId: OWNER, username: 'user2', agent: agent(), text, lane, env: ENV, deps: { fetch: p.fetch } })
const submit = (text: string, lane = MAIN_LANE, clientMsgId?: string, p?: ReturnType<typeof gatedProvider>) =>
  submitMessage({ userId: OWNER, username: 'user2', agent: agent(), text, lane, env: ENV, clientMsgId, ...(p ? { deps: { fetch: p.fetch } } : {}) })
const lane = (l = MAIN_LANE) => listMessages(OWNER, SLUG, { lane: l })

let server: http.Server
let baseUrl: string

async function call(method: string, p: string, body?: unknown) {
  const token = jwt.sign({ id: OWNER, username: 'user2', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  fs.mkdirSync(path.join(TMP_AGENTS, SLUG))
  fs.writeFileSync(
    path.join(TMP_AGENTS, SLUG, 'agent.yaml'),
    'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\nprovider: anthropic\n',
  )
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/agent-chat', router)
  await new Promise<void>(resolve => { server = app.listen(0, () => resolve()) })
  const addr = server.address()
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

beforeEach(async () => {
  await whenLaneIdle(OWNER, SLUG)
  getDb().prepare('DELETE FROM agent_chat_messages').run()
  getDb().prepare('DELETE FROM agent_chat_threads').run()
})

// A failed assertion must not leave a turn parked in the gate for the next case.
afterEach(async () => {
  stopTurn(OWNER, SLUG, MAIN_LANE, { dropQueued: true })
  for (const p of providers.splice(0)) p.release()
  await whenLaneIdle(OWNER, SLUG)
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await whenLaneIdle(OWNER, SLUG)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})


/**
 * POST a chat message over a raw socket and hang up mid-turn, the way a
 * browser does on a full page load. Resolves once the socket is destroyed.
 */
function postThenDrop(text: string, extra: Record<string, unknown> = {}) {
  const token = jwt.sign({ id: OWNER, username: 'user2', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const payload = JSON.stringify({ text, ...extra })
  const req = http.request(`${baseUrl}/api/agent-chat/agents/${SLUG}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: `token=${token}` },
  })
  let answered = false
  req.on('response', () => { answered = true })
  req.on('error', () => { /* we hung up on purpose */ })
  req.end(payload)
  return { drop: () => req.destroy(), answered: () => answered }
}

/** Wait until the server has seen the client hang up (its 'close' fired). */
const settle = () => new Promise(r => setTimeout(r, 50))

const stoppedRows = () => lane().filter(m => m.meta?.kind === 'stopped')

describe('a dropped request is not Stop (obj 901329)', () => {
  it('mid-turn disconnect: the turn finishes, the answer is stored, no stopped row', async () => {
    const p = gatedProvider()
    const logs: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    try {
      const c = postThenDrop('long question')
      await p.arrived(1)
      c.drop()
      await settle()
      // Still running after the browser left — not cancelled.
      expect(laneTurnState(OWNER, SLUG, MAIN_LANE).running).toBe(true)
      p.release()
      await whenLaneIdle(OWNER, SLUG)
      expect(c.answered()).toBe(false)
    } finally {
      console.warn = warn
    }
    const rows = lane()
    expect(rows.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(rows[1].content).toContain('long question')
    expect(stoppedRows()).toHaveLength(0)
    expect(rows.some(m => m.content === 'You stopped this reply.')).toBe(false)
    // Logged as a disconnect, not as the person pressing Stop.
    expect(logs.some(l => l.includes('[agent-chat] disconnect:') && l.includes('not a Stop'))).toBe(true)
    expect(logs.some(l => l.includes('[agent-chat] stop:'))).toBe(false)
  })

  it('the person sees the finished answer when they come back (GET after a disconnect)', async () => {
    const p = gatedProvider()
    const c = postThenDrop('come back later')
    await p.arrived(1)
    c.drop()
    await settle()
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    const g = await call('GET', `/agents/${SLUG}/messages`)
    expect(g.status).toBe(200)
    expect(g.json.turn).toEqual({ running: false, queued: 0, held: 0 })
    expect(g.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant'])
  })

  it('explicit stop: POST /stop still writes "You stopped this reply.", aborts the turn and halts tools', async () => {
    // A provider that answers with a TOOL CALL even after it was cancelled — the
    // loop must not act on it once Stop is pressed.
    let calls = 0
    let inside: () => void = () => {}
    const arrived = new Promise<void>(r => { inside = r })
    let sawAbort = false
    const f = (async (_url: string, init: RequestInit) => {
      calls++
      inside()
      await new Promise<void>(resolve => init.signal?.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true }))
      return new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 't1', name: 'search_notes', input: { query: 'x' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const logs: string[] = []
    const log = console.log
    console.log = (...a: unknown[]) => { logs.push(a.map(String).join(' ')) }
    let s
    try {
      const first = runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'stop me', env: ENV, deps: { fetch: f } })
      await arrived
      s = await call('POST', `/agents/${SLUG}/stop`, {})
      await first
      await whenLaneIdle(OWNER, SLUG)
    } finally {
      console.log = log
    }
    expect(s.status).toBe(200)
    expect(s.json).toMatchObject({ stopped: true })
    expect(sawAbort).toBe(true)
    expect(calls).toBe(1)
    const rows = lane()
    expect(rows.map(m => m.role)).toEqual(['user', 'error'])
    expect(rows[1]).toMatchObject({ content: 'You stopped this reply.', meta: { kind: 'stopped' } })
    // No tool ran after Stop.
    expect(rows.some(m => m.role === 'tool')).toBe(false)
    expect(logs.some(l => l.includes('[agent-chat] stop: the person pressed Stop'))).toBe(true)
  })

  it('explicit stop over HTTP on a turn whose own request is still open: the open request gets the stopped row', async () => {
    const p = gatedProvider()
    const pending = call('POST', `/agents/${SLUG}/messages`, { text: 'cancel me' })
    await p.arrived(1)
    const s = await call('POST', `/agents/${SLUG}/stop`, {})
    expect(s.json).toMatchObject({ stopped: true })
    const r = await pending
    expect(r.status).toBe(200)
    expect(r.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'error'])
    expect(r.json.messages[1]).toMatchObject({ content: 'You stopped this reply.', meta: { kind: 'stopped' } })
  })

  it('queued follow-up after disconnect: a message queued behind the dropped turn is still delivered', async () => {
    const p = gatedProvider()
    const c = postThenDrop('original')
    await p.arrived(1)
    // #900949: the lane is busy, so Send queues (202) instead of refusing.
    const q = await call('POST', `/agents/${SLUG}/messages`, { text: 'follow-up' })
    expect(q.status).toBe(202)
    expect(q.json.queued).toBe(true)
    c.drop()
    await settle()
    p.release()
    // The original finishes, then the drain hands the queued follow-up to the model.
    await p.arrived(2)
    expect(userLines(p.bodies[1])).toEqual(['original', 'follow-up'])
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    const rows = lane()
    expect(rows.map(m => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(rows.filter(m => m.role === 'user').map(m => m.content)).toEqual(['original', 'follow-up'])
    expect(rows.every(m => !m.meta?.queued)).toBe(true)
    expect(stoppedRows()).toHaveLength(0)
  })

  it('regression #900949: Send still queues (202) while the lane is busy, and is delivered in order', async () => {
    const p = gatedProvider()
    const first = call('POST', `/agents/${SLUG}/messages`, { text: 'one' })
    await p.arrived(1)
    const q1 = await call('POST', `/agents/${SLUG}/messages`, { text: 'two' })
    const q2 = await call('POST', `/agents/${SLUG}/messages`, { text: 'three' })
    expect([q1.status, q2.status]).toEqual([202, 202])
    expect(q2.json.turn).toEqual({ running: true, queued: 2, held: 0 })
    p.release()
    expect((await first).status).toBe(200)
    await p.arrived(2)
    expect(userLines(p.bodies[1])).toEqual(['one', 'two', 'three'])
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    expect(lane().filter(m => m.role === 'user').map(m => m.content)).toEqual(['one', 'two', 'three'])
  })

  it('an "AI unavailable" failure after the browser left keeps the message and says why, instead of deleting it', async () => {
    let inside: () => void = () => {}
    const arrived = new Promise<void>(r => { inside = r })
    let fail: () => void = () => {}
    const gate = new Promise<void>(r => { fail = r })
    const f = (async () => {
      inside()
      await gate
      return new Response(JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529, headers: { 'Content-Type': 'application/json' } })
    }) as unknown as typeof fetch
    const r = submitMessage({ userId: OWNER, username: 'user2', agent: agent(), text: 'are you there', env: ENV, deps: { fetch: f }, responseGone: () => true })
    await arrived
    fail()
    await r.catch(() => undefined)
    await whenLaneIdle(OWNER, SLUG)
    const rows = lane()
    expect(rows[0]).toMatchObject({ role: 'user', content: 'are you there' })
    expect(rows.at(-1)?.role).toBe('error')
    expect(stoppedRows()).toHaveLength(0)
  })
})
