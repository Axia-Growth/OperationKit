import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * obj 901488 — three promises of the bot chat, each proven over HTTP against
 * the real route, the real engine and the real card-filing tool:
 *
 *   A. A turn that reaches the step limit still ANSWERS: one last model call
 *      with no tools writes what was done, and the person can press Continue.
 *      The red "Couldn't answer" row is not written for it.
 *   B. A message sent while the bot works is QUEUED and run after — never a
 *      second turn in parallel, never dropped. It can be removed before it
 *      runs, and after a Stop it waits for the person to confirm.
 *   C. NO DOUBLE RUNS. A re-send of a message the server already has (same id
 *      after a dropped request, or the same text again with a new id) starts
 *      no second turn and runs no tool a second time. No question is asked.
 *
 * The provider stub is the Anthropic HTTP API. Every request body that leaves
 * the process is recorded, and the stub counts how many requests are inside it
 * at once, so "one turn" and "no parallel turn" are measured, not assumed.
 */
process.env.JWT_SECRET = 'test-secret-step-limit-queue-x'
const TMP_DB = path.join(os.tmpdir(), `cc-chat-step-limit-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
// The HTTP route runs the turn with process.env and the global fetch.
process.env.ANTHROPIC_API_KEY = 'k'
process.env.AGENT_CHAT_PROVIDER = 'anthropic'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-step-limit-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-step-limit-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { SETTING_ENABLED, setTurnLimits } = await import('./long-turns.js')
const { listMessages, laneTurnState, stopTurn, whenLaneIdle, maxSteps, setSetting, MAX_STEPS, MAX_STEPS_CEILING, CONTINUE_TEXT, stepLimitList } = await import('./engine.js')
const { seedExistingBotsOnce } = await import('./bot-workspaces.js')
const { default: router } = await import('../../routes/agent-chat.js')

const OWNER = 2
const SLUG = 'helper'
const WS = 'growth'

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
type Body = { messages: { role: string; content: unknown }[]; tools?: unknown[] }
type Handler = (body: Body, n: number) => Block[] | Promise<Block[]>

// ── the provider stub ──
let handler: Handler | null = null
const bodies: Body[] = []
let inside = 0
let maxInside = 0
let gates: (() => void)[] = []
const arrivals: { n: number; resolve: () => void }[] = []
const realFetch = globalThis.fetch
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u.startsWith('http://127.0.0.1') || !handler) return realFetch(url, init)
  const body = JSON.parse(String(init?.body)) as Body
  bodies.push(body)
  const n = bodies.length
  inside++
  maxInside = Math.max(maxInside, inside)
  for (const w of arrivals.filter(x => n >= x.n)) w.resolve()
  try {
    const blocks = await Promise.race([
      Promise.resolve(handler(body, n)),
      new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })),
    ])
    return new Response(JSON.stringify({ content: blocks }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    if (err instanceof Response) return err
    throw err
  } finally {
    inside--
  }
}) as typeof fetch

/** Resolves once the provider has received its nth request. */
const arrived = (n: number) => new Promise<void>(resolve => (bodies.length >= n ? resolve() : arrivals.push({ n, resolve })))
/** A promise a handler can await: the request stays inside the provider until `release()`. */
const gate = () => new Promise<void>(resolve => { gates.push(resolve) })
const release = () => { const g = gates; gates = []; g.forEach(r => r()) }
const text = (t: string): Block[] => [{ type: 'text', text: t }]
const fileCard = (title: string, id = `t-${title}`): Block => ({ type: 'tool_use', id, name: 'create_objective', input: { title, description: `Do ${title}` } })

const flat = (b: Body) => JSON.stringify(b.messages)
const hasToolBlocks = (b: Body) => /"type":"tool_(use|result)"/.test(flat(b))

let server: http.Server
let baseUrl: string
const token = () => jwt.sign({ id: OWNER, username: 'user2', role: 'member' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })

async function call(method: string, p: string, body?: unknown) {
  const res = await realFetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token()}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const t = await res.text()
  return { status: res.status, json: t ? JSON.parse(t) : null }
}
const post = (body: Record<string, unknown>) => call('POST', `/agents/${SLUG}/messages`, body)

/** POST a chat message over a raw socket and hang up mid-turn: what the browser sees as a 524 / lost request. */
function postThenDrop(body: Record<string, unknown>) {
  const payload = JSON.stringify(body)
  const req = http.request(`${baseUrl}/api/agent-chat/agents/${SLUG}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: `token=${token()}` },
  })
  let answered = false
  req.on('response', () => { answered = true })
  req.on('error', () => { /* we hung up on purpose */ })
  req.end(payload)
  return { drop: () => req.destroy(), answered: () => answered }
}
const settle = (ms = 50) => new Promise(r => setTimeout(r, ms))

const lane = () => listMessages(OWNER, SLUG)
const roles = () => lane().map(m => m.role)
const users = () => lane().filter(m => m.role === 'user')
const toolRows = () => lane().filter(m => m.role === 'tool')
const cardsFiled = () => (getDb().prepare(`SELECT title FROM objectives WHERE workspace = ? ORDER BY id`).all(WS) as { title: string }[]).map(r => r.title)

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, ?)`).run(WS, WS)
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(OWNER, WS)
  seedExistingBotsOnce([SLUG])
  fs.mkdirSync(path.join(TMP_AGENTS, SLUG))
  fs.writeFileSync(
    path.join(TMP_AGENTS, SLUG, 'agent.yaml'),
    'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools:\n  - create_objective\ncolour: blue\nversion: 1.0.0\nauthor: Test\nprovider: anthropic\n',
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
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare('DELETE FROM objectives').run()
  // Card filing has its own replay guard (same title + description = the card already filed); start each case clean.
  db.prepare('DELETE FROM bot_job_origins').run()
  db.prepare(`DELETE FROM settings WHERE key = 'agent_chat_max_steps'`).run()
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(SETTING_ENABLED)
  db.prepare('DELETE FROM agent_chat_turn_limits').run()
  bodies.length = 0
  arrivals.length = 0
  inside = 0
  maxInside = 0
  handler = null
  delete process.env.AGENT_CHAT_MAX_STEPS
  delete process.env.AGENT_CHAT_DUPLICATE_WINDOW_MS
})

// A failed assertion must not leave a turn parked in a gate for the next case.
afterEach(async () => {
  stopTurn(OWNER, SLUG, undefined, { dropQueued: true })
  release()
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

describe('A. a turn that reaches the step limit still answers (obj 901488)', () => {
  // The step-limit summary is the ending of a turn that runs WITHOUT a long-reply
  // budget (obj 901491 switched off; bot-to-bot and card wakes use the same loop).
  // With the budget on (the default) the turn ends with the long-reply limit
  // report instead: see "with long replies on" below.
  beforeEach(() => setSetting(SETTING_ENABLED, '0'))

  it('writes a summary with one last no-tools model call, stored as a normal answer marked step_limit — no red error row', async () => {
    process.env.AGENT_CHAT_MAX_STEPS = '3'
    // The model never stops asking for tools: three steps, one card each.
    handler = (b, n) => (n <= 3 ? [fileCard(`card ${n}`)] : text('**Done** – filed 3 cards.\n**Not done** – the deploy.\n**Next step** – deploy.'))
    const r = await post({ text: 'file the cards then deploy' })

    expect(r.status).toBe(200)
    expect(r.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'tool', 'tool', 'tool', 'assistant'])
    const answer = r.json.messages.at(-1)
    expect(answer.content).toContain('filed 3 cards')
    expect(answer.meta).toMatchObject({ kind: 'step_limit', steps: 3, summary_by: 'model' })
    // Nothing red: no error row, and the old dead-end sentence is gone.
    expect(roles()).not.toContain('error')
    expect(JSON.stringify(lane())).not.toMatch(/without a final answer/)

    // Exactly 3 tool steps + 1 summary call. The summary call carries NO tools
    // and no tool blocks, and is told what the turn did.
    expect(bodies).toHaveLength(4)
    for (const b of bodies.slice(0, 3)) expect(b.tools?.length).toBeGreaterThan(0)
    expect(bodies[3].tools ?? []).toHaveLength(0)
    expect(hasToolBlocks(bodies[3])).toBe(false)
    expect(flat(bodies[3])).toContain('used all 3 steps')
    expect(flat(bodies[3])).toContain('create_objective')
    expect(flat(bodies[3])).toContain('file the cards then deploy')
    // The work itself happened once.
    expect(cardsFiled()).toEqual(['card 1', 'card 2', 'card 3'])
  })

  it('still answers when the summary call itself fails: the turn\'s own tool lines are listed', async () => {
    process.env.AGENT_CHAT_MAX_STEPS = '2'
    handler = (b, n) => {
      if (n <= 2) return [fileCard(`card ${n}`)]
      throw new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 500 })
    }
    const r = await post({ text: 'do the thing' })
    expect(r.status).toBe(200)
    const answer = r.json.messages.at(-1)
    expect(answer.role).toBe('assistant')
    expect(answer.meta).toMatchObject({ kind: 'step_limit', steps: 2, summary_by: 'list' })
    expect(answer.content).toContain('Created card #')
    expect(answer.content).toContain('card 1')
    expect(answer.content).toContain('card 2')
    expect(answer.content).toContain('Continue')
    expect(roles()).not.toContain('error')
  })

  it('a step is one model call, not one tool call: a single step may run several tools', async () => {
    process.env.AGENT_CHAT_MAX_STEPS = '1'
    handler = (b, n) => (n === 1 ? [fileCard('a'), fileCard('b'), fileCard('c')] : text('Filed a, b and c.'))
    const r = await post({ text: 'three at once' })
    expect(toolRows()).toHaveLength(3)
    expect(r.json.messages.at(-1).meta).toMatchObject({ kind: 'step_limit', steps: 1 })
  })

  it('Continue resumes with a new turn that sees what was done; pressing it twice runs once', async () => {
    process.env.AGENT_CHAT_MAX_STEPS = '2'
    handler = (b, n) => (n <= 2 ? [fileCard(`card ${n}`)] : n === 3 ? text('Done: 2 cards. Not done: card 3.') : n === 4 ? [fileCard('card 3')] : text('All three cards are filed.'))
    const first = await post({ text: 'file three cards' })
    const summary = first.json.messages.at(-1)
    expect(summary.meta.kind).toBe('step_limit')

    const [c1, c2] = await Promise.all([
      post({ continue_from: summary.id, client_msg_id: 'continue-press-1' }),
      post({ continue_from: summary.id, client_msg_id: 'continue-press-2' }),
    ])
    await whenLaneIdle(OWNER, SLUG)
    // One of the two presses ran the turn; the other was recognised as the same press.
    expect([c1.json.duplicate ?? false, c2.json.duplicate ?? false].sort()).toEqual([false, true])
    const ran = c1.json.duplicate ? c2 : c1
    expect(ran.status).toBe(200)
    expect(ran.json.messages[0]).toMatchObject({ role: 'user', content: CONTINUE_TEXT, meta: { kind: 'continue', continue_from: summary.id } })
    expect(ran.json.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'All three cards are filed.' })
    expect(users().map(m => m.content)).toEqual(['file three cards', CONTINUE_TEXT])
    // The resumed turn was told what already happened (summary + the earlier tool lines).
    expect(flat(bodies[3])).toContain('Done: 2 cards')
    expect(flat(bodies[3])).toContain('card 1')
    expect(bodies).toHaveLength(5)
    expect(cardsFiled()).toEqual(['card 1', 'card 2', 'card 3'])

    // A third press, later, is still the same press.
    const again = await post({ continue_from: summary.id })
    expect(again.json).toMatchObject({ duplicate: true, duplicate_state: 'answered', duplicate_by: 'continue' })
    expect(bodies).toHaveLength(5)
  })

  it('with long replies on (the default): the limit report is a normal answer, and Continue resumes from it once', async () => {
    getDb().prepare(`DELETE FROM settings WHERE key = ?`).run(SETTING_ENABLED)
    setTurnLimits(SLUG, { max_steps: 8 }, OWNER)
    handler = (b, n) => (n <= 8 ? [fileCard(`card ${n}`)] : n === 9 ? [fileCard('card 9')] : text('All nine cards are filed.'))
    const first = await post({ text: 'file nine cards' })
    await whenLaneIdle(OWNER, SLUG)
    expect(first.status).toBe(200)
    const report = lane().at(-1)!
    expect(report).toMatchObject({ role: 'assistant', meta: { kind: 'turn_limit', limit: 'steps' } })
    expect(report.content).toContain('**Done so far** (8 actions)')
    expect(roles()).not.toContain('error')
    // The budget is spent on tool steps only: no extra model call for the report.
    expect(bodies).toHaveLength(8)

    const [c1, c2] = await Promise.all([
      post({ continue_from: report.id, client_msg_id: 'continue-long-1' }),
      post({ continue_from: report.id, client_msg_id: 'continue-long-2' }),
    ])
    await whenLaneIdle(OWNER, SLUG)
    expect([c1.json.duplicate ?? false, c2.json.duplicate ?? false].sort()).toEqual([false, true])
    expect(users().map(m => m.content)).toEqual(['file nine cards', CONTINUE_TEXT])
    expect(lane().at(-1)).toMatchObject({ role: 'assistant', content: 'All nine cards are filed.' })
    expect(bodies).toHaveLength(10)
    expect(cardsFiled()).toHaveLength(9)
  })

  it('Continue is refused for anything that is not the newest step-limit answer', async () => {
    process.env.AGENT_CHAT_MAX_STEPS = '1'
    handler = (b, n) => (n === 1 ? [fileCard('x')] : text(`answer ${n}`))
    const first = await post({ text: 'go' })
    const summary = first.json.messages.at(-1)
    const userRow = first.json.messages[0]
    expect((await post({ continue_from: userRow.id })).status).toBe(409)
    expect((await post({ continue_from: 'abc' })).status).toBe(400)
    // The person moved on: the old answer can no longer be continued.
    handler = () => text('ok')
    await post({ text: 'never mind, something else' })
    const late = await post({ continue_from: summary.id })
    expect(late.status).toBe(409)
    expect(late.json.code).toBe('nothing_to_continue')
  })

  it('a real failure with nothing to report is still an error row', async () => {
    handler = () => { throw new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 }) }
    await post({ text: 'hello' })
    expect(roles()).toEqual(['user', 'error'])
  })

  it('the limit is 8 unless the install changes it (setting, then env); nonsense values are ignored', () => {
    expect(MAX_STEPS).toBe(8)
    expect(maxSteps({} as NodeJS.ProcessEnv)).toBe(8)
    expect(maxSteps({ AGENT_CHAT_MAX_STEPS: '20' } as NodeJS.ProcessEnv)).toBe(20)
    for (const bad of ['0', '-3', '2.5', 'lots', '', String(MAX_STEPS_CEILING + 1)]) expect(maxSteps({ AGENT_CHAT_MAX_STEPS: bad } as NodeJS.ProcessEnv)).toBe(8)
    setSetting('agent_chat_max_steps', '12')
    expect(maxSteps({ AGENT_CHAT_MAX_STEPS: '20' } as NodeJS.ProcessEnv)).toBe(12)
    setSetting('agent_chat_max_steps', 'many')
    expect(maxSteps({ AGENT_CHAT_MAX_STEPS: '20' } as NodeJS.ProcessEnv)).toBe(20)
  })

  it('the fallback list names what ran, marks failures, and says how to go on', () => {
    const out = stepLimitList([{ name: 'read_file', summary: 'Read decisions/x.md', ok: true }, { name: 'merge_pr', summary: 'PR is not passed', ok: false }])
    expect(out).toContain('**read_file**: Read decisions/x.md')
    expect(out).toContain('(failed) **merge_pr**: PR is not passed')
    expect(out).toContain('Continue')
  })
})

describe('B. a message sent while the bot works is queued (obj 901488)', () => {
  it('is accepted (202, "queued"), runs after the current turn, and never in parallel with it', async () => {
    handler = async (b, n) => { await gate(); return text(`answer ${n}`) }
    const first = post({ text: 'first job' })
    await arrived(1)

    const q = await post({ text: 'second job' })
    expect(q.status).toBe(202)
    expect(q.json.queued).toBe(true)
    expect(q.json.messages[0]).toMatchObject({ content: 'second job', meta: { queued: true } })
    expect(q.json.turn).toEqual({ running: true, queued: 1, held: 0 })
    // The queued message did not start a turn of its own.
    await settle()
    expect(bodies).toHaveLength(1)

    release()
    expect((await first).status).toBe(200)
    await arrived(2)
    // Only now does the model see it — after the first answer.
    expect(flat(bodies[1])).toContain('second job')
    expect(flat(bodies[1])).toContain('answer 1')
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(roles()).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(users().map(m => m.content)).toEqual(['first job', 'second job'])
    expect(users().every(m => !m.meta?.queued)).toBe(true)
    // At no point were two model requests in flight for this conversation.
    expect(maxInside).toBe(1)
  })

  it('a queued message can be removed before it runs; one the bot already picked up cannot', async () => {
    handler = async (b, n) => { await gate(); return text(`answer ${n}`) }
    const first = post({ text: 'first job' })
    await arrived(1)
    const keep = await post({ text: 'keep me' })
    const drop = await post({ text: 'remove me' })

    const del = await call('DELETE', `/agents/${SLUG}/queued/${drop.json.messages[0].id}`)
    expect(del.status).toBe(200)
    expect(del.json.turn).toEqual({ running: true, queued: 1, held: 0 })

    release()
    await first
    await arrived(2)
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(users().map(m => m.content)).toEqual(['first job', 'keep me'])
    expect(JSON.stringify(bodies)).not.toContain('remove me')
    // Already delivered (or never queued): refused, nothing deleted.
    const delivered = users()[1]
    expect((await call('DELETE', `/agents/${SLUG}/queued/${delivered.id}`)).status).toBe(409)
    expect((await call('DELETE', `/agents/${SLUG}/queued/${keep.json.messages[0].id}`)).status).toBe(409)
    expect(users()).toHaveLength(2)
  })

  it('after Stop, queued messages wait for the person: not delivered until confirmed, and a new message does not carry them along', async () => {
    handler = async (b, n) => { await gate(); return text(`answer ${n}`) }
    const first = post({ text: 'long job' })
    await arrived(1)
    await post({ text: 'also deploy it' })

    const s = await call('POST', `/agents/${SLUG}/stop`, {})
    expect(s.json).toMatchObject({ stopped: true, dropped: 0, turn: { queued: 1, held: 1 } })
    await first
    await whenLaneIdle(OWNER, SLUG)
    // Reading the lane does not deliver a held message.
    const g = await call('GET', `/agents/${SLUG}/messages`)
    expect(g.json.turn).toEqual({ running: false, queued: 1, held: 1 })
    await settle()
    expect(bodies).toHaveLength(1)

    // A new message runs on its own; the held one is not slipped in with it.
    const next = post({ text: 'wait, do not deploy' })
    await arrived(2)
    expect(flat(bodies[1])).toContain('wait, do not deploy')
    expect(flat(bodies[1])).not.toContain('also deploy it')
    release()
    await next
    await whenLaneIdle(OWNER, SLUG)
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: false, queued: 1, held: 1 })
    expect(bodies).toHaveLength(2)

    // The person confirms: now it is delivered.
    const rel = await call('POST', `/agents/${SLUG}/queued/release`, {})
    expect(rel.json.released).toBe(1)
    await arrived(3)
    expect(flat(bodies[2])).toContain('also deploy it')
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: false, queued: 0, held: 0 })
    expect(users().map(m => m.content)).toEqual(['long job', 'wait, do not deploy', 'also deploy it'])
  })
})

describe('C. no double runs (obj 901488)', () => {
  it('a re-send after a simulated 524 produces exactly one turn and one set of tool calls — by the same id, or by the same text with a new id', async () => {
    // Turn = one tool step (files a card: the stand-in for a merge or a deploy), then the answer.
    handler = async (b, n) => {
      if (n === 1) { await gate(); return [fileCard('merge and deploy')] }
      if (n === 2) { await gate(); return text('Merged and deployed.') }
      return text(`UNEXPECTED model call ${n}`)
    }
    // The browser's request dies mid-turn (Cloudflare 524): it never gets an answer.
    const lost = postThenDrop({ text: 'merge the PRs and deploy', client_msg_id: 'send-0000001' })
    await arrived(1)
    lost.drop()
    await settle()
    expect(lost.answered()).toBe(false)
    expect(laneTurnState(OWNER, SLUG).running).toBe(true)

    // 1. The browser retries the SAME send (same id) while the turn is still running.
    const retry = await post({ text: 'merge the PRs and deploy', client_msg_id: 'send-0000001' })
    expect(retry.status).toBe(200)
    expect(retry.json).toMatchObject({ duplicate: true, duplicate_state: 'running', duplicate_by: 'id', queued: false, turn: { running: true, queued: 0 } })
    expect(retry.json.messages[0]).toMatchObject({ role: 'user', content: 'merge the PRs and deploy' })

    // 2. The person presses Send again on the same words (a NEW id), still mid-turn.
    const again = await post({ text: 'merge the PRs and deploy', client_msg_id: 'send-0000002' })
    expect(again.status).toBe(200)
    expect(again.json).toMatchObject({ duplicate: true, duplicate_state: 'running', duplicate_by: 'text', queued: false })
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: true, queued: 0, held: 0 })

    release() // the tool step
    await arrived(2)
    release() // the answer
    await whenLaneIdle(OWNER, SLUG)

    // 3. And once more just after it finished: the answer is handed back, nothing runs.
    const after = await post({ text: 'merge the PRs and deploy', client_msg_id: 'send-0000003' })
    expect(after.status).toBe(200)
    expect(after.json).toMatchObject({ duplicate: true, duplicate_state: 'answered', duplicate_by: 'text' })
    expect(after.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(after.json.messages.at(-1).content).toBe('Merged and deployed.')
    await whenLaneIdle(OWNER, SLUG)

    // ONE turn: one user row, one tool call, one answer, two model calls, one card.
    expect(roles()).toEqual(['user', 'tool', 'assistant'])
    expect(bodies).toHaveLength(2)
    expect(cardsFiled()).toEqual(['merge and deploy'])
    expect(maxInside).toBe(1)
    // The same-words repeats are marked `duplicate_by: 'text'`: that is what makes the page ask
    // "This already went through. Send again?" instead of running anything.
  })

  it('after the page asked "Send again?" and the person said yes (send_again), the repeat is accepted: queued mid-turn, run once after', async () => {
    handler = async (b, n) => { await gate(); return text(`answer ${n}`) }
    const first = post({ text: 'merge the PRs and deploy', client_msg_id: 'again-000001' })
    await arrived(1)
    // Without the yes: matched, nothing stored, nothing run.
    const asked = await post({ text: 'merge the PRs and deploy', client_msg_id: 'again-000002' })
    expect(asked.json).toMatchObject({ duplicate: true, duplicate_state: 'running', duplicate_by: 'text' })
    expect(laneTurnState(OWNER, SLUG).queued).toBe(0)
    // With the yes: a second message, queued behind the running turn (never a parallel turn).
    const yes = await post({ text: 'merge the PRs and deploy', client_msg_id: 'again-000003', send_again: true })
    expect(yes.status).toBe(202)
    expect(yes.json.duplicate).toBeUndefined()
    expect(yes.json.queued).toBe(true)
    expect(laneTurnState(OWNER, SLUG)).toMatchObject({ running: true, queued: 1 })
    // A browser retry of THAT send (same id) is still one message, even with send_again.
    const retried = await post({ text: 'merge the PRs and deploy', client_msg_id: 'again-000003', send_again: true })
    expect(retried.json).toMatchObject({ duplicate: true, duplicate_by: 'id', duplicate_state: 'queued' })
    expect(laneTurnState(OWNER, SLUG).queued).toBe(1)
    release()
    await first
    await arrived(2)
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(users().map(m => m.content)).toEqual(['merge the PRs and deploy', 'merge the PRs and deploy'])
    expect(bodies).toHaveLength(2)
  })

  it('the same text queued twice behind a running turn is one queued message', async () => {
    handler = async (b, n) => { await gate(); return text(`answer ${n}`) }
    const first = post({ text: 'first job' })
    await arrived(1)
    const a = await post({ text: 'then deploy', client_msg_id: 'queue-000001' })
    const b = await post({ text: 'then deploy', client_msg_id: 'queue-000002' })
    expect(a.status).toBe(202)
    expect(b.status).toBe(202)
    expect(b.json).toMatchObject({ duplicate: true, duplicate_state: 'queued', duplicate_by: 'text', queued: true })
    expect(b.json.messages[0].id).toBe(a.json.messages[0].id)
    expect(laneTurnState(OWNER, SLUG).queued).toBe(1)
    release()
    await first
    await arrived(2)
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(users().map(m => m.content)).toEqual(['first job', 'then deploy'])
    expect(bodies).toHaveLength(2)
  })

  it('a real intentional repeat runs normally: after another message, or after the window', async () => {
    handler = (b, n) => text(`answer ${n}`)
    const Q = 'what is the status of the deploy?'
    await post({ text: Q })
    // Something else came between → the same words are a new message.
    await post({ text: 'thanks' })
    const repeat = await post({ text: Q })
    expect(repeat.json.duplicate).toBeUndefined()
    expect(repeat.json.messages.at(-1).content).toBe('answer 3')

    // Nothing between and inside the window → the same message. Once the window has passed → a new one.
    const stillDup = await post({ text: Q })
    expect(stillDup.json).toMatchObject({ duplicate: true, duplicate_state: 'answered' })
    const later0 = bodies.length
    process.env.AGENT_CHAT_DUPLICATE_WINDOW_MS = '1'
    await settle(20)
    const later = await post({ text: Q })
    expect(bodies.length).toBe(later0 + 1)
    expect(later.json.duplicate).toBeUndefined()
    expect(later.json.messages.at(-1).content).toBe('answer 4')
    expect(users().map(m => m.content)).toEqual([Q, 'thanks', Q, Q])
    expect(bodies).toHaveLength(4)
  })

  it('the same words after a FAILED or STOPPED turn are an honest retry, and run', async () => {
    let fail = true
    handler = async (b, n) => {
      if (fail) throw new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 })
      await gate()
      return text(`answer ${n}`)
    }
    await post({ text: 'do it' })
    expect(roles()).toEqual(['user', 'error'])
    fail = false
    const retry = post({ text: 'do it' })
    await arrived(2)
    // It is running (not swallowed). Stop it, then send the same words again.
    await call('POST', `/agents/${SLUG}/stop`, {})
    await retry
    await whenLaneIdle(OWNER, SLUG)
    const third = post({ text: 'do it' })
    await arrived(3)
    release()
    const r = await third
    expect(r.json.duplicate).toBeUndefined()
    expect(r.json.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'answer 3' })
    expect(users()).toHaveLength(3)
  })

  it('a short reply repeated after an answer runs: "yes" to the next question is not a duplicate', async () => {
    handler = (b, n) => text(n === 1 ? 'Merge PR 904?' : 'Merged. Deploy it too?')
    await post({ text: 'yes' })
    const second = await post({ text: 'yes' })
    expect(second.json.duplicate).toBeUndefined()
    expect(users()).toHaveLength(2)
    expect(bodies).toHaveLength(2)
  })

  it('the check can be switched off', async () => {
    process.env.AGENT_CHAT_DUPLICATE_WINDOW_MS = '0'
    handler = (b, n) => text(`answer ${n}`)
    await post({ text: 'run the long job once more' })
    const second = await post({ text: 'run the long job once more' })
    expect(second.json.duplicate).toBeUndefined()
    expect(bodies).toHaveLength(2)
  })
})
