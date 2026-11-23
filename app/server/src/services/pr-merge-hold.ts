/**
 * obj 901456 — a passed card with an open pull request waits in `review` until
 * the PR merges.
 *
 * Before this, a reviewer PASS on a task (and the re-review churn guard in
 * poller-loop.ts) moved the card straight to `done` while its PR was still
 * open (#901388 / PR 889, #901389 / PR 888, #901393 / PR 892). Every merge
 * path (grant merge, Dev merge, `merge_approved_pr`) requires the card to be
 * in `review`, so those PRs could then no longer be merged through the board
 * (`not_in_review`), and the card read "done" for work that had shipped nowhere.
 *
 * Two halves:
 *  1. `holdForOpenPr` — at the point a PASS would write `done`, a card whose
 *     linked PR is not known to be merged or closed goes to `review` instead,
 *     and an `activity_log` milestone `pr_merge_hold` marks it as HELD (so the
 *     release below only ever closes cards this rule held, never a card a
 *     person or another rule parked in review).
 *  2. `releaseMergedPrHolds` — a throttled poller sweep over held cards still
 *     in `review` with a pass verdict. When the PR is merged (the durable
 *     `pr_terminal_states` record from the webhook, else a live `gh pr view`
 *     — the webhook is not reliable on every install) the card moves to
 *     `done`. A PR closed WITHOUT merging leaves the card in review for a
 *     person: nothing shipped.
 *
 * A card with no linked PR is untouched: it goes to `done` exactly as before.
 * Kill switch: `settings.pr_merge_hold_enabled = '0'` (read at point of use)
 * restores the old behaviour for new verdicts; cards already held stay held
 * until their PR merges or a person moves them.
 */
import type { Database } from 'better-sqlite3'
import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import { parsePrNumberFromUrl } from './pr-url.js'
import { parseRepoFromPrUrl, recordPRTerminalState } from './objective-prs.js'
import { runMachineStatusUpdate } from '../lib/status-lock.js'
import { logObjectiveAudit } from './objective-audit.js'
import { resolveWriteWorkspace } from './workspaces.js'

export const PR_MERGE_HOLD_TITLE = 'pr_merge_hold'
export const PR_MERGE_RELEASE_TITLE = 'pr_merge_hold_released'
/** How often the release sweep runs at all. */
export const PR_MERGE_HOLD_SWEEP_INTERVAL_MS = 60 * 1000
/** How often one held card's PR is asked about on GitHub. */
export const PR_MERGE_HOLD_RECHECK_MS = 5 * 60 * 1000

export type LinkedPrState = 'none' | 'open' | 'merged' | 'closed'
type GhExec = (args: string[]) => Promise<string>
type HoldFields = Pick<Objective, 'id' | 'pr_url' | 'pr_number'> & Partial<Objective>

export function prMergeHoldEnabled(db: Database): boolean {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'pr_merge_hold_enabled'").get() as { value?: string } | undefined
    return row?.value !== '0'
  } catch {
    return true
  }
}

/** The card's linked PR as (repo, number), or null when it has none. */
export function linkedPr(db: Database, obj: HoldFields): { repo: string | null; number: number } | null {
  const number = obj.pr_number ?? parsePrNumberFromUrl(obj.pr_url)
  if (!number) return null
  let repo = parseRepoFromPrUrl(obj.pr_url)
  if (!repo) {
    try {
      const row = db
        .prepare('SELECT repo FROM objective_prs WHERE objective_id = ? AND pr_number = ? AND repo IS NOT NULL LIMIT 1')
        .get(obj.id, number) as { repo?: string } | undefined
      repo = row?.repo ?? null
    } catch { /* table missing in a partial env */ }
  }
  return { repo, number }
}

/**
 * What the board already KNOWS about the linked PR, with no network call:
 * `none` (no PR), `merged` / `closed` (a recorded terminal state), else `open`.
 * Unknown counts as open on purpose: holding a card in review is the safe side,
 * and the release sweep asks GitHub before anything moves.
 */
export function recordedPrState(db: Database, obj: HoldFields): LinkedPrState {
  const pr = linkedPr(db, obj)
  if (!pr) return 'none'
  try {
    const row = pr.repo
      ? db.prepare('SELECT state FROM pr_terminal_states WHERE repo = ? AND pr_number = ?').get(pr.repo, pr.number) as { state?: string } | undefined
      : undefined
    if (row?.state === 'merged' || row?.state === 'closed') return row.state
    const log = db
      .prepare("SELECT state FROM objective_prs WHERE objective_id = ? AND pr_number = ? AND state IN ('merged','closed') LIMIT 1")
      .get(obj.id, pr.number) as { state?: string } | undefined
    if (log?.state === 'merged' || log?.state === 'closed') return log.state
  } catch { /* fall through: unknown = open */ }
  return 'open'
}

/**
 * Called where a PASS is about to write `done`. Returns `review` (and records
 * the hold) when the card has a linked PR that is not merged or closed;
 * otherwise returns `intended` unchanged. Only `done` is ever rewritten.
 */
export function holdForOpenPr(
  db: Database,
  obj: HoldFields,
  intended: ObjectiveStatus,
  pathway: string,
): ObjectiveStatus {
  if (intended !== 'done') return intended
  if (!prMergeHoldEnabled(db)) return intended
  if (recordedPrState(db, obj) !== 'open') return intended
  const pr = linkedPr(db, obj)!
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, ?, 'milestone', ?, ?, ?)`,
    ).run(
      obj.project || 'unknown',
      resolveWriteWorkspace(obj.workspace),
      obj.id,
      obj.ai_review_session_id ?? obj.session_id ?? null,
      PR_MERGE_HOLD_TITLE,
      `Review passed, but PR #${pr.number}${pr.repo ? ` on ${pr.repo}` : ''} is still open: the card waits in review until it merges.`,
      JSON.stringify({ kind: PR_MERGE_HOLD_TITLE, pathway, repo: pr.repo, pr_number: pr.number }),
    )
  } catch (err) {
    console.error(`[pr-merge-hold] could not record the hold for #${obj.id}:`, (err as Error).message)
  }
  console.log(`[pr-merge-hold] #${obj.id} passed with PR #${pr.number} open → review (was done; ${pathway})`)
  return 'review'
}

export interface ReleaseResult {
  objectiveId: number
  outcome: 'done' | 'still_open' | 'closed_unmerged' | 'unknown' | 'throttled' | 'no_pr' | 'skipped'
}

const lastChecked = new Map<number, number>()

/** Test hook: forget per-card GitHub check times. */
export function resetPrMergeHoldThrottle(): void {
  lastChecked.clear()
  lastSweepAt = 0
}

async function livePrState(gh: GhExec, repo: string, number: number): Promise<{ state: LinkedPrState; mergedAt: string | null } | null> {
  try {
    const raw = await gh(['pr', 'view', String(number), '--repo', repo, '--json', 'state,mergedAt'])
    const j = JSON.parse(raw || '{}') as { state?: string; mergedAt?: string | null }
    if (j.state === 'MERGED') return { state: 'merged', mergedAt: j.mergedAt ?? null }
    if (j.state === 'CLOSED') return { state: 'closed', mergedAt: null }
    if (j.state === 'OPEN') return { state: 'open', mergedAt: null }
    return null
  } catch {
    return null
  }
}

/**
 * Move held cards whose PR has merged to `done`. Bounded (50 cards), and each
 * card is asked about on GitHub at most every {@link PR_MERGE_HOLD_RECHECK_MS}
 * (a recorded merge from the webhook needs no call at all).
 */
export async function releaseMergedPrHolds(
  db: Database,
  opts: { gh: GhExec; now?: number; onUpdated?: (row: Objective) => void },
): Promise<ReleaseResult[]> {
  const now = opts.now ?? Date.now()
  const held = db
    .prepare(
      `SELECT o.* FROM objectives o
        WHERE o.status = 'review' AND o.ai_review_verdict = 'pass'
          AND (o.pr_url IS NOT NULL OR o.pr_number IS NOT NULL)
          AND EXISTS (SELECT 1 FROM activity_log a WHERE a.objective_id = o.id AND a.title = ?)
        ORDER BY o.updated_at ASC
        LIMIT 50`,
    )
    .all(PR_MERGE_HOLD_TITLE) as Objective[]

  const results: ReleaseResult[] = []
  for (const obj of held) {
    const pr = linkedPr(db, obj)
    if (!pr) { results.push({ objectiveId: obj.id, outcome: 'no_pr' }); continue }

    let state = recordedPrState(db, obj)
    if (state === 'open') {
      if (!pr.repo) { results.push({ objectiveId: obj.id, outcome: 'unknown' }); continue }
      const last = lastChecked.get(obj.id) ?? 0
      if (now - last < PR_MERGE_HOLD_RECHECK_MS) { results.push({ objectiveId: obj.id, outcome: 'throttled' }); continue }
      lastChecked.set(obj.id, now)
      const live = await livePrState(opts.gh, pr.repo, pr.number)
      if (!live) { results.push({ objectiveId: obj.id, outcome: 'unknown' }); continue }
      state = live.state
      // Keep the board's PR record in step with what GitHub just said.
      if (live.state === 'merged' || live.state === 'closed') {
        recordPRTerminalState({ repo: pr.repo, prNumber: pr.number, state: live.state, mergedAt: live.mergedAt })
      }
    }

    if (state === 'open') { results.push({ objectiveId: obj.id, outcome: 'still_open' }); continue }
    if (state === 'closed') { results.push({ objectiveId: obj.id, outcome: 'closed_unmerged' }); continue }

    const write = runMachineStatusUpdate(
      db,
      "UPDATE objectives SET status = 'done', updated_at = datetime('now') WHERE id = ? AND status = 'review'",
      obj.id,
    )
    if (write.changes === 0) { results.push({ objectiveId: obj.id, outcome: 'skipped' }); continue }
    lastChecked.delete(obj.id)
    logObjectiveAudit(db, {
      objectiveId: obj.id,
      eventType: 'status_change',
      fromStatus: 'review',
      toStatus: 'done',
      actor: 'state-poller',
      pathway: 'pr-merge-hold-release',
      sessionId: obj.ai_review_session_id ?? null,
      titleSnapshot: obj.title,
      workspace: obj.workspace,
    })
    try {
      db.prepare(
        `INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata)
         VALUES (?, ?, ?, ?, 'milestone', ?, ?, ?)`,
      ).run(
        obj.project || 'unknown',
        resolveWriteWorkspace(obj.workspace),
        obj.id,
        obj.ai_review_session_id ?? null,
        PR_MERGE_RELEASE_TITLE,
        `PR #${pr.number}${pr.repo ? ` on ${pr.repo}` : ''} merged: the passed card is done.`,
        JSON.stringify({ kind: PR_MERGE_RELEASE_TITLE, repo: pr.repo, pr_number: pr.number }),
      )
    } catch { /* the audit row above is the record that matters */ }
    console.log(`[pr-merge-hold] #${obj.id}: PR #${pr.number} merged → done`)
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(obj.id) as Objective | undefined
    if (updated) opts.onUpdated?.(updated)
    results.push({ objectiveId: obj.id, outcome: 'done' })
  }
  return results
}

let lastSweepAt = 0

/** Poller wiring, throttled to {@link PR_MERGE_HOLD_SWEEP_INTERVAL_MS}. */
export async function sweepMergedPrHolds(
  db: Database,
  opts: { gh: GhExec; onUpdated?: (row: Objective) => void },
): Promise<ReleaseResult[]> {
  const now = Date.now()
  if (now - lastSweepAt < PR_MERGE_HOLD_SWEEP_INTERVAL_MS) return []
  lastSweepAt = now
  return releaseMergedPrHolds(db, { ...opts, now })
}
