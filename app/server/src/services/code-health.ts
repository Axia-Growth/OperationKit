// ── Code-health Job: a recurring janitor pass on ONE linked repo (obj 901770) ──
//
// An admin switches it on per repo (Settings → Workspaces → the repo's menu).
// Each run is one board card that finds ONE small, checkable slice of debt or
// slop in that repo and opens ONE small PR for it, or reports that nothing
// needed doing. Bigger findings never become a PR here: the run raises them in
// Needs You for a person.
//
// How it is built, and why:
//   - The SETTING is one row per repo in `code_health_jobs`. No row = off, so
//     an existing install never starts a run it did not ask for. Switching it
//     on creates the routine; switching it off disables it (never deletes it,
//     so the history on Jobs → Executions survives).
//   - The SCHEDULE is an ordinary AI routine named `code-health:<repo id>`
//     (same shape as High Agency's `high-agency:<slug>`). Reusing the routine
//     scheduler gives a run every guard a Job already has: one run in flight
//     (max_queue_depth 1), the over-fire guard, K-failure auto-pause, the
//     routines kill switch, the session cap, and Run now / Executions on the
//     Jobs page. It is never hand-edited: saving rewrites it, and the boot
//     resync refreshes the brief without touching a paused routine.
//   - The CARD is a `task` with create_pr on, so a run's PR takes the existing
//     path: independent AI review (always — see `alwaysReviewPr` in
//     poller-decisions.ts; the green lane would otherwise skip the reviewer for
//     a backend-only PR on a routine card), then auto-merge-on-green
//     (auto-merge.ts) when the owner's `auto_merge_enabled` switch is on.
//   - LIGHTWEIGHT ONLY is enforced by the server, not just the brief:
//     `codeHealthMergeBlock` refuses auto-merge for a code-health PR that is
//     over the size cap, touches a database schema / migration path, a
//     rebuild path (Dockerfile, compose, package.json, lockfiles) or CI config,
//     or whose size cannot be read. Such a PR stays in review — Needs You —
//     for a person.
//   - A code-health merge is never a deploy: the merged-PR webhook skips
//     auto-deploy for it (`isCodeHealthPr`). The owner deploys.
//   - One waiting PR at a time: a run is refused (`codeHealthFireRefusal`)
//     while an earlier code-health card for the same repo still sits in review
//     with a PR, so unmerged cleanups never pile up.
import { execFile } from 'child_process'
import type { Database } from 'better-sqlite3'
import type { CodeHealthJobStatus, Objective, WorkspaceRepo } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { getWorkspaceRepo } from './workspace-repos.js'
import { nextRunAt, type RoutineRow } from './routine-scheduler.js'
import { resumeRoutine } from './routine-auto-pause.js'
import { isMigrationPath } from '../lib/migration-paths.js'
import { isRebuildPath } from './chat-deploy.js'

export const CODE_HEALTH_PREFIX = 'code-health:'
export const CODE_HEALTH_CADENCES = ['weekly', 'daily'] as const
export type CodeHealthCadence = (typeof CODE_HEALTH_CADENCES)[number]
export const DEFAULT_CADENCE: CodeHealthCadence = 'weekly'

/** Size cap for a code-health PR that may auto-merge. Settings override, read at point of use. */
export const DEFAULT_MAX_FILES = 8
export const DEFAULT_MAX_LINES = 200

export interface CodeHealthLimits {
  maxFiles: number
  maxLines: number
}

export interface CodeHealthRow {
  repo_id: number
  workspace: string
  enabled: number
  cadence: string
  routine_id: number | null
  run_as_user_id: number | null
  updated_by: string | null
  updated_at: string
}

export type CodeHealthStatus = CodeHealthJobStatus

export function isCodeHealthCadence(v: unknown): v is CodeHealthCadence {
  return typeof v === 'string' && (CODE_HEALTH_CADENCES as readonly string[]).includes(v)
}

export function codeHealthRoutineName(repoId: number): string {
  return `${CODE_HEALTH_PREFIX}${repoId}`
}

/** The repo id a `code-health:<id>` routine name belongs to, or null. */
export function codeHealthRepoId(routineName: string | null | undefined): number | null {
  const m = /^code-health:(\d+)$/.exec(String(routineName || ''))
  if (!m) return null
  const id = Number(m[1])
  return Number.isInteger(id) && id > 0 ? id : null
}

function settingInt(db: Database, key: string, fallback: number, min: number, max: number): number {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    const n = row ? Number.parseInt(row.value, 10) : NaN
    if (Number.isFinite(n) && n >= min && n <= max) return n
  } catch {
    /* no settings table (tests) → default */
  }
  return fallback
}

/** `settings.code_health_max_files` / `code_health_max_lines`, else the defaults. */
export function codeHealthLimits(db: Database = getDb()): CodeHealthLimits {
  return {
    maxFiles: settingInt(db, 'code_health_max_files', DEFAULT_MAX_FILES, 1, 50),
    maxLines: settingInt(db, 'code_health_max_lines', DEFAULT_MAX_LINES, 10, 2000),
  }
}

/**
 * The cron for a repo's runs, in server time (UTC on the host). The minute is
 * spread by repo id so several repos do not all start at once. Weekly = Monday.
 */
export function codeHealthCron(repoId: number, cadence: CodeHealthCadence): string {
  const minute = (Math.abs(Math.trunc(repoId)) * 7) % 60
  return cadence === 'daily' ? `${minute} 7 * * *` : `${minute} 7 * * 1`
}

/** Why a repo cannot run a code-health Job, or null when it can. */
export function codeHealthUnavailable(repo: Pick<WorkspaceRepo, 'github'>): string | null {
  const gh = (repo.github || '').trim()
  if (!gh || !/^[\w.-]+\/[\w.-]+$/.test(gh)) {
    return 'Link a GitHub repo (owner/name) to this repo first: a code-health run opens a pull request there.'
  }
  return null
}

/** The run card's title. Stable, so the duplicate guard and the Jobs page group runs. */
export function codeHealthTitle(repo: Pick<WorkspaceRepo, 'name'>): string {
  return `Code health — ${repo.name}`
}

/**
 * The worker brief for one run. Plain rules; the server enforces the parts that
 * matter (size cap, path walls, independent review, no deploy) on its own.
 */
export function codeHealthBrief(repo: Pick<WorkspaceRepo, 'name' | 'github'>, limits: CodeHealthLimits): string {
  const gh = repo.github || repo.name
  return [
    `Recurring code-health pass on ${gh}. Find ONE small, checkable slice of tech debt or slop, fix it in ONE small pull request, or report that nothing needed doing.`,
    '',
    'Good slices (pick one, the smallest useful one):',
    '- dead code: an unused export, function, file or variable nothing imports',
    '- a duplicated helper that can call the existing one',
    '- a type-check, lint or compiler warning, or an `any` that has an obvious real type',
    '- a stale TODO/FIXME whose fix is a few lines, or a comment that now lies about the code',
    '- a missing or wrong test for a small pure function',
    '- a typo in a user-facing message or doc',
    '',
    'Steps:',
    `1. Check for an open code-health PR first: gh pr list --repo ${gh} --state open --json number,title,headRefName. If one whose title starts with "Code health" is open, make no changes and report skipped-open-pr(#n).`,
    '2. Look around (grep, the type-checker, the linter, the tests) and choose ONE slice. Say in one line why it is safe.',
    `3. Keep the diff small: at most ${limits.maxFiles} files and ${limits.maxLines} changed lines (added + removed). No behaviour change beyond the fix.`,
    '4. Never in this PR: database schema or data-migration changes, new or upgraded dependencies (package.json, lockfiles), Dockerfile or compose changes, CI workflow changes, sign-in / permission / payment code, secrets or config values. A PR that touches any of these, or is over the size cap, is never auto-merged; it waits for a person.',
    '5. Run the repo\'s own checks for what you touched (type-check, the tests for that file, the build if it is cheap) and keep them green. Commit with a message that names the slice.',
    `6. Open the PR (create_pr is on) titled "Code health: <the slice in a few words>". Body: what was wrong, what changed, how you checked it. PR only: do not merge, do not deploy.`,
    '',
    'If nothing small is worth doing: make no commits, say "nothing to do" and why in one line, and finish.',
    '',
    'If you find something real that is bigger than this pass (a risky refactor, a dependency upgrade, a schema change, anything over the cap): do NOT open a PR for it. Raise it for a person in Needs You through your job disposition (POST /api/internal/objectives/<this card id>/job-disposition with disposition "needs_review" and a decision briefing that proposes filing it as its own project card), then finish.',
    '',
    'The independent AI reviewer grades the PR, not you: do not say it passed review or CI until it has.',
  ].join('\n')
}

export function codeHealthCompletionGoal(limits: CodeHealthLimits): string {
  return (
    `Either ONE small code-health PR (at most ${limits.maxFiles} files / ${limits.maxLines} changed lines, repo checks green, ` +
    'no schema, dependency, CI, sign-in or payment changes) is open with the slice explained, or the run reports "nothing to do" ' +
    '(or skipped-open-pr) with a one-line reason. Bigger findings are raised in Needs You, never opened as a PR here.'
  )
}

export function codeHealthTemplate(repo: WorkspaceRepo, row: Pick<CodeHealthRow, 'run_as_user_id'>, limits: CodeHealthLimits): Record<string, unknown> {
  const tpl: Record<string, unknown> = {
    title: codeHealthTitle(repo),
    description: codeHealthBrief(repo, limits),
    agent_context: 'general',
    workspace: repo.workspace,
    project: repo.name,
    category: 'operations',
    completion_goal: codeHealthCompletionGoal(limits),
    workflow_hint: null,
    effort: 'normal',
    type: 'task',
    create_pr: true,
  }
  if (row.run_as_user_id != null) tpl.assigned_user_id = row.run_as_user_id
  return tpl
}

// ── reads ──

export function getCodeHealthRow(repoId: number, db: Database = getDb()): CodeHealthRow | undefined {
  return db.prepare('SELECT * FROM code_health_jobs WHERE repo_id = ?').get(repoId) as CodeHealthRow | undefined
}

function routineById(db: Database, id: number | null): RoutineRow | undefined {
  if (id == null) return undefined
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow | undefined
}

function routineFor(db: Database, row: CodeHealthRow | undefined, repoId: number): RoutineRow | undefined {
  return (
    routineById(db, row?.routine_id ?? null) ??
    (db.prepare('SELECT * FROM routines WHERE name = ?').get(codeHealthRoutineName(repoId)) as RoutineRow | undefined)
  )
}

export function codeHealthStatus(repo: WorkspaceRepo, db: Database = getDb(), now = new Date()): CodeHealthStatus {
  const row = getCodeHealthRow(repo.id, db)
  const cadence = isCodeHealthCadence(row?.cadence) ? row!.cadence as CodeHealthCadence : DEFAULT_CADENCE
  const routine = routineFor(db, row, repo.id)
  const enabled = !!row && Number(row.enabled) === 1
  const paused = enabled && !!routine && (Number(routine.enabled) !== 1 || !!routine.auto_paused_at)
  const next = enabled && routine && !paused ? nextRunAt(routine.cron_expr, now) : null
  return {
    repo_id: repo.id,
    enabled,
    cadence,
    routine_id: routine?.id ?? null,
    paused,
    next_run_at: next ? next.toISOString() : null,
    limits: codeHealthLimits(db),
    unavailable: codeHealthUnavailable(repo),
  }
}

// ── writes ──

/**
 * Make the repo's managed routine match its row: schedule, brief and on/off.
 * Creates the routine the first time the job is switched on. `keepRunState`
 * (the boot resync) refreshes schedule + brief only: a routine paused on the
 * Jobs page, or auto-paused, stays paused.
 */
export function syncCodeHealthRoutine(
  repo: WorkspaceRepo,
  row: CodeHealthRow,
  opts: { keepRunState?: boolean; db?: Database } = {},
): RoutineRow | null {
  const db = opts.db ?? getDb()
  const existing = routineFor(db, row, repo.id)
  const enabled = Number(row.enabled) === 1
  if (!existing && !enabled) return null
  const cadence = isCodeHealthCadence(row.cadence) ? row.cadence : DEFAULT_CADENCE
  const cron = codeHealthCron(repo.id, cadence)
  const tpl = JSON.stringify(codeHealthTemplate(repo, row, codeHealthLimits(db)))
  let id: number
  if (existing) {
    db.prepare("UPDATE routines SET cron_expr = ?, objective_template = ?, kind = 'ai', max_queue_depth = 1 WHERE id = ?")
      .run(cron, tpl, existing.id)
    id = existing.id
  } else {
    id = Number(
      db.prepare("INSERT INTO routines (name, cron_expr, objective_template, enabled, max_queue_depth, kind) VALUES (?, ?, ?, 0, 1, 'ai')")
        .run(codeHealthRoutineName(repo.id), cron, tpl).lastInsertRowid,
    )
  }
  const wasEnabled = existing ? Number(existing.enabled) === 1 : false
  if (opts.keepRunState && existing) {
    // run state untouched
  } else if (enabled && (!wasEnabled || existing?.auto_paused_at)) {
    resumeRoutine(id, `code-health:${row.updated_by ?? 'admin'}`)
  } else if (!enabled && wasEnabled) {
    db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(id)
  }
  if (row.routine_id !== id) db.prepare('UPDATE code_health_jobs SET routine_id = ? WHERE repo_id = ?').run(id, repo.id)
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as RoutineRow
}

export type SetCodeHealthResult =
  | { ok: true; status: CodeHealthStatus }
  | { ok: false; code: 'repo_not_linked' | 'bad_cadence'; error: string }

/** Switch a repo's code-health Job on/off and/or change its cadence. */
export function setCodeHealthJob(
  repo: WorkspaceRepo,
  patch: { enabled?: boolean; cadence?: unknown },
  actor: { userId: number | null; label: string },
  db: Database = getDb(),
): SetCodeHealthResult {
  if (patch.cadence !== undefined && !isCodeHealthCadence(patch.cadence)) {
    return { ok: false, code: 'bad_cadence', error: `cadence must be one of: ${CODE_HEALTH_CADENCES.join(', ')}` }
  }
  const prev = getCodeHealthRow(repo.id, db)
  const enabled = patch.enabled ?? (prev ? Number(prev.enabled) === 1 : false)
  if (enabled) {
    const why = codeHealthUnavailable(repo)
    if (why) return { ok: false, code: 'repo_not_linked', error: why }
  }
  const cadence = (patch.cadence as CodeHealthCadence | undefined) ?? (isCodeHealthCadence(prev?.cadence) ? prev!.cadence : DEFAULT_CADENCE)
  // The admin who switches it on is who each run card is assigned to (visible to them).
  const runAs = enabled && (!prev || Number(prev.enabled) !== 1) ? actor.userId : (prev?.run_as_user_id ?? actor.userId)
  db.prepare(
    `INSERT INTO code_health_jobs (repo_id, workspace, enabled, cadence, run_as_user_id, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id) DO UPDATE SET workspace = excluded.workspace, enabled = excluded.enabled, cadence = excluded.cadence,
       run_as_user_id = excluded.run_as_user_id, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(repo.id, repo.workspace, enabled ? 1 : 0, cadence, runAs, actor.label)
  const row = getCodeHealthRow(repo.id, db)!
  syncCodeHealthRoutine(repo, row, { db })
  return { ok: true, status: codeHealthStatus(repo, db) }
}

/** The repo was removed: switch its job off (the routine and row stay for history). */
export function disableCodeHealthForRepo(repoId: number, db: Database = getDb()): void {
  const row = getCodeHealthRow(repoId, db)
  if (!row) return
  db.prepare("UPDATE code_health_jobs SET enabled = 0, updated_by = 'repo-removed', updated_at = datetime('now') WHERE repo_id = ?").run(repoId)
  const r = routineFor(db, row, repoId)
  if (r) db.prepare('UPDATE routines SET enabled = 0 WHERE id = ?').run(r.id)
}

/**
 * Boot: refresh every code-health routine's brief + schedule from the current
 * code (a paused routine stays paused), and switch off the job of a repo that
 * is gone or no longer linked to GitHub.
 */
export function resyncCodeHealthRoutines(db: Database = getDb()): { synced: number; disabled: number } {
  let synced = 0
  let disabled = 0
  const rows = db.prepare('SELECT * FROM code_health_jobs').all() as CodeHealthRow[]
  for (const row of rows) {
    const repo = getWorkspaceRepo(row.repo_id)
    if (!repo || (Number(row.enabled) === 1 && codeHealthUnavailable(repo))) {
      if (Number(row.enabled) === 1) {
        disableCodeHealthForRepo(row.repo_id, db)
        disabled++
      }
      continue
    }
    if (syncCodeHealthRoutine(repo, row, { keepRunState: true, db })) synced++
  }
  return { synced, disabled }
}

// ── guards used by the scheduler, the poller, auto-merge and the webhook ──

/**
 * Refuse a code-health fire when its repo is gone / unlinked, or when an earlier
 * run's PR is still waiting in review for a person (one waiting PR per repo).
 * Prefix `code-health guard` is a benign skip (never counts toward auto-pause).
 */
export function codeHealthFireRefusal(routine: Pick<RoutineRow, 'id' | 'name'>, db: Database = getDb()): string | null {
  const repoId = codeHealthRepoId(routine.name)
  if (repoId == null) return null
  const repo = getWorkspaceRepo(repoId)
  if (!repo) return `code-health guard: repo #${repoId} no longer exists`
  const why = codeHealthUnavailable(repo)
  if (why) return `code-health guard: repo "${repo.name}" has no GitHub repo linked`
  try {
    const waiting = db
      .prepare(
        `SELECT id FROM objectives
          WHERE routine_id = ? AND status = 'review' AND deleted_at IS NULL
            AND (pr_number IS NOT NULL OR (pr_url IS NOT NULL AND pr_url != ''))
          ORDER BY id ASC LIMIT 1`,
      )
      .get(routine.id) as { id: number } | undefined
    if (waiting) return `code-health guard: card #${waiting.id} still has a PR waiting for a person`
  } catch {
    /* unreadable → do not block on it */
  }
  return null
}

/** Is this card a code-health run (its routine is `code-health:<id>`)? */
export function isCodeHealthCard(obj: Pick<Objective, 'routine_id'>, db: Database = getDb()): boolean {
  if (obj.routine_id == null) return false
  try {
    const r = db.prepare('SELECT name FROM routines WHERE id = ?').get(obj.routine_id) as { name: string } | undefined
    return codeHealthRepoId(r?.name) != null
  } catch {
    return false
  }
}

/** Was this merged PR a code-health run's PR? Used to keep it from auto-deploying. */
export function isCodeHealthPr(db: Database, repo: string, prNumber: number): boolean {
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) return false
  try {
    const row = db
      .prepare(
        `SELECT o.id FROM objectives o JOIN routines r ON r.id = o.routine_id
          WHERE r.name LIKE 'code-health:%' AND o.pr_number = ?
            AND lower(COALESCE(o.pr_url, '')) LIKE ?
          LIMIT 1`,
      )
      .get(prNumber, `%github.com/${repo.trim().toLowerCase()}/pull/${prNumber}%`) as { id: number } | undefined
    return !!row
  } catch {
    return false
  }
}

/** CI config: a janitor PR never changes what gates it. */
export function isCiConfigPath(file: string): boolean {
  const p = String(file || '').trim().replace(/^\.?\//, '')
  return p.startsWith('.github/')
}

export interface PrSize {
  additions: number
  deletions: number
  changedFiles: number
  files: string[]
}

/**
 * PURE: why a code-health PR may NOT auto-merge, or null when it is lightweight.
 * Unknown size fails closed.
 */
export function codeHealthMergeBlock(size: PrSize | null, limits: CodeHealthLimits): string | null {
  if (!size) return 'code-health PR size unreadable — a person merges it'
  const lines = (size.additions || 0) + (size.deletions || 0)
  const files = Math.max(size.changedFiles || 0, size.files.length)
  if (files > limits.maxFiles) return `code-health PR touches ${files} files (cap ${limits.maxFiles}) — a person merges it`
  if (lines > limits.maxLines) return `code-health PR changes ${lines} lines (cap ${limits.maxLines}) — a person merges it`
  const schema = size.files.filter(isMigrationPath)
  if (schema.length) return `code-health PR touches a database schema / migration path (${schema[0]}) — a person merges it`
  const rebuild = size.files.filter(isRebuildPath)
  if (rebuild.length) return `code-health PR touches a dependency / image file (${rebuild[0]}) — a person merges it`
  const ci = size.files.filter(isCiConfigPath)
  if (ci.length) return `code-health PR touches CI config (${ci[0]}) — a person merges it`
  return null
}

export type GhExec = (args: string[]) => Promise<string>

const realGh: GhExec = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message))
      else resolve(stdout)
    })
  })

/** Read a PR's size from GitHub. Null on any error (callers fail closed). */
export async function readPrSize(repo: string, prNumber: number, gh: GhExec = realGh): Promise<PrSize | null> {
  try {
    const out = await gh(['pr', 'view', String(prNumber), '--repo', repo, '--json', 'additions,deletions,changedFiles,files'])
    const j = JSON.parse(out) as { additions?: number; deletions?: number; changedFiles?: number; files?: { path?: string }[] }
    if (typeof j.additions !== 'number' || typeof j.deletions !== 'number') return null
    return {
      additions: j.additions,
      deletions: j.deletions,
      changedFiles: typeof j.changedFiles === 'number' ? j.changedFiles : (j.files || []).length,
      files: (j.files || []).map((f) => String(f.path || '')).filter(Boolean),
    }
  } catch {
    return null
  }
}
