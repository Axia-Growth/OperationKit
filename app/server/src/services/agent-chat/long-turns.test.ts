import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

/*
 * Long chat turns run as a background job — obj 901491.
 *
 * Before: a chat turn died at 8 model rounds ("Stopped after 8 steps without a
 * final answer") and its HTTP request stayed open for the whole turn, so the
 * proxy in front answered 524 at about 100 seconds. Now:
 *
 *   1. A turn runs under the bot's budget (default 60 steps / 30 minutes). The
 *      request that started it answers "working on it" after a short wait and
 *      the turn carries on server-side; its tool lines and its final answer
 *      land in the same chat lane.
 *   2. A turn that runs out of steps or time posts what it did, what it did
 *      not do and the next step — never a bare error.
 *   3. A turn cut off by a restart gets the same report on the next boot.
 *   4. The budget is per bot, set by an admin in the browser only.
 *   5. Nothing about what the turn may do changes: the model is offered the
 *      very same tools on step 30 as on step 1.
 *
 * Time is a VIRTUAL clock the provider stub advances on every model call, so
 * "seven minutes" costs milliseconds. The provider is the Anthropic HTTP
 * adapter with a stubbed fetch: the bodies asserted on are what really left.
 */
process.env.JWT_SECRET = 'test-secret-long-turns-xxxxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-long-turns-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.ANTHROPIC_API_KEY = 'k'
process.env.AGENT_CHAT_PROVIDER = 'anthropic'
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-long-turns-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-long-turns-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, laneTurnState, laneTurnJob, stopTurn, submitMessage, whenLaneIdle, setSetting } = await import('./engine.js')
const { MAIN_LANE } = await import('./threads.js')
const { getTurnJob, recoverInterruptedTurns, setTurnLimits, turnBudgetFor, turnStopReport, SETTING_ENABLED, SETTING_FOREGROUND_SECONDS } = await import('./long-turns.js')
const { default: router } = await import('../../routes/agent-chat.js')

const OWNER = 2
const ADMIN = 3
const SLUG = 'helper'
const ENV = { ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv

type Body = { messages: { role: string; content: unknown }[]; tools?: unknown[] }

/** A clock the test owns. It starts at the real time and only moves when told to. */
function virtualClock() {
  let t = Date.now()
  const start = t
  return { now: () => new Date(t), advance: (seconds: number) => { t += seconds * 1000 }, elapsedSeconds: () => (t - start) / 1000 }
}

/**
 * A model that calls one tool per round for `toolRounds` rounds, then answers.
 * Every call moves the virtual clock on by `secondsPerCall` (a model call plus
 * its tool) and takes a few real milliseconds, so a background turn is really
 * still running when the foreground wait ends.
 */
function workingModel(p: { toolRounds: number; secondsPerCall: number; clock: ReturnType<typeof virtualClock>; answer?: string; hold?: Promise<void> }) {
  const bodies: Body[] = []
  const f = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Body
    bodies.push(body)
    const n = bodies.length
    if (p.hold) await p.hold
    await new Promise(r => setTimeout(r, 3))
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    p.clock.advance(p.secondsPerCall)
    const content =
      n <= p.toolRounds
        ? [{ type: 'tool_use', id: `call_${n}`, name: 'list_folders', input: {} }]
        : [{ type: 'text', text: p.answer ?? 'All done.' }]
    return new Response(JSON.stringify({ content }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: f, bodies }
}

const agent = () => ({ ...findAgent(SLUG)!, provider: 'anthropic' as const })
const lane = () => listMessages(OWNER, SLUG, { lane: MAIN_LANE, limit: 500 })
const jobs = () => getDb().prepare('SELECT * FROM agent_chat_turn_jobs ORDER BY id').all() as Record<string, unknown>[]

function submit(text: string, model: ReturnType<typeof workingModel>, clock: ReturnType<typeof virtualClock>, foregroundMs = 15) {
  return submitMessage({ userId: OWNER, username: 'user2', agent: agent(), text, env: ENV, deps: { fetch: model.fetch }, now: clock.now, foregroundMs })
}

let server: http.Server
let baseUrl: string
// The HTTP route runs a turn with process.env and the global fetch: route model calls to the active stub.
let activeProvider: typeof fetch | null = null
const realFetch = globalThis.fetch
globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
  const u = String(url instanceof Request ? url.url : url)
  if (u.startsWith('http://127.0.0.1') || !activeProvider) return realFetch(url, init)
  return activeProvider(u, init as RequestInit)
}) as typeof fetch

async function call(method: string, p: string, body?: unknown, as: { id: number; username: string; role: string } = { id: OWNER, username: 'user2', role: 'member' }) {
  const token = jwt.sign(as, process.env.JWT_SECRET as string, { expiresIn: '1h' })
  const res = await fetch(`${baseUrl}/api/agent-chat${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `token=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, json: text ? JSON.parse(text) : null }
}
const asAdmin = { id: ADMIN, username: 'boss', role: 'admin' }

beforeAll(async () => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'boss', 'x', 'admin')`).run(ADMIN)
  fs.mkdirSync(path.join(TMP_AGENTS, SLUG))
  fs.writeFileSync(
    path.join(TMP_AGENTS, SLUG, 'agent.yaml'),
    'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools:\n  - list_folders\ncolour: blue\nversion: 1.0.0\nauthor: Test\nprovider: anthropic\n',
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
  db.prepare('DELETE FROM agent_chat_turn_jobs').run()
  db.prepare('DELETE FROM agent_chat_turn_limits').run()
  db.prepare('DELETE FROM settings WHERE key LIKE ?').run('agent_chat_turn_%')
  db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_ENABLED)
  activeProvider = null
})

afterEach(async () => {
  stopTurn(OWNER, SLUG, MAIN_LANE, { dropQueued: true })
  await whenLaneIdle(OWNER, SLUG)
})

afterAll(async () => {
  globalThis.fetch = realFetch
  await new Promise<void>(resolve => server.close(() => resolve()))
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('a long chat turn finishes as a background job (obj 901491)', () => {
  it('35 tool steps over 7 minutes: the request returns at once, the answer is posted in the chat, no "Stopped after 8 steps"', async () => {
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 35, secondsPerCall: 12, clock, answer: 'All ten pull requests are merged.' })

    const r = await submit('merge the ten open PRs', model, clock)

    // The caller is answered while the turn is still working: this is the
    // response the browser gets instead of waiting for a proxy to give up (524).
    expect(r.queued).toBe(false)
    expect(r.background).toBe(true)
    expect(r.messages.map(m => m.role)).toContain('user')
    expect(r.messages.some(m => m.role === 'assistant')).toBe(false)
    const mid = laneTurnState(OWNER, SLUG)
    expect(mid.running).toBe(true)
    expect(laneTurnJob(OWNER, SLUG)).toMatchObject({ background: true, max_steps: 60, max_minutes: 30 })

    await whenLaneIdle(OWNER, SLUG)

    const rows = lane()
    // Progress: one line per tool action, in the lane, in order, before the answer.
    const tools = rows.filter(m => m.role === 'tool')
    expect(tools).toHaveLength(35)
    expect(tools.every(m => m.tool_name === 'list_folders')).toBe(true)
    // The result is a normal bot message in the same chat.
    const last = rows.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('All ten pull requests are merged.')
    expect(last.meta?.kind).toBeUndefined()
    // No dead turn: no error line at all, and not the old one.
    expect(rows.filter(m => m.role === 'error')).toEqual([])
    expect(rows.some(m => /Stopped after \d+ steps/.test(m.content))).toBe(false)
    // It really was long: 36 model calls, more than five minutes on the turn's clock.
    expect(model.bodies).toHaveLength(36)
    expect(clock.elapsedSeconds()).toBeGreaterThanOrEqual(5 * 60)
    expect(laneTurnState(OWNER, SLUG)).toEqual({ running: false, queued: 0, held: 0 })

    // The turn-level record: who, which bot, the budget, how far, how it ended.
    const [job] = jobs()
    expect(job).toMatchObject({ user_id: OWNER, agent_slug: SLUG, thread_id: null, status: 'answered', background: 1, max_steps: 60, max_seconds: 1800, steps: 36, tool_calls: 35, limit_reason: null })
    expect(job.finished_at).toBeTruthy()
    expect(job.detached_at).toBeTruthy()
  })

  it('keeps every wall: the model is offered exactly the same tools on step 30 as on step 1', async () => {
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 31, secondsPerCall: 10, clock })
    const r = await submit('do a long job', model, clock)
    expect(r.background).toBe(true)
    await whenLaneIdle(OWNER, SLUG)
    expect(model.bodies[0].tools).toBeTruthy()
    expect(model.bodies[29].tools).toEqual(model.bodies[0].tools)
    // A turn started through submitMessage with no browser session is recorded as such.
    expect(jobs()[0].browser_session).toBe(0)
  })

  it('a short turn is answered in the request, as before', async () => {
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 1, secondsPerCall: 2, clock, answer: 'Here you go.' })
    const r = await submit('quick one', model, clock, 5000)
    expect(r.background).toBeUndefined()
    expect(r.messages.map(m => m.role)).toEqual(['user', 'tool', 'assistant'])
    expect(r.messages.at(-1)!.content).toBe('Here you go.')
    expect(jobs()[0]).toMatchObject({ status: 'answered', background: 0, steps: 2, tool_calls: 1 })
  })

  it('Stop still stops a background turn', async () => {
    const clock = virtualClock()
    let release: () => void = () => {}
    const hold = new Promise<void>(resolve => { release = resolve })
    const model = workingModel({ toolRounds: 5, secondsPerCall: 5, clock, hold })
    const r = await submit('long job', model, clock)
    expect(r.background).toBe(true)
    expect(stopTurn(OWNER, SLUG).stopped).toBe(true)
    release()
    await whenLaneIdle(OWNER, SLUG)
    expect(lane().at(-1)).toMatchObject({ role: 'error', meta: { kind: 'stopped' } })
    expect(jobs()[0].status).toBe('stopped')
  })
})

describe('a turn that reaches its limit never ends silently (obj 901491)', () => {
  it('step limit: posts what it did, what it did not do and the next step, as a bot message', async () => {
    setTurnLimits(SLUG, { max_steps: 8 }, ADMIN)
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 999, secondsPerCall: 5, clock })

    const r = await submit('merge everything', model, clock, 5000)

    expect(model.bodies).toHaveLength(8)
    const last = r.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.meta).toMatchObject({ kind: 'turn_limit', limit: 'steps' })
    expect(last.content).toContain('step limit (8 steps)')
    expect(last.content).toContain('**Done so far** (8 actions)')
    expect(last.content).toContain('- list_folders: ')
    expect(last.content).toContain('**Not done:**')
    expect(last.content).toContain('**Next step:** send "continue"')
    // Not the old red box.
    expect(r.messages.filter(m => m.role === 'error')).toEqual([])
    expect(jobs()[0]).toMatchObject({ status: 'limit', limit_reason: 'steps', steps: 8, tool_calls: 8 })
    expect(last.meta?.turn_job_id).toBe(jobs()[0].id)
  })

  it('time limit: stops between actions and reports the same way', async () => {
    setTurnLimits(SLUG, { max_minutes: 2 }, ADMIN)
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 999, secondsPerCall: 45, clock })

    const r = await submit('merge everything', model, clock, 5000)

    // 45 s a round against a 2-minute budget: the third round crosses it.
    expect(model.bodies.length).toBeLessThanOrEqual(4)
    const last = r.messages.at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.meta).toMatchObject({ kind: 'turn_limit', limit: 'time' })
    expect(last.content).toContain('time limit (2 minutes)')
    expect(last.content).toContain('**Done so far**')
    expect(last.content).toContain('**Next step:**')
    expect(jobs()[0]).toMatchObject({ status: 'limit', limit_reason: 'time' })
  })

  it('"continue" after a limit starts a fresh budget and the model sees the report as history', async () => {
    setTurnLimits(SLUG, { max_steps: 8 }, ADMIN)
    const clock = virtualClock()
    await submit('merge everything', workingModel({ toolRounds: 999, secondsPerCall: 5, clock }), clock, 5000)
    const next = workingModel({ toolRounds: 2, secondsPerCall: 5, clock, answer: 'Finished the rest.' })
    const r = await submit('continue', next, clock, 5000)
    expect(r.messages.at(-1)!.content).toBe('Finished the rest.')
    expect(JSON.stringify(next.bodies[0].messages)).toContain('step limit (8 steps)')
    expect(jobs().map(j => j.status)).toEqual(['limit', 'answered'])
  })

  it('a turn cut off by a restart is closed with a report on the next boot, once', async () => {
    const db = getDb()
    const first = Number(db.prepare(`INSERT INTO agent_chat_messages (user_id, agent_slug, role, content) VALUES (?, ?, 'user', 'merge the ten PRs')`).run(OWNER, SLUG).lastInsertRowid)
    db.prepare(`INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, tool_name, meta) VALUES (?, ?, 'tool', 'Merged PR 901', 'dev_merge_pr', '{"ok":true}')`).run(OWNER, SLUG)
    db.prepare(`INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, tool_name, meta) VALUES (?, ?, 'tool', 'PR 902 is behind main', 'dev_merge_pr', '{"ok":false}')`).run(OWNER, SLUG)
    const jobId = Number(db.prepare(`INSERT INTO agent_chat_turn_jobs (user_id, agent_slug, thread_id, max_steps, max_seconds, background, first_message_id) VALUES (?, ?, NULL, 60, 1800, 1, ?)`).run(OWNER, SLUG, first).lastInsertRowid)

    const notified: string[] = []
    expect(recoverInterruptedTurns((u, s) => notified.push(`${u}:${s}`))).toBe(1)

    const last = lane().at(-1)!
    expect(last.role).toBe('assistant')
    expect(last.meta).toMatchObject({ kind: 'turn_interrupted', turn_job_id: jobId })
    expect(last.content).toContain('The server restarted')
    expect(last.content).toContain('**Done so far** (2 actions, 1 failed)')
    expect(last.content).toContain('- dev_merge_pr: Merged PR 901')
    expect(last.content).toContain('- FAILED: dev_merge_pr: PR 902 is behind main')
    expect(last.content).toContain('may or may not have gone through')
    expect(getTurnJob(jobId)).toMatchObject({ status: 'interrupted', note: 'server restart' })
    expect(notified).toEqual([`${OWNER}:${SLUG}`])
    // A second boot (or a second call) posts nothing more.
    expect(recoverInterruptedTurns()).toBe(0)
    expect(lane().filter(m => m.meta?.kind === 'turn_interrupted')).toHaveLength(1)
  })

  it('the report keeps the last 15 actions and says how many came before', () => {
    const done = Array.from({ length: 40 }, (_, i) => ({ tool: 'dev_merge_pr', summary: `action ${i + 1}`, ok: true }))
    const text = turnStopReport({ why: 'steps', budget: { maxSteps: 60, maxSeconds: 1800 }, done })
    expect(text).toContain('**Done so far** (40 actions)')
    expect(text).toContain('(25 earlier actions are in the chat above)')
    expect(text).toContain('- dev_merge_pr: action 40')
    expect(text).not.toContain('- dev_merge_pr: action 25\n')
  })
})

describe('the budget is per bot and admin-set (obj 901491)', () => {
  it('defaults to 60 steps / 30 minutes; a bot row and the install settings change it; the kill switch restores the old path', async () => {
    expect(turnBudgetFor(SLUG)).toEqual({ enabled: true, maxSteps: 60, maxSeconds: 1800, foregroundMs: 20_000 })
    setSetting('agent_chat_turn_max_steps', '40')
    setSetting('agent_chat_turn_max_minutes', '10')
    setSetting(SETTING_FOREGROUND_SECONDS, '5')
    expect(turnBudgetFor(SLUG)).toEqual({ enabled: true, maxSteps: 40, maxSeconds: 600, foregroundMs: 5000 })
    setTurnLimits(SLUG, { max_steps: 120, max_minutes: 45 }, ADMIN)
    expect(turnBudgetFor(SLUG)).toMatchObject({ maxSteps: 120, maxSeconds: 2700 })
    expect(turnBudgetFor('another-bot')).toMatchObject({ maxSteps: 40, maxSeconds: 600 })
    // The foreground wait can never be set past what a proxy tolerates.
    setSetting(SETTING_FOREGROUND_SECONDS, '600')
    expect(turnBudgetFor(SLUG).foregroundMs).toBe(90_000)

    setSetting(SETTING_ENABLED, '0')
    expect(turnBudgetFor(SLUG)).toEqual({ enabled: false, maxSteps: 8, maxSeconds: 0, foregroundMs: 0 })
    const clock = virtualClock()
    const model = workingModel({ toolRounds: 999, secondsPerCall: 5, clock })
    const r = await submit('merge everything', model, clock, 1)
    // Off = the path without a budget: the caller waits, 8 steps, no job record.
    // Since obj 901488 that path ends with a written step-limit summary (here the
    // plain list of what ran, as this model never writes one), not the old error line.
    expect(r.background).toBeUndefined()
    expect(model.bodies).toHaveLength(9)
    const end = r.messages.at(-1)!
    expect(end).toMatchObject({ role: 'assistant', meta: { kind: 'step_limit', steps: 8, summary_by: 'list' } })
    expect(r.messages.filter(m => m.role === 'tool')).toHaveLength(8)
    expect(r.messages.some(m => m.role === 'error')).toBe(false)
    expect(jobs()).toEqual([])
  })

  it('over HTTP: only an admin in the browser may change it, values are range-checked, null clears', async () => {
    const before = await call('GET', `/agents/${SLUG}/turn-limits`)
    expect(before.status).toBe(200)
    expect(before.json.turn_limits).toMatchObject({ install_enabled: true, max_steps: null, max_minutes: null, effective: { max_steps: 60, max_minutes: 30 } })
    expect(before.json.recent).toEqual([])

    expect((await call('PUT', `/agents/${SLUG}/turn-limits`, { max_steps: 100 })).status).toBe(403)
    expect((await call('PUT', `/agents/${SLUG}/turn-limits`, { max_steps: 5000 }, asAdmin)).status).toBe(400)
    expect((await call('PUT', `/agents/${SLUG}/turn-limits`, { max_minutes: '30' }, asAdmin)).status).toBe(400)
    expect((await call('PUT', `/agents/${SLUG}/turn-limits`, { max_steps: 2.5 }, asAdmin)).status).toBe(400)

    const set = await call('PUT', `/agents/${SLUG}/turn-limits`, { max_steps: 100, max_minutes: 45 }, asAdmin)
    expect(set.status).toBe(200)
    expect(set.json.turn_limits).toMatchObject({ max_steps: 100, max_minutes: 45, effective: { max_steps: 100, max_minutes: 45 } })
    const cleared = await call('PUT', `/agents/${SLUG}/turn-limits`, { max_steps: null }, asAdmin)
    expect(cleared.json.turn_limits).toMatchObject({ max_steps: null, max_minutes: 45, effective: { max_steps: 60, max_minutes: 45 } })
  })

  it('over HTTP: POST /messages answers 202 "background" while the turn works; GET shows its progress, then its answer', async () => {
    setSetting(SETTING_FOREGROUND_SECONDS, '1')
    const clock = virtualClock()
    let release: () => void = () => {}
    const hold = new Promise<void>(resolve => { release = resolve })
    const model = workingModel({ toolRounds: 3, secondsPerCall: 5, clock, hold, answer: 'Done in the background.' })
    activeProvider = model.fetch

    const started = Date.now()
    const post = await call('POST', `/agents/${SLUG}/messages`, { text: 'a long job' })
    // Answered by the foreground wait, not by the turn ending: far inside any proxy's patience.
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(post.status).toBe(202)
    expect(post.json).toMatchObject({ background: true, queued: false, turn: { running: true, queued: 0 } })
    expect(post.json.turn_job).toMatchObject({ background: true, max_steps: 60, max_minutes: 30 })
    expect(post.json.messages.map((m: { role: string }) => m.role)).toEqual(['user'])

    release()
    await whenLaneIdle(OWNER, SLUG)
    const get = await call('GET', `/agents/${SLUG}/messages`)
    expect(get.json.turn).toEqual({ running: false, queued: 0, held: 0 })
    expect(get.json.turn_job).toBeNull()
    expect(get.json.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'tool', 'tool', 'tool', 'assistant'])
    expect(get.json.messages.at(-1).content).toBe('Done in the background.')
    // The admin sees the turn's record on the bot's settings panel.
    const rec = await call('GET', `/agents/${SLUG}/turn-limits`, undefined, asAdmin)
    expect(rec.json.recent[0]).toMatchObject({ status: 'answered', background: true, steps: 4, tool_calls: 3 })
  })
})
