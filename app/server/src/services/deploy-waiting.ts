/**
 * "Merged, waiting for deploy" (obj 901389).
 *
 * The owner deploys; a bot may merge under a merge grant. After a merge nothing
 * used to tell the owner WHICH merged pull requests are not live yet — the drift
 * guard (services/drift-guard.ts) only says "the live checkout is N commits
 * behind main". This module turns that into a list:
 *
 *   each commit on `origin/main` that is not in the live checkout's HEAD, with
 *   its PR number, title, card number, who merged it (a person, the background
 *   auto-merge, or a bot under grant #N), and a flag when it touches a schema /
 *   migration path (lib/migration-paths.ts),
 *
 * plus the two checks CLAUDE.md "Merge ≠ deployed" names: is HEAD == origin/main,
 * and did the running server start after the last merge.
 *
 * It is READ-ONLY. It never fetches (the drift guard already fetches origin/main
 * every 60 s, so the local `origin/main` ref is at most that old), never asks
 * GitHub anything, never deploys and never restarts anything. Every git call goes
 * through an injectable runner so the logic is testable without a repo.
 */
import { execFileSync } from 'child_process'
import type { Database } from 'better-sqlite3'
import { CC_REPO_DIR } from '../config.js'
import { analyzeDrift } from './drift-guard.js'
import { findGrantMerge } from './merge-deploy-gate.js'
import { migrationPaths } from '../lib/migration-paths.js'
import { selfRepo } from './auto-deploy.js'

/** Runs `git -C <repo> <args>` and returns trimmed stdout; throws on failure. */
export type GitRunner = (args: string[]) => string

export interface WaitingCommit {
  sha: string
  committed_at: string
  subject: string
  files: string[]
}

export type MergedBy =
  | { kind: 'bot_grant'; bot: string; grant_id: number }
  | { kind: 'auto_merge' }
  | { kind: 'person'; login: string }
  | { kind: 'unknown' }

export interface WaitingEntry {
  sha: string
  short_sha: string
  committed_at: string
  pr_number: number | null
  pr_url: string | null
  title: string
  card_id: number | null
  card_title: string | null
  merged_by: MergedBy
  /** One plain line: "Operation Kit Dev (bot) under grant #4", "operator", "auto-merge", "unknown". */
  merged_by_label: string
  migration: boolean
  migration_paths: string[]
}

export interface DeployStatus {
  /** False when git could not be read; every other field is then best-effort. */
  ok: boolean
  error?: string
  repo: string
  checked_at: string
  head: string | null
  origin_main: string | null
  /** Check 1 of "Merge ≠ deployed": HEAD equals origin/main. */
  checkout_at_origin_main: boolean
  behind: number
  ahead: number
  dirty_served_files: string[]
  /** Newest first, as `git log` lists them. */
  waiting: WaitingEntry[]
  migrations_waiting: number
  /** Commit time of origin/main's tip — the last merge. */
  last_merge_at: string | null
  server_started_at: string
  /** Check 2 of "Merge ≠ deployed": the running server started after the last merge. */
  server_started_after_last_merge: boolean | null
  /** Both checks hold and nothing is waiting. */
  live: boolean
  summary: string
  note: string
}

const RS = '\x1e'
const US = '\x1f'

/** `git log --name-only --format=%x1e%H%x1f%cI%x1f%s HEAD..origin/main` → commits. Pure. */
export function parseWaitingLog(raw: string): WaitingCommit[] {
  const out: WaitingCommit[] = []
  for (const chunk of String(raw || '').split(RS)) {
    if (!chunk.trim()) continue
    const lines = chunk.split('\n')
    const [sha, committedAt, ...rest] = lines[0].split(US)
    if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha.trim())) continue
    out.push({
      sha: sha.trim(),
      committed_at: (committedAt || '').trim(),
      subject: rest.join(US).trim(),
      files: lines.slice(1).map(l => l.trim()).filter(Boolean),
    })
  }
  return out
}

/** The PR number a merge commit names: a squash "Title (#123)" or "Merge pull request #123". Pure. */
export function prNumberFromSubject(subject: string): number | null {
  const s = String(subject || '')
  const m = /\(#(\d+)\)\s*$/.exec(s) ?? /^Merge pull request #(\d+)\b/.exec(s)
  return m ? Number(m[1]) : null
}

function titleFromSubject(subject: string): string {
  return String(subject || '').replace(/\s*\(#\d+\)\s*$/, '').trim()
}

interface CardRow { id: number; title: string; pr_url: string | null }

function findCard(db: Database, repo: string, prNumber: number): CardRow | null {
  try {
    const row = db
      .prepare(
        `SELECT id, title, pr_url FROM objectives
          WHERE pr_number = ? AND deleted_at IS NULL AND lower(COALESCE(pr_url, '')) LIKE lower(?)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(prNumber, `%/${repo}/pull/${prNumber}`) as CardRow | undefined
    if (row) return row
  } catch {
    /* fall through to the changelog link */
  }
  try {
    const cl = db
      .prepare(
        `SELECT o.id, o.title, o.pr_url FROM changelog_entries c JOIN objectives o ON o.id = c.objective_id
          WHERE lower(c.repo) = lower(?) AND c.pr_number = ? LIMIT 1`,
      )
      .get(repo, prNumber) as CardRow | undefined
    return cl ?? null
  } catch {
    return null
  }
}

interface ChangelogRow { title_eng: string | null; merged_by: string | null; pr_url: string | null }

function changelogRow(db: Database, repo: string, prNumber: number): ChangelogRow | null {
  try {
    return (db
      .prepare('SELECT title_eng, merged_by, pr_url FROM changelog_entries WHERE lower(repo) = lower(?) AND pr_number = ? LIMIT 1')
      .get(repo, prNumber) as ChangelogRow | undefined) ?? null
  } catch {
    return null
  }
}

function autoMerged(db: Database, cardId: number): boolean {
  try {
    return !!db
      .prepare("SELECT 1 FROM activity_log WHERE objective_id = ? AND title = 'auto_merge_decision' AND detail LIKE '[merge]%MERGED via%' LIMIT 1")
      .get(cardId)
  } catch {
    return false
  }
}

export function mergedByLabel(m: MergedBy): string {
  switch (m.kind) {
    case 'bot_grant': return `${m.bot} (bot) under grant #${m.grant_id}`
    case 'auto_merge': return 'background auto-merge'
    case 'person': return m.login
    default: return 'unknown'
  }
}

/** Enrich raw commits from the DB: card, title, who merged, migration flag. Reads only. */
export function buildWaitingEntries(db: Database, repo: string, commits: readonly WaitingCommit[]): WaitingEntry[] {
  return commits.map(c => {
    const pr = prNumberFromSubject(c.subject)
    const card = pr != null && repo ? findCard(db, repo, pr) : null
    const cl = pr != null && repo ? changelogRow(db, repo, pr) : null
    let mergedBy: MergedBy = { kind: 'unknown' }
    const gm = pr != null && repo ? findGrantMerge(db, repo, pr) : null
    if (gm) mergedBy = { kind: 'bot_grant', bot: gm.bot, grant_id: gm.grantId }
    else if (card && autoMerged(db, card.id)) mergedBy = { kind: 'auto_merge' }
    else if (cl?.merged_by) mergedBy = { kind: 'person', login: cl.merged_by }
    const mig = migrationPaths(c.files)
    const cardId = card?.id ?? gm?.objectiveId ?? null
    return {
      sha: c.sha,
      short_sha: c.sha.slice(0, 8),
      committed_at: c.committed_at,
      pr_number: pr,
      pr_url: cl?.pr_url || card?.pr_url || (pr != null && repo ? `https://github.com/${repo}/pull/${pr}` : null),
      title: (cl?.title_eng || '').trim() || titleFromSubject(c.subject),
      card_id: cardId,
      card_title: card?.title ?? null,
      merged_by: mergedBy,
      merged_by_label: mergedByLabel(mergedBy),
      migration: mig.length > 0,
      migration_paths: mig,
    }
  })
}

function defaultGit(repoDir: string): GitRunner {
  return args => execFileSync('git', ['-C', repoDir, ...args], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** When this Node process started (the running server). */
export function serverStartedAt(nowMs = Date.now(), uptimeSec = process.uptime()): Date {
  return new Date(nowMs - uptimeSec * 1000)
}

export interface CollectOptions {
  repoDir?: string
  repo?: string
  git?: GitRunner
  now?: Date
  startedAt?: Date
}

/** The whole read-only picture. Never throws. */
export function collectDeployStatus(db: Database, opts: CollectOptions = {}): DeployStatus {
  const now = opts.now ?? new Date()
  const git = opts.git ?? defaultGit(opts.repoDir ?? CC_REPO_DIR)
  const repo = opts.repo ?? selfRepo()
  const started = opts.startedAt ?? serverStartedAt(now.getTime())
  const note = "Read-only. origin/main is as of the drift guard's last fetch (every 60 s). Nothing here deploys or restarts anything; the owner deploys."
  const base = {
    repo,
    checked_at: now.toISOString(),
    server_started_at: started.toISOString(),
    note,
  }
  try {
    const head = git(['rev-parse', 'HEAD'])
    let originMain: string | null = null
    try { originMain = git(['rev-parse', 'origin/main']) } catch { originMain = null }
    if (!originMain) {
      return {
        ...base, ok: false, error: 'origin/main is not known in the live checkout', head, origin_main: null,
        checkout_at_origin_main: false, behind: 0, ahead: 0, dirty_served_files: [], waiting: [], migrations_waiting: 0,
        last_merge_at: null, server_started_after_last_merge: null, live: false,
        summary: 'Could not compare the live checkout with origin/main.',
      }
    }
    const leftRight = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'])
    let porcelain = ''
    try { porcelain = git(['status', '--porcelain']) } catch { porcelain = '' }
    const drift = analyzeDrift({ porcelain, leftRight, fetchOk: true, ok: true })
    const commits = parseWaitingLog(git(['log', '--name-only', `--format=${RS}%H${US}%cI${US}%s`, 'HEAD..origin/main']))
    const waiting = buildWaitingEntries(db, repo, commits)
    let lastMergeAt: string | null = null
    try { lastMergeAt = git(['log', '-1', '--format=%cI', 'origin/main']) || null } catch { lastMergeAt = null }
    const lastMergeMs = lastMergeAt ? Date.parse(lastMergeAt) : NaN
    const startedAfter = Number.isFinite(lastMergeMs) ? started.getTime() > lastMergeMs : null
    const atOrigin = head === originMain
    const migrations = waiting.filter(w => w.migration).length
    const live = atOrigin && startedAfter === true && waiting.length === 0
    let summary: string
    if (live) summary = 'Everything merged to main is live: the checkout is at origin/main and the server started after the last merge.'
    else if (waiting.length > 0) {
      summary = `${waiting.length} merged pull request${waiting.length === 1 ? ' is' : 's are'} waiting for a deploy` +
        (migrations ? ` (${migrations} with a database migration)` : '') + '.'
    } else if (!atOrigin) summary = `The live checkout is not at origin/main (${drift.ahead} ahead).`
    else summary = 'The checkout is at origin/main, but the running server started before the last merge: it needs a backend restart to run it.'
    return {
      ...base,
      ok: true,
      head,
      origin_main: originMain,
      checkout_at_origin_main: atOrigin,
      behind: drift.behind,
      ahead: drift.ahead,
      dirty_served_files: drift.dirtyServedFiles,
      waiting,
      migrations_waiting: migrations,
      last_merge_at: lastMergeAt,
      server_started_after_last_merge: startedAfter,
      live,
      summary,
    }
  } catch (err) {
    return {
      ...base, ok: false, error: `git could not be read: ${(err as Error).message.split('\n')[0]}`, head: null, origin_main: null,
      checkout_at_origin_main: false, behind: 0, ahead: 0, dirty_served_files: [], waiting: [], migrations_waiting: 0,
      last_merge_at: null, server_started_after_last_merge: null, live: false,
      summary: 'Could not read the live checkout, so what is live is unknown.',
    }
  }
}
