/**
 * Operation Kit Dev: merge its own PRs once CI is green (obj 901424, scope 1).
 *
 * The owner approved fewer walls for Dev than the grant-merge path
 * (services/grant-merge.ts) has. Compared with `mergeUnderGrant`, this path:
 *
 *  - needs no merge grant: the dev-ops switch (switch.ts) is the gate;
 *  - merges a card that is already DONE (and one in review, blocked, or in
 *    ai_review), not only one waiting in review;
 *  - merges with NO AI review yet. A review that FAILED (`fail` / `blocked`)
 *    still refuses: a reviewer found something, and that is not "no review";
 *  - merges a project-type card;
 *  - updates a BEHIND branch itself (GitHub update-branch, pinned to the head it
 *    read, a merge from the base, never a rebase or force push), then merges
 *    once CI is green on the NEW head. The waiting happens in the background
 *    tick below, not inside the chat turn.
 *
 * What did NOT change, and must not:
 *  - Reserved PRs are refused before any GitHub call, with the very same seed +
 *    setting + env (`loadReservedPrs` / `reservedPrMatch`). PR 645 in
 *    operationkit and in operationkit stays reserved.
 *  - Only Dev's own cards: `cardOwnerBot` says Dev owns it, or Dev's chat filed
 *    it (`agent_chat_cards`). In a workspace the bot may use, on a card the
 *    person can see.
 *  - A worker still running (queue / planning / working) or a cancelled card is
 *    refused. Strategy and money-path cards are refused.
 *  - CI green is the strict merge rule (`ciGreenForMerge`: every check
 *    finished green, required checks readable, zero checks refuses), and the
 *    merge is pinned with `--match-head-commit` to the head that was checked.
 *  - Only GitHub CLEAN / HAS_HOOKS merges. DIRTY, BLOCKED, UNKNOWN refuse.
 *
 * Every call and every background step writes a dev_ops_audit row.
 */
import type { Objective, User } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import type { AuthRequest } from '../../middleware/auth.js'
import { runStatusChange } from '../../routes/objectives-status.js'
import { logActivity } from '../../routes/feed.js'
import { cardOwnerBot, ownerHasSlug } from '../bots/card-owner.js'
import { fetchPrCheckState, fetchRequiredChecks } from '../ci-green-gate-github.js'
import type { ExecFn } from '../ci-green-gate-decide.js'
import { repoFromPrUrl } from '../ci-green-gate-run.js'
import {
  isGhCredentialRejected,
  isGhNotLoggedIn,
  NO_MERGE_CREDENTIAL_MESSAGE,
  resolveMergeGithubAuth,
  type MergeGithubAuth,
  type MergeGithubAuthQuery,
} from '../grant-merge-github-auth.js'
import { ciGreenForMerge, loadReservedPrs, reservedPrMatch, type CiGreenResult, type ReservedPr } from '../grant-merge.js'
import { isMoneyPath } from '../merge-lane.js'
import { writeDevOpsAudit } from './audit.js'
import { DEV_OPS_BOT_SLUG, getDevOpsSwitch } from './switch.js'

export type DevMergeCode =
  | 'merged'
  | 'already_merged'
  | 'branch_updated_waiting_for_ci'
  | 'no_pr'
  | 'reserved_pr'
  | 'not_dev_card'
  | 'strategy'
  | 'money_path'
  | 'card_still_running'
  | 'card_cancelled'
  | 'review_failed'
  | 'pr_not_open'
  | 'ci_not_green'
  | 'pr_not_mergeable'
  | 'pr_state_unreadable'
  | 'head_sha_unreadable'
  | 'branch_update_failed'
  | 'merge_failed'
  | 'github_credential_missing'
  | 'github_credential_rejected'

export type DevMergeCard = Pick<
  Objective,
  'id' | 'title' | 'description' | 'status' | 'type' | 'workspace' | 'project' | 'pr_url' | 'pr_number' | 'is_strategy'
> & { ai_review_verdict?: string | null; owner_bot?: string | null; agent_context?: string | null }

export interface DevMergeResult {
  ok: boolean
  code: DevMergeCode
  message: string
  repo?: string
  pr_number?: number
  pr_url?: string
  head_sha?: string
  /** The card moved to done after the merge (or was already done). */
  card_done?: boolean
  pending_id?: number
}

/** Statuses where a worker may still be pushing to the branch. */
const RUNNING = new Set(['queue', 'planning', 'working'])
const FAILED_VERDICTS = new Set(['fail', 'blocked'])

/**
 * Is this a Dev card? Dev's chat filed it (`agent_chat_cards`), or Dev owns it
 * (`cardOwnerBot`) AND it was created by an admin or by the system (no
 * creator). A member's card that merely names Dev as its owner does not count:
 * with no review required, that label alone must not open a merge.
 */
export function isDevCard(card: Pick<DevMergeCard, 'id' | 'owner_bot' | 'agent_context'> & { created_by?: number | null }): boolean {
  const db = getDb()
  try {
    const filed = db.prepare('SELECT agent_slug FROM agent_chat_cards WHERE objective_id = ?').get(card.id) as { agent_slug?: string } | undefined
    if (String(filed?.agent_slug ?? '').toLowerCase() === DEV_OPS_BOT_SLUG) return true
  } catch { /* fall through to ownership */ }
  try {
    if (!ownerHasSlug(cardOwnerBot(card, db), DEV_OPS_BOT_SLUG)) return false
    const creator = card.created_by ?? (db.prepare('SELECT created_by FROM objectives WHERE id = ?').get(card.id) as { created_by?: number | null } | undefined)?.created_by ?? null
    if (creator == null) return true
    const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(creator) as { role?: string } | undefined)?.role
    return role === 'admin'
  } catch {
    return false
  }
}

const no = (code: DevMergeCode, message: string, extra: Partial<DevMergeResult> = {}): DevMergeResult => ({ ok: false, code, message, ...extra })

/** The checks that need no GitHub call. Pure apart from the ownership read. Null = go on. */
export function precheckDevMerge(card: DevMergeCard, reserved: readonly ReservedPr[]): DevMergeResult | null {
  if (!(card.pr_number != null && Number(card.pr_number) > 0) && !/\/pull\/\d+/.test(card.pr_url ?? '')) {
    return no('no_pr', `Card #${card.id} has no pull request, so there is nothing to merge.`)
  }
  const hit = reservedPrMatch(card, reserved)
  if (hit) {
    return no('reserved_pr', `PR #${hit.number}${hit.repo ? ` (${hit.repo})` : ''} is reserved: only the owner merges it. Nothing was merged.`)
  }
  if (!isDevCard(card)) return no('not_dev_card', `Card #${card.id} is not a Dev bot card (not owned or filed by the Dev bot), so Dev may not merge it.`)
  if (card.is_strategy) return no('strategy', `Card #${card.id} is a Strategy; only the owner closes a Strategy.`)
  if (isMoneyPath(card)) return no('money_path', `Card #${card.id} is on the money path (billing/payments); the owner merges it.`)
  if (card.status === 'cancelled') return no('card_cancelled', `Card #${card.id} is cancelled; its PR is not merged.`)
  if (RUNNING.has(card.status)) {
    return no('card_still_running', `Card #${card.id} is ${card.status}: its worker may still push to the branch. Merge once it has finished.`)
  }
  if (FAILED_VERDICTS.has(String(card.ai_review_verdict ?? ''))) {
    return no('review_failed', `Card #${card.id}'s AI review did not pass (verdict: ${card.ai_review_verdict}). Fix the findings first; nothing was merged.`)
  }
  return null
}

export function prNumberOf(card: Pick<DevMergeCard, 'pr_number' | 'pr_url'>): number {
  if (card.pr_number != null && Number(card.pr_number) > 0) return Number(card.pr_number)
  const m = /\/pull\/(\d+)/.exec(card.pr_url ?? '')
  return m ? Number(m[1]) : 0
}

export interface PrRead {
  url: string
  headSha: string
  baseRef: string
  state: string
  mergeState: string
  ci: CiGreenResult
}

/** One read of the PR: head, base, state, mergeability and strict CI. Throws on a GitHub error. */
export async function readPr(exec: ExecFn, repo: string, prNumber: number): Promise<PrRead> {
  const pr = await fetchPrCheckState(repo, prNumber, exec)
  const required = await fetchRequiredChecks(repo, pr.baseRef, exec)
  const ci = ciGreenForMerge(required, pr.rollup)
  const raw = await exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeStateStatus'])
  const j = JSON.parse(raw) as { state?: string; mergeStateStatus?: string }
  return {
    url: pr.url,
    headSha: typeof pr.headSha === 'string' ? pr.headSha.trim() : '',
    baseRef: pr.baseRef ?? '',
    state: String(j.state ?? '').toUpperCase(),
    mergeState: String(j.mergeStateStatus ?? '').toUpperCase(),
    ci,
  }
}

const SHA_RE = /^[0-9a-f]{7,64}$/i

function ghFailure(err: unknown, repo: string): DevMergeResult | null {
  const m = (err as Error)?.message ?? ''
  if (isGhNotLoggedIn(m)) return no('github_credential_missing', `${NO_MERGE_CREDENTIAL_MESSAGE} Nothing was merged.`)
  if (isGhCredentialRejected(m)) {
    return no('github_credential_rejected', `GitHub rejected the credential the server used (expired, revoked, or not authorised for ${repo}). Reconnect GitHub in Settings → Integrations. Nothing was merged.`)
  }
  return null
}

export interface DevMergeDeps {
  /** A ready `gh` runner (tests). When given, no credential is resolved. */
  exec?: ExecFn
  resolveAuth?: (q: MergeGithubAuthQuery) => MergeGithubAuth | null
  reserved?: readonly ReservedPr[]
}

export interface DevActor {
  userId: number
  username: string
  botSlug: string
}

function resolveExec(card: DevMergeCard, actor: DevActor, deps: DevMergeDeps): ExecFn | null {
  if (deps.exec) return deps.exec
  const auth = (deps.resolveAuth ?? resolveMergeGithubAuth)({ workspace: card.workspace, grantorUserId: actor.userId, agent: actor.botSlug })
  return auth ? auth.exec : null
}

/** GitHub's update-branch, pinned to the head we read. A merge from the base; never a rebase or force push. */
export async function updateBranch(exec: ExecFn, repo: string, prNumber: number, headSha: string): Promise<void> {
  await exec('gh', [
    'api', '--method', 'PUT',
    '-H', 'Accept: application/vnd.github+json',
    `repos/${repo}/pulls/${prNumber}/update-branch`,
    '-f', `expected_head_sha=${headSha}`,
  ])
}

async function squashMerge(exec: ExecFn, repo: string, prNumber: number, headSha: string): Promise<void> {
  await exec('gh', ['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo, '--match-head-commit', headSha])
}

/** Move the card to done through the status handler (every completion gate applies). */
export async function closeCardDone(cardId: number, actor: DevActor, pathway: string): Promise<{ ok: boolean; error?: string }> {
  const db = getDb()
  const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(cardId) as { status?: string } | undefined
  if (!row) return { ok: false, error: 'card not found' }
  if (row.status === 'done') return { ok: true }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.userId) as User | undefined
  const req = { user, headers: {}, authVia: 'session' } as unknown as AuthRequest
  const r = await runStatusChange(req, cardId, 'done', { actor: `bot:${actor.botSlug} (chat, for ${actor.username})`, pathway, humanTerminal: false })
  if (r.code === 200) return { ok: true }
  return { ok: false, error: (r.body as { error?: string } | undefined)?.error ?? `status ${r.code}` }
}

function cardLine(card: Pick<DevMergeCard, 'id' | 'project' | 'workspace'>, title: string, metadata: Record<string, unknown>): void {
  try {
    logActivity({
      project: card.project || 'operationkit',
      workspace: card.workspace ?? undefined,
      objective_id: card.id,
      event_type: 'decision',
      title,
      metadata,
    })
  } catch (err) {
    console.warn('[dev-ops] card line failed:', (err as Error).message)
  }
}

/**
 * Merge one of Dev's cards' PR. Writes the audit rows itself. A BEHIND branch is
 * updated and queued; the tick merges it when CI on the new head is green.
 */
export async function devMerge(card: DevMergeCard, actor: DevActor, deps: DevMergeDeps = {}): Promise<DevMergeResult> {
  const audit = (r: DevMergeResult, action = 'merge') => {
    writeDevOpsAudit({
      bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action,
      target: r.repo && r.pr_number ? `${r.repo}#${r.pr_number}` : `card #${card.id}`,
      objective_id: card.id,
      outcome: r.code === 'merged' || r.code === 'already_merged' ? 'done' : r.code === 'branch_updated_waiting_for_ci' ? 'waiting' : 'refused',
      code: r.code,
      detail: r.message,
    })
    return r
  }

  const pre = precheckDevMerge(card, deps.reserved ?? loadReservedPrs())
  if (pre) return audit(pre)
  const prNumber = prNumberOf(card)
  const repo = repoFromPrUrl(card.pr_url)
  if (!repo) return audit(no('pr_state_unreadable', `Card #${card.id} has PR #${prNumber} but no GitHub link to read its repo from. Nothing was merged.`, { pr_number: prNumber }))
  const base = { repo, pr_number: prNumber }

  const exec = resolveExec(card, actor, deps)
  if (!exec) return audit(no('github_credential_missing', `${NO_MERGE_CREDENTIAL_MESSAGE} Nothing was merged.`, base))

  let pr: PrRead
  try {
    pr = await readPr(exec, repo, prNumber)
  } catch (err) {
    return audit({ ...(ghFailure(err, repo) ?? no('pr_state_unreadable', `Could not read PR #${prNumber} on ${repo} (${(err as Error).message}). Nothing was merged.`)), ...base })
  }
  const withPr = { ...base, pr_url: pr.url || card.pr_url || undefined }

  if (pr.state === 'MERGED') {
    const done = await closeCardDone(card.id, actor, 'dev-ops:merge')
    return audit({ ok: true, code: 'already_merged', message: `PR #${prNumber} on ${repo} is already merged.${done.ok ? ` Card #${card.id} is done.` : ` The card could not be marked done: ${done.error}.`}`, card_done: done.ok, ...withPr })
  }
  if (pr.state && pr.state !== 'OPEN') return audit(no('pr_not_open', `PR #${prNumber} on ${repo} is ${pr.state.toLowerCase()}, not open. Nothing was merged.`, withPr))
  if (!SHA_RE.test(pr.headSha)) {
    return audit(no('head_sha_unreadable', `GitHub did not return a readable head commit for PR #${prNumber}, so nothing can be pinned. Nothing was merged.`, withPr))
  }

  if (pr.mergeState === 'BEHIND') {
    try {
      await updateBranch(exec, repo, prNumber, pr.headSha)
    } catch (err) {
      return audit({ ...(ghFailure(err, repo) ?? no('branch_update_failed', `PR #${prNumber} is behind ${pr.baseRef || 'its base'} and GitHub refused to update the branch (${(err as Error).message}). Nothing was merged.`)), ...withPr })
    }
    const pendingId = Number(getDb().prepare(
      `INSERT INTO dev_ops_pending_merges (objective_id, repo, pr_number, previous_head_sha, bot_slug, user_id, username, last_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'branch updated; waiting for CI on the new head')`,
    ).run(card.id, repo, prNumber, pr.headSha, actor.botSlug, actor.userId, actor.username).lastInsertRowid)
    cardLine(card, `The Dev bot updated PR #${prNumber} (${repo}) from ${pr.baseRef || 'its base'} (it was behind). It merges itself once CI is green on the new head.`, {
      kind: 'dev_ops_branch_update', repo, pr_number: prNumber, previous_head_sha: pr.headSha, pending_id: pendingId,
    })
    return audit({
      ok: true, code: 'branch_updated_waiting_for_ci', pending_id: pendingId, head_sha: pr.headSha,
      message: `PR #${prNumber} was behind ${pr.baseRef || 'its base'}, so I updated the branch (a merge from ${pr.baseRef || 'the base'}; no rebase, no force push). CI is running on the new head; I merge it automatically as soon as CI is green there.`,
      ...withPr,
    }, 'branch_update')
  }

  if (!pr.ci.green) return audit(no('ci_not_green', `CI is not green on PR #${prNumber}: ${pr.ci.reason}. Nothing was merged.`, withPr))
  if (pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS') {
    return audit(no('pr_not_mergeable', `PR #${prNumber} is not cleanly mergeable (GitHub says ${pr.mergeState || 'unknown'}). Nothing was merged.`, withPr))
  }

  try {
    await squashMerge(exec, repo, prNumber, pr.headSha)
  } catch (err) {
    return audit({ ...(ghFailure(err, repo) ?? no('merge_failed', `GitHub refused the squash-merge of PR #${prNumber} (${(err as Error).message}).`)), ...withPr })
  }
  cardLine(card, `The Dev bot squash-merged PR #${prNumber} (${repo}) at ${pr.headSha.slice(0, 12)} for ${actor.username}; ${pr.ci.reason}.`, {
    kind: 'dev_ops_merge', repo, pr_number: prNumber, head_sha: pr.headSha,
  })
  const done = await closeCardDone(card.id, actor, 'dev-ops:merge')
  return audit({
    ok: true, code: 'merged', head_sha: pr.headSha, card_done: done.ok,
    message: `Squash-merged PR #${prNumber} on ${repo} (${pr.ci.reason}).${done.ok ? ` Card #${card.id} is done.` : ` The card could not be marked done: ${done.error}.`}`,
    ...withPr,
  })
}

// ── Background: merge an updated branch once CI on the new head is green ──

/** Is `sha` a merge commit with `previous` as one of exactly two parents (GitHub's update-branch result)? */
export async function isUpdateCommitOf(exec: ExecFn, repo: string, sha: string, previous: string): Promise<boolean> {
  try {
    const raw = await exec('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '[.parents[].sha]'])
    const parents = JSON.parse(raw) as unknown
    return Array.isArray(parents) && parents.length === 2 && parents.some(p => typeof p === 'string' && p.toLowerCase().startsWith(previous.toLowerCase()))
  } catch {
    return false
  }
}

/** How long a pending merge waits for CI before giving up. */
export const PENDING_MERGE_TTL_MS = 90 * 60_000
/** How long GitHub may take to put the update commit on the branch. */
const UPDATE_LAG_MS = 10 * 60_000
/** Update a branch that fell behind again at most this many times. */
const MAX_UPDATES = 3

interface PendingRow {
  id: number
  objective_id: number
  repo: string
  pr_number: number
  previous_head_sha: string
  bot_slug: string
  user_id: number | null
  username: string | null
  updates: number
  created_at: string
  updated_at: string
}

const ms = (sqlTime: string) => Date.parse(sqlTime.replace(' ', 'T') + (sqlTime.endsWith('Z') ? '' : 'Z'))

export interface PendingTickResult {
  id: number
  outcome: 'merged' | 'waiting' | 'failed' | 'expired' | 'updated_again'
  reason: string
}

/** One pass over the waiting merges. Host tick + tests. */
export async function processPendingMerges(deps: DevMergeDeps & { now?: () => number } = {}): Promise<PendingTickResult[]> {
  const db = getDb()
  const now = (deps.now ?? Date.now)()
  const rows = db.prepare("SELECT * FROM dev_ops_pending_merges WHERE status = 'waiting' ORDER BY id").all() as PendingRow[]
  const out: PendingTickResult[] = []
  for (const row of rows) {
    const actor: DevActor = { userId: row.user_id ?? 0, username: row.username ?? 'unknown', botSlug: row.bot_slug }
    const finish = (status: 'merged' | 'failed' | 'expired', reason: string, code: string) => {
      db.prepare("UPDATE dev_ops_pending_merges SET status = ?, last_reason = ?, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = ?").run(status, reason, row.id)
      writeDevOpsAudit({
        bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'merge_on_green',
        target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id,
        outcome: status === 'merged' ? 'done' : 'failed', code, detail: reason,
      })
      out.push({ id: row.id, outcome: status, reason })
    }
    const wait = (reason: string) => {
      db.prepare("UPDATE dev_ops_pending_merges SET last_reason = ? WHERE id = ?").run(reason, row.id)
      out.push({ id: row.id, outcome: 'waiting', reason })
    }

    // The switch, the card and the reserved list are re-read on every pass.
    if (!getDevOpsSwitch(row.bot_slug).enabled) { finish('failed', 'Operator tools were switched off; the waiting merge was dropped.', 'switch_off'); continue }
    const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id ?? -1) as { role?: string } | undefined)?.role
    if (role !== 'admin') { finish('failed', 'The person who asked for the merge is no longer an admin; nothing was merged.', 'not_admin'); continue }
    const card = db.prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(row.objective_id) as DevMergeCard | undefined
    if (!card) { finish('failed', 'The card is gone; nothing was merged.', 'card_missing'); continue }
    const reserved = deps.reserved ?? loadReservedPrs()
    // The PR this row will merge, by its stored repo + number (not whatever the card links now).
    const stored = { pr_url: `https://github.com/${row.repo}/pull/${row.pr_number}`, pr_number: row.pr_number }
    if (reservedPrMatch(stored, reserved)) { finish('failed', `PR #${row.pr_number} (${row.repo}) is reserved; nothing was merged.`, 'reserved_pr'); continue }
    const pre = precheckDevMerge(card, reserved)
    if (pre) { finish('failed', pre.message, pre.code); continue }
    if (repoFromPrUrl(card.pr_url) !== row.repo || prNumberOf(card) !== row.pr_number) {
      finish('failed', `Card #${card.id} now links a different pull request; the waiting merge of PR #${row.pr_number} was dropped.`, 'pr_changed')
      continue
    }
    if (now - ms(row.created_at) > PENDING_MERGE_TTL_MS) { finish('expired', `CI did not go green on PR #${row.pr_number} within ${PENDING_MERGE_TTL_MS / 60_000} minutes; nothing was merged.`, 'expired'); continue }

    const exec = resolveExec(card, actor, deps)
    if (!exec) { finish('failed', NO_MERGE_CREDENTIAL_MESSAGE, 'github_credential_missing'); continue }
    let pr: PrRead
    try {
      pr = await readPr(exec, row.repo, row.pr_number)
    } catch (err) {
      wait(`could not read the PR this pass (${(err as Error).message})`)
      continue
    }
    if (pr.state === 'MERGED') {
      const done = await closeCardDone(card.id, actor, 'dev-ops:merge-on-green')
      finish('merged', `PR #${row.pr_number} was already merged${done.ok ? '; card done' : ''}.`, 'already_merged')
      continue
    }
    if (pr.state && pr.state !== 'OPEN') { finish('failed', `PR #${row.pr_number} is ${pr.state.toLowerCase()}; nothing was merged.`, 'pr_not_open'); continue }
    if (!SHA_RE.test(pr.headSha)) { wait('head commit unreadable this pass'); continue }
    if (pr.headSha === row.previous_head_sha) {
      if (now - ms(row.updated_at) > UPDATE_LAG_MS) finish('failed', 'GitHub never put the update commit on the branch; nothing was merged.', 'update_not_applied')
      else wait('waiting for GitHub to add the update commit')
      continue
    }
    // Only GitHub's own update commit may be merged: a merge commit whose parents are
    // the head we graded and the base. Any other new head (someone pushed while we
    // waited) is not what the person asked to merge.
    if (!(await isUpdateCommitOf(exec, row.repo, pr.headSha, row.previous_head_sha))) {
      finish('failed', `PR #${row.pr_number} got a different new commit than the branch update (${pr.headSha.slice(0, 12)}); nothing was merged. Ask again to merge the new code.`, 'head_not_update_commit')
      continue
    }
    if (pr.mergeState === 'BEHIND') {
      if (row.updates >= MAX_UPDATES) { finish('failed', `PR #${row.pr_number} fell behind ${row.updates} times; stopped updating it.`, 'too_many_updates'); continue }
      try {
        await updateBranch(exec, row.repo, row.pr_number, pr.headSha)
      } catch (err) {
        finish('failed', `GitHub refused to update the branch again (${(err as Error).message}).`, 'branch_update_failed')
        continue
      }
      db.prepare("UPDATE dev_ops_pending_merges SET previous_head_sha = ?, updates = updates + 1, last_reason = 'behind again; updated', updated_at = datetime('now') WHERE id = ?").run(pr.headSha, row.id)
      writeDevOpsAudit({ bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'branch_update', target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id, outcome: 'waiting', code: 'branch_updated_waiting_for_ci', detail: 'The branch fell behind again and was updated again.' })
      out.push({ id: row.id, outcome: 'updated_again', reason: 'behind again; updated' })
      continue
    }
    if (!pr.ci.green) {
      if (/^(check\(s\) red|required check\(s\) failing)/.test(pr.ci.reason)) finish('failed', `CI failed on the updated head of PR #${row.pr_number}: ${pr.ci.reason}. Nothing was merged.`, 'ci_failed')
      else wait(pr.ci.reason)
      continue
    }
    if (pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS') {
      if (pr.mergeState === 'UNKNOWN' || pr.mergeState === '') wait('GitHub is still computing mergeability')
      else finish('failed', `PR #${row.pr_number} is not cleanly mergeable (${pr.mergeState}); nothing was merged.`, 'pr_not_mergeable')
      continue
    }
    try {
      await squashMerge(exec, row.repo, row.pr_number, pr.headSha)
    } catch (err) {
      finish('failed', `GitHub refused the squash-merge (${(err as Error).message}).`, 'merge_failed')
      continue
    }
    cardLine(card, `The Dev bot squash-merged PR #${row.pr_number} (${row.repo}) at ${pr.headSha.slice(0, 12)} after updating the branch; ${pr.ci.reason}.`, {
      kind: 'dev_ops_merge', repo: row.repo, pr_number: row.pr_number, head_sha: pr.headSha, pending_id: row.id,
    })
    const done = await closeCardDone(card.id, actor, 'dev-ops:merge-on-green')
    finish('merged', `Squash-merged PR #${row.pr_number} at ${pr.headSha.slice(0, 12)} (${pr.ci.reason})${done.ok ? '; card done' : `; card not marked done: ${done.error}`}.`, 'merged')
  }
  return out
}
