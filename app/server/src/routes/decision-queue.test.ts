import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901084 — the "Needs you" decision stack and stale asks that clear themselves:
//   auto-clear on card finish (status route, poller sweep, queue read, decide guard),
//   the one case a finished card keeps its decision (a job that ended by asking),
//   the queue + badge count (visibility, urgency-then-age order), legacy asks
//   adopted with no briefing, and bot chat needs-you posts resolved at read time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-queue-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-decision-queue'
process.env.TRANSCRIPT_DIR = TMP
process.env.DOC_INGEST_KB_DIR = path.join(TMP, 'kbroot')

const sendFollowUp = vi.hoisted(() => vi.fn((sid: string) => sid))
vi.mock('../services/session-manager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  sendFollowUp,
  getSessionState: () => 'review',
  stopSession: vi.fn(async () => {}),
}))
vi.mock('../services/session-control.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-control.js')>()),
  getSessionState: () => 'review',
}))

const { getDb, initDb } = await import('../db/index.js')
const { default: decisionsRouter } = await import('./decisions.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { raiseDecision, getDecision } = await import('../services/decisions.js')
const {
  sweepStaleDecisions,
  maybeSweepStaleDecisions,
  listDecisionQueue,
  decisionQueueCount,
  resolveNeedsYouMessages,
  staleReasonFor,
} = await import('../services/decision-queue.js')
const { STALE_REASONS, BOT_NEEDS_YOU_KIND } = await import('@operationkit/shared')
const { briefDueDecisions, setBriefingModel } = await import('../services/decision-autobrief.js')

let server: http.Server
let base: string
let adminCookie: string
let memberCookie: string

const briefing = {
  context: 'The weekly outreach batch is drafted and checked against the ICP. Sending is the last step before replies land.',
  question: 'Should we send the 40-lead batch today?',
  options: [
    { label: 'Send today', pros: ['Replies before the weekend'], cons: ['No second review'], next: 'I send it and report bounces in an hour.' },
    { label: 'Hold a day', pros: ['Time to test subject lines'], cons: ['Replies slip to Monday'], next: 'I draft 2 subject lines for you to pick.' },
  ],
  recommended: 'A',
  recommended_why: 'The lines match last month’s best performer.',
}

async function call(method: string, url: string, opts: { cookie?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

function card(status: string, extra: Record<string, unknown> = {}): number {
  const db = getDb()
  const r = db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES (?, 'general', 'ws', 1, ?)`)
    .run(`Card ${Math.random().toString(36).slice(2, 7)}`, status)
  const id = Number(r.lastInsertRowid)
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE objectives SET ${k} = ? WHERE id = ?`).run(v, id)
  return id
}

function raise(objectiveId: number, extra: Partial<Parameters<typeof raiseDecision>[1]> = {}): number {
  const out = raiseDecision(getDb(), { objective_id: objectiveId, workspace: 'ws', source: 'worker', briefing, ...extra })
  if (!out.ok) throw new Error(out.errors.join('; '))
  return out.decision.id
}

const state = (id: number) => getDecision(getDb(), id)!
const setCard = (id: number, sql: string, ...args: unknown[]) => getDb().prepare(`UPDATE objectives SET ${sql} WHERE id = ?`).run(...args, id)
/** Make a decision look `minutes` old (SQLite UTC, no zone). */
const age = (decisionId: number, minutes: number) =>
  getDb().prepare(`UPDATE decisions SET created_at = datetime('now', ?) WHERE id = ?`).run(`-${minutes} minutes`, decisionId)
const queueIds = async (cookie: string) => ((await call('GET', '/api/decisions/queue', { cookie })).json.items as { decision: { id: number } }[]).map(i => i.decision.id)
const clearAll = () => getDb().prepare("UPDATE decisions SET state = 'withdrawn', withdrawn_reason = 'test reset' WHERE state = 'open'").run()

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (2, 'sam', 'x', 'member')`).run()
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/decisions', decisionsRouter)
  app.use('/api/objectives', objectivesRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const secret = process.env.JWT_SECRET as string
  adminCookie = `token=${jwt.sign({ id: 1, username: 'operator', role: 'admin' }, secret, { expiresIn: '1h' })}`
  memberCookie = `token=${jwt.sign({ id: 2, username: 'sam', role: 'member' }, secret, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  clearAll()
  sendFollowUp.mockClear()
})

describe('stale asks clear themselves when the card finishes', () => {
  it('the status route clears the pending decision the moment a person cancels the card', async () => {
    const id = card('review')
    const d = raise(id)
    const r = await call('PATCH', `/api/objectives/${id}/status`, { cookie: adminCookie, body: { status: 'cancelled' } })
    expect(r.status).toBe(200)
    const after = state(d)
    expect(after.state).toBe('withdrawn')
    expect(after.withdrawn_reason).toBe(STALE_REASONS.cancelled)
    // The thread says so in plain words; nothing was sent to the card.
    expect(after.thread.at(-1)?.body).toBe(`Cleared automatically: no longer needed (card cancelled). Card #${id} does not need an answer any more, so nothing was sent.`)
    expect(sendFollowUp).not.toHaveBeenCalled()
    expect(await queueIds(adminCookie)).not.toContain(d)
  })

  it('a card that finished without asking: the sweep withdraws it as "no longer needed (card finished)"', () => {
    const id = card('working')
    const d = raise(id)
    setCard(id, "status = 'done'")
    const res = sweepStaleDecisions(getDb())
    expect(res.clearedIds).toContain(d)
    expect(state(d)).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'no longer needed (card finished)' })
    // Idempotent: a second pass finds nothing.
    expect(sweepStaleDecisions(getDb()).clearedIds).not.toContain(d)
  })

  it('a card a person closed, a deleted card and a newer run of the same job that itself asked all clear it', () => {
    const closed = card('done', { job_disposition: 'needs_review', terminal_by_human: 1 })
    const gone = card('review')
    const oldRun = card('done', { job_disposition: 'needs_review', routine_id: 4242 })
    const [d1, d2, d3] = [raise(closed), raise(gone), raise(oldRun)]
    getDb().prepare('DELETE FROM objectives WHERE id = ?').run(gone)
    const newRun = card('done', { job_disposition: 'needs_review', routine_id: 4242 }) // the job ran again AND itself asked
    raise(newRun)
    sweepStaleDecisions(getDb())
    expect(state(d1).withdrawn_reason).toBe(STALE_REASONS.closedByPerson)
    expect(state(d2).withdrawn_reason).toBe(STALE_REASONS.missing)
    expect(state(d3).withdrawn_reason).toBe(STALE_REASONS.newerRun)
  })

  // obj 901675 — hourly High Agency wakes: a pending decision must survive the
  // next wake unless that next wake itself finished BY ASKING (its own decision
  // row). A wake still working, or one that finished `complete`, must not retire
  // an older pending ask — two asks were lost this way on 2026-11-20.
  describe('a newer run only retires the older ask when it itself asked (obj 901675)', () => {
    it('(a) older run asked, newer run still working: the older decision stays pending', () => {
      const older = card('done', { job_disposition: 'needs_review', routine_id: 555 })
      const d = raise(older)
      card('working', { routine_id: 555 }) // the hourly wake started again, still running
      sweepStaleDecisions(getDb())
      expect(state(d).state).toBe('open')
    })

    it('(b) newer run finished with disposition complete: the older decision stays pending', () => {
      const older = card('done', { job_disposition: 'needs_review', routine_id: 556 })
      const d = raise(older)
      card('done', { job_disposition: 'complete', routine_id: 556 }) // the next wake found nothing to ask
      sweepStaleDecisions(getDb())
      expect(state(d).state).toBe('open')
    })

    it('(c) newer run itself finished needs_review with a decision: the older one is withdrawn with the newerRun reason', () => {
      const older = card('done', { job_disposition: 'needs_review', routine_id: 557 })
      const d = raise(older)
      const newer = card('done', { job_disposition: 'needs_review', routine_id: 557 })
      raise(newer)
      sweepStaleDecisions(getDb())
      expect(state(d).state).toBe('withdrawn')
      expect(state(d).withdrawn_reason).toBe(STALE_REASONS.newerRun)
    })

    it('(d) deciding the kept decision (case a: newer run still working) is accepted, never 409 decision_stale', async () => {
      const older = card('done', { job_disposition: 'needs_review', routine_id: 558 })
      const d = raise(older, { source: 'job_disposition' })
      card('working', { routine_id: 558 })
      const r = await call('POST', `/api/decisions/${d}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
      expect(r.status).toBe(200)
      expect(r.json.code).not.toBe('decision_stale')
      expect(r.json.outcome).toBe('card_done')
      expect(r.json.can_reopen).toBe(true)
    })
  })

  it('a job that ended BY asking keeps its decision — the one case that shows Reopen and apply', async () => {
    const id = card('done', { job_disposition: 'needs_review', routine_id: 777 })
    const d = raise(id, { source: 'job_disposition' })
    sweepStaleDecisions(getDb())
    expect(state(d).state).toBe('open')
    expect(await queueIds(adminCookie)).toContain(d)
    const r = await call('POST', `/api/decisions/${d}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.json.outcome).toBe('card_done')
    expect(r.json.can_reopen).toBe(true)
  })

  it('Reopen and apply disappears once that ask goes stale (a person closed the card), and a reopen is refused', async () => {
    const id = card('done', { job_disposition: 'needs_review' })
    const d = raise(id, { source: 'job_disposition' })
    const first = await call('POST', `/api/decisions/${d}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(first.json.decision.can_reopen).toBe(true)
    setCard(id, 'terminal_by_human = 1') // the person closed it themselves
    const got = await call('GET', `/api/decisions/${d}`, { cookie: adminCookie })
    expect(got.json.decision.can_reopen).toBe(false)
    const re = await call('POST', `/api/decisions/${d}/decide`, { cookie: adminCookie, body: { reopen: true } })
    expect(re.status).toBe(409)
    expect(re.json.code).toBe('decision_stale')
    expect(re.json.error).toBe('This decision is no longer needed (card closed by a person), so the card was not reopened and nothing was sent.')
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('done')
    expect(sendFollowUp).not.toHaveBeenCalled()
  })

  it('pressing a button on an ask that outlived its card is refused plainly and clears it (never a dead click)', async () => {
    const id = card('working')
    const d = raise(id)
    setCard(id, "status = 'done'") // finished between the sweep ticks
    const r = await call('POST', `/api/decisions/${d}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('decision_stale')
    expect(r.json.error).toBe('This decision is no longer needed (card finished), so nothing was sent and nothing changed.')
    expect(r.json.decision.state).toBe('withdrawn')
    expect(sendFollowUp).not.toHaveBeenCalled()
  })

  it('the poller entry point is throttled', () => {
    const t = 10_000_000_000
    expect(maybeSweepStaleDecisions(getDb(), t)).not.toBeNull()
    expect(maybeSweepStaleDecisions(getDb(), t + 1000)).toBeNull()
    expect(maybeSweepStaleDecisions(getDb(), t + 16_000)).not.toBeNull()
  })

  it('relevance rule, as a table', () => {
    const c = (status: string, extra: Record<string, unknown> = {}) => ({ id: 1, title: 't', status, workspace: 'ws', project: null, terminal_by_human: 0, job_disposition: null, routine_id: null, owner_bot: null, agent_context: null, ...extra })
    expect(staleReasonFor(null)).toBe(STALE_REASONS.missing)
    expect(staleReasonFor(c('working'))).toBeNull()
    expect(staleReasonFor(c('review'))).toBeNull()
    expect(staleReasonFor(c('cancelled'))).toBe(STALE_REASONS.cancelled)
    expect(staleReasonFor(c('done'))).toBe(STALE_REASONS.finished)
    expect(staleReasonFor(c('done', { job_disposition: 'complete' }))).toBe(STALE_REASONS.finished)
    expect(staleReasonFor(c('done', { job_disposition: 'needs_review' }))).toBeNull()
    expect(staleReasonFor(c('done', { job_disposition: 'needs_review', terminal_by_human: 1 }))).toBe(STALE_REASONS.closedByPerson)
    expect(staleReasonFor(c('done', { job_disposition: 'needs_review' }), 99)).toBe(STALE_REASONS.newerRun)
  })
})

describe('the Needs you queue and its badge count', () => {
  it('counts every open, still-relevant decision and orders by urgency, then age', async () => {
    const runningOld = raise(card('working'))
    const blockingNew = raise(card('review'))
    const blockingOld = raise(card('review'))
    const jobAsked = raise(card('done', { job_disposition: 'needs_review' }))
    const stale = raise(card('done')) // finished: must not count, must not show
    age(runningOld, 600)
    age(blockingOld, 300)
    age(jobAsked, 120)
    age(blockingNew, 5)
    age(stale, 1000)

    const count = await call('GET', '/api/decisions/queue/count', { cookie: adminCookie })
    expect(count.status).toBe(200)
    expect(count.json.count).toBe(4)

    const q = await call('GET', '/api/decisions/queue', { cookie: adminCookie })
    expect(q.status).toBe(200)
    expect(q.json.count).toBe(4)
    expect(q.json.cleared).toBe(1) // the read swept the stale one
    expect(q.json.items.map((i: any) => i.decision.id)).toEqual([blockingOld, jobAsked, blockingNew, runningOld])
    expect(q.json.items.map((i: any) => i.urgency)).toEqual(['blocking', 'blocking', 'blocking', 'running'])
    // Each item carries the full briefing and its card.
    expect(q.json.items[0].decision.briefing.question).toBe(briefing.question)
    expect(q.json.items[0].card).toMatchObject({ status: 'review', workspace: 'ws' })
    expect((await call('GET', '/api/decisions/queue/count', { cookie: adminCookie })).json.count).toBe(4)
  })

  it('the count drops by one after a choice, and a new raise adds one', async () => {
    const a = raise(card('review'))
    raise(card('review'))
    expect((await call('GET', '/api/decisions/queue/count', { cookie: adminCookie })).json.count).toBe(2)
    await call('POST', `/api/decisions/${a}/decide`, { cookie: adminCookie, body: { choice: 'B' } })
    expect((await call('GET', '/api/decisions/queue/count', { cookie: adminCookie })).json.count).toBe(1)
    raise(card('working'))
    expect((await call('GET', '/api/decisions/queue/count', { cookie: adminCookie })).json.count).toBe(2)
  })

  it('a member sees only decisions on cards they own; an admin sees all', async () => {
    const mine = raise(card('review', { created_by: 2 }))
    const assigned = raise(card('review', { assigned_user_id: 2 }))
    const theirs = raise(card('review'))
    expect((await queueIds(memberCookie)).sort()).toEqual([mine, assigned].sort())
    expect((await call('GET', '/api/decisions/queue/count', { cookie: memberCookie })).json.count).toBe(2)
    expect(await queueIds(adminCookie)).toEqual(expect.arrayContaining([mine, assigned, theirs]))
    expect(decisionQueueCount(getDb(), { id: 2, role: 'member' })).toBe(2)
  })

  it('is a person\'s queue: a worker session token is refused', async () => {
    const id = card('review')
    const r = await call('GET', '/api/decisions/queue', { headers: { 'X-CC-Session-Token': mintSessionToken({ objectiveId: id, workspace: 'ws', actingUserId: 1 }) } })
    expect([401, 403]).toContain(r.status)
  })

  it('a legacy ask (job needs_review, no decision row) is adopted, hidden until briefed, then shown with a written briefing (obj 901151)', async () => {
    const id = card('review', { job_disposition: 'needs_review', job_review_note: 'Want me to send the batch?', owner_bot: 'scout' })
    const q = await call('GET', '/api/decisions/queue', { cookie: adminCookie })
    // Adopted as a flagged decision, but "no briefing given" never reaches the stack.
    expect(q.json.items.find((i: any) => i.card.id === id)).toBeUndefined()
    const row = getDb().prepare('SELECT id, incomplete, raw_note, agent_slug FROM decisions WHERE objective_id = ?').get(id) as { id: number; incomplete: number; raw_note: string; agent_slug: string }
    expect(row).toMatchObject({ incomplete: 1, raw_note: 'Want me to send the batch?', agent_slug: 'scout' })
    // The card is not running, so it is due a briefing; with no model the fallback writes one.
    setBriefingModel(null)
    try {
      await briefDueDecisions(getDb(), { logFyi: () => {} }, { objectiveId: id })
    } finally {
      setBriefingModel(undefined)
    }
    const item = (await call('GET', '/api/decisions/queue', { cookie: adminCookie })).json.items.find((i: any) => i.card.id === id)
    expect(item).toBeTruthy()
    expect(item.decision.incomplete).toBe(false)
    expect(item.decision.flags).toContain('auto_briefing')
    expect(item.decision.briefing.question).toMatch(/Should scout go ahead/)
    expect(item.decision.briefing.context).toContain('Want me to send the batch?')
    expect(item.decision.briefing.options).toHaveLength(2)
    expect(item.card.bot).toBe('scout')
    // Once only: a second read does not adopt it again.
    await call('GET', '/api/decisions/queue', { cookie: adminCookie })
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM decisions WHERE objective_id = ?').get(id) as { n: number }).n).toBe(1)
  })

  it('listDecisionQueue filters by workspace', () => {
    const other = card('review')
    setCard(other, "workspace = 'other'")
    const d = raise(other, { workspace: 'other' })
    raise(card('review'))
    expect(listDecisionQueue(getDb(), { id: 1, role: 'admin' }, { workspace: 'other' }).map(i => i.decision.id)).toEqual([d])
  })
})

describe('bot chat needs-you posts are resolved at read time (no dead buttons)', () => {
  const post = (objectiveId: number, extra: Record<string, unknown> = {}) => ({
    role: 'assistant',
    meta: { kind: BOT_NEEDS_YOU_KIND, objective_id: objectiveId, reason: 'decision', title: 't', ...extra } as Record<string, unknown>,
  })

  it('the #901076 case: a decision post with no decision on a finished card becomes one resolved line', () => {
    const id = card('done')
    const [m] = resolveNeedsYouMessages(getDb(), [post(id)])
    expect(m.meta?.resolved).toEqual({ reason: STALE_REASONS.finished, text: 'Resolved: no longer needed (card finished).' })
  })

  it('a post whose decision was cleared says why; an answered one is left showing its outcome', async () => {
    const id = card('working')
    const d = raise(id)
    setCard(id, "status = 'done'")
    sweepStaleDecisions(getDb())
    const [cleared] = resolveNeedsYouMessages(getDb(), [post(id, { decision_id: d })])
    expect((cleared.meta?.resolved as { text: string }).text).toBe('Resolved: no longer needed (card finished).')

    const live = card('review')
    const answered = raise(live)
    await call('POST', `/api/decisions/${answered}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    const [kept] = resolveNeedsYouMessages(getDb(), [post(live, { decision_id: answered })])
    expect(kept.meta?.resolved).toBeUndefined()
  })

  it('a decision post with no id is linked to the card\'s open decision; a superseded one to the newer', () => {
    const id = card('review')
    const first = raise(id)
    const [linked] = resolveNeedsYouMessages(getDb(), [post(id)])
    expect(linked.meta?.decision_id).toBe(first)
    const second = raise(id) // supersedes the first
    const [moved] = resolveNeedsYouMessages(getDb(), [post(id, { decision_id: first })])
    expect(moved.meta?.decision_id).toBe(second)
    expect(moved.meta?.resolved).toBeUndefined()
  })

  it('approval / ceiling / blocker posts on an ended card resolve too, even a job that ended by asking', () => {
    const id = card('done', { job_disposition: 'needs_review' })
    const [m] = resolveNeedsYouMessages(getDb(), [post(id, { reason: 'blocker' })])
    expect(m.meta?.resolved).toBeTruthy()
    const live = card('working')
    const [n] = resolveNeedsYouMessages(getDb(), [post(live, { reason: 'blocker' })])
    expect(n.meta?.resolved).toBeUndefined()
    // Non-needs-you rows pass through untouched.
    const plain = { role: 'assistant', meta: { kind: 'other' } }
    expect(resolveNeedsYouMessages(getDb(), [plain])[0]).toBe(plain)
  })
})
