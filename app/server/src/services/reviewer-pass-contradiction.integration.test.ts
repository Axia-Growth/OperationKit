/**
 * If the reviewer says "pass" but marks a criterion [FAIL], the card must not be
 * closed. Runs the real `pollAIReviewSessions` against a real database and a real
 * reviewer transcript.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reviewer-pass-contradiction-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-pass-contradiction'
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

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

const RUBRIC = [
  { id: 'crit-1', criterion: 'Backend persists results', type: 'functional', method: 'api' },
  { id: 'crit-2', criterion: 'Export includes the totals row', type: 'functional', method: 'api' },
]

let nextId = 9400100
/** Seeds a task created by a routine. Those skip human review, so a "pass" would
 *  close the card with nobody looking. */
function seedUnderReview(reviewerText: string): number {
  const id = nextId++
  const sid = `cc-${id}-reviewer`
  getDb().prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_session_id, ai_review_iteration, routine_id, acceptance_criteria)
     VALUES (?, ?, 'task', 'ai_review', 'normal', 'operationkit', 'operationkit', ?, 1, 4242, ?)`,
  ).run(id, `obj ${id}`, sid, JSON.stringify(RUBRIC))
  fs.writeFileSync(path.join(TMP, `${sid}.jsonl`), [
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: reviewerText }] } }),
    JSON.stringify({ type: 'result', subtype: 'success' }),
  ].join('\n') + '\n')
  return id
}

function cardOf(id: number) {
  return getDb().prepare('SELECT status, ai_review_verdict, ai_review_findings FROM objectives WHERE id = ?').get(id) as {
    status: string; ai_review_verdict: string | null; ai_review_findings: string | null
  }
}
function reviewRowOf(id: number) {
  return getDb().prepare('SELECT verdict, criteria_results, markdown_body FROM objective_reviews WHERE objective_id = ?').get(id) as {
    verdict: string; criteria_results: string; markdown_body: string
  }
}

describe('a reviewer pass contradicted by its own [FAIL] line', () => {
  it('is recorded as fail and the card is not closed', async () => {
    const id = seedUnderReview([
      '<verdict>pass</verdict>',
      '<findings>',
      '# AI Review Findings',
      '',
      '- [PASS] crit-1: row dump shows the parsed JSON was written',
      '- [FAIL] crit-2: export.csv has 12 data rows and no totals row',
      '</findings>',
    ].join('\n'))
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.status).toBe('review') // no worker session to bounce to
    expect(card.ai_review_verdict).toBe('fail')
    // The findings start with a note explaining the change and keep the reviewer's evidence.
    expect(card.ai_review_findings).toContain('crit-2')
    expect(card.ai_review_findings).toContain('reviewer wrote `pass`')
    expect(card.ai_review_findings).toContain('no totals row')

    const row = reviewRowOf(id)
    expect(row.verdict).toBe('fail')
    expect(row.markdown_body).toContain('reviewer wrote `pass`')
    expect(JSON.parse(row.criteria_results)).toMatchObject([
      { criterion_id: 'crit-1', status: 'pass' },
      { criterion_id: 'crit-2', status: 'fail' },
    ])
  })

  it('a pass whose lines all pass still closes the card, findings untouched', async () => {
    const findings = [
      '# AI Review Findings',
      '',
      '- [PASS] crit-1: row dump shows the parsed JSON was written',
      '- [PASS] crit-2: export.csv ends with the totals row',
    ].join('\n')
    const id = seedUnderReview(`<verdict>pass</verdict>\n<findings>\n${findings}\n</findings>`)
    await pollAIReviewSessions()

    const card = cardOf(id)
    expect(card.status).toBe('done')
    expect(card.ai_review_verdict).toBe('pass')
    expect(card.ai_review_findings).toBe(findings)
    expect(reviewRowOf(id).verdict).toBe('pass')
  })
})
