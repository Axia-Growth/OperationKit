import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// obj 901059 — decision briefings end to end over HTTP:
//   raise (validation refuses no question / no options) → render data →
//   Q&A thread round-trip with the raising bot → approve on a live card,
//   on a DONE card (no silent no-op: card_done + "Reopen and apply"), reopen
//   and apply → learning log + KB summary + feedback into the briefing prompt.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-decisions-test-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-decisions'
process.env.TRANSCRIPT_DIR = TMP
process.env.DOC_INGEST_KB_DIR = path.join(TMP, 'kbroot')

const sendFollowUp = vi.hoisted(() => vi.fn((sid: string) => sid))
const sessionState = vi.hoisted(() => ({ value: 'review' as 'working' | 'review' | 'dead' }))
vi.mock('../services/session-manager.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-manager.js')>()),
  sendFollowUp,
  getSessionState: () => sessionState.value,
  stopSession: vi.fn(async () => {}),
}))
vi.mock('../services/session-control.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../services/session-control.js')>()),
  getSessionState: () => sessionState.value,
}))

const { getDb, initDb } = await import('../db/index.js')
const { default: decisionsRouter } = await import('./decisions.js')
const { default: objectivesRouter } = await import('./objectives.js')
const { default: internalRouter } = await import('./internal.js')
const { setDecisionAnswerer, answerPrompt } = await import('../services/decision-answerer.js')
const { mintSessionToken } = await import('../lib/session-trust.js')
const { decisionLog, writeDecisionLogToKb, briefingFeedbackLines, DECISION_LOG_KB_PATH } = await import('../services/decisions.js')
const { buildDecisionRequestBlock } = await import('../services/decision-prompt.js')
const { buildHighAgencyBrief } = await import('../services/agent-chat/high-agency.js')
const { registerKnownSecret, clearRegisteredSecretsForTests } = await import('../services/secret-redaction.js')

let server: http.Server
let base: string
let adminCookie: string
let memberCookie: string
let bearerAdmin: string

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
    headers: {
      'Content-Type': 'application/json',
      ...(opts.cookie ? { Cookie: opts.cookie } : {}),
      ...(opts.headers ?? {}),
    },
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
    .run(`Outreach batch ${Math.random().toString(36).slice(2, 7)}`, status)
  const id = Number(r.lastInsertRowid)
  for (const [k, v] of Object.entries(extra)) db.prepare(`UPDATE objectives SET ${k} = ? WHERE id = ?`).run(v, id)
  // The card's worker ran before, so a follow-up has a thread to resume.
  db.prepare(`INSERT INTO session_intel (session_id, objective_id, started_at, ended_at) VALUES (?, ?, datetime('now','-1 hour'), datetime('now','-50 minutes'))`)
    .run(`cc-${id}-1`, id)
  return id
}

function token(objectiveId: number): Record<string, string> {
  return { 'X-CC-Session-Token': mintSessionToken({ objectiveId, workspace: 'ws', actingUserId: 1 }) }
}

async function raise(objectiveId: number, body: Record<string, unknown> = briefing) {
  return call('POST', '/api/decisions', { headers: token(objectiveId), body: { objective_id: objectiveId, ...body } })
}

const status = (id: number) => (getDb().prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string }).status
const tick = () => new Promise(r => setTimeout(r, 15))

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
  app.use('/api/internal', internalRouter)
  server = http.createServer(app)
  await new Promise<void>(resolve => server.listen(0, resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  const secret = process.env.JWT_SECRET as string
  adminCookie = `token=${jwt.sign({ id: 1, username: 'operator', role: 'admin' }, secret, { expiresIn: '1h' })}`
  memberCookie = `token=${jwt.sign({ id: 2, username: 'sam', role: 'member' }, secret, { expiresIn: '1h' })}`
  bearerAdmin = `Bearer ${jwt.sign({ id: 1, username: 'operator', role: 'admin' }, secret, { expiresIn: '1h' })}`
})

afterAll(async () => {
  setDecisionAnswerer(null)
  await new Promise<void>(resolve => server.close(() => resolve()))
  fs.rmSync(TMP, { recursive: true, force: true })
})

beforeEach(() => {
  sendFollowUp.mockClear()
  sessionState.value = 'review'
})

describe('raising a decision — the briefing is required', () => {
  it('refuses a request with no question and no options, saying exactly what is missing', async () => {
    const id = card('working')
    const r = await raise(id, { context: 'Something happened.', recommended: 'A', recommended_why: 'x' })
    expect(r.status).toBe(400)
    expect(r.json.errors.join(' ')).toMatch(/question is required/)
    expect(r.json.errors.join(' ')).toMatch(/options is required/)
    expect((await call('GET', `/api/decisions?objective_id=${id}`, { cookie: adminCookie })).json.decisions).toEqual([])
  })

  it('a worker raises one with its session token; the card serves the full briefing', async () => {
    const id = card('working')
    const r = await raise(id)
    expect(r.status).toBe(201)
    expect(r.json.decision).toMatchObject({ objective_id: id, source: 'worker', state: 'open', incomplete: false })
    const list = await call('GET', `/api/decisions?objective_id=${id}`, { cookie: adminCookie })
    const d = list.json.decisions[0]
    expect(d.briefing.question).toBe(briefing.question)
    expect(d.briefing.options.map((o: { key: string }) => o.key)).toEqual(['A', 'B'])
    expect(d.briefing.options[0]).toMatchObject({ pros: ['Replies before the weekend'], cons: ['No second review'] })
    expect(d.briefing.recommended).toBe('A')
  })

  it("a worker token cannot raise on someone else's card", async () => {
    const mine = card('working')
    const other = card('working')
    const r = await call('POST', '/api/decisions', { headers: token(mine), body: { objective_id: other, ...briefing } })
    expect(r.status).toBe(403)
  })

  it('a new decision on the same card supersedes the open one', async () => {
    const id = card('working')
    const first = await raise(id)
    const second = await raise(id, { ...briefing, question: 'Send to 20 leads instead?' })
    expect(second.json.superseded).toEqual([first.json.decision.id])
    const list = (await call('GET', `/api/decisions?objective_id=${id}`, { cookie: adminCookie })).json.decisions
    expect(list.map((d: { state: string }) => d.state)).toEqual(['open', 'withdrawn'])
  })
})

describe('job disposition needs_review carries the briefing', () => {
  function job(): number {
    return card('working', { routine_id: 999 })
  }

  it('refuses an incomplete decision object (no options) before writing anything', async () => {
    const id = job()
    const r = await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: 'x', decision: { ...briefing, options: [] } } })
    expect(r.status).toBe(400)
    expect(r.json.errors.join(' ')).toMatch(/options is required/)
    expect((getDb().prepare('SELECT job_disposition FROM objectives WHERE id = ?').get(id) as { job_disposition: string | null }).job_disposition).toBeNull()
  })

  it('records a full briefing as an open decision', async () => {
    const id = job()
    const r = await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: 'needs a send decision', decision: briefing } })
    expect(r.status).toBe(200)
    expect(r.json.decision_id).toBeGreaterThan(0)
    expect(r.json.warning).toBeUndefined()
  })

  it('flags a needs_review with no briefing instead of hiding it', async () => {
    const id = job()
    const r = await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: 'Want me to send the batch?' } })
    expect(r.status).toBe(200)
    expect(r.json.warning).toMatch(/WITHOUT a decision briefing/)
    const d = (await call('GET', `/api/decisions/${r.json.decision_id}`, { cookie: adminCookie })).json.decision
    expect(d).toMatchObject({ incomplete: true, flags: ['no_question', 'no_options'], raw_note: 'Want me to send the batch?' })
    expect(d.briefing.context).toBe('Want me to send the batch?')
  })
})

describe('Q&A thread', () => {
  it('the person asks, the raising bot answers in the same thread with the card context', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    const seen: { question: string; title: string | null }[] = []
    setDecisionAnswerer(async ({ question, objective }) => {
      seen.push({ question, title: objective?.title ?? null })
      return { text: 'Bounces were 1.2% last week, under the 3% limit.', by: 'Outreach Bot' }
    })
    const r = await call('POST', `/api/decisions/${d.id}/questions?wait=1`, { cookie: adminCookie, body: { body: 'What was the bounce rate last time?' } })
    expect(r.status).toBe(201)
    expect(seen[0].question).toBe('What was the bounce rate last time?')
    expect(seen[0].title).toMatch(/^Outreach batch/)
    const thread = r.json.decision.thread
    expect(thread.map((m: { role: string }) => m.role)).toEqual(['human', 'bot'])
    expect(thread[0]).toMatchObject({ body: 'What was the bounce rate last time?', status: 'answered', author: 'operator' })
    expect(thread[1]).toMatchObject({ body: 'Bounces were 1.2% last week, under the 3% limit.', author: 'Outreach Bot', in_reply_to: thread[0].id })
    // Approve stays available in the thread: the decision is still open.
    expect(r.json.decision.state).toBe('open')
  })

  it('a failed answer is said plainly in the thread, never left pending', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    setDecisionAnswerer(async () => { throw new Error('no AI seat free') })
    const r = await call('POST', `/api/decisions/${d.id}/questions?wait=1`, { cookie: adminCookie, body: { body: 'Why today?' } })
    expect(r.json.decision.thread[0].status).toBe('failed')
    expect(r.json.decision.thread[1]).toMatchObject({ role: 'system' })
    expect(r.json.decision.thread[1].body).toMatch(/could not answer just now \(no AI seat free\)/)
  })

  it('the answer prompt carries the briefing, the card and the question, and forbids acting', () => {
    const { system, user } = answerPrompt({
      decision: { id: 1, objective_id: 5, briefing: { ...briefing, options: briefing.options.map((o, i) => ({ ...o, key: 'AB'[i] })) }, thread: [], raw_note: null } as never,
      objective: { id: 5, title: 'Outreach', status: 'review', workspace: 'ws', description: 'Send weekly batch' } as never,
      question: 'Why today?',
    }, 'Outreach Bot')
    expect(system).toMatch(/Do not take any action/)
    expect(user).toContain('Option A: Send today (recommended)')
    expect(user).toContain('Send weekly batch')
    expect(user).toContain('UNTRUSTED')
    expect(user).toContain('Why today?')
  })

  it('only a person in the web UI may ask or decide — not a Bearer token, not a worker token', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    const viaBearer = await call('POST', `/api/decisions/${d.id}/decide`, { headers: { Authorization: bearerAdmin }, body: { choice: 'A' } })
    expect(viaBearer.status).toBe(403)
    const viaWorker = await call('POST', `/api/decisions/${d.id}/questions`, { headers: token(id), body: { body: 'hi' } })
    expect(viaWorker.status).toBe(401)
    const member = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: memberCookie, body: { choice: 'A' } })
    expect(member.status).toBe(403)
  })
})

describe('approve / deny — a clear outcome, never a dead click', () => {
  it('on a parked card: records the choice, restarts the card with it, and says what happens next', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    const r = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'B' } })
    expect(r.status).toBe(200)
    expect(r.json.outcome).toBe('sent')
    expect(r.json.outcome_text).toBe(`You chose B: Hold a day. Card #${id} restarted with your choice. Next: I draft 2 subject lines for you to pick.`)
    expect(r.json.can_reopen).toBe(false)
    expect(r.json.decision).toMatchObject({ state: 'decided', chosen: 'B', decided_by: 'operator', outcome: 'sent' })
    expect(status(id)).toBe('working')
    await tick()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const [, text, , opts] = sendFollowUp.mock.calls[0] as unknown as [string, string, unknown, { sender: { kind: string } }]
    expect(text).toContain(`Decision #${d.id}: ${briefing.question}`)
    expect(text).toContain('Answer: option B — Hold a day.')
    // Delivered under the deciding person's own server-derived sender (cookie = verified owner).
    expect(JSON.stringify(opts.sender)).toMatch(/owner|verified/i)
    // The outcome is also a line in the decision's thread.
    expect(r.json.decision.thread.at(-1)).toMatchObject({ role: 'system', body: r.json.outcome_text })
  })

  it('on a card mid-turn: queues the choice instead of killing the run', async () => {
    const id = card('working', { session_id: 'live-1' })
    getDb().prepare('UPDATE objectives SET session_id = ? WHERE id = ?').run(`cc-${id}-1`, id)
    sessionState.value = 'working'
    const d = (await raise(id)).json.decision
    const r = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.json.outcome).toBe('queued')
    expect(r.json.outcome_text).toMatch(/mid-run, so your choice is queued/)
    await tick()
    expect(sendFollowUp).not.toHaveBeenCalled()
    expect((getDb().prepare('SELECT COUNT(*) AS n FROM followup_queue WHERE objective_id = ?').get(id) as { n: number }).n).toBe(1)
  })

  it('approving on a DONE card does not silently no-op: it explains in one line and offers Reopen and apply', async () => {
    const id = card('working', { routine_id: 998 })
    await call('POST', `/api/internal/objectives/${id}/job-disposition`, { body: { disposition: 'needs_review', note: 'send?', decision: briefing } })
    getDb().prepare("UPDATE objectives SET status = 'done' WHERE id = ?").run(id)
    const d = (await call('GET', `/api/decisions?objective_id=${id}`, { cookie: adminCookie })).json.decisions[0]

    const r = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'A' } })
    expect(r.status).toBe(200)
    expect(r.json.outcome).toBe('card_done')
    expect(r.json.can_reopen).toBe(true)
    expect(r.json.outcome_text).toBe(`You chose A: Send today. Card #${id} is already done, so nothing was sent yet. Press Reopen and apply to act on it.`)
    expect(status(id)).toBe('done')
    await tick()
    expect(sendFollowUp).not.toHaveBeenCalled()

    // Re-deciding without reopen is refused with a plain reason.
    const again = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'B' } })
    expect(again.status).toBe(409)
    expect(again.json.error).toMatch(/already answered: Chose A: Send today/)

    // "Reopen and apply": an explicit human reopen, then the same choice is sent.
    const re = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { reopen: true } })
    expect(re.status).toBe(200)
    expect(re.json.outcome).toBe('reopened')
    expect(re.json.outcome_text).toBe(`You chose A: Send today. Card #${id} was done, so it was reopened and your choice sent. Next: I send it and report bounces in an hour.`)
    expect(status(id)).toBe('working')
    await tick()
    expect(sendFollowUp).toHaveBeenCalledTimes(1)
    const audit = getDb().prepare("SELECT from_status, to_status, pathway, actor FROM objective_audit WHERE objective_id = ? AND pathway = 'decision-reopen-and-apply'").get(id)
    expect(audit).toEqual({ from_status: 'done', to_status: 'review', pathway: 'decision-reopen-and-apply', actor: 'operator' })
  })

  it('a deny on a job that ended by asking is recorded and says nothing else changes (no reopen offered)', async () => {
    const id = card('done', { job_disposition: 'needs_review' })
    const d = (await raise(id)).json.decision
    const r = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'deny', note: 'not this week' } })
    expect(r.json.outcome).toBe('recorded')
    expect(r.json.can_reopen).toBe(false)
    expect(r.json.outcome_text).toMatch(/^You said no to all the options\. Recorded on card #\d+; it is already finished, so nothing else changes\.$/)
    expect(r.json.decision.decision_note).toBe('not this week')
  })

  it('an unknown choice gets the valid ones back', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    const r = await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'Z' } })
    expect(r.status).toBe(400)
    expect(r.json.valid_choices).toEqual(['A', 'B', 'deny'])
  })

  it('the card message route explains a done card plainly (no more "reopen it before sending")', async () => {
    const id = card('done')
    const r = await call('POST', `/api/objectives/${id}/message`, { cookie: adminCookie, body: { message: 'Approved' } })
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'card_done', can_reopen: true })
    expect(r.json.error).toBe(`Card #${id} is already finished, so your message was not sent and nothing changed. Reopen the card first if you want it to act on this.`)
  })
})

describe('learning log', () => {
  it('stores briefing, questions, answers, choice and outcome — queryable, summarised to the KB, fed back to briefings', async () => {
    const id = card('review')
    const d = (await raise(id)).json.decision
    setDecisionAnswerer(async () => ({ text: 'It costs $4 in sends.', by: 'Outreach Bot' }))
    await call('POST', `/api/decisions/${d.id}/questions?wait=1`, { cookie: adminCookie, body: { body: 'How much will this cost?' } })
    await call('POST', `/api/decisions/${d.id}/decide`, { cookie: adminCookie, body: { choice: 'A' } })

    const log = await call('GET', `/api/decisions/log?objective_id=${id}`, { cookie: adminCookie })
    expect(log.status).toBe(200)
    expect(log.json.entries[0]).toMatchObject({
      id: d.id,
      question: briefing.question,
      chosen: 'A',
      chosen_label: 'Chose A: Send today',
      followed_recommendation: true,
      outcome: 'sent',
      questions: [{ question: 'How much will this cost?', answer: 'It costs $4 in sends.' }],
    })
    // A member who does not own the card sees none of it.
    expect((await call('GET', `/api/decisions/log?objective_id=${id}`, { cookie: memberCookie })).json.entries).toEqual([])

    // The route itself refreshed the workspace's KB summary after the decision.
    await tick()
    const routeWritten = path.join(TMP, 'kbroot', 'ws', DECISION_LOG_KB_PATH)
    expect(fs.readFileSync(routeWritten, 'utf8')).toContain('How much will this cost?')

    // The knowledge-base summary.
    const kb = path.join(TMP, 'kb')
    const abs = writeDecisionLogToKb(getDb(), 'ws', { kbRoot: () => kb })
    expect(abs).toBe(path.join(kb, DECISION_LOG_KB_PATH))
    const md = fs.readFileSync(abs as string, 'utf8')
    expect(md).toContain('# Decision log: ws')
    expect(md).toContain('## Questions that briefings should answer up front')
    expect(md).toContain('- How much will this cost?')
    expect(md).toContain('A: It costs $4 in sends.')
    expect(md).toContain('**Result:** Chose A: Send today by operator')

    // Fed back: the next briefing prompt carries the question the owner had to ask.
    const lines = briefingFeedbackLines(getDb(), 'ws', 'Operator')
    expect(lines[0]).toMatch(/Questions Operator had to ask on recent decisions/)
    expect(lines.join('\n')).toContain('"How much will this cost?"')
    const block = buildDecisionRequestBlock({ objectiveId: id, workspace: 'ws', owner: 'Operator', isJob: false }).join('\n')
    expect(block).toContain('## Asking Operator for a decision')
    expect(block).toContain('X-CC-Session-Token')
    expect(block).toContain('"How much will this cost?"')
    expect(decisionLog(getDb(), { workspace: 'ws' }).length).toBeGreaterThan(3)
  })
})

describe('secrets never leak through briefings, the Q&A thread, the KB log or prompts', () => {
  // Built at runtime so the secret scanners never see a literal key in the tree.
  const NAME = 'PLANTED_DECISION_KEY'
  const SECRET = ['pk', 'plant', Date.now().toString(36), Math.random().toString(36).slice(2, 10), 'zz'].join('')
  const REDACTED = `[REDACTED:${NAME}]`
  beforeAll(() => registerKnownSecret(NAME, SECRET))
  afterAll(() => clearRegisteredSecretsForTests())

  it('a planted key in context, an option pro, a question and a bot answer is stored redacted in both tables', async () => {
    const id = card('review')
    const leaky = {
      ...briefing,
      context: `The batch is ready; the vendor key is ${SECRET} if you need it. Sending is the last step.`,
      options: [
        { ...briefing.options[0], pros: [`Already authed with ${SECRET}`] },
        briefing.options[1],
      ],
    }
    const r = await raise(id, leaky)
    expect(r.status).toBe(201)
    const did = r.json.decision.id
    setDecisionAnswerer(async () => ({ text: `Yes, I used ${SECRET} for the last batch.`, by: 'Outreach Bot' }))
    const q = await call('POST', `/api/decisions/${did}/questions?wait=1`, { cookie: adminCookie, body: { body: `Is ${SECRET} the right key?` } })
    expect(q.status).toBe(201)

    const row = getDb().prepare('SELECT context, options FROM decisions WHERE id = ?').get(did) as { context: string; options: string }
    expect(row.context).toContain(REDACTED)
    expect(row.context).not.toContain(SECRET)
    expect(row.options).toContain(REDACTED)
    expect(row.options).not.toContain(SECRET)
    expect(JSON.parse(row.options)[0].pros[0]).toBe(`Already authed with ${REDACTED}`)
    const msgs = getDb().prepare('SELECT role, body FROM decision_messages WHERE decision_id = ? ORDER BY id').all(did) as { role: string; body: string }[]
    expect(msgs.map(m => m.role)).toEqual(['human', 'bot'])
    for (const m of msgs) {
      expect(m.body).toContain(REDACTED)
      expect(m.body).not.toContain(SECRET)
    }
    // And over HTTP: the card's own view serves the redacted text.
    const view = await call('GET', `/api/decisions?objective_id=${id}`, { cookie: adminCookie })
    expect(JSON.stringify(view.json)).not.toContain(SECRET)

    // KB summary, worker prompt block and High Agency brief never carry it.
    const kb = path.join(TMP, 'kb-leak')
    const md = fs.readFileSync(writeDecisionLogToKb(getDb(), 'ws', { kbRoot: () => kb }) as string, 'utf8')
    expect(md).toContain(REDACTED)
    expect(md).not.toContain(SECRET)
    const block = buildDecisionRequestBlock({ objectiveId: id, workspace: 'ws', owner: 'Operator', isJob: false }).join('\n')
    expect(block).toContain(`Is ${REDACTED} the right key?`)
    expect(block).not.toContain(SECRET)
  })

  it('a row written with scrubbing bypassed is still redacted on the way out (KB, prompts, answer prompt)', async () => {
    // db.exec is not wrapped by the write scrubber: this stands in for a row
    // written before scrubbing existed or with CC_SCRUB_DB_WRITES=0.
    const id = card('review')
    const db = getDb()
    db.exec(`INSERT INTO decisions (objective_id, workspace, source, context, question, options, recommended, recommended_why)
             VALUES (${id}, 'ws-raw', 'worker', 'Context with ${SECRET} inside.', 'Ship with ${SECRET}?', '[{"key":"A","label":"Go ${SECRET}","pros":["p ${SECRET}"],"cons":["c"],"next":"n"},{"key":"B","label":"Wait","pros":["p"],"cons":["c"],"next":"n"}]', 'A', 'Because ${SECRET}.')`)
    const did = (db.prepare("SELECT id FROM decisions WHERE workspace = 'ws-raw'").get() as { id: number }).id
    db.exec(`INSERT INTO decision_messages (decision_id, role, author, body, status) VALUES (${did}, 'human', 'operator', 'Why ${SECRET}?', 'answered')`)
    db.exec(`INSERT INTO decision_messages (decision_id, role, author, body, status, in_reply_to) VALUES (${did}, 'bot', 'Bot', 'Because ${SECRET} works.', NULL, last_insert_rowid())`)
    expect((db.prepare('SELECT context FROM decisions WHERE id = ?').get(did) as { context: string }).context).toContain(SECRET)

    const kb = path.join(TMP, 'kb-raw')
    const md = fs.readFileSync(writeDecisionLogToKb(db, 'ws-raw', { kbRoot: () => kb }) as string, 'utf8')
    expect(md).toContain(`Q: Why ${REDACTED}?`)
    expect(md).toContain(`A: Because ${REDACTED} works.`)
    expect(md).not.toContain(SECRET)

    const fb = briefingFeedbackLines(db, 'ws-raw', 'Operator').join('\n')
    expect(fb).toContain(`Why ${REDACTED}?`)
    expect(fb).not.toContain(SECRET)
    const block = buildDecisionRequestBlock({ objectiveId: id, workspace: 'ws-raw', owner: 'Operator', isJob: false }).join('\n')
    expect(block).toContain(REDACTED)
    expect(block).not.toContain(SECRET)
    const agent = { slug: 'cto', name: 'CTO', description: 'Runs engineering.', system_prompt: 'You own engineering health.', knowledge_folders: [] as string[] }
    const brief = buildHighAgencyBrief(agent, { level: 4, workspace: 'ws-raw', allow_cards: true, allow_workflows: false }, 'Operator')
    expect(brief).toContain(`Why ${REDACTED}?`)
    expect(brief).not.toContain(SECRET)

    const { user } = answerPrompt({
      decision: { id: did, objective_id: id, briefing: { context: `ctx ${SECRET}`, question: 'Q?', options: [], recommended: '', recommended_why: '' }, thread: [], raw_note: null } as never,
      objective: { id, title: 'Outreach', status: 'review', workspace: 'ws-raw', description: `desc ${SECRET}` } as never,
      question: `Pasted ${SECRET} here`,
    }, 'Outreach Bot')
    expect(user).toContain(`Pasted ${REDACTED} here`)
    expect(user).not.toContain(SECRET)
  })
})
