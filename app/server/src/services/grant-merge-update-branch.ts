/**
 * Grant merge: bring a BEHIND branch up to date itself (obj 901412).
 *
 * The repo's ruleset requires a PR branch to be up to date with its base before
 * it merges, and `mergeUnderGrant` only merges a PR GitHub reports as CLEAN /
 * HAS_HOOKS. So every merge left every other open PR BEHIND, and each one then
 * cost a whole worker session just to merge main into its branch.
 *
 * `mergeUnderGrant` calls `updateBehindBranch` at ONE point: after the grant,
 * card state, passing review, PR-open and CI-green checks have all passed, and
 * only when GitHub's mergeStateStatus is exactly `BEHIND`. Every other state
 * (DIRTY, BLOCKED, UNKNOWN, …) is refused there exactly as before.
 *
 * What it does:
 *  - GitHub's own update-branch call,
 *    `PUT /repos/{owner}/{repo}/pulls/{n}/update-branch` with
 *    `expected_head_sha` = the head the merge tool just read and graded. That is
 *    a merge FROM the base branch into the PR branch. It never rebases, never
 *    force-pushes and never resolves a conflict: if the head moved, or the
 *    update cannot be made cleanly, GitHub refuses it and so do we.
 *  - It does NOT wait for CI and does NOT merge. It returns the distinct result
 *    `branch_updated_ci_pending` (HTTP 202): the branch was updated, CI is now
 *    running on the new head, nothing was merged, the card did not move, call
 *    the merge again when CI is green. The next call reads the NEW head, needs
 *    its CI green and GitHub CLEAN, and pins `--match-head-commit` to it, so a
 *    head whose checks have not passed is never merged.
 *    Why not wait: the merge runs inside a bot's HTTP request or a chat model
 *    turn, and this repo's CI takes minutes; holding either open that long is
 *    a timeout, not a feature.
 *  - It writes a card line (`activity_log`, metadata.kind
 *    `grant_merge_branch_update`). The route writes the `delegation_audit` row
 *    (event `approval_used`, reason `grant_merge:branch_updated_ci_pending`),
 *    the same trail a merge uses.
 *
 * A failed update-branch call is the refusal `branch_update_failed` (502):
 * nothing merged, card not moved.
 */
import type { ExecFn } from './ci-green-gate-decide.js'
import { logActivity } from '../routes/feed.js'

export const BRANCH_UPDATED_CODE = 'branch_updated_ci_pending' as const
export const BRANCH_UPDATE_FAILED_CODE = 'branch_update_failed' as const

export interface BranchUpdateInput {
  exec: ExecFn
  repo: string
  prNumber: number
  /** The head commit the merge tool just read; sent as expected_head_sha. */
  headSha: string
  baseRef?: string | null
  card: { id: number; workspace?: string | null; project?: string | null }
}

export type BranchUpdateOutcome =
  | { ok: false; status: 202; code: typeof BRANCH_UPDATED_CODE; error: string }
  | { ok: false; status: 502; code: typeof BRANCH_UPDATE_FAILED_CODE | 'head_sha_unreadable'; error: string }

export async function updateBehindBranch(input: BranchUpdateInput): Promise<BranchUpdateOutcome> {
  const { exec, repo, prNumber, headSha, card } = input
  const base = input.baseRef || 'its base branch'
  // Never send the update without pinning the head we graded.
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) {
    return {
      ok: false,
      status: 502,
      code: 'head_sha_unreadable',
      error: `GitHub did not return a readable head commit for PR #${prNumber} on ${repo}, so the branch update cannot be pinned to the commit CI checked. Nothing was updated or merged and the card was not closed.`,
    }
  }
  try {
    await exec('gh', [
      'api', '--method', 'PUT',
      '-H', 'Accept: application/vnd.github+json',
      `repos/${repo}/pulls/${prNumber}/update-branch`,
      '-f', `expected_head_sha=${headSha}`,
    ])
  } catch (err) {
    return {
      ok: false,
      status: 502,
      code: BRANCH_UPDATE_FAILED_CODE,
      error: `PR #${prNumber} on ${repo} is behind ${base}, and GitHub refused to update the branch (${(err as Error).message}). Nothing was merged and the card was not closed.`,
    }
  }
  const line = `Updated PR #${prNumber} (${repo}) from ${base} before merging: it was behind (GitHub update-branch from head ${headSha.slice(0, 12)}; a merge from ${base}, no rebase, no force push). Nothing merged yet; CI is running on the new head.`
  try {
    logActivity({
      project: card.project || 'operationkit',
      workspace: card.workspace ?? undefined,
      objective_id: card.id,
      event_type: 'decision',
      title: line,
      metadata: { kind: 'grant_merge_branch_update', repo, pr_number: prNumber, previous_head_sha: headSha, base_ref: input.baseRef ?? null },
    })
  } catch (err) {
    console.warn('[grant-merge] branch-update card line failed:', (err as Error).message)
  }
  return {
    ok: false,
    status: 202,
    code: BRANCH_UPDATED_CODE,
    error: `PR #${prNumber} on ${repo} was behind ${base}, so the branch was updated from ${base} (GitHub update-branch, a merge; no rebase, no force push). CI is now running on the new head. Nothing was merged and the card was not closed: send the merge approval again when CI is green.`,
  }
}
