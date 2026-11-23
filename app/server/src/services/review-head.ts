/**
 * obj 901455 — tie an AI review to the commit it read.
 *
 * A `pass` verdict used to be a property of the CARD, not of a commit, so a PR
 * could change after the review and still merge on the old pass (#901277: PR 859
 * merged on a review of an older commit). Now:
 *
 *  - When a reviewer is spawned, the PR's head commit is recorded on the card as
 *    `objectives.ai_review_head_sha` (`captureReviewHeadSha`, called from every
 *    spawn site). If that read fails, the poller fills it when it collects the
 *    verdict (`poller-ai-review.ts`), so a pass is never left unpinned by a flaky
 *    GitHub call at spawn time.
 *  - The grant merge (`grant-merge.ts`) compares that commit with the PR head it
 *    is about to merge (`classifyHeadMove`). Same commit → merge. The only commits
 *    since are GitHub "update branch" merges from the base (what PR 896's
 *    update-branch creates) → merge. Anything else → refuse with `review_stale`
 *    and request a fresh review (`requestReReviewForStalePass`).
 *
 * A card whose pass predates this column (`ai_review_head_sha` NULL) is merged as
 * before: there is no record of what it read, and refusing every queued PR would
 * force a re-review of the whole board.
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import type { ExecFn } from './ci-green-gate-decide.js'
import { repoFromPrUrl } from './ci-green-gate-run.js'

const SHA_RE = /^[0-9a-f]{7,64}$/i

export function isSha(s: unknown): s is string {
  return typeof s === 'string' && SHA_RE.test(s.trim())
}

/** Two SHAs name the same commit (either may be abbreviated, 7+ chars). */
export function sameSha(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = (a ?? '').trim().toLowerCase()
  const y = (b ?? '').trim().toLowerCase()
  if (!isSha(x) || !isSha(y)) return false
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y)
}

/** The PR's current head commit, or null when it cannot be read. */
export async function fetchPrHeadSha(repo: string, prNumber: number, exec: ExecFn): Promise<string | null> {
  try {
    const raw = await exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'headRefOid'])
    const sha = String((JSON.parse(raw) as { headRefOid?: string }).headRefOid ?? '').trim()
    return isSha(sha) ? sha : null
  } catch {
    return null
  }
}

type HeadCard = Pick<Objective, 'id' | 'pr_url' | 'pr_number'>

function prOf(card: HeadCard): { repo: string; prNumber: number } | null {
  const repo = repoFromPrUrl(card.pr_url)
  const n = card.pr_number != null ? Number(card.pr_number) : Number(/\/pull\/(\d+)/.exec(card.pr_url ?? '')?.[1])
  if (!repo || !Number.isInteger(n) || n <= 0) return null
  return { repo, prNumber: n }
}

/**
 * Record the head commit a reviewer is about to read. Best-effort, never throws.
 * Guarded on the reviewer session so a late answer cannot stamp a newer review.
 * `onlyIfEmpty` is the verdict-time fallback: it never overwrites a spawn-time read.
 */
export async function captureReviewHeadSha(
  db: Database.Database,
  card: HeadCard,
  reviewerSessionId: string,
  exec?: ExecFn,
  opts: { onlyIfEmpty?: boolean } = {},
): Promise<string | null> {
  try {
    const pr = prOf(card)
    if (!pr) return null
    // Same convention as worktree-reaper / stall-watchdog: a test that spawns a
    // reviewer through a real code path never shells out to the real `gh`.
    if (!exec && process.env.VITEST && process.env.CC_REVIEW_HEAD_IN_TESTS !== '1') return null
    const run = exec ?? (await import('./ci-green-gate-github.js')).defaultExec
    const sha = await fetchPrHeadSha(pr.repo, pr.prNumber, run)
    if (!sha) return null
    const r = db
      .prepare(
        `UPDATE objectives SET ai_review_head_sha = ?
          WHERE id = ? AND ai_review_session_id = ?${opts.onlyIfEmpty ? " AND (ai_review_head_sha IS NULL OR ai_review_head_sha = '')" : ''}`,
      )
      .run(sha, card.id, reviewerSessionId)
    return r.changes > 0 ? sha : null
  } catch (err) {
    console.warn(`[review-head] could not record the reviewed commit for card #${card.id}:`, (err as Error).message)
    return null
  }
}

/** A commit as GitHub's REST `GET /repos/:repo/commits/:sha` returns it (the fields read here). */
interface GhCommit {
  sha?: string
  parents?: Array<{ sha?: string }>
  commit?: { message?: string; committer?: { name?: string; email?: string } }
  committer?: { login?: string } | null
}

/**
 * True when this commit is a merge GitHub itself made when a PR branch was
 * updated from its base: two parents, committed by GitHub (`web-flow`), message
 * `Merge branch '<base>' into <branch>`. That is the commit the update-branch API
 * (and the "Update branch" button) writes; a person's push is not.
 */
export function isUpdateBranchMerge(c: GhCommit, baseRef: string | null | undefined): boolean {
  if (!c || (c.parents?.length ?? 0) !== 2) return false
  const byGithub = c.committer?.login === 'web-flow' || (c.commit?.committer?.email ?? '').toLowerCase() === 'noreply@github.com'
  if (!byGithub) return false
  const m = /^Merge branch '([^']+)' into \S+/.exec((c.commit?.message ?? '').trim())
  if (!m) return false
  if (baseRef && m[1] !== baseRef) return false
  return true
}

export type HeadMove =
  | { kind: 'same' }
  | { kind: 'update_branch_only'; merges: string[] }
  | { kind: 'moved'; reason: string }

/** Most GitHub update-branch merges allowed between the reviewed commit and the head. */
export const MAX_UPDATE_BRANCH_HOPS = 10

/**
 * What happened to the PR between the reviewed commit and its head. Walks the
 * FIRST-parent chain back from the head: every step must be a GitHub
 * update-branch merge, and the chain must reach the reviewed commit. Anything it
 * cannot read counts as `moved` (fail closed: a re-review, never an unchecked merge).
 */
export async function classifyHeadMove(input: {
  repo: string
  reviewedSha: string
  headSha: string
  baseRef?: string | null
  exec: ExecFn
}): Promise<HeadMove> {
  const { repo, reviewedSha, headSha, baseRef, exec } = input
  if (sameSha(reviewedSha, headSha)) return { kind: 'same' }
  const merges: string[] = []
  let cur = headSha
  for (let i = 0; i < MAX_UPDATE_BRANCH_HOPS; i++) {
    let c: GhCommit
    try {
      c = JSON.parse(await exec('gh', ['api', `repos/${repo}/commits/${cur}`])) as GhCommit
    } catch (err) {
      return { kind: 'moved', reason: `commit ${cur.slice(0, 12)} could not be read (${(err as Error).message})` }
    }
    if (!isUpdateBranchMerge(c, baseRef)) {
      return { kind: 'moved', reason: `commit ${cur.slice(0, 12)} is not a GitHub update-branch merge from ${baseRef || 'the base branch'}` }
    }
    merges.push(String(c.sha ?? cur))
    const first = String(c.parents?.[0]?.sha ?? '')
    if (sameSha(reviewedSha, first)) return { kind: 'update_branch_only', merges }
    if (!isSha(first)) return { kind: 'moved', reason: `commit ${cur.slice(0, 12)} has no readable first parent` }
    cur = first
  }
  return { kind: 'moved', reason: `more than ${MAX_UPDATE_BRANCH_HOPS} commits since the reviewed one` }
}

/**
 * The grant merge refused a pass that read an older commit: clear that pass
 * (only while the card is still in review on it) and request a fresh review
 * through the same door the stranded-review drain uses. Never starts the worker.
 * Returns the new reviewer's session id, or null when no review could start (the
 * pass stays cleared, so the card cannot merge on it; the stranded-review drain
 * or a person picks it up).
 */
export async function requestReReviewForStalePass(
  db: Database.Database,
  card: Pick<Objective, 'id'>,
  info: { reviewedSha: string; headSha: string },
  deps?: import('./ai-review-backfill.js').RequestReviewDeps,
): Promise<{ cleared: boolean; reviewerSessionId: string | null; detail?: string }> {
  const cleared = db
    .prepare(
      `UPDATE objectives SET ai_review_verdict = NULL, updated_at = datetime('now')
        WHERE id = ? AND status = 'review' AND ai_review_verdict = 'pass'
          AND ai_review_head_sha = ?`,
    )
    .run(card.id, info.reviewedSha).changes > 0
  if (!cleared) return { cleared: false, reviewerSessionId: null, detail: 'the card moved meanwhile' }
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, event_type, title, detail, metadata)
       SELECT COALESCE(project, 'unknown'), workspace, id, 'milestone', 'ai_review_stale',
              ?, ? FROM objectives WHERE id = ?`,
    ).run(
      `The AI review passed commit ${info.reviewedSha.slice(0, 12)}, but the PR head is now ${info.headSha.slice(0, 12)} with changes beyond a GitHub update-branch merge. The pass was cleared and a fresh review requested; nothing was merged.`,
      JSON.stringify({ kind: 'ai_review_stale', reviewed_head_sha: info.reviewedSha, pr_head_sha: info.headSha }),
      card.id,
    )
  } catch { /* the activity line is best-effort */ }
  try {
    const { requestAiReview } = await import('./ai-review-backfill.js')
    const d = deps ?? (await import('../routes/internal-ai-review.js')).defaultAiReviewDeps()
    const r = await requestAiReview(db, card.id, d, { requestedBy: 'grant-merge:review_stale' })
    return r.ok ? { cleared, reviewerSessionId: r.reviewer_session_id } : { cleared, reviewerSessionId: null, detail: r.code }
  } catch (err) {
    return { cleared, reviewerSessionId: null, detail: (err as Error).message }
  }
}
