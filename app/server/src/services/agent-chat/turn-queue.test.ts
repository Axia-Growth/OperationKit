import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * The composer stays usable while the bot is working — obj 900949.
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
process.env.JWT_SECRET = 'test-secret-turn-queue-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-turn-queue-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-turn-queue-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-turn-queue-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, laneTurnState, runTurn, stopTurn, submitMessage, whenLaneIdle } = await import('./engine.js')
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
  await whenLaneIdle(OWNER, SLUG)
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('a message sent while the bot is working (obj 900949)', () => {
  it('is accepted and stored as queued — not refused, not dropped', async () => {
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)

    const r = await submit('second')
    expect(r.queued).toBe(true)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toMatchObject({ role: 'user', content: 'second', meta: { queued: true } })
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: true, queued: 1 })
    // Stored right away: a reload while the bot works still shows it.
    expect(lane().map(m => m.content)).toContain('second')
    // ...but the running turn's model never saw it.
    expect(userLines(p.bodies[0])).toEqual(['first'])

    p.release()
    await first
    await p.arrived(2)
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: false, queued: 0 })
  })

  it('delivers several mid-turn messages after the running turn, in the order they were sent', async () => {
    const p = gatedProvider()
    const first = turn('one', p)
    await p.arrived(1)
    for (const t of ['two', 'three', 'four']) expect((await submit(t)).queued).toBe(true)
    expect(laneTurnState(OWNER, SLUG).queued).toBe(3)

    p.release()
    const done = await first
    expect(done.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    // The drain started as the first turn ended: the queue is now with the model.
    await p.arrived(2)
    expect(userLines(p.bodies[1])).toEqual(['one', 'two', 'three', 'four'])
    p.release()
    await whenLaneIdle(OWNER, SLUG)

    // The transcript reads in send order: the queued messages are re-filed
    // AFTER the answer they waited behind, each delivered (no queued flag).
    const rows = lane()
    expect(rows.map(m => [m.role, m.role === 'user' ? m.content : '…'])).toEqual([
      ['user', 'one'],
      ['assistant', '…'],
      ['user', 'two'],
      ['user', 'three'],
      ['user', 'four'],
      ['assistant', '…'],
    ])
    expect(rows.every(m => !m.meta?.queued)).toBe(true)
    expect(rows.at(-1)!.content).toContain('four')
  })

  it('a message sent while the queue is being delivered waits for the next turn, still in order', async () => {
    const p = gatedProvider()
    const first = turn('a', p)
    await p.arrived(1)
    await submit('b')
    p.release()
    await first
    await p.arrived(2) // the drain turn, carrying "b"
    await submit('c')
    p.release()
    await p.arrived(3) // the next drain, carrying "c"
    expect(userLines(p.bodies[2])).toEqual(['a', 'b', 'c'])
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    expect(lane().filter(m => m.role === 'user').map(m => m.content)).toEqual(['a', 'b', 'c'])
  })

  it('queues per lane: a side thread is not blocked by the main conversation', async () => {
    const p = gatedProvider()
    const t = createThread(OWNER, SLUG, 'Side')
    const side = { kind: 'thread' as const, id: t.id }
    const first = turn('main question', p)
    await p.arrived(1)
    const r = submitMessage({ userId: OWNER, username: 'user2', agent: agent(), text: 'side question', lane: side, env: ENV, deps: { fetch: p.fetch } })
    // Not queued: it ran as its own turn (it reached the provider).
    await p.arrived(2)
    p.release()
    expect((await r).queued).toBe(false)
    await first
    await whenLaneIdle(OWNER, SLUG)
  })
})

describe('Stop (obj 900949)', () => {
  it('cancels the running turn and keeps the queue, which is then delivered', async () => {
    const p = gatedProvider()
    const first = turn('long job', p)
    await p.arrived(1)
    await submit('follow-up 1')
    await submit('follow-up 2')

    const s = stopTurn(OWNER, SLUG, MAIN_LANE)
    expect(s.stopped).toBe(true)
    expect(s.dropped).toBe(0)

    const done = await first
    // The stopped turn says so, and records no answer.
    expect(done.messages.map(m => m.role)).toEqual(['user', 'error'])
    expect(done.messages[1].meta).toMatchObject({ kind: 'stopped' })

    // The queue was kept: it goes to the model next, in order.
    await p.arrived(2)
    expect(userLines(p.bodies[1])).toEqual(['long job', 'follow-up 1', 'follow-up 2'])
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    expect(lane().filter(m => m.role === 'user').map(m => m.content)).toEqual(['long job', 'follow-up 1', 'follow-up 2'])
  })

  it('drops the queue only when asked to (the confirmed path)', async () => {
    const p = gatedProvider()
    const first = turn('long job', p)
    await p.arrived(1)
    await submit('never mind 1')
    await submit('never mind 2')

    const s = stopTurn(OWNER, SLUG, MAIN_LANE, { dropQueued: true })
    expect(s).toMatchObject({ stopped: true, dropped: 2, queued: 0 })
    await first
    await whenLaneIdle(OWNER, SLUG)
    expect(p.bodies).toHaveLength(1)
    expect(lane().map(m => m.content)).not.toContain('never mind 1')
  })

  it('is a no-op on an idle lane', () => {
    expect(stopTurn(OWNER, SLUG, MAIN_LANE)).toEqual({ stopped: false, dropped: 0, running: false, queued: 0 })
  })
})

describe('over HTTP (obj 900949)', () => {
  it('POST mid-turn → 202 queued; GET reports the turn state; POST /stop cancels and keeps the queue', async () => {
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)

    const q = await call('POST', `/agents/${SLUG}/messages`, { text: 'queued one' })
    expect(q.status).toBe(202)
    expect(q.json.queued).toBe(true)
    expect(q.json.messages[0]).toMatchObject({ content: 'queued one', meta: { queued: true } })
    expect(q.json.turn).toEqual({ running: true, queued: 1 })

    const g = await call('GET', `/agents/${SLUG}/messages`)
    expect(g.status).toBe(200)
    expect(g.json.turn).toEqual({ running: true, queued: 1 })

    const s = await call('POST', `/agents/${SLUG}/stop`, {})
    expect(s.status).toBe(200)
    expect(s.json).toMatchObject({ stopped: true, dropped: 0 })
    expect(s.json.turn.queued).toBe(1)
    await first
    await p.arrived(2)
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    const after = await call('GET', `/agents/${SLUG}/messages`)
    expect(after.json.turn).toEqual({ running: false, queued: 0 })
    expect(after.json.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual(['first', 'queued one'])
  })

  it('POST /stop with drop_queued discards the queue', async () => {
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)
    await call('POST', `/agents/${SLUG}/messages`, { text: 'drop me' })
    const s = await call('POST', `/agents/${SLUG}/stop`, { drop_queued: true })
    expect(s.json).toMatchObject({ stopped: true, dropped: 1, turn: { queued: 0 } })
    await first
    await whenLaneIdle(OWNER, SLUG)
    expect(p.bodies).toHaveLength(1)
  })
})

/*
 * obj 900977 — one message, one stored row. The client gives every message a
 * client_msg_id; a repeat of the same id in the same lane (a retry after a
 * dropped response, a double submit) gets the stored row back and neither
 * inserts nor runs anything.
 */
describe('client_msg_id is an idempotency key (obj 900977)', () => {
  const users = (l = MAIN_LANE) => lane(l).filter(m => m.role === 'user')

  it('idle lane: the same id twice stores one user row and runs one turn', async () => {
    const p = gatedProvider()
    const first = submit('hello', MAIN_LANE, 'idle-msg-0001', p)
    await p.arrived(1)
    // The repeat lands while the first is still being answered…
    const again = await submit('hello', MAIN_LANE, 'idle-msg-0001', p)
    expect(again.duplicate).toBe(true)
    expect(again.queued).toBe(false)
    expect(again.messages).toHaveLength(1)
    expect(users()).toHaveLength(1)
    expect(again.messages[0].id).toBe(users()[0].id)
    expect(again.messages[0].meta).toMatchObject({ client_msg_id: 'idle-msg-0001' })
    expect(laneTurnState(OWNER, SLUG).queued).toBe(0)
    p.release()
    await first
    await whenLaneIdle(OWNER, SLUG)
    // …and once more after the turn ended.
    const later = await submit('hello', MAIN_LANE, 'idle-msg-0001', p)
    expect(later.duplicate).toBe(true)
    await whenLaneIdle(OWNER, SLUG)
    expect(users().map(m => m.content)).toEqual(['hello'])
    expect(lane().filter(m => m.role === 'assistant')).toHaveLength(1)
    expect(p.bodies).toHaveLength(1)
  })

  it('busy lane: the same id twice queues one row, delivered once with its id kept', async () => {
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)
    const a = await submit('follow-up', MAIN_LANE, 'busy-msg-0001')
    const b = await submit('follow-up', MAIN_LANE, 'busy-msg-0001')
    expect(a.queued).toBe(true)
    expect(a.duplicate).toBeUndefined()
    expect(b).toMatchObject({ queued: true, duplicate: true })
    expect(b.messages[0].id).toBe(a.messages[0].id)
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: true, queued: 1 })

    p.release()
    await first
    await p.arrived(2)
    // Delivered now (re-filed under a new row id, no queued flag): a late
    // repeat still finds it, and does not queue it a second time.
    const c = await submit('follow-up', MAIN_LANE, 'busy-msg-0001')
    expect(c).toMatchObject({ queued: false, duplicate: true })
    expect(c.messages[0].id).not.toBe(a.messages[0].id)
    expect(c.messages[0].meta).toEqual({ client_msg_id: 'busy-msg-0001' })
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    expect(users().map(m => m.content)).toEqual(['first', 'follow-up'])
    expect(p.bodies).toHaveLength(2)
    expect(userLines(p.bodies[1]).filter(t => t === 'follow-up')).toHaveLength(1)
  })

  it('runTurn itself does not store a repeated id', async () => {
    const p = gatedProvider()
    const run = (id: string) => runTurn({ userId: OWNER, username: 'user2', agent: agent(), text: 'direct', env: ENV, deps: { fetch: p.fetch }, clientMsgId: id })
    const first = run('direct-msg-01')
    await p.arrived(1)
    // Mid-turn a repeat is answered with the stored row — not a ChatBusyError, not a second row.
    const again = await run('direct-msg-01')
    expect(again.messages.map(m => m.content)).toEqual(['direct'])
    p.release()
    await first
    await whenLaneIdle(OWNER, SLUG)
    await run('direct-msg-01')
    expect(users()).toHaveLength(1)
    expect(p.bodies).toHaveLength(1)
  })

  it('the id is scoped to its lane, and different ids are different messages', async () => {
    const side = { kind: 'thread' as const, id: createThread(OWNER, SLUG, 'Side').id }
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)
    await submit('same text', MAIN_LANE, 'scope-msg-001')
    await submit('same text', MAIN_LANE, 'scope-msg-002')
    expect(laneTurnState(OWNER, SLUG).queued).toBe(2)
    // The same id in another lane is that lane's own message.
    const other = submit('same text', side, 'scope-msg-001', p)
    await p.arrived(2)
    expect(users(side)).toHaveLength(1)
    p.release()
    await first
    await other
    await p.arrived(3)
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    await whenLaneIdle(OWNER, SLUG, side)
    expect(users().map(m => m.content)).toEqual(['first', 'same text', 'same text'])
  })

  it('over HTTP: a repeated POST answers with the stored row (202 queued, then 200 delivered); a bad id is a 400', async () => {
    const p = gatedProvider()
    const first = turn('first', p)
    await p.arrived(1)
    const body = { text: 'retry me', client_msg_id: 'http-msg-0001' }
    const a = await call('POST', `/agents/${SLUG}/messages`, body)
    const b = await call('POST', `/agents/${SLUG}/messages`, body)
    expect(a.status).toBe(202)
    expect(a.json.duplicate).toBeUndefined()
    expect(b.status).toBe(202)
    expect(b.json).toMatchObject({ queued: true, duplicate: true, turn: { running: true, queued: 1 } })
    expect(b.json.messages[0].id).toBe(a.json.messages[0].id)
    expect(b.json.messages[0].meta).toMatchObject({ queued: true, client_msg_id: 'http-msg-0001' })

    const bad = await call('POST', `/agents/${SLUG}/messages`, { text: 'x', client_msg_id: 'no spaces allowed!' })
    expect(bad.status).toBe(400)
    const short = await call('POST', `/agents/${SLUG}/messages`, { text: 'x', client_msg_id: 42 })
    expect(short.status).toBe(400)

    p.release()
    await first
    await p.arrived(2)
    p.release()
    await whenLaneIdle(OWNER, SLUG)
    const c = await call('POST', `/agents/${SLUG}/messages`, body)
    expect(c.status).toBe(200)
    expect(c.json).toMatchObject({ queued: false, duplicate: true })
    const g = await call('GET', `/agents/${SLUG}/messages`)
    const mine = g.json.messages.filter((m: { content: string }) => m.content === 'retry me')
    expect(mine).toHaveLength(1)
    expect(mine[0].meta).toEqual({ client_msg_id: 'http-msg-0001' })
    expect(p.bodies).toHaveLength(2)
  })
})
