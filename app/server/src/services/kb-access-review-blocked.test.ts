/**
 * obj 901525 — criterion c4: a review that could not check a criterion for
 * ACCESS reasons (it could not reach a knowledge-base file through the docs
 * route) must not count toward the review cap.
 *
 * `pollAIReviewSessions` already keeps a `blocked` verdict out of the
 * fail/respawn/cap-out machinery (`AI_REVIEW_ITERATION_CAP` /
 * `decideRespawnAction` / `escalateCapOut` only run in the FAIL branch of
 * `poller-ai-review.ts`). The fix that makes this matter is the new reviewer
 * prompt instruction (`buildReviewerKbAccessBlock`, `kb-access-prompt.ts`)
 * telling the reviewer to emit `blocked`, never `fail`, when a KB file is
 * unreachable for access reasons — so this test seeds a card already AT the
 * iteration cap and proves a `blocked` verdict still does not cap it out,
 * respawn the worker, or touch `ai_review_cap_out`. A regression that routed
 * KB-access blocks through the fail path would show up here as a cap-out /
 * respawn instead of a clean park in `review`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-access-blocked-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-901525-kb-blocked'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
// The reviewer session is over; nothing here should reach tmux, the network,
// or respawn a worker session.
vi.mock('./session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, getSessionState: () => 'dead', killTmuxByName: () => false }
})
const sendFollowUpMock = vi.fn()
vi.mock('./session-manager.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, sendFollowUp: sendFollowUpMock, startSession: vi.fn() }
})

const { getDb, initDb } = await import('../db/index.js')
const { pollAIReviewSessions } = await import('./poller-ai-review.js')
const { AI_REVIEW_ITERATION_CAP } = await import('./poller-decisions.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 9901525
function seedAtCap(opts: { transcript: string }): { id: number; sid: string } {
  const db = getDb()
  const id = nextId++
  const sid = `cc-${id}-reviewer`
  // Already AT the iteration cap — the exact state in which a `fail` verdict
  // would escalateCapOut. type='feature' (not a parentless task) so a
  // `blocked` verdict routes to `review`, not `done`.
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_session_id, ai_review_iteration, session_id)
     VALUES (?, ?, 'feature', 'ai_review', 'normal', 'operationkit', 'operationkit', ?, ?, 'cc-worker-session')`,
  ).run(id, `obj ${id}`, sid, AI_REVIEW_ITERATION_CAP)
  fs.writeFileSync(path.join(TMP, `${sid}.jsonl`), opts.transcript)
  return { id, sid }
}

function cardOf(id: number) {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as {
    status: string; ai_review_verdict: string | null; ai_review_findings: string | null; session_id: string | null
  }
}

function capOutRowsOf(id: number): number {
  return (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM activity_log WHERE objective_id = ? AND metadata LIKE '%ai_review_cap_out%'")
      .get(id) as { n: number }
  ).n
}

describe('a BLOCKED verdict for a KB-access problem never counts toward the review cap', () => {
  it('reviewer blocked on a docs-route access failure, already at the cap → parked in review, no cap-out, no worker respawn', async () => {
    const { id } = seedAtCap({
      transcript: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'text',
              text: '<verdict>blocked</verdict>\n<findings>- [BLOCKED] vault-runbook: GET /api/docs/file returned 403 — could not check, not evidence the file is missing</findings>',
            }],
          },
        }),
        JSON.stringify({ type: 'result', subtype: 'success' }),
      ].join('\n') + '\n',
    })

    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.ai_review_verdict).toBe('blocked')
    expect(card.ai_review_findings).toContain('could not check')
    // Parked for a human — never force-closed, never cap-out escalated.
    expect(card.status).toBe('review')
    expect(capOutRowsOf(id)).toBe(0)
    // The worker was never respawned (no follow-up sent, session_id unchanged).
    expect(sendFollowUpMock).not.toHaveBeenCalled()
    expect(card.session_id).toBe('cc-worker-session')
  })
})
