/**
 * obj 900322 (corrections round) — the REVIEWER no-output gap.
 *
 * The worker-side truthfulness fix is scoped to `status='working'`
 * (`handleDeadSessionOutcome`). It therefore cannot reach the one remaining
 * lifecycle where silence still completed a card: a standalone `task` whose
 * REVIEWER session produced nothing. `pollAIReviewSessions`'s `!verdict` branch
 * sent exactly that case to `done` — an infrastructure failure on the review
 * side silently marking the work verified.
 *
 * This drives `pollAIReviewSessions` itself, over a real DB and a real (empty)
 * reviewer transcript.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reviewer-nooutput-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-900322-rv'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
// The reviewer session is over; nothing here should reach tmux or the network.
vi.mock('./session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, getSessionState: () => 'dead', killTmuxByName: () => false }
})

const { getDb, initDb } = await import('../db/index.js')
const { pollAIReviewSessions } = await import('./poller-ai-review.js')
const { mapObjective } = await import('../routes/objectives-helpers.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 9300322
/**
 * A ROUTINE-SPAWNED task under AI review — the shape that actually reached the
 * `done` arm. `mustRouteToHumanReview` exempts routine/delegator-spawned cards
 * (so jobs don't flood Needs You), and `delegatorParentOf` is null for a card
 * with no parent, so the `!verdict` branch wrote `done` with nothing verified.
 * A hand-made top-level card was never at risk; seeding one would have made
 * this test pass without the fix.
 */
function seedUnderReview(opts: { transcript: string; type?: string }): { id: number; sid: string } {
  const db = getDb()
  const id = nextId++
  const sid = `cc-${id}-reviewer`
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_session_id, ai_review_iteration, routine_id)
     VALUES (?, ?, ?, 'ai_review', 'normal', 'operationkit', 'operationkit', ?, 1, 4242)`,
  ).run(id, `obj ${id}`, opts.type ?? 'task', sid)
  fs.writeFileSync(path.join(TMP, `${sid}.jsonl`), opts.transcript)
  return { id, sid }
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; ai_review_verdict: string | null; ai_review_findings: string | null
  }
}

function runnerFailureOf(id: number) {
  return getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND title = 'reviewer_runner_failure'").all(id) as {
    session_id: string; event_type: string; detail: string; metadata: string
  }[]
}
function reviewRowsOf(id: number): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM objective_reviews WHERE objective_id = ?').get(id) as { n: number }).n
}
function fullCardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective
}

describe('a REVIEWER that produced nothing must not mark the card done', () => {
  // obj 900959 changed WHAT is written for this case, not where the card lands:
  // it is still parked in `review` (never done), but a reviewer that never ran is
  // a runner failure, so the verdict stays empty instead of reading "blocked".
  it('empty reviewer transcript → review, verdict left NULL, recorded as a runner failure', async () => {
    const { id, sid } = seedUnderReview({ transcript: '' })
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.status).toBe('review')           // <- was 'done' before obj 900322
    expect(card.ai_review_verdict).toBeNull()    // <- was 'blocked' before obj 900959
    expect(card.ai_review_findings).toBeNull()
    const failure = runnerFailureOf(id)
    expect(failure).toHaveLength(1)
    expect(failure[0].session_id).toBe(sid)
    expect(failure[0].event_type).toBe('error')
    expect(failure[0].detail).toContain('produced no output')
    // It must not blame the worker for a reviewer infra failure.
    expect(failure[0].detail).toContain('not a judgement about the work')
    expect(JSON.parse(failure[0].metadata)).toMatchObject({ kind: 'reviewer_runner_failure', cause: 'no_output' })
    // No review happened, so there is no review row for the round.
    expect(reviewRowsOf(id)).toBe(0)
    // The card API says why there is no verdict.
    expect(mapObjective(fullCardOf(id)).review_runner_failure).toMatchObject({ cause: 'no_output' })
  })

  it('a reviewer that DIED partway (text, no result, no verdict) → review, verdict NULL, runner failure', async () => {
    const { id } = seedUnderReview({
      transcript: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking the diff now.' }] } }) + '\n',
    })
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.status).toBe('review')
    expect(card.ai_review_verdict).toBeNull()
    expect(card.ai_review_findings).toBeNull()
    const failure = runnerFailureOf(id)
    expect(failure).toHaveLength(1)
    expect(failure[0].detail).toContain('Checking the diff now.')
    expect(JSON.parse(failure[0].metadata)).toMatchObject({ cause: 'no_verdict' })
    expect(reviewRowsOf(id)).toBe(0)
  })

  it('a reviewer that ran and said BLOCKED is still a real blocked verdict', async () => {
    const { id } = seedUnderReview({
      transcript: [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<verdict>blocked</verdict>\n<findings>The preview would not load.</findings>' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n') + '\n',
    })
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toContain('The preview would not load.')
    expect(runnerFailureOf(id)).toHaveLength(0)
    expect(reviewRowsOf(id)).toBe(1)
    expect(mapObjective(fullCardOf(id)).review_runner_failure).toBeNull()
    // This routine task closes on a blocked verdict; the close is now on the
    // audit trail, so the card says it was closed without a passing review.
    expect(card.status).toBe('done')
    expect(mapObjective(fullCardOf(id)).closed_over_review).toMatchObject({ verdict: 'blocked', by: 'state-poller', reason: null })
  })

  it('a reviewer that DID run but emitted no <verdict> keeps its existing handling', async () => {
    const { id } = seedUnderReview({
      transcript: [
        JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I reviewed the diff and it looks fine, but I forgot the tag.' }] } }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n') + '\n',
    })
    await pollAIReviewSessions()

    const card = cardOf(id)
    // Narrowness check: the new branch did NOT fire. This reviewer ran and
    // emitted prose, so it keeps its pre-existing handling verbatim — the old
    // findings text, and whatever status the pre-existing rules choose (the
    // human-review routing rules decide that, and this fix does not touch them).
    expect(card.status).toBe('done')  // unchanged: this reviewer ran
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toBe('Reviewer ended without emitting a verdict block.')
    expect(card.ai_review_findings).not.toContain('produced no output at all')
  })
})
