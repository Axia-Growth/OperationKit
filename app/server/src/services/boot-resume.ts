/**
 * Boot resume (obj 901459) — after a restart, give a card the restart cut off the
 * same ONE automatic resume the live poller would have given it.
 *
 * The live loop (poller-loop.ts, dead-session path) resumes a dead `working`
 * card when (a) messages were queued for it mid-turn, (b) the owner's last
 * message never got a reply, or (c) the process died mid-turn (abnormal-end
 * retry). The boot sweep (`sweepStaleWorkingSessions`) skipped all three, so a
 * card that was mid-run when the app restarted landed in `review` and waited for
 * a person to nudge it.
 *
 * Storm guards — a restart loop must never become a resume loop:
 *   1. Per card, per episode: every boot resume spends the stall watchdog's
 *      durable once-only budget (`objectives.stall_restarts`, claimed with the
 *      same compare-and-set). The start is attributed `boot_resume`, which is in
 *      `AUTO_RETRY_START_REASONS`, so it does NOT re-arm the budget. A card killed
 *      by a second restart therefore finds the budget spent: a mid-turn death is
 *      flagged (needs_agent kind=stalled + alert, parked blocked) by the
 *      abnormal-end path, anything else falls through to the normal review
 *      routing. `stall_watchdog_enabled='0'` / `stall_watchdog_max_restarts=0`
 *      turn boot resumes off with the rest.
 *   2. Per boot: at most `boot_resume_max_per_boot` cards are resumed (env
 *      `CC_BOOT_RESUME_MAX` wins; default 5; 0 = off). The rest are parked as
 *      before, so a crash with many live cards does not stampede the account pool.
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { resolveStallConfig } from './stall-watchdog.js'

export const BOOT_RESUME_START_REASON = 'boot_resume'
export const DEFAULT_BOOT_RESUME_MAX = 5

export type BootResumeOutcome =
  | 'queued'        // resumed with messages queued mid-turn
  | 'unanswered'    // resumed by re-sending the owner's unanswered message(s)
  | 'abnormal_end'  // resumed by the abnormal-end retry (mid-turn death)
  | 'capped'        // per-boot cap reached; not resumed
  | 'none'          // nothing to resume (or the per-card budget is spent)

export interface BootResumeBudget {
  max: number
  used: number
}

export interface BootResumeDeps {
  db: Database.Database
  /** Any messages queued for this card while its worker was mid-turn. */
  hasQueued: (objective: Objective) => boolean
  /** Resume the session with the queued messages. True when it went out. */
  deliverQueued: (objective: Objective) => boolean
  /** Any owner messages in the transcript with no reply after them. */
  hasUnanswered: (objective: Objective) => boolean
  /** Re-send them. True when it went out. */
  resendUnanswered: (objective: Objective) => boolean
  /** The live loop's abnormal-end handler (claims the shared budget itself). */
  abnormalEnd: (objective: Objective) => boolean
  log?: (msg: string) => void
}

function readSetting(db: Database.Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  } catch {
    return undefined
  }
}

/** Per-boot cap. Read once per sweep. Negative / junk values fall back to the default. */
export function resolveBootResumeMax(db: Database.Database, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CC_BOOT_RESUME_MAX ?? readSetting(db, 'boot_resume_max_per_boot')
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_BOOT_RESUME_MAX
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return DEFAULT_BOOT_RESUME_MAX
  return Math.floor(n)
}

export function newBootResumeBudget(db: Database.Database, env: NodeJS.ProcessEnv = process.env): BootResumeBudget {
  return { max: resolveBootResumeMax(db, env), used: 0 }
}

/** Same compare-and-set the stall watchdog and abnormal-end retry use. */
function claimEpisodeBudget(db: Database.Database, objectiveId: number): boolean {
  const cfg = resolveStallConfig(db)
  if (!cfg.enabled) return false
  const row = db.prepare('SELECT status, stall_restarts FROM objectives WHERE id = ?').get(objectiveId) as
    { status: string; stall_restarts: number | null } | undefined
  if (!row || row.status !== 'working') return false
  const spent = Number(row.stall_restarts) || 0
  if (spent >= cfg.maxAutoRestarts) return false
  const claim = db.prepare(
    "UPDATE objectives SET stall_restarts = COALESCE(stall_restarts, 0) + 1 WHERE id = ? AND status = 'working' AND COALESCE(stall_restarts, 0) = ?",
  ).run(objectiveId, spent)
  return claim.changes === 1
}

function logActivity(db: Database.Database, o: Objective, outcome: BootResumeOutcome): void {
  try {
    db.prepare(
      "INSERT INTO activity_log (project, workspace, objective_id, session_id, event_type, title, detail, metadata) VALUES (?, ?, ?, ?, 'milestone', 'boot_resume', ?, ?)",
    ).run(
      o.project || 'unknown', o.workspace, o.id, o.session_id,
      `Restart cut this card off; resumed it once automatically (${outcome}).`,
      JSON.stringify({ kind: 'boot_resume', outcome }),
    )
  } catch { /* telemetry never blocks */ }
}

/**
 * Called by the boot sweep for a `working` card whose session is dead, AFTER
 * `handleSessionDeath` and BEFORE the no-output classifier / review routing.
 * Returns the outcome; only `queued` / `unanswered` / `abnormal_end` mean the
 * card was resumed and the caller must leave it alone.
 */
export function bootResumeInterrupted(objective: Objective, budget: BootResumeBudget, deps: BootResumeDeps): BootResumeOutcome {
  const log = deps.log ?? ((m: string) => console.warn(m))
  if (!objective.session_id || objective.delegate_mode || objective.status !== 'working') return 'none'
  if (budget.used >= budget.max) {
    log(`[boot-resume] #${objective.id}: per-boot cap (${budget.max}) reached — parking it as before`)
    return 'capped'
  }

  let wantsQueued = false
  let wantsUnanswered = false
  try { wantsQueued = deps.hasQueued(objective) } catch { /* treat as none */ }
  if (!wantsQueued) {
    try { wantsUnanswered = deps.hasUnanswered(objective) } catch { /* treat as none */ }
  }

  if ((wantsQueued || wantsUnanswered) && claimEpisodeBudget(deps.db, objective.id)) {
    const outcome: BootResumeOutcome = wantsQueued ? 'queued' : 'unanswered'
    let sent = false
    try {
      sent = wantsQueued ? deps.deliverQueued(objective) : deps.resendUnanswered(objective)
    } catch (err) {
      log(`[boot-resume] #${objective.id}: ${outcome} resend failed: ${(err as Error)?.message ?? err}`)
    }
    if (sent) {
      budget.used++
      logActivity(deps.db, objective, outcome)
      log(`[boot-resume] #${objective.id}: restart cut it off — resumed once (${outcome})`)
      return outcome
    }
    // The budget stays spent (claimed before the side effect, like the
    // abnormal-end retry), so a broken resend cannot loop across restarts.
    return 'none'
  }

  // A mid-turn death: the abnormal-end retry (or, with the budget spent, its
  // flag + blocked park — the "second restart" case).
  let resumed = false
  try { resumed = deps.abnormalEnd(objective) } catch { resumed = false }
  if (resumed) {
    budget.used++
    logActivity(deps.db, objective, 'abnormal_end')
    log(`[boot-resume] #${objective.id}: restart cut it off mid-turn — resumed once (abnormal_end)`)
    return 'abnormal_end'
  }
  return 'none'
}
