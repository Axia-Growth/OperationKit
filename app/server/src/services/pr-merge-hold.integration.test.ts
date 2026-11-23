/**
 * obj 901456 — a passed card with an open pull request waits in `review` until
 * the PR merges, then closes.
 *
 * Bug: a reviewer PASS on a task wrote `done` while the PR was still open
 * (#901388 / PR 889, #901389 / PR 888). The merge tools need `review`, so those
 * PRs were refused as `not_in_review`.
 *
 * The PASS half drives `pollAIReviewSessions` itself over a real DB and a real
 * reviewer transcript. The release half drives `releaseMergedPrHolds` with a
 * stub `gh`. Cards are routine-spawned tasks: that is the shape whose PASS went
 * to `done` (a top-level hand-made card is already held by mustRouteToHumanReview).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-pr-merge-hold-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-901456-xxxx'
process.env.TRANSCRIPT_DIR = TMP
process.env.PROJECTS_DIR = TMP

vi.mock('../ws/index.js', () => ({ broadcast: vi.fn(), broadcastToObjective: vi.fn() }))
vi.mock('./notifier.js', () => ({ sendTelegram: vi.fn(), insertAlert: vi.fn() }))
vi.mock('./session-intel-pipeline.js', () => ({ queueExtraction: vi.fn() }))
vi.mock('./session-control.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, getSessionState: () => 'dead', killTmuxByName: () => false }
})
// No GitHub in tests: CI is green, auto-merge does nothing, the harness status post fails fast.
vi.mock('./ci-green-gate.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, runCompletionGate: vi.fn(async () => ({ blocked: false })) }
})
vi.mock('./auto-merge.js', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return { ...actual, evaluateAutoMerge: vi.fn(async () => undefined) }
})
vi.mock('child_process', async (orig) => {
  const actual = await (orig() as Promise<Record<string, unknown>>)
  return {
    ...actual,
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb?: (e: Error | null, out: string) => void) => {
      const done = typeof _opts === 'function' ? (_opts as typeof cb) : cb
      done?.(new Error('no gh in tests'), '')
      return { on: () => undefined } as unknown
    },
  }
})

const { getDb, initDb } = await import('../db/index.js')
const { pollAIReviewSessions } = await import('./poller-ai-review.js')
const {
  releaseMergedPrHolds,
  resetPrMergeHoldThrottle,
  holdForOpenPr,
  PR_MERGE_HOLD_RECHECK_MS,
} = await import('./pr-merge-hold.js')

const REPO = 'your-org/operationkit'

beforeAll(() => { initDb() })
beforeEach(() => {
  resetPrMergeHoldThrottle()
  getDb().prepare("DELETE FROM settings WHERE key = 'pr_merge_hold_enabled'").run()
})
afterAll(() => {
  try { getDb().close() } catch { /* ignore */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

let nextId = 9456000
let nextPr = 7000

const PASS_TRANSCRIPT = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '<verdict>pass</verdict>\n<findings>All criteria met.</findings>' }] } }),
  JSON.stringify({ type: 'result', subtype: 'success' }),
].join('\n') + '\n'

function seedUnderReview(opts: { withPr: boolean }): { id: number; pr: number | null } {
  const db = getDb()
  const id = nextId++
  const sid = `cc-${id}-reviewer`
  const pr = opts.withPr ? nextPr++ : null
  db.prepare(
    `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_session_id, ai_review_iteration, routine_id, pr_number, pr_url)
     VALUES (?, ?, 'task', 'ai_review', 'normal', 'operationkit', 'operationkit', ?, 1, 4242, ?, ?)`,
  ).run(id, `obj ${id}`, sid, pr, pr ? `https://github.com/${REPO}/pull/${pr}` : null)
  fs.writeFileSync(path.join(TMP, `${sid}.jsonl`), PASS_TRANSCRIPT)
  return { id, pr }
}

const statusOf = (id: number) =>
  (getDb().prepare('SELECT status, ai_review_verdict FROM objectives WHERE id = ?').get(id) as { status: string; ai_review_verdict: string | null })
const holdRows = (id: number) =>
  getDb().prepare("SELECT * FROM activity_log WHERE objective_id = ? AND title = 'pr_merge_hold'").all(id) as { metadata: string }[]
const auditRows = (id: number) =>
  getDb().prepare("SELECT * FROM objective_audit WHERE objective_id = ? AND pathway = 'pr-merge-hold-release'").all(id) as { from_status: string; to_status: string }[]

/** A stub `gh pr view` that answers one state for every PR and counts calls. */
function ghSaying(state: 'OPEN' | 'MERGED' | 'CLOSED') {
  const calls: string[][] = []
  const gh = async (args: string[]) => {
    calls.push(args)
    return JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-11-18T23:00:00Z' : null })
  }
  return { gh, calls }
}

describe('reviewer PASS with an open PR', () => {
  it('keeps the card in review (verdict pass) and records the hold', async () => {
    const { id, pr } = seedUnderReview({ withPr: true })
    await pollAIReviewSessions()

    expect(statusOf(id)).toEqual({ status: 'review', ai_review_verdict: 'pass' })   // <- was 'done'
    const holds = holdRows(id)
    expect(holds).toHaveLength(1)
    expect(JSON.parse(holds[0].metadata)).toMatchObject({ kind: 'pr_merge_hold', pathway: 'reviewer-verdict-pass', repo: REPO, pr_number: pr })
  })

  it('stays in review while GitHub says the PR is open, then goes to done once it merges', async () => {
    const { id, pr } = seedUnderReview({ withPr: true })
    await pollAIReviewSessions()
    expect(statusOf(id).status).toBe('review')

    const open = ghSaying('OPEN')
    const t0 = 1_000_000
    let res = await releaseMergedPrHolds(getDb(), { gh: open.gh, now: t0 })
    expect(res.find(r => r.objectiveId === id)?.outcome).toBe('still_open')
    expect(open.calls.find(a => a.includes(String(pr)))).toEqual(['pr', 'view', String(pr), '--repo', REPO, '--json', 'state,mergedAt'])
    expect(statusOf(id).status).toBe('review')

    // Within the recheck window GitHub is not asked again.
    const merged = ghSaying('MERGED')
    res = await releaseMergedPrHolds(getDb(), { gh: merged.gh, now: t0 + 1000 })
    expect(res.find(r => r.objectiveId === id)?.outcome).toBe('throttled')
    expect(statusOf(id).status).toBe('review')

    // The PR merges; the next check closes the card.
    const updated: number[] = []
    res = await releaseMergedPrHolds(getDb(), { gh: merged.gh, now: t0 + PR_MERGE_HOLD_RECHECK_MS + 1, onUpdated: (r) => updated.push(r.id) })
    expect(res.find(r => r.objectiveId === id)?.outcome).toBe('done')
    expect(statusOf(id)).toEqual({ status: 'done', ai_review_verdict: 'pass' })
    expect(updated).toContain(id)
    expect(auditRows(id)).toEqual([expect.objectContaining({ from_status: 'review', to_status: 'done' })])
    // GitHub's answer is now on the board's PR record too.
    const term = getDb().prepare('SELECT state FROM pr_terminal_states WHERE repo = ? AND pr_number = ?').get(REPO, pr) as { state: string }
    expect(term.state).toBe('merged')
  })

  it('a merge the webhook already recorded closes the card with no GitHub call', async () => {
    const { id, pr } = seedUnderReview({ withPr: true })
    await pollAIReviewSessions()
    expect(statusOf(id).status).toBe('review')
    getDb().prepare("INSERT INTO pr_terminal_states (repo, pr_number, state) VALUES (?, ?, 'merged')").run(REPO, pr)

    const never = ghSaying('OPEN')
    const res = await releaseMergedPrHolds(getDb(), { gh: never.gh, now: 5_000_000 })
    expect(res.find(r => r.objectiveId === id)?.outcome).toBe('done')
    expect(never.calls.some(a => a.includes(String(pr)))).toBe(false)
    expect(statusOf(id).status).toBe('done')
  })

  it('a PR closed without merging leaves the card in review for a person', async () => {
    const { id } = seedUnderReview({ withPr: true })
    await pollAIReviewSessions()
    const closed = ghSaying('CLOSED')
    const res = await releaseMergedPrHolds(getDb(), { gh: closed.gh, now: 9_000_000 })
    expect(res.find(r => r.objectiveId === id)?.outcome).toBe('closed_unmerged')
    expect(statusOf(id).status).toBe('review')
  })

  it('a PR already recorded as merged at pass time goes straight to done (no hold)', async () => {
    const { id, pr } = seedUnderReview({ withPr: true })
    getDb().prepare("INSERT INTO pr_terminal_states (repo, pr_number, state) VALUES (?, ?, 'merged')").run(REPO, pr)
    await pollAIReviewSessions()
    expect(statusOf(id).status).toBe('done')
    expect(holdRows(id)).toHaveLength(0)
  })
})

describe('unchanged behaviour', () => {
  it('a passed card with NO PR goes to done exactly as before', async () => {
    const { id } = seedUnderReview({ withPr: false })
    await pollAIReviewSessions()
    expect(statusOf(id)).toEqual({ status: 'done', ai_review_verdict: 'pass' })
    expect(holdRows(id)).toHaveLength(0)
  })

  it('kill switch pr_merge_hold_enabled=0 restores done-on-pass with an open PR', async () => {
    getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('pr_merge_hold_enabled', '0')").run()
    const { id } = seedUnderReview({ withPr: true })
    await pollAIReviewSessions()
    expect(statusOf(id).status).toBe('done')
    expect(holdRows(id)).toHaveLength(0)
  })

  it('the release never closes a passed review card this rule did not hold', async () => {
    const db = getDb()
    const id = nextId++
    const pr = nextPr++
    db.prepare(
      `INSERT INTO objectives (id, title, type, status, effort, project, workspace, ai_review_verdict, pr_number, pr_url)
       VALUES (?, ?, 'task', 'review', 'normal', 'operationkit', 'operationkit', 'pass', ?, ?)`,
    ).run(id, `obj ${id}`, pr, `https://github.com/${REPO}/pull/${pr}`)
    const merged = ghSaying('MERGED')
    const res = await releaseMergedPrHolds(db, { gh: merged.gh, now: 20_000_000 })
    expect(res.find(r => r.objectiveId === id)).toBeUndefined()
    expect(statusOf(id).status).toBe('review')
  })
})

describe('holdForOpenPr (also used by the re-review churn guard in poller-loop.ts)', () => {
  it('rewrites only done, only with an open linked PR', () => {
    const db = getDb()
    const base = { id: nextId++, project: 'operationkit', workspace: 'operationkit' }
    const withPr = { ...base, pr_number: 8123, pr_url: `https://github.com/${REPO}/pull/8123` }
    const noPr = { ...base, pr_number: null, pr_url: null }
    db.prepare(
      `INSERT INTO objectives (id, title, type, status, effort, project, workspace) VALUES (?, 't', 'task', 'working', 'normal', 'operationkit', 'operationkit')`,
    ).run(base.id)
    expect(holdForOpenPr(db, withPr as never, 'review', 'x')).toBe('review')
    expect(holdForOpenPr(db, noPr as never, 'done', 'x')).toBe('done')
    expect(holdForOpenPr(db, withPr as never, 'done', 'rereview-skip-already-passed')).toBe('review')
    expect(JSON.parse(holdRows(base.id)[0].metadata).pathway).toBe('rereview-skip-already-passed')
  })
})
