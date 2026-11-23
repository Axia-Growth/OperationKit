/**
 * Operation Kit Dev: read the real end state before saying "done" (obj 901495).
 *
 * On 2026-11-18/19 Dev ran two deploys that changed nothing and only found out
 * later: the code it had merged sat in an unmerged sync pull request, so the
 * repo the server updates from had nothing new. This module answers, in ONE
 * read-only call, the facts that tell "merged" from "deployed":
 *
 *   live commit      what this process is running: the same value
 *                    `GET /api/health` reports (lib/build-info.ts, pinned at boot)
 *   source checkout  the host folder update.sh pulls into: its HEAD, the repo
 *                    its `origin` points at and that repo's `main` head
 *                    (host-runner.sh `src-info`; needs no GitHub credential)
 *   public main      head of the repo the server updates from
 *   private main     head of the repo Dev's cards merge into
 *   sync PR          the rolling "sync/from-upstream" pull request that carries
 *                    private main into the public repo: number + state
 *
 * and, for one card (`readMergeFacts`), whether its pull request is really
 * merged on GitHub, the merge commit and the checks on it.
 *
 * Read-only: `git rev-parse` / `git ls-remote` on the host and `gh` reads with
 * the credential the merge tool already uses. Nothing here writes to GitHub or
 * the host, and no result carries a credential (the origin URL is reduced to
 * `owner/repo` on the host; it never leaves it).
 *
 * The two repos have separate histories (the public tree is a genericized
 * export), so a private sha is never compared with a public one. "Is private
 * main in what the server pulls?" is answered by the sync PR's state.
 */
import { getDb } from '../../db/index.js'
import { buildCommit } from '../../lib/build-info.js'
import type { ExecFn } from '../ci-green-gate-decide.js'
import { repoFromPrUrl } from '../ci-green-gate-run.js'
import { resolveMergeGithubAuth } from '../grant-merge-github-auth.js'
import { devOpsHostConfig, parseRunnerJson, runOnHost } from './host-exec.js'

export const DEFAULT_SYNC_BRANCH = 'sync/from-upstream'
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/
const SHA_RE = /^[0-9a-f]{7,64}$/i

export type EndStateCode = 'deployed' | 'merged_not_deployed' | 'unknown'

export interface SyncPr {
  repo: string
  number: number
  /** OPEN | MERGED | CLOSED */
  state: string
  url: string
  created_at: string | null
  updated_at: string | null
  merged_at: string | null
}

export interface EndState {
  /** What this server process runs: the `commit` of GET /api/health. */
  live_commit: string | null
  /** The host folder update.sh pulls into. */
  source_checkout: { head: string | null; origin_repo: string | null; origin_main_head: string | null } | null
  /** Head of the repo the server updates from. */
  public_main: { repo: string; sha: string } | null
  /** Head of the repo Dev's cards merge into. Null when it is the same repo, or unknown. */
  private_main: { repo: string; sha: string; committed_at: string | null } | null
  /** The newest sync pull request (an open one first). */
  sync_pr: SyncPr | null
  live_matches_public_main: boolean | null
  /** True while merged private code is not yet in the repo the server updates from. */
  private_waiting_on_sync: boolean | null
  state: EndStateCode
  /** The real state in plain words; say this, do not paraphrase it into "done". */
  summary: string
  /** What could not be read, and why. */
  notes: string[]
}

export interface EndStateDeps {
  exec?: ExecFn | null
  liveCommit?: () => string | null
  env?: NodeJS.ProcessEnv
}

export interface EndStateQuery {
  workspace: string | null
  userId: number
  botSlug: string
}

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 12) : 'unknown')

/** Same commit? One side is often a short sha (health reports 12 chars). */
export function sameCommit(a: string | null | undefined, b: string | null | undefined): boolean | null {
  const x = (a || '').trim().toLowerCase()
  const y = (b || '').trim().toLowerCase()
  if (!SHA_RE.test(x) || !SHA_RE.test(y)) return null
  return x.length <= y.length ? y.startsWith(x) : x.startsWith(y)
}

function setting(key: string): string {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return typeof row?.value === 'string' ? row.value.trim() : ''
  } catch {
    return ''
  }
}

const repoOrNull = (v: string) => (REPO_RE.test(v) && !v.includes('..') ? v : null)

/**
 * Which repos to read. Nothing is hard-coded: the public repo is whatever the
 * host checkout's `origin` is, the private repo is where this bot's cards open
 * their pull requests. Env / settings override both (read at point of use).
 */
export function endStateRepos(botSlug: string, env: NodeJS.ProcessEnv = process.env): { publicRepo: string | null; privateRepo: string | null; syncBranch: string } {
  const publicRepo = repoOrNull((env.CC_DEV_OPS_PUBLIC_REPO || '').trim() || setting('dev_ops_public_repo'))
  let privateRepo = repoOrNull((env.CC_DEV_OPS_PRIVATE_REPO || '').trim() || setting('dev_ops_private_repo'))
  if (!privateRepo) {
    try {
      const row = getDb().prepare(
        `SELECT pr_url FROM objectives
          WHERE pr_url LIKE 'https://github.com/%' AND deleted_at IS NULL AND (agent_context = ? OR owner_bot = ?)
          ORDER BY id DESC LIMIT 1`,
      ).get(botSlug, botSlug) as { pr_url?: string } | undefined
      privateRepo = repoOrNull(repoFromPrUrl(row?.pr_url) ?? '')
    } catch {
      privateRepo = null
    }
  }
  const branch = (env.CC_DEV_OPS_SYNC_BRANCH || '').trim() || setting('dev_ops_sync_branch') || DEFAULT_SYNC_BRANCH
  return { publicRepo, privateRepo, syncBranch: BRANCH_RE.test(branch) && !branch.includes('..') ? branch : DEFAULT_SYNC_BRANCH }
}

/** The host checkout: HEAD, origin repo, origin main head. Never throws. */
export async function readSourceCheckout(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: true; head: string | null; origin_repo: string | null; origin_main_head: string | null } | { ok: false; error: string }> {
  const hc = devOpsHostConfig(env)
  if (!hc.ok) return { ok: false, error: hc.error }
  try {
    const r = await runOnHost(hc.config.helperImage, ['src-info', hc.config.srcDir, hc.config.configPath], { timeoutMs: 60_000 })
    const j = parseRunnerJson(r.stdout)
    if (!j || j.ok !== true) return { ok: false, error: String(j?.message ?? (r.stderr || `exit ${r.code}`)).trim().slice(0, 300) }
    const sha = (v: unknown) => (typeof v === 'string' && SHA_RE.test(v.trim()) ? v.trim().toLowerCase() : null)
    return { ok: true, head: sha(j.head), origin_repo: repoOrNull(typeof j.origin_repo === 'string' ? j.origin_repo : ''), origin_main_head: sha(j.origin_main) }
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300) }
  }
}

async function ghJson<T>(exec: ExecFn, args: string[]): Promise<T> {
  return JSON.parse(await exec('gh', args)) as T
}

async function mainHead(exec: ExecFn, repo: string): Promise<{ sha: string; committed_at: string | null }> {
  const j = await ghJson<{ sha?: string; date?: string }>(exec, ['api', `repos/${repo}/commits/main`, '--jq', '{sha: .sha, date: .commit.committer.date}'])
  if (!j.sha || !SHA_RE.test(j.sha)) throw new Error('no sha in the answer')
  return { sha: j.sha.toLowerCase(), committed_at: j.date ?? null }
}

async function newestSyncPr(exec: ExecFn, repo: string, branch: string): Promise<SyncPr | null> {
  const rows = await ghJson<Array<{ number?: number; state?: string; url?: string; createdAt?: string; updatedAt?: string; mergedAt?: string | null }>>(
    exec, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '5', '--json', 'number,state,url,createdAt,updatedAt,mergedAt'])
  if (!Array.isArray(rows) || rows.length === 0) return null
  const pick = rows.find(r => String(r.state).toUpperCase() === 'OPEN') ?? [...rows].sort((a, b) => Number(b.number) - Number(a.number))[0]
  return {
    repo, number: Number(pick.number), state: String(pick.state ?? '').toUpperCase(), url: String(pick.url ?? ''),
    created_at: pick.createdAt ?? null, updated_at: pick.updatedAt ?? null, merged_at: pick.mergedAt ?? null,
  }
}

const ghWhy = (err: unknown) => (err as Error).message.split('\n')[0].slice(0, 200)

/** Pure: the facts → the words. Exported so the wording is tested on its own. */
export function describeEndState(f: Pick<EndState, 'live_commit' | 'public_main' | 'private_main' | 'sync_pr' | 'source_checkout'>): Pick<EndState, 'state' | 'summary' | 'live_matches_public_main' | 'private_waiting_on_sync'> {
  const live = f.live_commit
  const pub = f.public_main
  const match = pub ? sameCommit(live, pub.sha) : null
  const pr = f.sync_pr
  const priv = f.private_main

  // Is merged private code still outside the repo the server pulls from?
  let waiting: boolean | null = null
  let waitingWhy = ''
  if (!priv) {
    // Same repo for cards and the server (no sync step), or the private side is unknown.
    if (pr?.state === 'OPEN') {
      waiting = true
      waitingWhy = `sync PR #${pr.number} on ${pr.repo} is open (not merged)`
    }
  } else if (pr?.state === 'OPEN') {
    waiting = true
    waitingWhy = `sync PR #${pr.number} on ${pr.repo} is open (not merged), so ${pub?.repo ?? 'the repo the server updates from'} does not have private main ${short(priv.sha)} yet`
  } else if (pr?.state === 'MERGED') {
    const mergedAt = Date.parse(pr.merged_at ?? '')
    const privAt = Date.parse(priv.committed_at ?? '')
    if (Number.isFinite(mergedAt) && Number.isFinite(privAt) && privAt > mergedAt + 60_000) {
      waiting = true
      waitingWhy = `private main ${short(priv.sha)} (${priv.committed_at}) is newer than the last merged sync PR #${pr.number} (${pr.merged_at}) and no sync PR is open: the sync has not run for it, or that change had nothing to publish`
    } else {
      waiting = false
    }
  } else if (pr) {
    waiting = null
    waitingWhy = `the newest sync PR #${pr.number} is ${pr.state.toLowerCase()}`
  }

  const parts: string[] = []
  let state: EndStateCode = 'unknown'
  if (match === true) {
    state = waiting ? 'merged_not_deployed' : 'deployed'
    parts.push(`Deployed, commit ${short(live)} live: it is the head of ${pub!.repo} main, so a deploy now would change nothing.`)
    if (waiting) parts.push(`Merged, not deployed: ${waitingWhy}.`)
    else if (priv && waiting === false) parts.push(`Private main ${short(priv.sha)} is covered by merged sync PR #${pr!.number}.`)
  } else if (match === false) {
    state = 'merged_not_deployed'
    parts.push(`Merged, not deployed: live commit is ${short(live)}, ${pub!.repo} main is at ${short(pub!.sha)}. A deploy would move the server to ${short(pub!.sha)}.`)
    if (waiting) parts.push(`Also ${waitingWhy}.`)
  } else {
    parts.push(live ? `Live commit is ${short(live)}; the head of the repo the server updates from could not be read, so I cannot say whether it is current.` : 'The live commit is unknown.')
    if (waitingWhy) parts.push(`${waitingWhy[0].toUpperCase()}${waitingWhy.slice(1)}.`)
  }
  const co = f.source_checkout
  if (co?.head && live && sameCommit(co.head, live) === false) {
    parts.push(`The host checkout is at ${short(co.head)} but the running app is ${short(live)}: the code was pulled and the app was not rebuilt or restarted on it.`)
  }
  return { state, summary: parts.join(' '), live_matches_public_main: match, private_waiting_on_sync: waiting }
}

/** One read of everything. Never throws; what could not be read is in `notes`. */
export async function readEndState(q: EndStateQuery, deps: EndStateDeps = {}): Promise<EndState> {
  const env = deps.env ?? process.env
  const notes: string[] = []
  const live = (deps.liveCommit ?? buildCommit)()
  const cfg = endStateRepos(q.botSlug, env)

  const src = await readSourceCheckout(env)
  const source_checkout = src.ok ? { head: src.head, origin_repo: src.origin_repo, origin_main_head: src.origin_main_head } : null
  if (!src.ok) notes.push(`Host checkout not read: ${src.error}`)

  const publicRepo = cfg.publicRepo ?? source_checkout?.origin_repo ?? null
  if (!publicRepo) notes.push('The repo this server updates from is not known (the host checkout was not read and dev_ops_public_repo is not set).')
  const privateRepo = cfg.privateRepo && cfg.privateRepo.toLowerCase() !== (publicRepo ?? '').toLowerCase() ? cfg.privateRepo : null
  if (!cfg.privateRepo) notes.push('No private repo known yet (no card of this bot has a pull request, and dev_ops_private_repo is not set).')

  let exec: ExecFn | null = deps.exec === undefined ? null : deps.exec
  if (deps.exec === undefined) {
    try { exec = resolveMergeGithubAuth({ workspace: q.workspace, grantorUserId: q.userId, agent: q.botSlug })?.exec ?? null } catch { exec = null }
  }
  if (!exec) notes.push('No GitHub credential on the server, so GitHub was not read (the same credential the merge tool uses).')

  let public_main: EndState['public_main'] = null
  if (publicRepo && source_checkout?.origin_main_head && source_checkout.origin_repo === publicRepo) {
    public_main = { repo: publicRepo, sha: source_checkout.origin_main_head }
  } else if (publicRepo && exec) {
    try { public_main = { repo: publicRepo, sha: (await mainHead(exec, publicRepo)).sha } } catch (err) { notes.push(`${publicRepo} main not read: ${ghWhy(err)}`) }
  }

  let private_main: EndState['private_main'] = null
  if (privateRepo && exec) {
    try { private_main = { repo: privateRepo, ...(await mainHead(exec, privateRepo)) } } catch (err) { notes.push(`${privateRepo} main not read: ${ghWhy(err)}`) }
  }

  let sync_pr: SyncPr | null = null
  if (publicRepo && privateRepo && exec) {
    try { sync_pr = await newestSyncPr(exec, publicRepo, cfg.syncBranch) } catch (err) { notes.push(`Sync PR on ${publicRepo} not read: ${ghWhy(err)}`) }
  }

  const facts = { live_commit: live, source_checkout, public_main, private_main, sync_pr }
  return { ...facts, ...describeEndState(facts), notes }
}

// ── After a merge: is the PR really merged? ──────────────────────────────────

export interface MergeFacts {
  repo: string
  pr_number: number
  /** OPEN | MERGED | CLOSED */
  state: string
  merged: boolean
  merge_sha: string | null
  merged_at: string | null
  base: string | null
  /** Checks on the PR head, by conclusion. */
  checks: { total: number; passed: number; failed: string[]; pending: string[] }
  summary: string
}

interface Rollup { name?: string; context?: string; status?: string; conclusion?: string; state?: string }

export function countChecks(rollup: Rollup[] | null | undefined): MergeFacts['checks'] {
  const failed: string[] = []
  const pending: string[] = []
  let passed = 0
  const rows = Array.isArray(rollup) ? rollup : []
  for (const c of rows) {
    const name = String(c.name ?? c.context ?? 'check').slice(0, 80)
    const done = String(c.conclusion ?? c.state ?? '').toUpperCase()
    const status = String(c.status ?? '').toUpperCase()
    if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(done)) passed += 1
    else if (done === '' || done === 'PENDING' || done === 'EXPECTED' || (status && status !== 'COMPLETED')) pending.push(name)
    else failed.push(name)
  }
  return { total: rows.length, passed, failed: failed.slice(0, 10), pending: pending.slice(0, 10) }
}

/** GitHub's own answer for one PR: merged or not, the merge commit, the checks. Throws on a GitHub error. */
export async function readMergeFacts(exec: ExecFn, repo: string, prNumber: number): Promise<MergeFacts> {
  const j = await ghJson<{ state?: string; mergedAt?: string | null; mergeCommit?: { oid?: string } | null; baseRefName?: string; statusCheckRollup?: Rollup[] }>(
    exec, ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergedAt,mergeCommit,baseRefName,statusCheckRollup'])
  const state = String(j.state ?? '').toUpperCase()
  const merged = state === 'MERGED'
  const merge_sha = merged && j.mergeCommit?.oid && SHA_RE.test(j.mergeCommit.oid) ? j.mergeCommit.oid.toLowerCase() : null
  const checks = countChecks(j.statusCheckRollup)
  const checkWords = checks.total === 0 ? 'no checks reported'
    : `${checks.passed}/${checks.total} checks passed${checks.failed.length ? `, failed: ${checks.failed.join(', ')}` : ''}${checks.pending.length ? `, still running: ${checks.pending.join(', ')}` : ''}`
  const summary = merged
    ? `Merged, not deployed: PR #${prNumber} on ${repo} is merged${merge_sha ? ` as ${short(merge_sha)}` : ''}${j.baseRefName ? ` into ${j.baseRefName}` : ''} (${checkWords}). It is not live until a deploy brings it to the server.`
    : `Not merged: PR #${prNumber} on ${repo} is ${state.toLowerCase() || 'unreadable'} (${checkWords}).`
  return { repo, pr_number: prNumber, state, merged, merge_sha, merged_at: j.mergedAt ?? null, base: j.baseRefName ?? null, checks, summary }
}

/** The merge sha right after a merge. Best effort: GitHub may need a moment; never throws. */
export async function mergeShaAfterMerge(exec: ExecFn, repo: string, prNumber: number): Promise<string | null> {
  try {
    const j = await ghJson<{ state?: string; mergeCommit?: { oid?: string } | null }>(exec, ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeCommit'])
    const oid = j.mergeCommit?.oid
    return String(j.state).toUpperCase() === 'MERGED' && oid && SHA_RE.test(oid) ? oid.toLowerCase() : null
  } catch {
    return null
  }
}
