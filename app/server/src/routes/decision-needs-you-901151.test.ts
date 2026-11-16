import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901151 — Operator's Needs you screenshot (Nov 16): card #901136 "Operation Kit
// Dev: High Agency wake" showed "No briefing given", stayed in the stack after
// the card was done, and Approve answered "Card is already done, nothing was sent
// yet. Press Reopen and apply". One test block per bug:
//   1. a bare needs_review stop is briefed from the summary (or filed as an FYI),
//      and the bot's Q&A answer becomes the briefing when there was none
//   2. a card that ends settles its asks AT ONCE (broadcast hook, no sweep) and
//      the stack/count never list an ask on a done/cancelled card
//   3. Approve on a finished bot card is delivered to the bot (chat + its next
//      session's prompt, exactly once), never a dead end
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decision-901151-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-needsyou'
process.env.TRANSCRIPT_DIR = TMP
process.env.DOC_INGEST_KB_DIR = path.join(TMP, 'kbroot')

// The terminal bridge is never used here; a stub keeps the suite off the native pty build.
vi.mock('node-pty', () => ({ spawn: vi.fn(), default: { spawn: vi.fn() } }))

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
const { default: internalRouter } = await import('./internal.js')
const { broadcast } = await import('../ws/index.js')
const { getDecision, raiseDecision } = await import('../services/decisions.js')
const { listDecisionQueue, decisionQueueCount } = await import('../services/decision-queue.js')
const { setDecisionAnswerer } = await import('../services/decision-answerer.js')
const autobrief = await import('../services/decision-autobrief.js')
const { handleCardEnded, startDecisionCardEndHook } = await import('../services/decision-card-end.js')
const { takePendingAnswersBlock, confirmPendingAnswers, releasePendingAnswers } = await import('../services/decision-delivery.js')
const { stopForOwnerRules, buildDecisionRequestBlock } = await import('../services/decision-prompt.js')
const { buildHighAgencyBrief } = await import('../services/agent-chat/high-agency.js')

let server: http.Server
let base: string
let adminCookie: string

const BOT = 'operation-kit-dev'
const NOTE = 'Decision #6 done: all seven quality-pass PRs are merged and main passes the full gate. Two things to check before the next deploy: KNOWLEDGE_BASE_DIR/VAULT_PATH on the server (827) and who can set vault_path (826).'

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

async function call(method: string, url: string, opts: { cookie?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(opts.cookie ? { Cookie: opts.cookie } : {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

/** A High Agency wake card worked by the bot (agent_context = its slug), still running. */
function wake(extra: Record<string, unknown> = {}): number {
  const db = getDb()
  const r = db.prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, routine_id) VALUES ('Operation Kit Dev: High Agency wake', ?, 'ws', 1, 'working', ?)`)
    .run(BOT, 900553 + Math.floor(Math.random() * 1e6))
  const id = Number(r.lastInsertRowid)
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE objectives SET ${k} = ? WHERE id = ?`).run(v, id)
  db.prepare(`INSERT INTO session_intel (session_id, objective_id, started_at, ended_at) VALUES (?, ?, datetime('now','-1 hour'), datetime('now','-50 minutes'))`).run(`cc-${id}-1`, id)
  return id
}

function plainCard(status: string): number {
  const r = getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status) VALUES ('Plain card', 'general', 'ws', 1, ?)`).run(status)
  return Number(r.lastInsertRowid)
}

/** The poller's session-end routing for a job: straight to done, then the broadcast every path makes. */
function endCard(id: number, status: 'done' | 'cancelled' = 'done') {
  getDb().prepare("UPDATE objectives SET status = ?, last_session_summary = COALESCE(last_session_summary, 'All seven PRs merged; main is green. Nothing deployed.') WHERE id = ?").run(status, id)
  broadcast({ type: 'objective_updated', payload: getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never })
}

const viewer = { id: 1, role: 'admin' }
const queueIds = () => listDecisionQueue(getDb(), viewer).map(i => i.decision.id)
const openFor = (id: number) => getDb().prepare("SELECT id FROM decisions WHERE objective_id = ? ORDER BY id DESC").get(id) as { id: number }
const routineOf = (id: number) => (getDb().prepare('SELECT routine_id FROM objectives WHERE id = ?').get(id) as { routine_id: number | null }).routine_id
const settle = () => new Promise(r => setTimeout(r, 30))
const fyis: string[] = []
const sink = { logFyi: ({ summary }: { summary: string }) => { fyis.push(summary) } }

beforeAll(async () => {
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (1, 'operator', 'x', 'admin')`).run()
  // The bot has High Agency on, which is what makes its slug a card owner (cardOwnerBot).
  db.prepare(`INSERT INTO agent_chat_high_agency (slug, enabled, level, workspace, run_as_user_id) VALUES (?, 1, 4, 'ws', 1)`).run(BOT)
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/decisions', decisionsRouter)
  app.use('/api/objectives', objectivesRouter)
  app.use('/api/internal', internalRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  adminCookie = `token=${jwt.sign({ id: 1, username: 'operator', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
  startDecisionCardEndHook()
})

afterAll(async () => {
  autobrief.setBriefingModel(undefined)
  setDecisionAnswerer(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  fyis.length = 0
  sendFollowUp.mockClear()
  autobrief.setBriefingModel(null)
})

describe('1. a stop with no briefing is briefed, or filed as an FYI', () => {
  it('a High Agency wake stops with a bare note: hidden while running, briefed from the summary the moment the card ends', async () => {
    const seen: string[] = []
    autobrief.setBriefingModel(async ({ user }) => {
      seen.push(user)
      return '```json\n' + JSON.stringify({
        kind: 'decision',
        context: 'All seven quality-pass PRs are merged and main is green. Two server settings can make the Knowledge page empty after the next deploy.',
        question: 'Should the bot check the knowledge base settings before the next deploy?',
        options: [
          { key: 'A', label: 'Check first', pros: ['No empty Knowledge page'], cons: ['Deploy waits a few minutes'], next: 'The bot checks KNOWLEDGE_BASE_DIR and vault_path and reports.' },
          { key: 'B', label: 'Deploy now', pros: ['Ships sooner'], cons: ['Knowledge page may be empty'], next: 'The deploy goes ahead and the bot watches the Knowledge page.' },
        ],
        recommended: 'A',
        recommended_why: 'A two-minute check avoids a visible outage.',
      }) + '\n```'
    })
    const id = wake()
    const r = await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: NOTE } })
    expect(r.status).toBe(200)
    const did = r.json.decision_id as number
    expect(getDecision(getDb(), did)!.incomplete).toBe(true)
    // Never "no briefing given" in the stack: hidden while the wake still runs.
    expect(queueIds()).not.toContain(did)
    expect(decisionQueueCount(getDb(), viewer)).toBe(queueIds().length)

    endCard(id) // the poller auto-closes a job card at session end
    await vi.waitFor(() => expect(getDecision(getDb(), did)!.incomplete).toBe(false))
    const d = getDecision(getDb(), did)!
    expect(d.briefing.question).toBe('Should the bot check the knowledge base settings before the next deploy?')
    expect(d.briefing.options.map(o => o.key)).toEqual(['A', 'B'])
    expect(d.flags).toContain('auto_briefing')
    expect(d.flags).not.toContain('auto_briefing_fallback')
    expect(d.thread.at(-1)!.body).toMatch(/written automatically from its note and session summary/)
    // The model saw the note and the session summary, inside the untrusted frame.
    expect(seen[0]).toContain('Two things to check before the next deploy')
    expect(seen[0]).toContain('Session summary')
    expect(seen[0]).toContain('UNTRUSTED-CONTENT')
    // A job that ended BY asking with a real briefing is the bot's live ask: it is in the stack.
    expect(queueIds()).toContain(did)
  })

  it('an FYI (nothing to decide) leaves Needs you: withdrawn, sent to the activity feed, job marked complete', async () => {
    autobrief.setBriefingModel(async () => JSON.stringify({ kind: 'fyi', summary: 'All seven PRs merged; check two server settings before the next deploy.' }))
    const id = wake()
    const r = await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: NOTE } })
    endCard(id)
    await vi.waitFor(() => expect(getDecision(getDb(), r.json.decision_id)!.state).toBe('withdrawn'))
    // The live hook logs to the real activity feed; check the row it wrote.
    const d = getDecision(getDb(), r.json.decision_id)!
    expect(d.withdrawn_reason).toBe(autobrief.FYI_WITHDRAWN_REASON)
    expect(queueIds()).not.toContain(d.id)
    const job = getDb().prepare('SELECT job_disposition FROM objectives WHERE id = ?').get(id) as { job_disposition: string }
    expect(job.job_disposition).toBe('complete')
    const act = getDb().prepare("SELECT title, detail, metadata FROM activity_log WHERE objective_id = ? AND metadata LIKE '%fyi_report%'").get(id) as { title: string; detail: string }
    expect(act.title).toMatch(/FYI from/)
    expect(act.detail).toContain('All seven PRs merged')
  })

  it('with no model available the fallback still writes a real, answerable briefing from the bot\'s own words', async () => {
    const id = wake({ status: 'review' })
    const out = raiseDecision(getDb(), { objective_id: id, workspace: 'ws', source: 'job_disposition', agent_slug: BOT, briefing: null, raw_note: NOTE, allowIncomplete: true })
    if (!out.ok) throw new Error('raise failed')
    const res = await autobrief.autoBriefDecision(getDb(), out.decision.id, sink)
    expect(res.kind).toBe('briefed')
    const d = getDecision(getDb(), out.decision.id)!
    expect(d.incomplete).toBe(false)
    expect(d.flags).toEqual(expect.arrayContaining(['auto_briefing', 'auto_briefing_fallback']))
    expect(d.briefing.context).toContain('Decision #6 done')
    expect(d.briefing.question).toBe(`Should Operation Kit Dev go ahead with what it proposes on card #${id}?`)
    expect(d.briefing.options).toHaveLength(2)
    expect(d.briefing.recommended).toBe('B')
  })

  it('the bot\'s Q&A answer becomes the briefing when the original had none', async () => {
    const id = wake({ status: 'review' })
    const out = raiseDecision(getDb(), { objective_id: id, workspace: 'ws', source: 'job_disposition', agent_slug: BOT, briefing: null, raw_note: 'see summary', allowIncomplete: true })
    if (!out.ok) throw new Error('raise failed')
    setDecisionAnswerer(async () => ({ text: 'I need you to say whether I may merge PR 830 before the 5 pm deploy.', by: 'Operation Kit Dev' }))
    const r = await call('POST', `/api/decisions/${out.decision.id}/questions?wait=1`, { cookie: adminCookie, body: { body: 'What do you need from me?' } })
    expect(r.status).toBe(201)
    await vi.waitFor(() => expect(getDecision(getDb(), out.decision.id)!.incomplete).toBe(false))
    const d = getDecision(getDb(), out.decision.id)!
    expect(d.briefing.context).toContain('may merge PR 830')
    expect(d.thread.at(-1)!.body).toMatch(/written from its answer in this thread/)
    // It never turns into an FYI once the person engaged with it.
    expect(d.state).toBe('open')
  })

  it('model replies are parsed strictly: an invalid briefing is refused, an FYI needs a summary', () => {
    expect(autobrief.parseBriefingDraft('{"kind":"decision","question":"Ship?","options":[]}')).toBeNull()
    expect(autobrief.parseBriefingDraft('{"kind":"fyi","summary":""}')).toBeNull()
    expect(autobrief.parseBriefingDraft('no json at all')).toBeNull()
    expect(autobrief.parseBriefingDraft('Sure: {"kind":"fyi","summary":"Done, nothing to decide."} hope that helps')).toEqual({ kind: 'fyi', summary: 'Done, nothing to decide.' })
    const ok = autobrief.parseBriefingDraft(JSON.stringify({ kind: 'decision', ...briefing }))
    expect(ok?.kind).toBe('decision')
  })

  it('the High Agency wake brief and the worker prompt require a briefing whenever the session stops for the owner', () => {
    const rules = stopForOwnerRules('Operator', 'disposition').join('\n')
    expect(rules).toMatch(/you MUST record `needs_review` WITH a `decision` object/)
    expect(rules).toMatch(/An FYI is not an ask/)
    const agent = { slug: BOT, name: 'Operation Kit Dev', description: 'Runs the product.', system_prompt: 'You own quality.', knowledge_folders: [] as string[] }
    const brief = buildHighAgencyBrief(agent, { level: 4, workspace: 'ws', allow_cards: true, allow_workflows: false }, 'Operator')
    expect(brief).toContain('Stopping for Operator.')
    expect(brief).toContain('An FYI is not an ask.')
    expect(brief).not.toMatch(/`needs_review` if you started a project/)
    const worker = buildDecisionRequestBlock({ objectiveId: 1, workspace: 'ws', owner: 'Operator', isJob: false }).join('\n')
    expect(worker).toMatch(/you MUST raise a decision with the briefing/)
  })
})

describe('2. a card that ends settles its asks at once; the stack never shows a finished card\'s ask', () => {
  it('cancelling or finishing a card withdraws its ask on the broadcast itself, with no sweep', async () => {
    const a = plainCard('review')
    const b = plainCard('working')
    const da = raiseDecision(getDb(), { objective_id: a, workspace: 'ws', source: 'worker', briefing })
    const db_ = raiseDecision(getDb(), { objective_id: b, workspace: 'ws', source: 'worker', briefing })
    if (!da.ok || !db_.ok) throw new Error('raise failed')
    expect(queueIds()).toEqual(expect.arrayContaining([da.decision.id, db_.decision.id]))
    endCard(a, 'done')
    endCard(b, 'cancelled')
    await settle()
    expect(getDecision(getDb(), da.decision.id)!).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'no longer needed (card finished)' })
    expect(getDecision(getDb(), db_.decision.id)!).toMatchObject({ state: 'withdrawn', withdrawn_reason: 'no longer needed (card cancelled)' })
  })

  it('the stack query and the badge exclude asks on done/cancelled cards even before anything withdrew them', () => {
    const before = queueIds().length
    const done = plainCard('review')
    const cancelled = plainCard('review')
    const d1 = raiseDecision(getDb(), { objective_id: done, workspace: 'ws', source: 'worker', briefing })
    const d2 = raiseDecision(getDb(), { objective_id: cancelled, workspace: 'ws', source: 'worker', briefing })
    if (!d1.ok || !d2.ok) throw new Error('raise failed')
    // Raw status writes: no route, no broadcast, no sweep.
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(done)
    getDb().prepare("UPDATE objectives SET status = 'cancelled' WHERE id = ?").run(cancelled)
    expect(queueIds()).not.toContain(d1.decision.id)
    expect(queueIds()).not.toContain(d2.decision.id)
    expect(queueIds().length).toBe(before)
    expect(decisionQueueCount(getDb(), viewer)).toBe(before)
  })

  it('a done card closed by a person, or replaced by a newer wake, drops out; a newer wake retires the old ask', async () => {
    const old = wake({ job_disposition: 'needs_review' })
    const d = raiseDecision(getDb(), { objective_id: old, workspace: 'ws', source: 'job_disposition', agent_slug: BOT, briefing })
    if (!d.ok) throw new Error('raise failed')
    endCard(old)
    await settle()
    expect(queueIds()).toContain(d.decision.id) // ended BY asking, with a real briefing
    const routine = (getDb().prepare('SELECT routine_id FROM objectives WHERE id = ?').get(old) as { routine_id: number }).routine_id
    getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, routine_id) VALUES ('next wake', ?, 'ws', 1, 'working', ?)`).run(BOT, routine)
    expect(queueIds()).not.toContain(d.decision.id)
    await handleCardEnded(getDb(), old, sink)
    expect(getDecision(getDb(), d.decision.id)!.withdrawn_reason).toMatch(/newer run/)
  })
})

describe('3. Approve on a finished bot card is delivered to the bot, not a dead end', () => {
  it('records the choice, posts it to the bot\'s chat, leaves the card done, and hands it to the bot\'s next session once', async () => {
    const id = wake({ job_disposition: 'needs_review' })
    const raised = raiseDecision(getDb(), { objective_id: id, workspace: 'ws', source: 'job_disposition', agent_slug: BOT, briefing })
    if (!raised.ok) throw new Error('raise failed')
    endCard(id)
    await settle()
    const r = await call('POST', `/api/decisions/${raised.decision.id}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.status).toBe(200)
    expect(r.json.outcome).toBe('delivered')
    expect(r.json.outcome_text).toContain("went straight to Operation Kit Dev: it is in Operation Kit Dev's chat")
    expect(r.json.outcome_text).not.toMatch(/Press Reopen and apply/)
    expect(r.json.decision).toMatchObject({ state: 'decided', chosen: 'A', delivered_to: BOT })
    expect((getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status).toBe('done')
    expect(sendFollowUp).not.toHaveBeenCalled()
    // Gone from the stack.
    expect(queueIds()).not.toContain(raised.decision.id)
    // In the bot's chat, for the person who decided.
    const chat = getDb().prepare("SELECT user_id, agent_slug, content, meta FROM agent_chat_messages WHERE meta LIKE '%decision_delivered%' ORDER BY id DESC").get() as { user_id: number; agent_slug: string; content: string }
    expect(chat).toMatchObject({ user_id: 1, agent_slug: BOT })
    expect(chat.content).toContain(`Decision #${raised.decision.id}: Should we send the 40-lead batch today?`)
    expect(chat.content).toContain('Answer: option A — Send today.')

    // The NEXT RUN OF THE SAME ROUTINE (the bot's next wake) gets it in its prompt, once.
    const next = wake({ routine_id: routineOf(id) })
    const nextCard = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(next) as never
    const block = takePendingAnswersBlock(getDb(), nextCard, 'Operator').join('\n')
    expect(block).toContain('Answers waiting for you')
    expect(block).toContain(`### From card #${id}`)
    expect(block).toContain('Do this next: I send it and report bounces in an hour.')
    expect(confirmPendingAnswers(getDb(), next)).toBe(1) // the session really started
    expect(takePendingAnswersBlock(getDb(), nextCard, 'Operator')).toEqual([])
    // Picked up, so "Reopen and apply" is no longer offered (no double-apply).
    const after = (await call('GET', `/api/decisions/${raised.decision.id}`, { cookie: adminCookie })).json.decision
    expect(after.can_reopen).toBe(false)
    const again = await call('POST', `/api/decisions/${raised.decision.id}/decide`, { cookie: adminCookie, body: { reopen: true } })
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('decision_delivered')
  })

  it('"Reopen and apply" is still there for an answer that needs more work on that card, and consumes the delivery', async () => {
    const id = wake({ job_disposition: 'needs_review' })
    const raised = raiseDecision(getDb(), { objective_id: id, workspace: 'ws', source: 'job_disposition', agent_slug: BOT, briefing })
    if (!raised.ok) throw new Error('raise failed')
    endCard(id)
    await settle()
    const first = await call('POST', `/api/decisions/${raised.decision.id}/decide`, { cookie: adminCookie, body: { choice: 'B' } })
    expect(first.json.outcome).toBe('delivered')
    expect(first.json.can_reopen).toBe(true)
    const re = await call('POST', `/api/decisions/${raised.decision.id}/decide`, { cookie: adminCookie, body: { reopen: true } })
    expect(re.status).toBe(200)
    expect(re.json.outcome).toBe('reopened')
    await settle()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const nextCard = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(wake({ routine_id: routineOf(id) })) as never
    expect(takePendingAnswersBlock(getDb(), nextCard, 'Operator').join('\n')).not.toContain(`### From card #${id}`)
  })

  it('a finished card no bot owns keeps the old card_done + Reopen and apply', async () => {
    const id = getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, routine_id, job_disposition) VALUES ('Plain job', 'general', 'ws', 1, 'done', 4242, 'needs_review')`).run().lastInsertRowid as number
    const raised = raiseDecision(getDb(), { objective_id: Number(id), workspace: 'ws', source: 'job_disposition', briefing })
    if (!raised.ok) throw new Error('raise failed')
    const r = await call('POST', `/api/decisions/${raised.decision.id}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.json.outcome).toBe('card_done')
    expect(r.json.can_reopen).toBe(true)
  })
})

describe('3b. The delivered-answer hand-off stays in its workspace, its routine, and survives a failed spawn', () => {
  /** A finished bot card in `workspace` whose decision was answered and delivered to the bot. */
  function deliveredOn(workspace: string, routineId: number | null): { card: number; decision: number } {
    const card = Number(getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, routine_id) VALUES ('Finished bot card', ?, ?, 1, 'done', ?)`)
      .run(BOT, workspace, routineId).lastInsertRowid)
    const raised = raiseDecision(getDb(), { objective_id: card, workspace, source: 'worker', agent_slug: BOT, briefing })
    if (!raised.ok) throw new Error('raise failed')
    getDb().prepare("UPDATE decisions SET state = 'decided', chosen = 'A', decided_at = datetime('now'), delivered_to = ?, delivered_user_id = 1, delivered_at = datetime('now') WHERE id = ?")
      .run(BOT, raised.decision.id)
    return { card, decision: raised.decision.id }
  }
  function botCard(workspace: string, routineId: number | null = null) {
    const id = Number(getDb().prepare(`INSERT INTO objectives (title, agent_context, workspace, created_by, status, routine_id) VALUES ('Next bot card', ?, ?, 1, 'working', ?)`)
      .run(BOT, workspace, routineId).lastInsertRowid)
    return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as never as { id: number }
  }
  const consumed = (id: number) => (getDb().prepare('SELECT delivered_consumed_at, delivered_consumed_by FROM decisions WHERE id = ?').get(id) as { delivered_consumed_at: string | null; delivered_consumed_by: number | null })
  const take = (card: { id: number }) => takePendingAnswersBlock(getDb(), card as never, 'Operator').join('\n')

  it('never hands workspace A\'s answer to the bot\'s card in workspace B (or one with a blank workspace); a card in A still gets it', () => {
    const a = deliveredOn('ws-a', null)
    const inB = botCard('ws-b')
    expect(take(inB)).not.toContain(`Decision #${a.decision}`)
    expect(take(inB)).toBe('')
    confirmPendingAnswers(getDb(), inB.id)
    expect(take(botCard(''))).toBe('')
    expect(consumed(a.decision).delivered_consumed_at).toBeNull() // still waiting
    const inA = botCard('ws-a')
    expect(take(inA)).toContain(`Decision #${a.decision}`)
    confirmPendingAnswers(getDb(), inA.id)
    expect(consumed(a.decision)).toMatchObject({ delivered_consumed_by: inA.id })
  })

  it('an answer on a High Agency wake goes only to the next run of that routine, not to an unrelated card the bot owns', () => {
    const routine = 777001
    const w = deliveredOn('ws-r', routine)
    expect(take(botCard('ws-r'))).toBe('') // a plain code card the bot owns
    expect(take(botCard('ws-r', 777002))).toBe('') // a different routine
    expect(consumed(w.decision).delivered_consumed_at).toBeNull()
    const nextWake = botCard('ws-r', routine)
    expect(take(nextWake)).toContain(`Decision #${w.decision}`)
    // An answer on a non-routine card still reaches any card the bot owns there, routine runs included.
    const plain = deliveredOn('ws-r', null)
    expect(take(botCard('ws-r', routine))).toContain(`Decision #${plain.decision}`)
  })

  it('consumes only once the session really started: a failed spawn releases the answer, and an unconfirmed claim lapses', () => {
    const d = deliveredOn('ws-s', null)
    const first = botCard('ws-s')
    expect(take(first)).toContain(`Decision #${d.decision}`) // prompt built, spawn not yet started
    expect(consumed(d.decision).delivered_consumed_at).toBeNull()
    // While that spawn is in flight, another card does not grab it too.
    const other = botCard('ws-s')
    expect(take(other)).toBe('')
    // The spawn failed: the claim is released and the next session gets it.
    expect(releasePendingAnswers(getDb(), first.id)).toBe(1)
    expect(take(other)).toContain(`Decision #${d.decision}`)
    // `other` never confirms (process died): after the claim window, a third card may take it.
    getDb().prepare("UPDATE decisions SET delivered_claimed_at = datetime('now', '-11 minutes') WHERE id = ?").run(d.decision)
    const third = botCard('ws-s')
    expect(take(third)).toContain(`Decision #${d.decision}`)
    expect(confirmPendingAnswers(getDb(), third.id)).toBe(1)
    expect(consumed(d.decision)).toMatchObject({ delivered_consumed_by: third.id })
    expect(confirmPendingAnswers(getDb(), other.id)).toBe(0) // the lapsed claim cannot consume it twice
    expect(take(botCard('ws-s'))).toBe('')
  })
})
