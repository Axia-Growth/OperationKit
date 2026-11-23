/**
 * Operation Kit Dev: act on a pull request by REPO and NUMBER (obj 901492).
 *
 * `devMerge` (merge.ts) merges the PR of one of Dev's own cards. The owner also
 * wants Dev to merge a PR that no card links (above all the public repo's
 * "Sync from upstream" PR, which is what the live server deploys from) and to
 * update a branch in a way that really starts CI. This file is that path. It
 * exists only behind the per-repo grant in repo-grant.ts (off by default) on
 * top of the operator-tools gate (an admin typing in the browser, never a wake).
 *
 * Two entry points, both audited on every outcome:
 *
 *  - `devRepoMerge`: squash-merge `owner/name#N` when it is open, cleanly
 *    mergeable and CI is green. A card is linked or filed so the trail stays.
 *  - `devRefreshPrCi`: update a behind branch (GitHub update-branch, pinned to
 *    the head it read) and make sure CI really runs on the head: a cancelled
 *    run is re-run through the Actions API, and "no run ever appeared" is
 *    reported as a failure with its cause, never left as silence.
 *
 * WALLS (each has a test in repo-merge.test.ts; none is configurable off):
 *  - the repo must be granted; the turn must pass devOpsGate (the caller);
 *  - a reserved PR (`loadReservedPrs`: the seed incl. 645 + server setting/env,
 *    and the Full access protected list) is refused BEFORE any GitHub call:
 *    never merged, never updated, never re-run;
 *  - reserved CONTENT: a PR whose title, body or commits name a reserved PR, or
 *    whose files overlap the files a reserved PR adds, is refused. A sync-shaped
 *    PR whose upstream reserved PR cannot be read is refused too (fail closed);
 *  - a PR from a fork and a draft PR are refused (community code reaches the
 *    private repo by hand; see .github/workflows/oss-sync.yml);
 *  - a linked card's rules stay: a FAILED AI review, a worker still running, a
 *    Strategy and a money-path card refuse;
 *  - CI: every check finished green and the required checks readable
 *    (`ciGreenForMerge`), with ONE carve-out: GitHub's code-scanning RESULT
 *    check is judged by the CodeQL wall below instead of by its colour;
 *  - CodeQL: an open high / critical alert on the PR outside test files
 *    refuses; alerts that cannot be read refuse;
 *  - mergeability: only GitHub CLEAN / HAS_HOOKS (or UNSTABLE when the only
 *    non-green check is the code-scanning result the CodeQL wall just cleared).
 *    No admin bypass is ever used. A PR BLOCKED only by a code-scanning BOT
 *    thread on a test file has that thread resolved; a person's conversation is
 *    never resolved;
 *  - the merge is pinned with `--match-head-commit` to the head that was graded.
 *
 * What this file never does: deploy, run a migration, change a repo setting or
 * branch protection, force-push, rebase, or read a secret into a result. The
 * only GitHub writes are update-branch, Actions re-run, resolveReviewThread
 * (bot thread, test file) and the squash-merge.
 */
import type { Objective } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { logActivity } from '../../routes/feed.js'
import { depthForParent } from '../../lib/objective-depth.js'
import { FULL_ACCESS_PROTECTED_PRS } from '@operationkit/shared'
import { fetchRequiredChecks } from '../ci-green-gate-github.js'
import { normaliseRollup, type ExecFn, type RollupEntry } from '../ci-green-gate-decide.js'
import { repoFromPrUrl } from '../ci-green-gate-run.js'
import {
  ghExecWithToken,
  isGhCredentialRejected,
  isGhNotLoggedIn,
  NO_MERGE_CREDENTIAL_MESSAGE,
  resolveMergeGithubAuth,
  type MergeCredentialSource,
  type MergeGithubAuthQuery,
} from '../grant-merge-github-auth.js'
import { ciGreenForMerge, loadReservedPrs, reservedPrMatch, type CiGreenResult, type ReservedPr } from '../grant-merge.js'
import { isMoneyPath } from '../merge-lane.js'
import { getSecretValue } from '../secrets-store.js'
import { writeDevOpsAudit } from './audit.js'
import { closeCardDone, prNumberOf, updateBranch, type DevActor } from './merge.js'
import { parseRepo, repoGrantActive } from './repo-grant.js'
import { getDevOpsSwitch } from './switch.js'

/**
 * The NAME of the optional dedicated GitHub credential for this path. The value
 * lives in Settings → Secrets and is read by name at call time; it is never in
 * code, a log, a result or an audit row. When it is not set, the path uses the
 * same credential chain as every other server-side merge.
 */
export const REPO_RIGHTS_SECRET_NAME = 'DEV_BOT_GITHUB_TOKEN'

export type RepoCredentialSource = 'named_secret' | MergeCredentialSource

export type RepoMergeCode =
  | 'merged'
  | 'already_merged'
  | 'branch_updated_waiting_for_ci'
  | 'ci_running'
  | 'ci_rerun_requested'
  | 'ci_green'
  | 'ci_red'
  | 'ci_never_started'
  | 'bad_request'
  | 'repo_not_granted'
  | 'reserved_pr'
  | 'reserved_content'
  | 'reserved_content_unreadable'
  | 'fork_pr'
  | 'pr_draft'
  | 'strategy'
  | 'money_path'
  | 'card_still_running'
  | 'review_failed'
  | 'pr_not_open'
  | 'ci_not_green'
  | 'codeql_high'
  | 'codeql_unreadable'
  | 'pr_not_mergeable'
  | 'pr_state_unreadable'
  | 'head_sha_unreadable'
  | 'branch_update_failed'
  | 'merge_failed'
  | 'github_credential_missing'
  | 'github_credential_rejected'

export interface RepoMergeResult {
  ok: boolean
  code: RepoMergeCode
  message: string
  repo?: string
  pr_number?: number
  pr_url?: string
  head_sha?: string
  /** The card that carries the trail: the linked one, or the one this call filed. */
  objective_id?: number
  card_filed?: boolean
  card_done?: boolean
  pending_id?: number
  /** Not green only because CI has not finished (wait and look again). */
  pending?: boolean
  /** Which kind of credential the server used (a label, never a value). */
  credential?: RepoCredentialSource
}

export interface RepoMergeDeps {
  /** A ready `gh` runner (tests). When given, no credential is resolved. */
  exec?: ExecFn
  resolveAuth?: (q: MergeGithubAuthQuery) => { exec: ExecFn; source: RepoCredentialSource } | null
  reserved?: readonly ReservedPr[]
  /** Wait between mergeability re-reads (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface RepoTarget {
  repo: unknown
  number: unknown
  /** The chat's workspace: where a card is filed when none is linked. */
  workspace?: string | null
}

const SHA_RE = /^[0-9a-f]{7,64}$/i
const RUNNING = new Set(['queue', 'planning', 'working'])
const FAILED_VERDICTS = new Set(['fail', 'blocked'])
const no = (code: RepoMergeCode, message: string, extra: Partial<RepoMergeResult> = {}): RepoMergeResult => ({ ok: false, code, message, ...extra })

// ── credential (by name) ─────────────────────────────────────────────────────

/**
 * The `gh` runner for this path. The dedicated credential, when the admin
 * stored one under REPO_RIGHTS_SECRET_NAME (workspace scope, then global), else
 * the shared server merge chain. Returns a label for the source, never a value.
 */
export function resolveRepoAuth(q: MergeGithubAuthQuery): { exec: ExecFn; source: RepoCredentialSource } | null {
  const scopes = [
    ...(q.workspace ? [{ scopeType: 'workspace' as const, workspace: q.workspace }] : []),
    { scopeType: 'global' as const },
  ]
  for (const scope of scopes) {
    try {
      const token = getSecretValue(scope, REPO_RIGHTS_SECRET_NAME, q.grantorUserId ?? null, 'server')
      if (token) return { exec: ghExecWithToken(token), source: 'named_secret' }
    } catch { /* no store / no such scope: fall through */ }
  }
  return resolveMergeGithubAuth(q)
}

function ghFailure(err: unknown, repo: string): RepoMergeResult | null {
  const m = (err as Error)?.message ?? ''
  if (isGhNotLoggedIn(m)) return no('github_credential_missing', `${NO_MERGE_CREDENTIAL_MESSAGE} Nothing was changed.`)
  if (isGhCredentialRejected(m)) {
    return no('github_credential_rejected', `GitHub rejected the credential the server used (expired, revoked, or not authorised for ${repo}). Reconnect GitHub in Settings → Integrations, or store a working ${REPO_RIGHTS_SECRET_NAME} in Settings → Secrets. Nothing was changed.`)
  }
  return null
}

// ── reserved pull requests and reserved content ──────────────────────────────

/** Every reserved rule: the grant-merge list plus the Full access protected numbers (any repo). */
export function allReserved(reserved: readonly ReservedPr[]): ReservedPr[] {
  return [...reserved, ...FULL_ACCESS_PROTECTED_PRS.map(number => ({ repo: null, number }))]
}

/** A reserved PR number named in free text (`PR 645`, `#645`, `pull/645`), or null. */
export function reservedPrInText(text: string, reserved: readonly ReservedPr[]): number | null {
  for (const n of new Set(reserved.map(r => r.number))) {
    if (new RegExp(`(?:\\bPRs?[\\s:#-]*|\\bpulls?\\/|\\bpull[- ]requests?[\\s:#-]*|\\bGH-|#)${n}\\b`, 'i').test(text)) return n
  }
  return null
}

/** A PR that carries another repo's tree: the rolling sync branch, or its title. */
export function isSyncShaped(pr: Pick<RepoPr, 'headRef' | 'title'>): boolean {
  return /^sync\//i.test(pr.headRef) || /^\s*sync from upstream\b/i.test(pr.title)
}

const lines = (raw: string) => raw.split('\n').map(l => l.trim()).filter(Boolean)
const isNotFound = (err: unknown) => /HTTP 404|Not Found/i.test((err as Error)?.message ?? '')

/**
 * Does this PR carry reserved content? Text first (no extra GitHub call), then
 * the files: the files this PR changes against the files each reserved PR ADDS.
 * Null = clean. The reserved PR is looked up under the target repo's owner for
 * a rule that names only a repo.
 */
export async function reservedContentRefusal(
  exec: ExecFn,
  repo: string,
  pr: RepoPr,
  reserved: readonly ReservedPr[],
): Promise<RepoMergeResult | null> {
  const text = [pr.title, pr.body, ...pr.commitHeadlines].join('\n')
  const named = reservedPrInText(text, reserved)
  if (named != null) {
    return no('reserved_content', `PR #${pr.number} on ${repo} names reserved pull request ${named} in its title, description or commits, so it may carry reserved work. Only the owner merges it. Nothing was changed.`)
  }
  const owner = repo.split('/')[0]
  const candidates = new Map<string, { repo: string; number: number }>()
  for (const r of reserved) {
    const target = r.repo == null ? repo : r.repo.includes('/') ? r.repo.toLowerCase() : `${owner}/${r.repo.toLowerCase()}`
    if (target === repo && r.number === pr.number) continue
    candidates.set(`${target}#${r.number}`, { repo: target, number: r.number })
  }
  if (candidates.size === 0) return null

  const sync = isSyncShaped(pr)
  let mine: Set<string> | null = null
  for (const c of candidates.values()) {
    const cross = c.repo !== repo
    let added: string[]
    try {
      added = lines(await exec('gh', ['api', '--paginate', `repos/${c.repo}/pulls/${c.number}/files?per_page=100`, '--jq', '.[]|select(.status=="added")|.filename']))
    } catch (err) {
      // "Not found" is the normal answer when that repo has no such PR. For a sync it
      // is ALSO what a credential that cannot see the upstream repo gets, and the two
      // cannot be told apart: a sync is refused unless every upstream rule was read.
      if (isNotFound(err) && !(sync && cross)) continue
      return no('reserved_content_unreadable', isNotFound(err)
        ? `PR #${pr.number} on ${repo} is a sync from another repo, and the server's GitHub credential cannot read reserved pull request ${c.repo}#${c.number} upstream, so it cannot prove this sync carries none of it. Nothing was changed.`
        : `Could not read reserved pull request ${c.repo}#${c.number} to check PR #${pr.number} against it (${(err as Error).message}). Nothing was changed.`)
    }
    if (added.length === 0) continue
    if (!mine) {
      try {
        mine = new Set(lines(await exec('gh', ['api', '--paginate', `repos/${repo}/pulls/${pr.number}/files?per_page=100`, '--jq', '.[].filename'])))
      } catch (err) {
        return no('reserved_content_unreadable', `Could not read the files of PR #${pr.number} on ${repo} (${(err as Error).message}). Nothing was changed.`)
      }
      // GitHub lists at most 3000 files of a PR. A longer PR was compared on a cut-off list.
      if (pr.changedFiles > mine.size) {
        return no('reserved_content_unreadable', `PR #${pr.number} on ${repo} changes ${pr.changedFiles} files but GitHub listed only ${mine.size}, so it cannot be fully checked for reserved content. Nothing was changed.`)
      }
    }
    const hit = added.find(f => mine!.has(f))
    if (hit) {
      return no('reserved_content', `PR #${pr.number} on ${repo} contains a file that reserved pull request ${c.repo}#${c.number} adds (${hit}). Only the owner merges it. Nothing was changed.`)
    }
  }
  return null
}

// ── reading the PR ───────────────────────────────────────────────────────────

export interface RepoPr {
  number: number
  url: string
  title: string
  body: string
  state: string
  mergeState: string
  headSha: string
  headRef: string
  baseRef: string
  isDraft: boolean
  isFork: boolean
  rollup: RollupEntry[]
  commitHeadlines: string[]
  /** GitHub's own count of changed files (the files API stops at 3000). */
  changedFiles: number
}

const PR_FIELDS = 'number,url,title,body,state,mergeStateStatus,headRefOid,headRefName,baseRefName,isDraft,isCrossRepository,statusCheckRollup,commits,changedFiles'

/** One read of everything the walls need. Throws on a GitHub error. */
export async function readRepoPr(exec: ExecFn, repo: string, prNumber: number): Promise<RepoPr> {
  const raw = await exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', PR_FIELDS])
  const j = JSON.parse(raw) as Record<string, unknown>
  const commits = Array.isArray(j.commits) ? (j.commits as { messageHeadline?: string; messageBody?: string }[]) : []
  return {
    number: prNumber,
    url: String(j.url ?? `https://github.com/${repo}/pull/${prNumber}`),
    title: String(j.title ?? ''),
    body: String(j.body ?? ''),
    state: String(j.state ?? '').toUpperCase(),
    mergeState: String(j.mergeStateStatus ?? '').toUpperCase(),
    headSha: typeof j.headRefOid === 'string' ? j.headRefOid.trim() : '',
    headRef: String(j.headRefName ?? ''),
    baseRef: String(j.baseRefName ?? ''),
    isDraft: j.isDraft === true,
    isFork: j.isCrossRepository === true,
    rollup: Array.isArray(j.statusCheckRollup) ? (j.statusCheckRollup as RollupEntry[]) : [],
    commitHeadlines: commits.map(c => `${c.messageHeadline ?? ''}\n${c.messageBody ?? ''}`),
    changedFiles: Number.isFinite(Number(j.changedFiles)) ? Number(j.changedFiles) : 0,
  }
}

// ── CodeQL wall ──────────────────────────────────────────────────────────────

/**
 * A test file: by GitHub's own classification, or by a narrow path rule: a test
 * FILE name anywhere, a `__tests__` / `__mocks__` folder anywhere, or the repo's
 * top-level `test/` / `tests/` folder. A folder merely called `fixtures`, `e2e` or
 * a nested `tests` is not enough: shipped code lives in such places too. An empty
 * path is NOT a test file.
 */
export function isTestPath(path: string, classifications: readonly string[] = []): boolean {
  if (classifications.some(c => String(c).toLowerCase() === 'test')) return true
  if (!path) return false
  return /(^|\/)(__tests__|__mocks__)\//i.test(path)
    || /^tests?\//i.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
    || /(^|\/)test_[^/]+\.py$/i.test(path)
    || /_test\.(py|go)$/i.test(path)
}

const NO_CODE_SCANNING_RE = /Code Security must be enabled|Advanced Security must be enabled|Code scanning is not enabled|no analysis found/i

export interface CodeqlVerdict {
  /** Null = the wall passed. */
  refusal: RepoMergeResult | null
  /** High / critical findings that were set aside because they sit in test files. */
  testOnlyHigh: number
  enabled: boolean
}

/**
 * The CodeQL wall: open high / critical code-scanning alerts on the PR block
 * the merge unless every one of them is in a test file. Unreadable = refuse.
 * "Code scanning is not switched on for this repo" passes ONLY when the head
 * carries no code-scanning result check.
 */
export async function codeqlWall(exec: ExecFn, repo: string, prNumber: number, hasResultCheck: boolean): Promise<CodeqlVerdict> {
  let raw: string
  try {
    raw = await exec('gh', [
      'api', '--paginate', `repos/${repo}/code-scanning/alerts?pr=${prNumber}&state=open&per_page=100`,
      '--jq', '.[]|{sev:(.rule.security_severity_level//""),path:(.most_recent_instance.location.path//""),cls:(.most_recent_instance.classifications//[]),rule:(.rule.id//"")}',
    ])
  } catch (err) {
    const m = (err as Error).message ?? ''
    if (NO_CODE_SCANNING_RE.test(m) && !hasResultCheck) return { refusal: null, testOnlyHigh: 0, enabled: false }
    return { refusal: no('codeql_unreadable', `Could not read the CodeQL findings for PR #${prNumber} on ${repo} (${m}), so the merge is refused. Nothing was merged.`), testOnlyHigh: 0, enabled: true }
  }
  let alerts: { sev: string; path: string; cls: string[]; rule: string }[]
  try {
    alerts = lines(raw).map(l => JSON.parse(l))
  } catch {
    return { refusal: no('codeql_unreadable', `GitHub returned CodeQL findings for PR #${prNumber} on ${repo} that could not be parsed, so the merge is refused. Nothing was merged.`), testOnlyHigh: 0, enabled: true }
  }
  const high = alerts.filter(a => ['high', 'critical'].includes(String(a.sev).toLowerCase()))
  const outside = high.filter(a => !isTestPath(String(a.path ?? ''), Array.isArray(a.cls) ? a.cls : []))
  if (outside.length) {
    const where = [...new Set(outside.map(a => `${a.path || '(no path)'} (${a.rule || 'rule unknown'})`))].slice(0, 5).join('; ')
    return {
      refusal: no('codeql_high', `CodeQL reports ${outside.length} high-severity finding(s) outside test files on PR #${prNumber} (${repo}): ${where}. Fix or dismiss them on GitHub first. Nothing was merged.`),
      testOnlyHigh: high.length - outside.length,
      enabled: true,
    }
  }
  return { refusal: null, testOnlyHigh: high.length, enabled: true }
}

/** Names of the code-scanning RESULT checks on this head (GitHub's own app, not the Analyze jobs). Empty on error. */
async function codeScanningCheckNames(exec: ExecFn, repo: string, sha: string): Promise<Set<string>> {
  try {
    return new Set(lines(await exec('gh', ['api', '--paginate', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--jq', '.check_runs[]|select(.app.slug=="github-advanced-security")|.name'])))
  } catch {
    return new Set()
  }
}

export interface RepoCi {
  ci: CiGreenResult
  /** Code-scanning result checks that finished FAILURE and were left to the CodeQL wall. */
  setAside: number
  /** Every other entry on the head, harness statuses included, is green / neutral / skipped. */
  restGreen: boolean
}

/**
 * CI for this path: strict, with ONE carve-out. A code-scanning RESULT check
 * that finished with conclusion FAILURE ("alerts found") is left to the CodeQL
 * wall, which reads the alerts themselves. Any other conclusion of that check
 * (cancelled, timed out, stale, action required), a pending one, and a
 * REQUIRED one stay in strict CI.
 */
export function ciForRepoMerge(required: Parameters<typeof ciGreenForMerge>[0], rollup: RollupEntry[], resultChecks: ReadonlySet<string>): RepoCi {
  const requiredNames = new Set(required.contexts ?? [])
  let setAside = 0
  const kept = rollup.filter(e => {
    const isFailedResult = !!e.name && resultChecks.has(e.name) && !e.workflowName && !requiredNames.has(e.name)
      && String(e.status ?? '').toUpperCase() === 'COMPLETED' && String(e.conclusion ?? '').toUpperCase() === 'FAILURE'
    if (isFailedResult) setAside += 1
    return !isFailedResult
  })
  const restGreen = normaliseRollup(kept).every(c => c.state === 'success' || c.state === 'neutral')
  return { ci: ciGreenForMerge(required, kept), setAside, restGreen }
}

// ── making CI really run ─────────────────────────────────────────────────────

export const MAX_RUN_ATTEMPTS = 3

export interface CiKick {
  state: 'none' | 'rerun' | 'running' | 'completed'
  rerun: string[]
  running: string[]
  /** Workflows that ended badly and already used every allowed attempt. */
  exhausted: string[]
}

interface RunRow { id: number; name: string; event: string; status: string; conclusion: string | null; run_attempt: number }

/**
 * Look at the Actions runs on this exact commit and restart what did not
 * really run: a cancelled / startup-failed run is re-run in full; with
 * `rerunFailed`, a failed or timed-out run has its failed jobs re-run. Each
 * run is restarted at most MAX_RUN_ATTEMPTS times in total. Throws on a GitHub
 * read error.
 */
export async function kickCi(exec: ExecFn, repo: string, sha: string, opts: { rerunFailed?: boolean; lookOnly?: boolean } = {}): Promise<CiKick> {
  const raw = await exec('gh', ['api', `repos/${repo}/actions/runs?head_sha=${sha}&per_page=100`, '--jq', '[.workflow_runs[]|{id,name,event,status,conclusion,run_attempt}]'])
  const all = (JSON.parse(raw || '[]') as RunRow[]).filter(r => String(r.event).startsWith('pull_request'))
  const latest = new Map<string, RunRow>()
  for (const r of all) if (!latest.has(r.name)) latest.set(r.name, r) // API order: newest first
  const out: CiKick = { state: 'none', rerun: [], running: [], exhausted: [] }
  if (latest.size === 0) return out
  for (const r of latest.values()) {
    if (r.status !== 'completed') { out.running.push(r.name); continue }
    const c = String(r.conclusion ?? '')
    const dead = c === 'cancelled' || c === 'startup_failure'
    const failed = c === 'failure' || c === 'timed_out'
    if (!dead && !(failed && opts.rerunFailed)) continue
    if (Number(r.run_attempt) >= MAX_RUN_ATTEMPTS || opts.lookOnly) { out.exhausted.push(r.name); continue }
    await exec('gh', ['api', '--method', 'POST', `repos/${repo}/actions/runs/${r.id}/${dead ? 'rerun' : 'rerun-failed-jobs'}`])
    out.rerun.push(r.name)
  }
  out.state = out.rerun.length ? 'rerun' : out.running.length ? 'running' : 'completed'
  return out
}

// ── review threads (required conversation resolution) ────────────────────────

const THREADS_QUERY = 'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved path comments(first:1){nodes{author{login __typename}}}}}}}}'
const RESOLVE_MUTATION = 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'
export const CODE_SCANNING_BOT = 'github-advanced-security'

/**
 * Resolve the open review threads GitHub's code-scanning BOT left on TEST
 * files (the CodeQL wall has already accepted those findings). A thread by a
 * person, or by the bot on a non-test file, is counted and left alone, and
 * when there is even one of those, NOTHING is resolved.
 */
export async function resolveCodeScanningTestThreads(exec: ExecFn, repo: string, prNumber: number): Promise<{ resolved: number; left: number }> {
  const [owner, name] = repo.split('/')
  const raw = await exec('gh', ['api', 'graphql', '-f', `query=${THREADS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${prNumber}`])
  const nodes = ((JSON.parse(raw) as { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } } }).data?.repository?.pullRequest?.reviewThreads?.nodes ?? []) as {
    id: string; isResolved: boolean; path?: string | null; comments?: { nodes?: { author?: { login?: string; __typename?: string } | null }[] }
  }[]
  const mine: string[] = []
  let left = 0
  for (const t of nodes) {
    if (t.isResolved) continue
    const author = t.comments?.nodes?.[0]?.author
    const botThread = author?.__typename === 'Bot' && author.login === CODE_SCANNING_BOT
    if (botThread && isTestPath(String(t.path ?? ''))) mine.push(t.id)
    else left += 1
  }
  // All or nothing: if any conversation must stay open, the PR stays blocked whatever
  // we do, so nothing is resolved (the bot leaves no trace on a PR it will not merge).
  if (left > 0) return { resolved: 0, left }
  let resolved = 0
  for (const id of mine) {
    await exec('gh', ['api', 'graphql', '-f', `query=${RESOLVE_MUTATION}`, '-f', `id=${id}`])
    resolved += 1
  }
  return { resolved, left }
}

// ── cards: link or file ──────────────────────────────────────────────────────

type LinkedCard = Pick<Objective, 'id' | 'title' | 'description' | 'status' | 'type' | 'workspace' | 'project' | 'pr_url' | 'pr_number' | 'is_strategy'> & { ai_review_verdict?: string | null }

/** Every live card that links this exact PR (repo and number), newest first. Cancelled cards are not links. */
export function linkedCards(repo: string, prNumber: number): LinkedCard[] {
  const rows = getDb().prepare(
    "SELECT * FROM objectives WHERE deleted_at IS NULL AND status != 'cancelled' AND (pr_number = ? OR pr_url LIKE ?) ORDER BY id DESC",
  ).all(prNumber, `%/pull/${prNumber}%`) as LinkedCard[]
  const name = repo.split('/')[1]
  return rows.filter(c => {
    if (prNumberOf(c) !== prNumber) return false
    const r = repoFromPrUrl(c.pr_url)
    return r ? r.toLowerCase() === repo : String(c.project ?? '').toLowerCase() === name
  })
}

/** The rules a linked card keeps. Null = go on. */
export function linkedCardRefusal(cards: readonly LinkedCard[]): RepoMergeResult | null {
  for (const c of cards) {
    if (c.is_strategy) return no('strategy', `Card #${c.id} links this pull request and is a Strategy; only the owner closes a Strategy. Nothing was merged.`, { objective_id: c.id })
    if (isMoneyPath(c)) return no('money_path', `Card #${c.id} links this pull request and is on the money path (billing/payments); the owner merges it. Nothing was merged.`, { objective_id: c.id })
    if (RUNNING.has(c.status)) return no('card_still_running', `Card #${c.id} links this pull request and is ${c.status}: its worker may still push to the branch. Merge once it has finished.`, { objective_id: c.id })
    if (FAILED_VERDICTS.has(String(c.ai_review_verdict ?? ''))) {
      return no('review_failed', `Card #${c.id} links this pull request and its AI review did not pass (verdict: ${c.ai_review_verdict}). Fix the findings first; nothing was merged.`, { objective_id: c.id })
    }
  }
  return null
}

function cardLine(card: { id: number; project?: string | null; workspace?: string | null }, title: string, metadata: Record<string, unknown>): void {
  try {
    logActivity({ project: card.project || 'operationkit', workspace: card.workspace ?? undefined, objective_id: card.id, event_type: 'decision', title, metadata })
  } catch (err) {
    console.warn('[dev-ops] card line failed:', (err as Error).message)
  }
}

/** File the card that records a merge no card linked. It is born done: the merge already happened. */
export function fileMergeCard(repo: string, pr: RepoPr, actor: DevActor, workspace: string | null | undefined, ci: string): number {
  const db = getDb()
  const title = `Merged ${repo}#${pr.number}: ${pr.title || 'pull request'}`.slice(0, 200)
  const description = [
    `The Dev bot squash-merged ${pr.url} for ${actor.username}, asked for in chat, under the bot's GitHub repo rights for ${repo}.`,
    `Head commit ${pr.headSha}; ${ci}.`,
    'No card linked this pull request, so this card was filed to keep the record. Nothing is live until a deploy.',
  ].join('\n')
  const id = Number(db.prepare(
    `INSERT INTO objectives (title, description, agent_context, workspace, project, category, depth, assigned_user_id, created_by, type, status, origin, pr_url, pr_number, skip_ai_review)
     VALUES (?, ?, ?, ?, ?, 'general', ?, ?, ?, 'task', 'done', 'agent_chat', ?, ?, 1)`,
  ).run(title, description, actor.botSlug, workspace || 'general', repo.split('/')[1], depthForParent(db, null), actor.userId || null, actor.userId || null, pr.url, pr.number).lastInsertRowid)
  try {
    if (actor.userId) db.prepare('INSERT OR IGNORE INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, ?)').run(id, actor.userId, actor.botSlug)
  } catch { /* the link is a convenience; the card and the audit row are the record */ }
  return id
}

// ── the shared walk ──────────────────────────────────────────────────────────

interface Target { repo: string; number: number; workspace: string | null }

function auditor(actor: DevActor, action: string, t: { repo?: string | null; number?: number | null }) {
  return (r: RepoMergeResult, as = action): RepoMergeResult => {
    const outcome = r.code === 'merged' || r.code === 'already_merged' || r.code === 'ci_green' ? 'done'
      : r.code === 'branch_updated_waiting_for_ci' || r.code === 'ci_running' || r.code === 'ci_rerun_requested' ? 'waiting'
        : 'refused'
    writeDevOpsAudit({
      bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: as,
      target: t.repo && t.number ? `${t.repo}#${t.number}` : (t.repo ?? null),
      objective_id: r.objective_id ?? null, outcome, code: r.code, detail: r.message,
    })
    return r
  }
}

/** Parse + grant + reserved: the walls that need no GitHub call. */
export function preflight(input: RepoTarget, actor: DevActor, reserved: readonly ReservedPr[]): { refusal: RepoMergeResult } | { target: Target } {
  const repo = parseRepo(input.repo)
  const number = Number(input.number)
  if (!repo) return { refusal: no('bad_request', 'repo must be one GitHub repo, written owner/name.') }
  if (!Number.isInteger(number) || number <= 0) return { refusal: no('bad_request', 'number must be a pull request number.', { repo }) }
  const base = { repo, pr_number: number }
  if (!repoGrantActive(actor.botSlug, repo)) {
    return { refusal: no('repo_not_granted', `GitHub repo rights are not switched on for ${repo}. An admin switches a repo on in the bot's settings (Operator tools → GitHub repo rights). Nothing was changed.`, base) }
  }
  const hit = reservedPrMatch({ pr_url: `https://github.com/${repo}/pull/${number}`, pr_number: number }, reserved)
  if (hit) return { refusal: no('reserved_pr', `PR #${number} (${hit.repo ?? repo}) is reserved: only the owner merges or changes it. Nothing was changed.`, base) }
  return { target: { repo, number, workspace: input.workspace ?? null } }
}

interface Inspection { pr: RepoPr; ci: CiGreenResult; setAside: number; restGreen: boolean; hasResultCheck: boolean }

/** Read the PR and apply the walls that hold for every action on it (merge, update, re-run). */
async function inspect(exec: ExecFn, t: Target, reserved: readonly ReservedPr[]): Promise<{ refusal: RepoMergeResult } | Inspection> {
  const base = { repo: t.repo, pr_number: t.number }
  let pr: RepoPr
  try {
    pr = await readRepoPr(exec, t.repo, t.number)
  } catch (err) {
    return { refusal: { ...(ghFailure(err, t.repo) ?? no('pr_state_unreadable', `Could not read PR #${t.number} on ${t.repo} (${(err as Error).message}). Nothing was changed.`)), ...base } }
  }
  const withPr = { ...base, pr_url: pr.url, head_sha: pr.headSha || undefined }
  if (pr.state === 'MERGED') return { refusal: { ok: true, code: 'already_merged', message: `PR #${t.number} on ${t.repo} is already merged.`, ...withPr } }
  if (pr.state !== 'OPEN') return { refusal: no('pr_not_open', `PR #${t.number} on ${t.repo} is ${pr.state.toLowerCase() || 'in an unknown state'}, not open. Nothing was changed.`, withPr) }
  if (pr.isDraft) return { refusal: no('pr_draft', `PR #${t.number} on ${t.repo} is a draft. Nothing was changed.`, withPr) }
  if (pr.isFork) return { refusal: no('fork_pr', `PR #${t.number} on ${t.repo} comes from a fork. Outside contributions are brought in by the owner by hand, never merged by the bot. Nothing was changed.`, withPr) }
  if (!SHA_RE.test(pr.headSha)) return { refusal: no('head_sha_unreadable', `GitHub did not return a readable head commit for PR #${t.number}, so nothing can be pinned. Nothing was changed.`, withPr) }
  const content = await reservedContentRefusal(exec, t.repo, pr, reserved)
  if (content) return { refusal: { ...content, ...withPr } }
  let required: Awaited<ReturnType<typeof fetchRequiredChecks>>
  try {
    required = await fetchRequiredChecks(t.repo, pr.baseRef, exec)
  } catch (err) {
    return { refusal: { ...(ghFailure(err, t.repo) ?? no('pr_state_unreadable', `Could not read the required checks of ${t.repo} (${(err as Error).message}). Nothing was changed.`)), ...withPr } }
  }
  const resultChecks = await codeScanningCheckNames(exec, t.repo, pr.headSha)
  const { ci, setAside, restGreen } = ciForRepoMerge(required, pr.rollup, resultChecks)
  return { pr, ci, setAside, restGreen, hasResultCheck: resultChecks.size > 0 }
}

function resolveExec(t: Target, actor: DevActor, deps: RepoMergeDeps): { exec: ExecFn; source?: RepoCredentialSource } | null {
  if (deps.exec) return { exec: deps.exec }
  return (deps.resolveAuth ?? resolveRepoAuth)({ workspace: t.workspace, grantorUserId: actor.userId, agent: actor.botSlug })
}

const realSleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Say why CI is not green in a way that tells "still running" from "never started". */
async function ciWaitReason(exec: ExecFn, t: Target, ins: Inspection): Promise<string> {
  if (!ins.ci.pending) return ins.ci.reason
  try {
    const k = await kickCi(exec, t.repo, ins.pr.headSha) // read + restart a cancelled run; never re-runs a failure here
    if (k.state === 'none') return `${ins.ci.reason}; no CI run exists for this head yet`
    if (k.state === 'rerun') return `${ins.ci.reason}; a cancelled CI run was restarted (${k.rerun.join(', ')})`
    if (k.state === 'running') return `${ins.ci.reason}; CI is still running on this head (${k.running.join(', ')}), and the required check appears when it finishes`
  } catch { /* the plain reason is enough */ }
  return ins.ci.reason
}

/** CodeQL wall → mergeability → squash-merge → card. Everything before it has passed. */
async function finishMerge(exec: ExecFn, t: Target, ins: Inspection, actor: DevActor, cards: readonly LinkedCard[], deps: RepoMergeDeps, via: string): Promise<RepoMergeResult> {
  const { pr } = ins
  const withPr = { repo: t.repo, pr_number: t.number, pr_url: pr.url, head_sha: pr.headSha, ...(cards[0] ? { objective_id: cards[0].id } : {}) }
  const codeql = await codeqlWall(exec, t.repo, t.number, ins.hasResultCheck)
  if (codeql.refusal) return { ...codeql.refusal, ...withPr }
  // The red code-scanning check was set aside on the promise that the alerts explain
  // it. If no high finding does, it failed for a reason this wall cannot see (a lower
  // threshold, an analysis error): that is a red check, not a cleared one.
  if (ins.setAside > 0 && codeql.testOnlyHigh === 0) {
    return no('codeql_unreadable', `The code-scanning check failed on PR #${t.number} (${t.repo}), but no open high finding explains it, so it cannot be cleared as "test files only". Look at the check on GitHub. Nothing was merged.`, withPr)
  }

  let mergeState = pr.mergeState
  let resolvedThreads = 0
  if (mergeState === 'BLOCKED') {
    let left = 0
    try {
      const r = await resolveCodeScanningTestThreads(exec, t.repo, t.number)
      resolvedThreads = r.resolved
      left = r.left
    } catch { /* unreadable threads: stay BLOCKED and refuse below */ }
    if (resolvedThreads > 0) {
      const sleep = deps.sleep ?? realSleep
      for (let i = 0; i < 4; i += 1) {
        await sleep(2000)
        try {
          const j = JSON.parse(await exec('gh', ['pr', 'view', String(t.number), '--repo', t.repo, '--json', 'mergeStateStatus,headRefOid'])) as { mergeStateStatus?: string; headRefOid?: string }
          if (String(j.headRefOid ?? '') !== pr.headSha) return no('pr_not_mergeable', `PR #${t.number} got a new commit while it was being checked. Nothing was merged; ask again to merge the new code.`, withPr)
          mergeState = String(j.mergeStateStatus ?? '').toUpperCase()
        } catch { mergeState = 'UNKNOWN' }
        if (mergeState !== 'UNKNOWN' && mergeState !== '') break
      }
    }
    if (mergeState === 'BLOCKED') {
      const why = left > 0 ? `${left} open review conversation(s) that only a person may resolve` : 'a branch rule GitHub did not name (a required review, an open conversation or a required check)'
      return no('pr_not_mergeable', `PR #${t.number} on ${t.repo} is blocked by ${why}. The bot never uses an admin bypass. Nothing was merged.`, withPr)
    }
  }
  // UNSTABLE = a non-required check is not green. It is accepted only when that check is
  // the code-scanning result the CodeQL wall just cleared and nothing else on the head is red.
  const clean = mergeState === 'CLEAN' || mergeState === 'HAS_HOOKS' || (mergeState === 'UNSTABLE' && ins.setAside > 0 && codeql.testOnlyHigh > 0 && ins.restGreen)
  if (!clean) {
    return no('pr_not_mergeable', `PR #${t.number} on ${t.repo} is not cleanly mergeable (GitHub says ${mergeState || 'unknown'}). Nothing was merged.`, withPr)
  }

  try {
    await exec('gh', [
      'pr', 'merge', String(t.number), '--squash', '--repo', t.repo, '--match-head-commit', pr.headSha,
      // The rolling sync branch belongs to the sync workflow; every other merged branch is removed.
      ...(isSyncShaped(pr) ? [] : ['--delete-branch']),
    ])
  } catch (err) {
    return { ...(ghFailure(err, t.repo) ?? no('merge_failed', `GitHub refused the squash-merge of PR #${t.number} on ${t.repo} (${(err as Error).message}). Nothing was merged.`)), ...withPr }
  }

  const notes = [
    ins.ci.reason,
    ...(codeql.testOnlyHigh ? [`${codeql.testOnlyHigh} high CodeQL finding(s), all in test files`] : []),
    ...(resolvedThreads ? [`resolved ${resolvedThreads} code-scanning bot thread(s) on test files`] : []),
  ].join('; ')
  const line = `The Dev bot squash-merged PR #${t.number} (${t.repo}) at ${pr.headSha.slice(0, 12)} for ${actor.username} under its GitHub repo rights${via ? ` (${via})` : ''}; ${notes}.`
  // The merge HAPPENED. Whatever goes wrong with the card from here on, the caller must
  // still get `merged` back so the audit row is written.
  let cardId: number | undefined = cards[0]?.id
  let filed = false
  let done = false
  let cardProblem = ''
  try {
    if (cards.length) {
      for (const c of cards) {
        cardLine(c, line, { kind: 'dev_ops_repo_merge', repo: t.repo, pr_number: t.number, head_sha: pr.headSha })
        const r = await closeCardDone(c.id, actor, 'dev-ops:repo-merge')
        if (c.id === cardId) { done = r.ok; if (!r.ok) cardProblem = r.error ?? 'the card could not be marked done' }
      }
    } else {
      cardId = fileMergeCard(t.repo, pr, actor, t.workspace, notes)
      filed = true
      done = true
      cardLine({ id: cardId, project: t.repo.split('/')[1], workspace: t.workspace }, line, { kind: 'dev_ops_repo_merge', repo: t.repo, pr_number: t.number, head_sha: pr.headSha, card_filed: true })
    }
  } catch (err) {
    cardProblem = (err as Error).message
  }
  const record = cardProblem
    ? `The card record could not be completed (${cardProblem}); the audit log has the merge.`
    : filed ? `No card linked it, so card #${cardId} was filed as the record.` : `Card #${cardId} carries the record and is done.`
  return {
    ok: true, code: 'merged', ...withPr, ...(cardId ? { objective_id: cardId } : {}), card_filed: filed, card_done: done,
    message: `Squash-merged PR #${t.number} on ${t.repo} (${notes}). ${record} Nothing is live until a deploy.`,
  }
}

function queuePending(t: Target, mode: 'merge' | 'ci_only', headSha: string, actor: DevActor): number {
  return Number(getDb().prepare(
    `INSERT INTO dev_ops_repo_pending (repo, pr_number, mode, previous_head_sha, bot_slug, user_id, username, workspace, last_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'branch updated; waiting for CI on the new head')`,
  ).run(t.repo, t.number, mode, headSha, actor.botSlug, actor.userId, actor.username, t.workspace).lastInsertRowid)
}

/** A waiting row already covers this PR: do not stack a second one. */
function waitingRow(t: Target): { id: number; mode: string } | undefined {
  return getDb().prepare("SELECT id, mode FROM dev_ops_repo_pending WHERE repo = ? AND pr_number = ? AND status = 'waiting' ORDER BY id DESC").get(t.repo, t.number) as { id: number; mode: string } | undefined
}

/**
 * Merge `owner/name#N`. Writes its own audit rows. A BEHIND branch is updated
 * and queued; the tick merges it when CI on the new head is green.
 */
export async function devRepoMerge(input: RepoTarget, actor: DevActor, deps: RepoMergeDeps = {}): Promise<RepoMergeResult> {
  const reserved = allReserved(deps.reserved ?? loadReservedPrs())
  const pre = preflight(input, actor, reserved)
  const audit = auditor(actor, 'repo_merge', 'target' in pre ? pre.target : { repo: parseRepo(input.repo), number: Number(input.number) || null })
  if ('refusal' in pre) return audit(pre.refusal)
  const t = pre.target
  const base = { repo: t.repo, pr_number: t.number }

  const cards = linkedCards(t.repo, t.number)
  const cardNo = linkedCardRefusal(cards)
  if (cardNo) return audit({ ...cardNo, ...base })

  const auth = resolveExec(t, actor, deps)
  if (!auth) return audit(no('github_credential_missing', `${NO_MERGE_CREDENTIAL_MESSAGE} Nothing was merged.`, base))
  const { exec } = auth
  const cred = auth.source ? { credential: auth.source } : {}

  const ins = await inspect(exec, t, reserved)
  if ('refusal' in ins) {
    if (ins.refusal.code === 'already_merged') {
      for (const c of cards) await closeCardDone(c.id, actor, 'dev-ops:repo-merge')
      return audit({ ...ins.refusal, ...(cards[0] ? { objective_id: cards[0].id, card_done: true } : {}), ...cred })
    }
    return audit({ ...ins.refusal, ...cred })
  }
  const withPr = { ...base, pr_url: ins.pr.url, head_sha: ins.pr.headSha, ...(cards[0] ? { objective_id: cards[0].id } : {}), ...cred }

  if (ins.pr.mergeState === 'BEHIND') {
    // One waiting row per PR: asking twice never updates the branch twice (a second
    // update would cancel the CI run the first one started).
    const already = waitingRow(t)
    if (already) {
      if (already.mode !== 'merge') getDb().prepare("UPDATE dev_ops_repo_pending SET mode = 'merge' WHERE id = ?").run(already.id)
      return audit({ ok: true, code: 'branch_updated_waiting_for_ci', pending_id: already.id, ...withPr, message: `PR #${t.number} on ${t.repo} was already updated and is waiting for CI on the new head. It merges itself as soon as CI is green there.` })
    }
    try {
      await updateBranch(exec, t.repo, t.number, ins.pr.headSha)
    } catch (err) {
      return audit({ ...(ghFailure(err, t.repo) ?? no('branch_update_failed', `PR #${t.number} is behind ${ins.pr.baseRef || 'its base'} and GitHub refused to update the branch (${(err as Error).message}). Nothing was merged.`)), ...withPr })
    }
    const pendingId = queuePending(t, 'merge', ins.pr.headSha, actor)
    for (const c of cards) cardLine(c, `The Dev bot updated PR #${t.number} (${t.repo}) from ${ins.pr.baseRef || 'its base'} (it was behind). It merges itself once CI is green on the new head.`, { kind: 'dev_ops_repo_branch_update', repo: t.repo, pr_number: t.number, previous_head_sha: ins.pr.headSha, pending_id: pendingId })
    return audit({
      ok: true, code: 'branch_updated_waiting_for_ci', pending_id: pendingId, ...withPr,
      message: `PR #${t.number} on ${t.repo} was behind ${ins.pr.baseRef || 'its base'}, so I updated the branch (a merge from the base; no rebase, no force push). I check that CI really starts on the new head (a cancelled run is restarted) and merge it as soon as CI is green there.`,
    }, 'repo_branch_update')
  }

  if (!ins.ci.green) {
    const reason = await ciWaitReason(exec, t, ins)
    return audit(no('ci_not_green', `CI is not green on PR #${t.number} (${t.repo}): ${reason}. Nothing was merged.`, { ...withPr, ...(ins.ci.pending ? { pending: true } : {}) }))
  }
  return audit({ ...(await finishMerge(exec, t, ins, actor, cards, deps, '')), ...cred })
}

/**
 * Update a behind branch and make sure CI really runs on the PR's head. Never
 * merges. Writes its own audit rows.
 */
export async function devRefreshPrCi(input: RepoTarget, actor: DevActor, deps: RepoMergeDeps = {}): Promise<RepoMergeResult> {
  const reserved = allReserved(deps.reserved ?? loadReservedPrs())
  const pre = preflight(input, actor, reserved)
  const audit = auditor(actor, 'repo_ci_refresh', 'target' in pre ? pre.target : { repo: parseRepo(input.repo), number: Number(input.number) || null })
  if ('refusal' in pre) return audit(pre.refusal)
  const t = pre.target
  const base = { repo: t.repo, pr_number: t.number }

  const auth = resolveExec(t, actor, deps)
  if (!auth) return audit(no('github_credential_missing', `${NO_MERGE_CREDENTIAL_MESSAGE} Nothing was changed.`, base))
  const { exec } = auth
  const cred = auth.source ? { credential: auth.source } : {}

  const ins = await inspect(exec, t, reserved)
  if ('refusal' in ins) return audit({ ...ins.refusal, ...cred })
  const withPr = { ...base, pr_url: ins.pr.url, head_sha: ins.pr.headSha, ...cred }

  if (ins.pr.mergeState === 'DIRTY') {
    return audit(no('pr_not_mergeable', `PR #${t.number} on ${t.repo} conflicts with ${ins.pr.baseRef || 'its base'}. GitHub starts no pull-request CI on a conflicting branch, and the bot never resolves a conflict: the branch needs a worker. Nothing was changed.`, withPr))
  }
  if (ins.pr.mergeState === 'BEHIND') {
    const already = waitingRow(t)
    if (already) return audit({ ok: true, code: 'branch_updated_waiting_for_ci', pending_id: already.id, ...withPr, message: `PR #${t.number} on ${t.repo} was already updated and is being watched until CI starts on the new head.` })
    try {
      await updateBranch(exec, t.repo, t.number, ins.pr.headSha)
    } catch (err) {
      return audit({ ...(ghFailure(err, t.repo) ?? no('branch_update_failed', `PR #${t.number} is behind ${ins.pr.baseRef || 'its base'} and GitHub refused to update the branch (${(err as Error).message}). Nothing was changed.`)), ...withPr })
    }
    const pendingId = queuePending(t, 'ci_only', ins.pr.headSha, actor)
    return audit({
      ok: true, code: 'branch_updated_waiting_for_ci', pending_id: pendingId, ...withPr,
      message: `PR #${t.number} on ${t.repo} was behind ${ins.pr.baseRef || 'its base'}, so I updated the branch (a merge from the base; no rebase, no force push). I keep watching until a CI run exists on the new head and restart it if it is cancelled. Nothing was merged.`,
    }, 'repo_branch_update')
  }

  if (ins.ci.green) return audit({ ok: true, code: 'ci_green', ...withPr, message: `CI is already green on PR #${t.number} (${t.repo}): ${ins.ci.reason}. Nothing was changed.` })
  let kick: CiKick
  try {
    kick = await kickCi(exec, t.repo, ins.pr.headSha, { rerunFailed: true })
  } catch (err) {
    return audit({ ...(ghFailure(err, t.repo) ?? no('pr_state_unreadable', `Could not read or restart the CI runs of PR #${t.number} on ${t.repo} (${(err as Error).message}).`)), ...withPr })
  }
  if (kick.state === 'rerun') return audit({ ok: true, code: 'ci_rerun_requested', ...withPr, message: `Restarted CI on PR #${t.number} (${t.repo}): ${kick.rerun.join(', ')}.${kick.running.length ? ` Still running: ${kick.running.join(', ')}.` : ''} Nothing was merged.` })
  if (kick.state === 'running') return audit({ ok: true, code: 'ci_running', ...withPr, pending: true, message: `CI is running on PR #${t.number} (${t.repo}): ${kick.running.join(', ')}. The required check appears when the run finishes. Nothing was changed.` })
  if (kick.state === 'none') {
    return audit(no('ci_never_started', `No CI run exists for the head of PR #${t.number} on ${t.repo} (${ins.pr.headSha.slice(0, 12)}), so there is nothing to re-run. The head was most likely pushed by an identity GitHub does not start workflows for, or Actions is off or out of minutes for the repo. A new push to the branch by a person or by ${REPO_RIGHTS_SECRET_NAME} starts it. Nothing was changed.`, withPr))
  }
  return audit(no('ci_red', `CI finished and is not green on PR #${t.number} (${t.repo}): ${ins.ci.reason}.${kick.exhausted.length ? ` Already re-run ${MAX_RUN_ATTEMPTS} times: ${kick.exhausted.join(', ')}.` : ''} Nothing was changed.`, withPr))
}

// ── Background: after a branch update ────────────────────────────────────────

/**
 * Is `sha` GitHub's OWN update-branch commit on top of `previous`? All of:
 *  - a merge commit with exactly two parents, one of them the head that was graded;
 *  - made by GitHub itself: signature verified and committer `web-flow` (a merge
 *    commit someone built and pushed by hand is neither);
 *  - the other parent is already on the base branch (it brings in nothing but the base).
 * Anything unreadable is "no".
 */
export async function isGithubUpdateCommit(exec: ExecFn, repo: string, sha: string, previous: string, baseRef: string): Promise<boolean> {
  try {
    const raw = await exec('gh', ['api', `repos/${repo}/commits/${sha}`, '--jq', '{parents:[.parents[].sha],verified:.commit.verification.verified,committer:(.committer.login//"")}'])
    const c = JSON.parse(raw) as { parents?: unknown; verified?: unknown; committer?: unknown }
    const parents = Array.isArray(c.parents) ? (c.parents as unknown[]).map(String) : []
    if (parents.length !== 2) return false
    const mine = parents.findIndex(p => p.toLowerCase().startsWith(previous.toLowerCase()))
    if (mine < 0) return false
    if (c.verified !== true || c.committer !== 'web-flow') return false
    const other = parents[1 - mine]
    if (!SHA_RE.test(other) || !baseRef) return false
    const cmp = JSON.parse(await exec('gh', ['api', `repos/${repo}/compare/${encodeURIComponent(baseRef)}...${other}`, '--jq', '{status,ahead_by}'])) as { status?: string; ahead_by?: number }
    return (cmp.status === 'behind' || cmp.status === 'identical') && Number(cmp.ahead_by) === 0
  } catch {
    return false
  }
}

/** How long a waiting row lives before it gives up. */
export const REPO_PENDING_TTL_MS = 90 * 60_000
/** How long GitHub may take to put the update commit on the branch, or to create a CI run for it. */
export const CI_START_LAG_MS = 10 * 60_000
const MAX_UPDATES = 3
const MAX_KICKS = 3

interface PendingRow {
  id: number; repo: string; pr_number: number; mode: 'merge' | 'ci_only'; previous_head_sha: string
  bot_slug: string; user_id: number | null; username: string | null; workspace: string | null
  updates: number; ci_kicks: number; created_at: string; updated_at: string
}

const ms = (sqlTime: string) => Date.parse(sqlTime.replace(' ', 'T') + (sqlTime.endsWith('Z') ? '' : 'Z'))

export interface RepoPendingTick { id: number; outcome: 'merged' | 'ci_started' | 'waiting' | 'failed' | 'expired' | 'updated_again'; reason: string }

/** One pass over the PRs whose branch this path updated. Host tick + tests. */
export async function processRepoPending(deps: RepoMergeDeps = {}): Promise<RepoPendingTick[]> {
  const db = getDb()
  const now = (deps.now ?? Date.now)()
  const rows = db.prepare("SELECT * FROM dev_ops_repo_pending WHERE status = 'waiting' ORDER BY id").all() as PendingRow[]
  const out: RepoPendingTick[] = []
  for (const row of rows) {
    const actor: DevActor = { userId: row.user_id ?? 0, username: row.username ?? 'unknown', botSlug: row.bot_slug }
    const t: Target = { repo: row.repo, number: row.pr_number, workspace: row.workspace }
    const action = row.mode === 'merge' ? 'repo_merge_on_green' : 'repo_ci_started'
    const finish = (status: 'merged' | 'ci_started' | 'failed' | 'expired', reason: string, code: string, objectiveId?: number) => {
      db.prepare("UPDATE dev_ops_repo_pending SET status = ?, last_reason = ?, updated_at = datetime('now'), finished_at = datetime('now') WHERE id = ?").run(status, reason, row.id)
      writeDevOpsAudit({
        bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action, target: `${row.repo}#${row.pr_number}`,
        objective_id: objectiveId ?? null, outcome: status === 'merged' || status === 'ci_started' ? 'done' : 'failed', code, detail: reason,
      })
      out.push({ id: row.id, outcome: status, reason })
    }
    const wait = (reason: string) => {
      db.prepare('UPDATE dev_ops_repo_pending SET last_reason = ? WHERE id = ?').run(reason, row.id)
      out.push({ id: row.id, outcome: 'waiting', reason })
    }

    // One row never takes the others down with it: an unexpected throw is a wait.
    try {
    // The switch, the person, the grant and the reserved list are re-read on every pass.
    if (!getDevOpsSwitch(row.bot_slug).enabled) { finish('failed', 'Operator tools were switched off; the waiting pull request was dropped.', 'switch_off'); continue }
    const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(row.user_id ?? -1) as { role?: string } | undefined)?.role
    if (role !== 'admin') { finish('failed', 'The person who asked is no longer an admin; nothing was merged.', 'not_admin'); continue }
    const reserved = allReserved(deps.reserved ?? loadReservedPrs())
    const pre = preflight({ repo: row.repo, number: row.pr_number, workspace: row.workspace }, actor, reserved)
    if ('refusal' in pre) { finish('failed', pre.refusal.message, pre.refusal.code); continue }
    if (now - ms(row.created_at) > REPO_PENDING_TTL_MS) { finish('expired', `CI did not ${row.mode === 'merge' ? 'go green' : 'start'} on PR #${row.pr_number} (${row.repo}) within ${REPO_PENDING_TTL_MS / 60_000} minutes; nothing was merged.`, 'expired'); continue }
    const cards = row.mode === 'merge' ? linkedCards(row.repo, row.pr_number) : []
    const cardNo = linkedCardRefusal(cards)
    if (cardNo) { finish('failed', cardNo.message, cardNo.code, cardNo.objective_id); continue }

    const auth = resolveExec(t, actor, deps)
    if (!auth) { finish('failed', NO_MERGE_CREDENTIAL_MESSAGE, 'github_credential_missing'); continue }
    const { exec } = auth
    const ins = await inspect(exec, t, reserved)
    if ('refusal' in ins) {
      if (ins.refusal.code === 'pr_state_unreadable') { wait(`could not read the PR this pass (${ins.refusal.message})`); continue }
      if (ins.refusal.code === 'already_merged') {
        for (const c of cards) await closeCardDone(c.id, actor, 'dev-ops:repo-merge-on-green')
        finish('merged', ins.refusal.message, 'already_merged', cards[0]?.id)
        continue
      }
      finish('failed', ins.refusal.message, ins.refusal.code)
      continue
    }
    const { pr } = ins
    if (pr.headSha === row.previous_head_sha) {
      if (now - ms(row.updated_at) > CI_START_LAG_MS) finish('failed', 'GitHub never put the update commit on the branch; nothing was merged.', 'update_not_applied')
      else wait('waiting for GitHub to add the update commit')
      continue
    }
    // Only GitHub's own update commit is acted on (see isGithubUpdateCommit). Any other new
    // head, a hand-made merge commit included, is not what the person asked for.
    if (!(await isGithubUpdateCommit(exec, row.repo, pr.headSha, row.previous_head_sha, pr.baseRef))) {
      finish('failed', `PR #${row.pr_number} got a different new commit than the branch update (${pr.headSha.slice(0, 12)}); nothing was merged. Ask again for the new code.`, 'head_not_update_commit')
      continue
    }
    if (pr.mergeState === 'BEHIND' && row.mode === 'merge') {
      if (row.updates >= MAX_UPDATES) { finish('failed', `PR #${row.pr_number} fell behind ${row.updates} times; stopped updating it.`, 'too_many_updates'); continue }
      try {
        await updateBranch(exec, row.repo, row.pr_number, pr.headSha)
      } catch (err) {
        finish('failed', `GitHub refused to update the branch again (${(err as Error).message}).`, 'branch_update_failed')
        continue
      }
      db.prepare("UPDATE dev_ops_repo_pending SET previous_head_sha = ?, updates = updates + 1, last_reason = 'behind again; updated', updated_at = datetime('now') WHERE id = ?").run(pr.headSha, row.id)
      writeDevOpsAudit({ bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'repo_branch_update', target: `${row.repo}#${row.pr_number}`, outcome: 'waiting', code: 'branch_updated_waiting_for_ci', detail: 'The branch fell behind again and was updated again.' })
      out.push({ id: row.id, outcome: 'updated_again', reason: 'behind again; updated' })
      continue
    }

    if (!ins.ci.green) {
      if (!ins.ci.pending) { finish('failed', `CI failed on the updated head of PR #${row.pr_number} (${row.repo}): ${ins.ci.reason}. Nothing was merged.`, 'ci_failed'); continue }
      // CI has not finished. Make sure it really started.
      let kick: CiKick
      try {
        kick = await kickCi(exec, row.repo, pr.headSha, { lookOnly: row.ci_kicks >= MAX_KICKS })
      } catch (err) {
        wait(`could not read the CI runs this pass (${(err as Error).message})`)
        continue
      }
      if (kick.state === 'none') {
        if (now - ms(row.updated_at) > CI_START_LAG_MS) {
          finish('failed', `GitHub created no CI run for the updated head of PR #${row.pr_number} (${row.repo}) within ${CI_START_LAG_MS / 60_000} minutes, so there is nothing to re-run. The update was most likely pushed by an identity GitHub does not start workflows for, or Actions is off or out of minutes. Store ${REPO_RIGHTS_SECRET_NAME} (see the Dev operator tools page) or push to the branch by hand. Nothing was merged.`, 'ci_never_started')
        } else wait('waiting for GitHub to create a CI run on the new head')
        continue
      }
      if (kick.exhausted.length && kick.state === 'completed') {
        finish('failed', `CI on PR #${row.pr_number} (${row.repo}) was cancelled and has already been restarted as often as allowed (${kick.exhausted.join(', ')}); stopped. Nothing was merged.`, 'too_many_ci_restarts')
        continue
      }
      if (kick.state === 'rerun') {
        db.prepare('UPDATE dev_ops_repo_pending SET ci_kicks = ci_kicks + 1 WHERE id = ?').run(row.id)
        writeDevOpsAudit({ bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'repo_ci_rerun', target: `${row.repo}#${row.pr_number}`, outcome: 'waiting', code: 'ci_rerun_requested', detail: `A cancelled CI run on the updated head was restarted: ${kick.rerun.join(', ')}.` })
        wait(`restarted a cancelled CI run (${kick.rerun.join(', ')})`)
        continue
      }
      if (row.mode === 'ci_only') { finish('ci_started', `CI is running on the updated head of PR #${row.pr_number} (${row.repo}): ${[...kick.running].join(', ') || 'runs finished'}. Nothing was merged.`, 'ci_running'); continue }
      wait(kick.state === 'running' ? `CI is running (${kick.running.join(', ')})` : ins.ci.reason)
      continue
    }
    if (row.mode === 'ci_only') { finish('ci_started', `CI ran and is green on the updated head of PR #${row.pr_number} (${row.repo}). Nothing was merged.`, 'ci_green'); continue }

    if (pr.mergeState === 'UNKNOWN' || pr.mergeState === '') { wait('GitHub is still computing mergeability'); continue }
    const r = await finishMerge(exec, t, ins, actor, cards, deps, 'after updating the branch')
    if (r.ok) finish('merged', r.message, 'merged', r.objective_id)
    else finish('failed', r.message, r.code, r.objective_id)
    } catch (err) {
      wait(`unexpected error this pass (${(err as Error).message})`)
    }
  }
  return out
}
