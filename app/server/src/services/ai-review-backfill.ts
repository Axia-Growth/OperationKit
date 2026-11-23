/**
 * obj 901381 — request an AI review for a card that is ALREADY sitting in
 * `review` with a linked PR and no verdict, without re-running the work.
 *
 * Why this exists: before obj 901381 a card filed with `create_pr = 0` (chat
 * `create_objective`, the internal create route) whose session opened a PR was
 * classified `green` by merge-lane.ts and routed straight to `review`, so the
 * reviewer never spawned and `ai_review_verdict` stayed NULL. Both auto-merge
 * and the grant-approved merge need a `pass` verdict, so those PRs could only be
 * judged by hand. The routing is fixed in poller-decisions.ts
 * (`decideWorkerEndRoute`); this module drains the cards stranded before it.
 *
 * It does exactly what the poller's `ai_review` branch does at session end
 * (bump `ai_review_iteration`, spawn the reviewer, set `status='ai_review'` +
 * `ai_review_session_id`) — and nothing to the worker: no worker session is
 * started or resumed. The poller's normal reviewer-end handling then takes over.
 *
 * Front door: `POST /api/internal/ai-review/request` (routes/internal-ai-review.ts).
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { hasLinkedPr } from './poller-decisions.js'
import { captureReviewHeadSha } from './review-head.js'

/** Columns the eligibility check reads. */
type Row = Pick<
  Objective,
  'id' | 'title' | 'workspace' | 'status' | 'type' | 'pr_number' | 'pr_url' | 'ai_review_verdict' | 'routine_id'
> & {
  ai_review_iteration?: number | null
  delegate_mode?: number | boolean | null
  skip_ai_review?: number | boolean | null
  is_strategy?: number | boolean | null
  deleted_at?: string | null
  origin?: string | null
  create_pr?: number | boolean | null
}

export type ReviewRefusal =
  | 'not_found'
  | 'deleted'
  | 'not_in_review'
  | 'has_verdict'
  | 'no_pr'
  | 'pr_not_open'
  | 'delegator'
  | 'strategy'
  | 'routine'
  | 'skip_ai_review'

/** Pure: why this card may NOT get a requested review, or null when it may. */
export function reviewRequestRefusal(row: Row | undefined): ReviewRefusal | null {
  if (!row) return 'not_found'
  if (row.deleted_at) return 'deleted'
  if (row.status !== 'review') return 'not_in_review'
  if (row.ai_review_verdict != null && String(row.ai_review_verdict) !== '') return 'has_verdict'
  if (!hasLinkedPr(row)) return 'no_pr'
  if (row.delegate_mode) return 'delegator'
  if (row.is_strategy) return 'strategy'
  if (row.routine_id != null) return 'routine'
  if (row.skip_ai_review) return 'skip_ai_review'
  return null
}

const SELECT_COLS = `id, title, workspace, status, type, origin, create_pr, pr_number, pr_url,
  ai_review_verdict, ai_review_iteration, routine_id, delegate_mode, skip_ai_review, is_strategy, deleted_at`

/**
 * Every card stranded the way #901371-#901378 are: in `review`, a linked PR, no
 * verdict, and nothing that would legitimately keep a reviewer off it.
 */
export function findStrandedPrReviews(db: Database.Database, opts: { workspace?: string } = {}): Row[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLS} FROM objectives
        WHERE status = 'review'
          AND (ai_review_verdict IS NULL OR ai_review_verdict = '')
          AND (pr_number IS NOT NULL OR (pr_url IS NOT NULL AND TRIM(pr_url) != ''))
          AND deleted_at IS NULL
          ${opts.workspace ? 'AND workspace = ?' : ''}
        ORDER BY id`,
    )
    .all(...(opts.workspace ? [opts.workspace] : [])) as Row[]
  return rows.filter((r) => reviewRequestRefusal(r) === null)
}

export interface RequestReviewDeps {
  /** Spawns the reviewer; returns its session id (session-manager's spawnReviewerSession). */
  spawnReviewer: (objective: Objective) => Promise<string>
  /**
   * The PR's live state (`OPEN` / `MERGED` / `CLOSED`), or null when it cannot
   * be read. A known non-open PR is refused; an unreadable state proceeds (the
   * reviewer reads the PR itself and will say so).
   */
  prState?: (objective: Objective) => Promise<string | null>
  /** Stops a reviewer that lost the race (the card moved while it spawned). */
  stopSession?: (sessionId: string) => Promise<void>
  /** `gh` runner for recording the reviewed head commit (obj 901455); defaults to the server's gh. */
  headExec?: import('./ci-green-gate-decide.js').ExecFn
}

export type RequestReviewResult =
  | { id: number; ok: true; dry_run: boolean; reviewer_session_id: string | null; iteration: number }
  | { id: number; ok: false; code: ReviewRefusal | 'iteration_cap' | 'spawn_failed' | 'raced'; detail?: string }

/**
 * Request one AI review. Never starts or resumes the worker. `dryRun` checks
 * eligibility (including the PR state) and writes nothing.
 */
export async function requestAiReview(
  db: Database.Database,
  id: number,
  deps: RequestReviewDeps,
  opts: { dryRun?: boolean; requestedBy?: string; maxIteration?: number } = {},
): Promise<RequestReviewResult> {
  const full = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as (Objective & Row) | undefined
  const refusal = reviewRequestRefusal(full)
  if (refusal || !full) return { id, ok: false, code: refusal ?? 'not_found' }
  // obj 901457: a bot asking for its own review must not buy a review round the
  // poller's bounce cap (AI_REVIEW_ITERATION_CAP) would not give the card. The
  // operator backfill route passes no cap, exactly as before.
  if (opts.maxIteration != null && (full.ai_review_iteration || 0) >= opts.maxIteration) {
    return { id, ok: false, code: 'iteration_cap', detail: `${full.ai_review_iteration || 0} of ${opts.maxIteration} review rounds used` }
  }

  if (deps.prState) {
    let state: string | null = null
    try { state = await deps.prState(full) } catch { state = null }
    if (state && state.toUpperCase() !== 'OPEN') {
      return { id, ok: false, code: 'pr_not_open', detail: state.toUpperCase() }
    }
  }

  const iteration = (full.ai_review_iteration || 0) + 1
  if (opts.dryRun) return { id, ok: true, dry_run: true, reviewer_session_id: null, iteration }

  // The reviewer prompt reads the iteration (rubric generation on iteration 1),
  // so it must see the bumped value — same as the poller's ai_review branch.
  ;(full as Objective & { ai_review_iteration: number }).ai_review_iteration = iteration
  let reviewerSessionId: string
  try {
    reviewerSessionId = await deps.spawnReviewer(full)
  } catch (err) {
    return { id, ok: false, code: 'spawn_failed', detail: (err as Error).message }
  }

  // Conditional on the card still being exactly where we found it, so a human
  // who moved it meanwhile wins and the stray reviewer is stopped.
  const r = db
    .prepare(
      `UPDATE objectives SET
         status = 'ai_review',
         ai_review_session_id = ?,
         ai_review_verdict = NULL,
         ai_review_findings = NULL,
         ai_review_iteration = ?,
         ai_review_head_sha = NULL,
         updated_at = datetime('now')
       WHERE id = ? AND status = 'review' AND (ai_review_verdict IS NULL OR ai_review_verdict = '')`,
    )
    .run(reviewerSessionId, iteration, id)
  if (r.changes === 0) {
    if (deps.stopSession) await deps.stopSession(reviewerSessionId).catch(() => {})
    return { id, ok: false, code: 'raced' }
  }
  // obj 901455: record the PR commit this reviewer reads (best-effort, async).
  void captureReviewHeadSha(db, full, reviewerSessionId, deps.headExec)

  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, ?, 'milestone', 'ai_review_requested', ?, ?)`,
    ).run(
      (full as Objective).project || 'unknown',
      full.workspace,
      id,
      reviewerSessionId,
      `AI review requested for a card in review with PR ${full.pr_number ?? full.pr_url} and no verdict (iteration ${iteration}); the work session was not re-run.`,
      JSON.stringify({ kind: 'ai_review_requested', requested_by: opts.requestedBy ?? 'operator', iteration }),
    )
  } catch (err) {
    console.warn(`[ai-review-backfill] activity_log write failed for obj ${id}:`, (err as Error).message)
  }
  return { id, ok: true, dry_run: false, reviewer_session_id: reviewerSessionId, iteration }
}
