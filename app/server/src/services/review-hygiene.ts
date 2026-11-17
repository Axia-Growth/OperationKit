/**
 * Review verdict hygiene (obj 900959).
 *
 * Two facts the card must tell the truth about:
 *
 * 1. **A reviewer that never gave a verdict is not a review.** When the reviewer
 *    session fails to start, dies, or ends without a `<verdict>` block, nothing
 *    was judged. That used to be written into `ai_review_verdict` /
 *    `ai_review_findings` as `blocked`, which reads as "the reviewer looked and
 *    could not verify". Now the verdict stays NULL ("not reviewed"), the card is
 *    parked in `review` for a person (never auto-closed), and the failure is
 *    recorded as a runner failure in `activity_log`
 *    (`metadata.kind = 'reviewer_runner_failure'`). A reviewer that RAN and said
 *    `blocked` (e.g. a dead preview host) is still a real `blocked` verdict.
 *
 * 2. **A card closed over a non-pass review says so.** `readClosedOverReview`
 *    derives `{ verdict, by, reason, at }` from the append-only `objective_audit`
 *    trail (the close row; `reason` is the obj 900952 `override_reason`).
 *
 * Deliberately free of `db/index.ts`: every function takes the handle.
 */
import type { Database } from 'better-sqlite3'
import type { ClosedOverReview, ReviewRunnerFailure } from '@operationkit/shared'

export const REVIEWER_RUNNER_FAILURE_KIND = 'reviewer_runner_failure'

/** `no_output` = the reviewer never started or died before emitting anything;
 *  `no_verdict` = it produced text but ended (or died) without a verdict. */
export type ReviewerRunnerFailureCause = 'no_output' | 'no_verdict'

const PARTIAL_MAX = 1500

export function describeReviewerRunnerFailure(cause: ReviewerRunnerFailureCause): string {
  return cause === 'no_output'
    ? 'The reviewer session produced no output: it failed to start, or died before it wrote anything. ' +
      'Nothing was reviewed. This is a runner failure, not a judgement about the work.'
    : 'The reviewer session ended without a verdict: it stopped or died partway through. ' +
      'No review was completed. This is a runner failure, not a judgement about the work.'
}

interface ReviewCardRow {
  id: number
  project?: string | null
  workspace?: string | null
  ai_review_session_id?: string | null
  ai_review_iteration?: number | null
}

export interface ParkUnreviewedDeps {
  db: Database
  /** The guarded machine status write (`runMachineStatusUpdate` on the host). */
  update: (sql: string, ...params: unknown[]) => { changes: number }
}

/**
 * The reviewer gave no verdict. Park the card in `review` with the verdict and
 * findings EMPTY, and record a runner failure. Always `review`, never `done`:
 * a card nobody reviewed must not close itself. Returns the recorded reason, or
 * null when the write was refused (a person already closed the card).
 */
export function parkUnreviewed(
  deps: ParkUnreviewedDeps,
  obj: ReviewCardRow,
  opts: { cause: ReviewerRunnerFailureCause; partial?: string | null },
): string | null {
  const res = deps.update(
    "UPDATE objectives SET status = 'review', ai_review_verdict = NULL, ai_review_findings = NULL, updated_at = datetime('now') WHERE id = ?",
    obj.id,
  )
  if (res.changes < 1) return null
  const reason = describeReviewerRunnerFailure(opts.cause)
  const partial = (opts.partial ?? '').trim()
  const detail = partial ? `${reason}\n--- partial reviewer output ---\n${partial.slice(0, PARTIAL_MAX)}` : reason
  try {
    deps.db.prepare(
      "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata) VALUES (?, ?, ?, ?, 'error', ?, ?, ?)",
    ).run(
      obj.project || 'unknown',
      obj.workspace || 'unknown',
      obj.id,
      obj.ai_review_session_id ?? null,
      REVIEWER_RUNNER_FAILURE_KIND,
      detail,
      JSON.stringify({
        kind: REVIEWER_RUNNER_FAILURE_KIND,
        cause: opts.cause,
        iteration: Number(obj.ai_review_iteration) || 0,
      }),
    )
  } catch (err) {
    console.error(`[review-hygiene] failed to record reviewer runner failure for #${obj.id}:`, err)
  }
  return reason
}

/**
 * The reviewer runner failure that explains why this card has no verdict, or
 * null. Present only while the verdict is empty AND the failed session is still
 * the card's current reviewer session, so a later re-review clears it.
 */
export function readReviewRunnerFailure(
  db: Database,
  row: { id: number; ai_review_verdict?: string | null; ai_review_session_id?: string | null },
): ReviewRunnerFailure | null {
  if (row.ai_review_verdict || !row.ai_review_session_id) return null
  try {
    const hit = db.prepare(
      `SELECT detail, metadata, created_at FROM activity_log
        WHERE objective_id = ? AND session_id = ? AND title = ?
        ORDER BY id DESC LIMIT 1`,
    ).get(row.id, row.ai_review_session_id, REVIEWER_RUNNER_FAILURE_KIND) as
      { detail: string | null; metadata: string | null; created_at: string } | undefined
    if (!hit) return null
    let cause: ReviewerRunnerFailureCause = 'no_verdict'
    try {
      if ((JSON.parse(hit.metadata || '{}') as { cause?: string }).cause === 'no_output') cause = 'no_output'
    } catch { /* keep the default */ }
    return { cause, reason: describeReviewerRunnerFailure(cause), at: hit.created_at }
  } catch {
    return null
  }
}

/**
 * Was this card closed while its review verdict was not `pass`? Derived from the
 * audit trail's latest close row. Present when the card is `done` and either the
 * verdict is `fail` / `blocked`, or the close carried a stated override reason
 * (an agent key closing a PR card with no passing review). A card that was never
 * reviewed and closed without a reason is an ordinary close: null.
 *
 * obj 901230: an agent-key PATCH also gets a MIRROR row from the agent-key guard
 * (`middleware/agent-key-guard.ts`, pathway `agent_api <METHOD> <path>`, no
 * reason), written AFTER the status handler's row. That mirror is skipped, so
 * the close read here is the handler's row, which holds the `override_reason`.
 */
export function readClosedOverReview(
  db: Database,
  row: { id: number; status: string; ai_review_verdict?: string | null },
): ClosedOverReview | null {
  if (row.status !== 'done' || row.ai_review_verdict === 'pass') return null
  const verdict = row.ai_review_verdict === 'fail' || row.ai_review_verdict === 'blocked' ? row.ai_review_verdict : null
  try {
    const close = db.prepare(
      `SELECT actor, reason, created_at FROM objective_audit
        WHERE objective_id = ? AND event_type = 'status_change' AND to_status = 'done'
          AND (pathway IS NULL OR pathway NOT LIKE 'agent\\_api %' ESCAPE '\\')
        ORDER BY id DESC LIMIT 1`,
    ).get(row.id) as { actor: string | null; reason: string | null; created_at: string } | undefined
    if (!close) return null
    const reason = (close.reason ?? '').trim() || null
    if (!verdict && !reason) return null
    return { verdict, by: close.actor ?? null, reason, at: close.created_at }
  } catch {
    return null
  }
}
