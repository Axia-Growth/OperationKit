/**
 * Grant-approved merge (obj 901231).
 *
 * The last mile of the bot flow: worker opens PR → independent AI review passes
 * → CI is green → the owner bot, under an active "Approve on my behalf" grant
 * for `merge` in the card's workspace, sends `approval: merge` on the card
 * (MCP `send_message`, or `POST /api/objectives/:id/message`). The server then
 * squash-merges the PR and only after that marks the card done.
 *
 * This is NOT auto-merge. `settings.auto_merge_enabled` is never read or
 * written here, a passing review on its own still merges nothing, and nothing
 * runs in the background: the merge happens only inside the request of a bot
 * that explicitly sent `approval: merge` and whose grant was checked by
 * `decideDelegatedApproval` (services/delegated-approvals.ts) — the same one
 * grant system the DELEGATED stamp and bot-approve use.
 *
 * The merge policy is the auto-merge policy, reused rather than restated:
 * `decideAutoMerge` (services/auto-merge.ts) with its owner switch forced on,
 * so the project-type, verdict, CI, money-path and behind/dirty rules are the
 * exact same code. Two things are stricter than the background path because a
 * merge is irreversible:
 *
 *  - CI green is read live from GitHub with the completion gate's own pieces
 *    (`fetchPrCheckState`, `fetchRequiredChecks`, `evaluateCiGate`), but
 *    without its fail-open escapes: an unreadable ruleset, a queued or absent
 *    required check, or any red/pending check refuses. Zero checks refuses.
 *  - The merge is pinned to the head commit that was checked
 *    (`--match-head-commit`), so a push between the check and the merge makes
 *    GitHub refuse it instead of merging unchecked code.
 *
 *  - A reserved PR is never merged under a grant (`reservedPrMatch`): the
 *    built-in seed (PR 645 in the private repo and in operationkit) plus whatever the server-side
 *    setting `grant_merge_reserved_prs` / env `CC_GRANT_MERGE_RESERVED_PRS`
 *    adds. It is decided before any GitHub call. The setting lives in the
 *    `settings` table, which no route writes (host / DB only), so a sandboxed
 *    card cannot edit it, and the seed cannot be removed by configuration.
 *  - An empty or unreadable head SHA refuses: the merge is never sent without
 *    `--match-head-commit`.
 *
 * Every refusal returns a code + a sentence and writes an `approval_denied`
 * delegation audit row; nothing is merged and the card does not move.
 */
import type { Objective } from '@operationkit/shared'
import { decideAutoMerge } from './auto-merge.js'
import { isMoneyPath } from './merge-lane.js'
import { defaultExec, fetchPrCheckState, fetchRequiredChecks } from './ci-green-gate-github.js'
import {
  DEFAULT_CONFIG,
  evaluateCiGate,
  isHarnessOwnStatus,
  normaliseRollup,
  type ExecFn,
  type RequiredChecks,
  type RollupEntry,
} from './ci-green-gate-decide.js'
import { repoFromPrUrl } from './ci-green-gate-run.js'
import { getDb } from '../db/index.js'

export type GrantMergeRefusal =
  | 'no_pr'
  | 'reserved_pr'
  | 'not_in_review'
  | 'strategy'
  | 'project_card'
  | 'money_path'
  | 'review_not_passed'
  | 'pr_not_open'
  | 'ci_not_green'
  | 'pr_not_mergeable'
  | 'pr_state_unreadable'
  | 'head_sha_unreadable'
  | 'merge_failed'

export type GrantMergeCard = Pick<
  Objective,
  'id' | 'title' | 'description' | 'status' | 'type' | 'workspace' | 'project' | 'pr_url' | 'pr_number' | 'is_strategy'
> & { ai_review_verdict?: string | null }

/** True when this card's `approval: merge` goes down the server-side merge path. */
export function cardHasPr(card: Pick<Objective, 'pr_url' | 'pr_number'>): boolean {
  return card.pr_number != null && Number(card.pr_number) > 0
}

export interface Refusal {
  ok: false
  status: number
  code: GrantMergeRefusal
  error: string
}

/** One reserved-PR rule: `repo` is `owner/name`, `name`, or null for "any repo". */
export interface ReservedPr {
  repo: string | null
  number: number
}

/**
 * Always reserved, whatever the configuration says.
 *
 * Both forms of PR 645 are listed, and the FIRST entry must stay byte-for-byte
 * as written (obj 901326). The live host runs the PUBLISHED tree, and the
 * publish transform (scripts/oss-genericize.sh) rewrites the private repo name
 * to `operationkit` everywhere. reservedPrMatch is repo-scoped, so a rewritten
 * seed stopped matching the private PR's URL. scripts/oss-reserved-pr-shield.txt
 * shields the first entry's exact literal; the second entry is what the private
 * form becomes, so the published seed carries both. Pinned by
 * scripts/oss-reserved-pr-shield-test.sh and routes/grant-merge.test.ts.
 */
export const GRANT_MERGE_RESERVED_SEED: readonly ReservedPr[] = [
  { repo: 'command-center-infra', number: 645 },
  { repo: 'operationkit', number: 645 },
]

export const GRANT_MERGE_RESERVED_SETTING = 'grant_merge_reserved_prs'
export const GRANT_MERGE_RESERVED_ENV = 'CC_GRANT_MERGE_RESERVED_PRS'

/**
 * Parse a comma/space/newline list of `owner/repo#N`, `repo#N`, `#N` or `N`.
 * Anything that does not parse is ignored (and never widens a match).
 */
export function parseReservedPrs(raw: string | null | undefined): ReservedPr[] {
  const out: ReservedPr[] = []
  for (const tok of String(raw ?? '').split(/[\s,;]+/)) {
    const t = tok.trim()
    if (!t) continue
    const m = /^(?:([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?))?#?(\d+)$/.exec(t)
    if (!m) continue
    const n = Number(m[2])
    if (!Number.isInteger(n) || n <= 0) continue
    out.push({ repo: m[1] ? m[1].toLowerCase() : null, number: n })
  }
  return out
}

/** The seed plus the server-side setting and env. Never fewer than the seed. */
export function loadReservedPrs(): ReservedPr[] {
  let fromSetting = ''
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(GRANT_MERGE_RESERVED_SETTING) as { value: string } | undefined
    fromSetting = row?.value ?? ''
  } catch {
    /* no DB: the seed still applies */
  }
  return [...GRANT_MERGE_RESERVED_SEED, ...parseReservedPrs(fromSetting), ...parseReservedPrs(process.env[GRANT_MERGE_RESERVED_ENV])]
}

/**
 * The reserved rule this card's PR hits, or null. Checks the stored
 * `pr_number` AND the number in `pr_url` (they should agree; if they do not,
 * either one being reserved is enough). With no readable repo, a bare number
 * that any rule reserves counts — fail closed.
 */
export function reservedPrMatch(card: Pick<Objective, 'pr_url' | 'pr_number'>, reserved: readonly ReservedPr[]): ReservedPr | null {
  const nums = new Set<number>()
  if (card.pr_number != null && Number.isInteger(Number(card.pr_number))) nums.add(Number(card.pr_number))
  const um = /\/pull\/(\d+)/.exec(card.pr_url ?? '')
  if (um) nums.add(Number(um[1]))
  const repo = (repoFromPrUrl(card.pr_url) ?? '').toLowerCase()
  const name = repo.split('/')[1] ?? ''
  for (const r of reserved) {
    if (!nums.has(r.number)) continue
    if (r.repo == null || !repo) return r
    if (r.repo.includes('/') ? r.repo === repo : r.repo === name) return r
  }
  return null
}

const refuse = (status: number, code: GrantMergeRefusal, error: string): Refusal => ({ ok: false, status, code, error })

/**
 * The checks that need no GitHub call. Pure. Returns null when the card may go
 * on to the live CI / mergeability checks.
 */
export function precheckGrantMerge(card: GrantMergeCard, reserved: readonly ReservedPr[] = GRANT_MERGE_RESERVED_SEED): Refusal | null {
  if (!cardHasPr(card)) return refuse(409, 'no_pr', `Card #${card.id} has no pull request, so there is nothing to merge.`)
  const hit = reservedPrMatch(card, reserved)
  if (hit) {
    return refuse(409, 'reserved_pr', `PR #${hit.number}${hit.repo ? ` (${hit.repo})` : ''} is reserved: it is never merged under a grant, only by the owner. Nothing was merged and the card was not closed.`)
  }
  if (card.is_strategy) return refuse(409, 'strategy', `Card #${card.id} is a Strategy; only the owner closes a Strategy.`)
  if (card.status !== 'review') {
    return refuse(409, 'not_in_review', `Card #${card.id} is ${card.status}, not waiting in review. A merge approval applies only once the worker has finished and the AI review has run.`)
  }
  if (isMoneyPath(card)) {
    return refuse(409, 'money_path', `Card #${card.id} is on the money path (billing/payments); its PR is merged by the owner, never under a grant.`)
  }
  // Reuse the auto-merge rules for project-type and verdict; CI/mergeability are
  // supplied as passing here because they are checked live afterwards.
  const policy = decideAutoMerge({
    enabled: true,
    hasPr: true,
    prNumber: Number(card.pr_number),
    harnessStatus: 'success',
    reviewVerdict: (card.ai_review_verdict ?? null) as 'pass' | 'fail' | 'blocked' | null,
    objectiveType: card.type,
    unsafe: false,
    moneyPath: false,
  })
  if (policy.action !== 'merge') {
    if (card.type === 'project') {
      return refuse(409, 'project_card', `Card #${card.id} is a project; its PR routes to the owner, not to a grant merge.`)
    }
    return refuse(409, 'review_not_passed', `Card #${card.id} has no passing AI review (verdict: ${card.ai_review_verdict ?? 'none'}). Nothing was merged and the card was not closed.`)
  }
  return null
}

export interface CiGreenResult {
  green: boolean
  reason: string
}

/**
 * Strict CI green for a merge: the completion gate's required-check rule with
 * no wait window, no fail-open on an unreadable ruleset, and every non-harness
 * check on the PR finished green (success / neutral / skipped). Pure.
 */
export function ciGreenForMerge(required: RequiredChecks, rollup: RollupEntry[] | null | undefined): CiGreenResult {
  if (required.source === 'unknown') {
    return { green: false, reason: `the branch's required checks could not be read (${required.error ?? 'unknown error'})` }
  }
  const checks = normaliseRollup(rollup).filter(c => !isHarnessOwnStatus(c.name))
  if (checks.length === 0) return { green: false, reason: 'the PR has no CI checks yet' }
  const gate = evaluateCiGate({ requiredChecks: required, rollup, holdCount: 0, waitedMinutes: 0, mode: 'enforce', config: DEFAULT_CONFIG })
  if (gate.failingRequired.length) return { green: false, reason: `required check(s) failing: ${gate.failingRequired.join(', ')}` }
  if (gate.missingRequired.length) return { green: false, reason: `required check(s) not finished: ${gate.missingRequired.join(', ')}` }
  if (gate.action !== 'allow') return { green: false, reason: gate.reason }
  const red = checks.filter(c => c.state === 'failure' || c.state === 'cancelled').map(c => c.name)
  if (red.length) return { green: false, reason: `check(s) red: ${red.join(', ')}` }
  const pending = checks.filter(c => c.state === 'pending').map(c => c.name)
  if (pending.length) return { green: false, reason: `check(s) still running: ${pending.join(', ')}` }
  return { green: true, reason: `all ${checks.length} check(s) green` }
}

export interface GrantMergeOk {
  ok: true
  repo: string
  prNumber: number
  prUrl: string
  headSha: string
  ci: string
}

export interface GrantMergeDeps {
  exec?: ExecFn
  /** Reserved PRs; defaults to `loadReservedPrs()` (seed + server-side setting/env). */
  reserved?: readonly ReservedPr[]
}

/**
 * Check everything and, when it all holds, squash-merge the card's PR. Does not
 * move the card — the caller marks it done after this returns ok.
 */
export async function mergeUnderGrant(card: GrantMergeCard, deps: GrantMergeDeps = {}): Promise<GrantMergeOk | Refusal> {
  const pre = precheckGrantMerge(card, deps.reserved ?? loadReservedPrs())
  if (pre) return pre
  const exec = deps.exec ?? defaultExec
  const prNumber = Number(card.pr_number)
  const repo = repoFromPrUrl(card.pr_url)
  if (!repo) return refuse(409, 'pr_state_unreadable', `Card #${card.id} has PR #${prNumber} but no GitHub PR link to read its repo from. Nothing was merged.`)

  let headSha = ''
  let prUrl = card.pr_url ?? ''
  let ci: CiGreenResult
  let mergeState = ''
  let prState = ''
  try {
    const pr = await fetchPrCheckState(repo, prNumber, exec)
    headSha = typeof pr.headSha === 'string' ? pr.headSha.trim() : ''
    prUrl = pr.url || prUrl
    const required = await fetchRequiredChecks(repo, pr.baseRef, exec)
    ci = ciGreenForMerge(required, pr.rollup)
    const raw = await exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeStateStatus'])
    const j = JSON.parse(raw) as { state?: string; mergeStateStatus?: string }
    prState = String(j.state ?? '').toUpperCase()
    mergeState = String(j.mergeStateStatus ?? '').toUpperCase()
  } catch (err) {
    return refuse(502, 'pr_state_unreadable', `Could not read PR #${prNumber} on ${repo} from GitHub (${(err as Error).message}). Nothing was merged and the card was not closed.`)
  }

  if (prState && prState !== 'OPEN') {
    return refuse(409, 'pr_not_open', `PR #${prNumber} on ${repo} is ${prState.toLowerCase()}, not open. Nothing was merged and the card was not closed.`)
  }
  if (!ci.green) {
    return refuse(409, 'ci_not_green', `CI is not green on PR #${prNumber}: ${ci.reason}. Nothing was merged and the card was not closed.`)
  }
  // Same rule as auto-merge's prUnsafeToAutoMerge: only CLEAN / HAS_HOOKS merge.
  const unsafe = mergeState !== 'CLEAN' && mergeState !== 'HAS_HOOKS'
  if (unsafe) {
    return refuse(409, 'pr_not_mergeable', `PR #${prNumber} is not cleanly mergeable (GitHub says ${mergeState || 'unknown'}: behind, conflicting or blocked). Update the branch first. Nothing was merged and the card was not closed.`)
  }

  // Never merge without pinning the checked commit: an empty or malformed head
  // SHA means we do not know what CI graded, so refuse instead of dropping the pin.
  if (!/^[0-9a-f]{7,64}$/i.test(headSha)) {
    return refuse(502, 'head_sha_unreadable', `GitHub did not return a readable head commit for PR #${prNumber} on ${repo}, so the merge cannot be pinned to the commit CI checked. Nothing was merged and the card was not closed.`)
  }

  try {
    await exec('gh', ['pr', 'merge', String(prNumber), '--squash', '--delete-branch', '--repo', repo, '--match-head-commit', headSha])
  } catch (err) {
    return refuse(502, 'merge_failed', `GitHub refused the squash-merge of PR #${prNumber} (${(err as Error).message}). The card was not closed.`)
  }
  return { ok: true, repo, prNumber, prUrl, headSha, ci: ci.reason }
}
