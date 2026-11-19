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
 * Merge queue (obj 901463). Waiting merges on the same repo are ONE ordered
 * queue (`dev_ops_pending_merges`, status `waiting`, lowest id first = the order
 * the merges were asked for). Only the row at the HEAD has its branch updated
 * and its CI awaited. Rows behind it are `stage = 'queued'`: nothing on GitHub
 * is touched for them (no update-branch, no CI run, no read) until they reach
 * the head. When the head merges, is refused or fails, the next row becomes the
 * head, is updated from the base once and merges on green. Updating every
 * behind PR at once made each merge put all the others behind again, so each
 * re-ran CI and was dropped at the update cap (PRs 881 / 884 / 890, 2026-11-18).
 * The update cap only counts updates made while a row is the head, and the
 * 90-minute wait starts when a row becomes the head, so time spent queued costs
 * nothing. A conflicted PR (GitHub DIRTY) is skipped (`conflict_skipped`) and
 * the row behind it becomes the head in the same pass. The queue adds no way to
 * merge: a row reaches GitHub's merge call through the same checks as before.
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
  | 'queued_behind'
  | 'already_queued'
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
  /** 1 = head of the repo's merge queue (the one being updated / awaiting CI). */
  queue_position?: number
  /** PR numbers ahead of this one in the queue, first to merge first. */
  queue_ahead?: number[]
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

const WAITING_CODES = new Set<DevMergeCode>(['branch_updated_waiting_for_ci', 'queued_behind', 'already_queued'])
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
      outcome: r.code === 'merged' || r.code === 'already_merged' ? 'done' : WAITING_CODES.has(r.code) ? 'waiting' : 'refused',
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

  // Already waiting in the queue: say where it sits, add nothing, touch nothing.
  {
    const queue = waitingQueue(repo)
    const at = queue.findIndex(q => q.pr_number === prNumber)
    if (at >= 0) {
      const ahead = queue.slice(0, at).map(q => q.pr_number)
      return audit({
        ok: true, code: 'already_queued', pending_id: queue[at].id, queue_position: at + 1, queue_ahead: ahead,
        message: at === 0
          ? `PR #${prNumber} is already first in the merge queue for ${repo}. It merges by itself once CI is green on its updated branch.`
          : `PR #${prNumber} is already in the merge queue for ${repo} at position ${at + 1}, behind ${prList(ahead)}. Its branch is left alone until it reaches the front.`,
        ...base, pr_url: card.pr_url || undefined,
      })
    }
  }

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

  // No await between this read of the queue and the INSERT below, so two asks
  // can never both see an empty queue.
  const db = getDb()
  const ahead = waitingQueue(repo).map(q => q.pr_number)
  const behind = pr.mergeState === 'BEHIND'
  if (!behind) {
    if (!pr.ci.green) return audit(no('ci_not_green', `CI is not green on PR #${prNumber}: ${pr.ci.reason}. Nothing was merged.`, withPr))
    if (pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS') {
      return audit(no('pr_not_mergeable', `PR #${prNumber} is not cleanly mergeable (GitHub says ${pr.mergeState || 'unknown'}). Nothing was merged.`, withPr))
    }
  }

  if (behind || ahead.length > 0) {
    // Into the queue, untouched. `previous_head_sha` is the head the person asked to merge.
    const pendingId = Number(db.prepare(
      `INSERT INTO dev_ops_pending_merges (objective_id, repo, pr_number, previous_head_sha, bot_slug, user_id, username, updates, stage, head_at, last_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'queued', ?, ?)`,
    ).run(
      card.id, repo, prNumber, pr.headSha, actor.botSlug, actor.userId, actor.username,
      ahead.length === 0 ? sqlNow(Date.now()) : null,
      ahead.length === 0 ? 'head of the queue' : queuedReason(ahead.length + 1, ahead),
    ).lastInsertRowid)

    if (ahead.length > 0) {
      cardLine(card, `PR #${prNumber} (${repo}) joined the merge queue at position ${ahead.length + 1}, behind ${prList(ahead)}. Its branch is not touched until it reaches the front.`, {
        kind: 'dev_ops_merge_queued', repo, pr_number: prNumber, head_sha: pr.headSha, pending_id: pendingId, queue_position: ahead.length + 1, queue_ahead: ahead,
      })
      return audit({
        ok: true, code: 'queued_behind', pending_id: pendingId, head_sha: pr.headSha, queue_position: ahead.length + 1, queue_ahead: ahead,
        message: `PR #${prNumber} is in the merge queue for ${repo} at position ${ahead.length + 1}, behind ${prList(ahead)}. I take them one at a time: its branch is not updated and no CI runs for it until it reaches the front; then it is updated from ${pr.baseRef || 'the base'} once and merges automatically when CI is green.`,
        ...withPr,
      })
    }

    // Head of an empty queue and behind: update it now, inside this call.
    inlineHeads.add(pendingId)
    try {
      await updateBranch(exec, repo, prNumber, pr.headSha)
    } catch (err) {
      const r = { ...(ghFailure(err, repo) ?? no('branch_update_failed', `PR #${prNumber} is behind ${pr.baseRef || 'its base'} and GitHub refused to update the branch (${(err as Error).message}). Nothing was merged.`)), ...withPr }
      db.prepare("UPDATE dev_ops_pending_merges SET status = 'failed', last_reason = ?, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = ?").run(r.message, pendingId)
      return audit(r)
    } finally {
      inlineHeads.delete(pendingId)
    }
    db.prepare("UPDATE dev_ops_pending_merges SET stage = 'updated', updates = 1, last_reason = 'branch updated; waiting for CI on the new head', updated_at = datetime('now') WHERE id = ?").run(pendingId)
    cardLine(card, `The Dev bot updated PR #${prNumber} (${repo}) from ${pr.baseRef || 'its base'} (it was behind). It merges itself once CI is green on the new head.`, {
      kind: 'dev_ops_branch_update', repo, pr_number: prNumber, previous_head_sha: pr.headSha, pending_id: pendingId,
    })
    return audit({
      ok: true, code: 'branch_updated_waiting_for_ci', pending_id: pendingId, head_sha: pr.headSha, queue_position: 1, queue_ahead: [],
      message: `PR #${prNumber} was behind ${pr.baseRef || 'its base'}, so I updated the branch (a merge from ${pr.baseRef || 'the base'}; no rebase, no force push). CI is running on the new head; I merge it automatically as soon as CI is green there. It is first in the merge queue for ${repo}.`,
      ...withPr,
    }, 'branch_update')
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

/** How long a merge at the HEAD of the queue waits for CI before giving up. Time spent queued does not count. */
export const PENDING_MERGE_TTL_MS = 90 * 60_000
/** How long GitHub may take to put the update commit on the branch. */
const UPDATE_LAG_MS = 10 * 60_000
/** Branch updates one row may get. Only the head of the queue is ever updated, so waiting costs none. */
export const MAX_UPDATES = 3

interface PendingRow {
  id: number
  objective_id: number
  repo: string
  pr_number: number
  /** stage `queued`: the head the merge was asked for. stage `updated`: the head update-branch was called on. */
  previous_head_sha: string
  bot_slug: string
  user_id: number | null
  username: string | null
  updates: number
  /** `queued` = branch untouched since the ask. `updated` = update-branch was called; the update commit is expected. */
  stage: 'queued' | 'updated'
  /** When the row became the head of its repo's queue. NULL = it has only waited so far. */
  head_at: string | null
  last_reason: string | null
  created_at: string
  updated_at: string
}

const ms = (sqlTime: string) => Date.parse(sqlTime.replace(' ', 'T') + (sqlTime.endsWith('Z') ? '' : 'Z'))
const sqlNow = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')
const prList = (prs: readonly number[]) => prs.map(n => `PR #${n}`).join(', ')
const queuedReason = (position: number, ahead: readonly number[]) => `queued: position ${position}, behind ${prList(ahead)}`

/** The waiting merges of one repo, in the order they were asked for. Index 0 is the head. */
function waitingQueue(repo: string): PendingRow[] {
  return getDb().prepare("SELECT * FROM dev_ops_pending_merges WHERE status = 'waiting' AND repo = ? COLLATE NOCASE ORDER BY id").all(repo) as PendingRow[]
}

/** Rows `devMerge` is updating inside a chat call right now; the tick leaves their repo alone for that pass. */
const inlineHeads = new Set<number>()

export interface PendingTickResult {
  id: number
  outcome: 'merged' | 'waiting' | 'failed' | 'expired' | 'updated' | 'updated_again' | 'queued'
  reason: string
  /** 1 = head. Set on rows still in the queue after this pass. */
  queue_position?: number
}

/**
 * One pass over the waiting merges. Host tick + tests.
 *
 * Per repo, only the head row is worked. A head that fails, expires or is
 * skipped makes way for the next row in the same pass (main did not move). A
 * head that MERGED ends the pass for that repo: the next row becomes the head
 * on the next pass, once GitHub has seen the new base.
 */
export async function processPendingMerges(deps: DevMergeDeps & { now?: () => number } = {}): Promise<PendingTickResult[]> {
  const db = getDb()
  const now = (deps.now ?? Date.now)()
  const all = db.prepare("SELECT * FROM dev_ops_pending_merges WHERE status = 'waiting' ORDER BY id").all() as PendingRow[]
  const out: PendingTickResult[] = []
  const repos = new Map<string, PendingRow[]>()
  for (const r of all) {
    const k = r.repo.toLowerCase()
    repos.set(k, [...(repos.get(k) ?? []), r])
  }

  for (const rows of repos.values()) {
    let i = 0
    for (; i < rows.length; i++) {
      if (inlineHeads.has(rows[i].id)) break
      const step = await processHead(rows[i], rows.length - i - 1, deps, now, out)
      if (step !== 'next') break
    }
    // Everything after the row that was worked last is still queued, untouched.
    // `i` is the head if it is still waiting, or a row that just merged.
    const merged = i < rows.length && out.some(o => o.id === rows[i].id && o.outcome === 'merged')
    const live = rows.slice(merged ? i + 1 : i)
    for (let p = merged ? 0 : 1; p < live.length; p++) {
      const row = live[p]
      const ahead = live.slice(0, p).map(r => r.pr_number)
      const position = p + 1
      const reason = ahead.length ? queuedReason(position, ahead) : 'next in the merge queue; starts on the next pass'
      if (row.last_reason !== reason) {
        db.prepare('UPDATE dev_ops_pending_merges SET last_reason = ? WHERE id = ?').run(reason, row.id)
        // One audit row each time a waiting PR's place changes, so its position can be reported.
        writeDevOpsAudit({
          bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'merge_queue',
          target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id, outcome: 'waiting',
          code: ahead.length ? 'queued_behind' : 'queue_next',
          detail: ahead.length
            ? `PR #${row.pr_number} is at position ${position} in the merge queue for ${row.repo}, behind ${prList(ahead)}. Its branch has not been touched.`
            : `PR #${row.pr_number} is next in the merge queue for ${row.repo}. Its branch has not been touched yet.`,
        })
      }
      out.push({ id: row.id, outcome: 'queued', reason, queue_position: position })
    }
  }
  return out
}

/** Work the head of one repo's queue. `next` = it left the queue without moving main, so the row behind it is the head now. */
async function processHead(
  row: PendingRow,
  waitingBehind: number,
  deps: DevMergeDeps & { now?: () => number },
  now: number,
  out: PendingTickResult[],
): Promise<'next' | 'stop'> {
  const db = getDb()
  {
    const actor: DevActor = { userId: row.user_id ?? 0, username: row.username ?? 'unknown', botSlug: row.bot_slug }
    const finish = (status: 'merged' | 'failed' | 'expired', reason: string, code: string): 'next' | 'stop' => {
      db.prepare("UPDATE dev_ops_pending_merges SET status = ?, last_reason = ?, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = ?").run(status, reason, row.id)
      writeDevOpsAudit({
        bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'merge_on_green',
        target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id,
        outcome: status === 'merged' ? 'done' : 'failed', code, detail: reason,
      })
      out.push({ id: row.id, outcome: status, reason })
      // After a real merge the base moved: let the next pass start the next row.
      return code === 'merged' ? 'stop' : 'next'
    }
    const wait = (reason: string): 'stop' => {
      db.prepare("UPDATE dev_ops_pending_merges SET last_reason = ? WHERE id = ?").run(reason, row.id)
      out.push({ id: row.id, outcome: 'waiting', reason, queue_position: 1 })
      return 'stop'
    }

    // First pass as the head: the wait clock starts here, not when the merge was asked for.
    if (!row.head_at) {
      row.head_at = sqlNow(now)
      db.prepare('UPDATE dev_ops_pending_merges SET head_at = ? WHERE id = ?').run(row.head_at, row.id)
      writeDevOpsAudit({
        bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'merge_queue',
        target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id, outcome: 'waiting', code: 'queue_head',
        detail: `PR #${row.pr_number} is now first in the merge queue for ${row.repo} (${waitingBehind} waiting behind it).`,
      })
    }

    // The switch, the card and the reserved list are re-read on every pass.
    if (!getDevOpsSwitch(row.bot_slug).enabled) return finish('failed', 'Operator tools were switched off; the waiting merge was dropped.', 'switch_off')
    const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id ?? -1) as { role?: string } | undefined)?.role
    if (role !== 'admin') return finish('failed', 'The person who asked for the merge is no longer an admin; nothing was merged.', 'not_admin')
    const card = db.prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(row.objective_id) as DevMergeCard | undefined
    if (!card) return finish('failed', 'The card is gone; nothing was merged.', 'card_missing')
    const reserved = deps.reserved ?? loadReservedPrs()
    // The PR this row will merge, by its stored repo + number (not whatever the card links now).
    const stored = { pr_url: `https://github.com/${row.repo}/pull/${row.pr_number}`, pr_number: row.pr_number }
    if (reservedPrMatch(stored, reserved)) return finish('failed', `PR #${row.pr_number} (${row.repo}) is reserved; nothing was merged.`, 'reserved_pr')
    const pre = precheckDevMerge(card, reserved)
    if (pre) return finish('failed', pre.message, pre.code)
    if (repoFromPrUrl(card.pr_url) !== row.repo || prNumberOf(card) !== row.pr_number) {
      return finish('failed', `Card #${card.id} now links a different pull request; the waiting merge of PR #${row.pr_number} was dropped.`, 'pr_changed')
    }
    if (now - ms(row.head_at) > PENDING_MERGE_TTL_MS) return finish('expired', `CI did not go green on PR #${row.pr_number} within ${PENDING_MERGE_TTL_MS / 60_000} minutes of it reaching the front of the merge queue; nothing was merged.`, 'expired')

    const exec = resolveExec(card, actor, deps)
    if (!exec) return finish('failed', NO_MERGE_CREDENTIAL_MESSAGE, 'github_credential_missing')
    let pr: PrRead
    try {
      pr = await readPr(exec, row.repo, row.pr_number)
    } catch (err) {
      return wait(`could not read the PR this pass (${(err as Error).message})`)
    }
    if (pr.state === 'MERGED') {
      const done = await closeCardDone(card.id, actor, 'dev-ops:merge-on-green')
      return finish('merged', `PR #${row.pr_number} was already merged${done.ok ? '; card done' : ''}.`, 'already_merged')
    }
    if (pr.state && pr.state !== 'OPEN') return finish('failed', `PR #${row.pr_number} is ${pr.state.toLowerCase()}; nothing was merged.`, 'pr_not_open')
    if (!SHA_RE.test(pr.headSha)) return wait('head commit unreadable this pass')

    if (row.stage === 'queued') {
      // Never updated by us: the head must still be the commit the merge was asked for.
      if (pr.headSha.toLowerCase() !== row.previous_head_sha.toLowerCase()) {
        return finish('failed', `PR #${row.pr_number} got a new commit (${pr.headSha.slice(0, 12)}) while it waited in the merge queue; nothing was merged. Ask again to merge the new code.`, 'head_changed_while_queued')
      }
    } else {
      if (pr.headSha === row.previous_head_sha) {
        if (now - ms(row.updated_at) > UPDATE_LAG_MS) return finish('failed', 'GitHub never put the update commit on the branch; nothing was merged.', 'update_not_applied')
        return wait('waiting for GitHub to add the update commit')
      }
      // Only GitHub's own update commit may be merged: a merge commit whose parents are
      // the head we graded and the base. Any other new head (someone pushed while we
      // waited) is not what the person asked to merge.
      if (!(await isUpdateCommitOf(exec, row.repo, pr.headSha, row.previous_head_sha))) {
        return finish('failed', `PR #${row.pr_number} got a different new commit than the branch update (${pr.headSha.slice(0, 12)}); nothing was merged. Ask again to merge the new code.`, 'head_not_update_commit')
      }
    }
    // A conflict needs a person or a worker. Skip it so the PRs behind it are not held up.
    if (pr.mergeState === 'DIRTY') {
      return finish('failed', `PR #${row.pr_number} conflicts with ${pr.baseRef || 'its base'} (GitHub says DIRTY), so it was skipped and taken out of the merge queue; nothing was merged. ${waitingBehind ? `The ${waitingBehind} PR(s) behind it carry on.` : ''} Resolve the conflict, then ask again.`.replace(/\s+/g, ' '), 'conflict_skipped')
    }
    if (pr.mergeState === 'BEHIND') {
      if (row.updates >= MAX_UPDATES) return finish('failed', `PR #${row.pr_number} fell behind ${row.updates} times while at the front of the merge queue; stopped updating it.`, 'too_many_updates')
      try {
        await updateBranch(exec, row.repo, row.pr_number, pr.headSha)
      } catch (err) {
        return finish('failed', `GitHub refused to update the branch${row.updates ? ' again' : ''} (${(err as Error).message}).`, 'branch_update_failed')
      }
      const first = row.updates === 0
      const reason = first ? 'reached the front of the queue; branch updated, waiting for CI on the new head' : 'behind again; updated'
      db.prepare("UPDATE dev_ops_pending_merges SET stage = 'updated', previous_head_sha = ?, updates = updates + 1, last_reason = ?, updated_at = datetime('now') WHERE id = ?").run(pr.headSha, reason, row.id)
      writeDevOpsAudit({
        bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'branch_update', target: `${row.repo}#${row.pr_number}`, objective_id: row.objective_id, outcome: 'waiting', code: 'branch_updated_waiting_for_ci',
        detail: first
          ? `PR #${row.pr_number} reached the front of the merge queue and its branch was updated from ${pr.baseRef || 'its base'} (update 1 of at most ${MAX_UPDATES}).`
          : `The branch fell behind again and was updated again (update ${row.updates + 1} of at most ${MAX_UPDATES}).`,
      })
      if (first) {
        cardLine(card, `PR #${row.pr_number} (${row.repo}) reached the front of the merge queue; the Dev bot updated it from ${pr.baseRef || 'its base'}. It merges itself once CI is green on the new head.`, {
          kind: 'dev_ops_branch_update', repo: row.repo, pr_number: row.pr_number, previous_head_sha: pr.headSha, pending_id: row.id,
        })
      }
      out.push({ id: row.id, outcome: first ? 'updated' : 'updated_again', reason, queue_position: 1 })
      return 'stop'
    }
    if (!pr.ci.green) {
      if (/^(check\(s\) red|required check\(s\) failing)/.test(pr.ci.reason)) return finish('failed', `CI failed on the ${row.stage === 'updated' ? 'updated ' : ''}head of PR #${row.pr_number}: ${pr.ci.reason}. Nothing was merged.`, 'ci_failed')
      return wait(pr.ci.reason)
    }
    if (pr.mergeState !== 'CLEAN' && pr.mergeState !== 'HAS_HOOKS') {
      if (pr.mergeState === 'UNKNOWN' || pr.mergeState === '') return wait('GitHub is still computing mergeability')
      return finish('failed', `PR #${row.pr_number} is not cleanly mergeable (${pr.mergeState}); nothing was merged.`, 'pr_not_mergeable')
    }
    try {
      await squashMerge(exec, row.repo, row.pr_number, pr.headSha)
    } catch (err) {
      // GitHub can report CLEAN for a moment after the base moved. If a fresh read now
      // says the branch is behind (or not computed yet), stay at the head and let the
      // next pass update it; nothing was merged either way.
      try {
        const again = await readPr(exec, row.repo, row.pr_number)
        if (again.state === 'OPEN' && again.headSha === pr.headSha && (again.mergeState === 'BEHIND' || again.mergeState === 'UNKNOWN' || again.mergeState === '')) {
          return wait('GitHub refused the merge because the base moved; re-checking on the next pass')
        }
      } catch { /* fall through to the failure */ }
      return finish('failed', `GitHub refused the squash-merge (${(err as Error).message}).`, 'merge_failed')
    }
    cardLine(card, `The Dev bot squash-merged PR #${row.pr_number} (${row.repo}) at ${pr.headSha.slice(0, 12)}${row.stage === 'updated' ? ' after updating the branch' : ''}; ${pr.ci.reason}.`, {
      kind: 'dev_ops_merge', repo: row.repo, pr_number: row.pr_number, head_sha: pr.headSha, pending_id: row.id,
    })
    const done = await closeCardDone(card.id, actor, 'dev-ops:merge-on-green')
    return finish('merged', `Squash-merged PR #${row.pr_number} at ${pr.headSha.slice(0, 12)} (${pr.ci.reason})${done.ok ? '; card done' : `; card not marked done: ${done.error}`}.`, 'merged')
  }
}
