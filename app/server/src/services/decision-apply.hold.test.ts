// Answering a decision lifts the hold that waited for it (obj 901277).
//
// Card #901231 sat in queue with queue_hold "Waiting for Operator's decision. Do
// not start until Operator approves …" and a brief saying "queued and held".
// Operator answered A; the card started — and both lines stayed, so the owning bot
// read a working card that still claimed to be held. Pinned here:
//   - the existing `sent` path still writes the follow-up into the card thread
//     and restarts the worker with it (must not regress);
//   - a wait-for-the-decision hold is cleared, the "held" brief gets one dated
//     line saying the hold was lifted, and both are logged;
//   - an unrelated hold (a vendor key, another card) is left in place.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-decision-apply-hold-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-decision-apply-hold-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { raiseDecision, recordChoice } = await import('./decisions.js')
const { applyDecision, isDecisionWaitHold, descriptionSaysHeld, HOLD_LIFTED_MARK } = await import('./decision-apply.js')
type ApplyDeps = import('./decision-apply.js').ApplyDeps
type Objective = import('@operationkit/shared').Objective
type MessageSender = import('@operationkit/shared').MessageSender

const OWNER: MessageSender = { kind: 'owner', verified: true, label: 'Operator', username: 'admin' }
const HELD_BRIEF = 'STATUS: queued and held — do not start until Operator approves.\n\nBuild grant-approved squash merge.'
const BRIEFING = {
  context: 'Grant-approved merge is built behind a flag.',
  question: 'Ship grant-approved merge as designed?',
  options: [
    { key: 'A', label: 'Yes, as designed', pros: ['Fewer clicks'], cons: ['New merge path'], next: 'I start the card (PR only).' },
    { key: 'B', label: 'Not yet', pros: ['No change'], cons: ['Manual merges'], next: 'I park it.' },
  ],
  recommended: 'A',
  recommended_why: 'Gated by an expiring grant.',
}

function deps() {
  const calls = { jsonl: [] as { sessionId: string; text: string; queued: boolean }[], followUps: [] as { sessionId: string; text: string; id: number }[] }
  const d: ApplyDeps = {
    getSessionState: () => 'dead',
    resolveSessionId: (_db, o) => o.session_id || `sess-${o.id}`,
    recordInJsonl: (sessionId, text, _s, queued) => { calls.jsonl.push({ sessionId, text, queued }) },
    enqueue: () => {},
    sendFollowUp: (sessionId, text, o) => { calls.followUps.push({ sessionId, text, id: o.id }) },
    audit: () => {},
    broadcast: () => {},
    noteStart: () => {},
    defer: fn => fn(),
  }
  return { d, calls }
}

function queuedCard(hold: string | null, description = HELD_BRIEF): number {
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, description, workspace, status, type, category, queue_hold, updated_at)
     VALUES ('Grant-approved merge', ?, 'growth', 'queue', 'task', 'general', ?, datetime('now'))`,
  ).run(description, hold).lastInsertRowid)
}

function decide(objectiveId: number, choice = 'A') {
  const r = raiseDecision(getDb(), { objective_id: objectiveId, workspace: 'growth', source: 'bot', agent_slug: 'dev', briefing: BRIEFING })
  if (!r.ok) throw new Error(r.errors.join('; '))
  return recordChoice(getDb(), r.decision.id, { choice, by: 'admin' })
}

function row(id: number) {
  return getDb().prepare('SELECT status, queue_hold, description FROM objectives WHERE id = ?').get(id) as Pick<Objective, 'status' | 'description'> & { queue_hold: string | null }
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('applyDecision on a card held for this decision', () => {
  it('starts the worker with the follow-up AND lifts the wait-for-decision hold', () => {
    const HOLD = "Waiting for Operator's decision. Do not start until Operator approves this grant-approved squash-merge behavior. auto_merge_enabled stays off."
    const id = queuedCard(HOLD)
    const decision = decide(id)
    const { d, calls } = deps()
    const res = applyDecision(getDb(), decision, { sender: OWNER, actor: 'admin', reopen: false }, d)

    // The existing `sent` path: the answer reaches the card thread and the worker.
    expect(res.outcome).toBe('sent')
    expect(calls.jsonl).toHaveLength(1)
    expect(calls.jsonl[0].text).toMatch(new RegExp(`^Decision #${decision.id}: Ship grant-approved merge as designed\\?`))
    expect(calls.jsonl[0].text).toMatch(/Answer: option A — Yes, as designed\./)
    expect(calls.followUps).toEqual([{ sessionId: calls.jsonl[0].sessionId, text: calls.jsonl[0].text, id }])

    // The hold that waited for this answer no longer reads as live.
    const after = row(id)
    expect(after.status).toBe('working')
    expect(after.queue_hold).toBeNull()
    expect(after.description.startsWith(`${HOLD_LIFTED_MARK} `)).toBe(true)
    expect(after.description).toMatch(new RegExp(`admin answered decision #${decision.id} \\(Chose A: Yes, as designed\\)`))
    expect(after.description).toContain(HELD_BRIEF) // the original brief is kept below the line

    const log = getDb().prepare("SELECT title, detail, metadata FROM activity_log WHERE objective_id = ? AND event_type = 'decision'").all(id) as { title: string; detail: string; metadata: string }[]
    expect(log).toHaveLength(1)
    expect(log[0].detail).toMatch(/cleared queue_hold "Waiting for Operator's decision/)
    expect(JSON.parse(log[0].metadata)).toMatchObject({ kind: 'decision_hold_lifted', decision_id: decision.id, previous_queue_hold: HOLD })
  })

  it('leaves an unrelated hold in place (and still sends the answer)', () => {
    const HOLD = 'Blocked on the Stripe test key — Settings → Secrets.'
    const id = queuedCard(HOLD, 'Build the billing page.')
    const decision = decide(id)
    const { d, calls } = deps()
    expect(applyDecision(getDb(), decision, { sender: OWNER, actor: 'admin', reopen: false }, d).outcome).toBe('sent')
    expect(calls.jsonl).toHaveLength(1)
    const after = row(id)
    expect(after.queue_hold).toBe(HOLD)
    expect(after.description).toBe('Build the billing page.')
  })

  it('a second answer does not stack a second "hold lifted" line', () => {
    const id = queuedCard('Hold until the owner approves.')
    const { d } = deps()
    applyDecision(getDb(), decide(id), { sender: OWNER, actor: 'admin', reopen: false }, d)
    getDb().prepare("UPDATE objectives SET status = 'review' WHERE id = ?").run(id)
    applyDecision(getDb(), decide(id, 'B'), { sender: OWNER, actor: 'admin', reopen: false }, d)
    const desc = row(id).description
    expect(desc.split(HOLD_LIFTED_MARK).length - 1).toBe(1)
  })
})

describe('which holds count as waiting for the decision', () => {
  it.each([
    ["Waiting for Operator's decision. Do not start until Operator approves.", true],
    ['Do not start until the owner approves the plan.', true],
    ['Hold until Operator signs off.', true],
    ['Waiting on owner approval', true],
    ['Needs operator decision before starting', true],
    ['Blocked on the Stripe test key', false],
    ['Waiting for #901200 to merge first', false],
    ['Start after Monday 9am', false],
    ['', false],
  ])('%s → %s', (hold, expected) => {
    expect(isDecisionWaitHold(hold)).toBe(expected)
  })

  it('spots a brief that still says it is held', () => {
    expect(descriptionSaysHeld('STATUS: queued and held, do not start until Operator approves')).toBe(true)
    expect(descriptionSaysHeld('Build the billing page.')).toBe(false)
  })
})
