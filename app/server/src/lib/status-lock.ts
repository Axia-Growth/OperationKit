import type { Database } from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { scheduleObjectiveWorktreeReap } from '../services/worktree-reaper.js'
import { cleanupOrphanedChildrenOnParentTerminal } from './cleanup-orphaned-children.js'

/**
 * Board broadcast for children retired by the orphan cleanup. Imported lazily:
 * ws/index.ts pulls node-pty and the socket server, which a status write (and
 * its unit tests) must not load eagerly. Best-effort — a failed broadcast only
 * means an open board shows the change on its next refresh.
 */
function lazyBroadcast(msg: { type: 'objective_updated'; payload: Objective }): void {
  void import('../ws/index.js').then(m => m.broadcast(msg)).catch(() => {})
}

/**
 * The one end-of-card reaction every MACHINE close must run (obj 901228): a
 * parent that just landed in done/cancelled retires its never-ran queued
 * children. The PATCH routes call the same helper themselves; this covers the
 * poller (reviewer PASS, worker-end apply, cap-out), hygiene auto-accept /
 * hard-expiry and flow-repair, which closed parents without it and stranded
 * their `[Review]` children in queue. Call ONLY right after a write that
 * really moved the row into a terminal status (changes > 0).
 */
export function onMachineTerminal(db: Database, id: number, status: 'done' | 'cancelled'): void {
  try {
    cleanupOrphanedChildrenOnParentTerminal(db, id, lazyBroadcast, status)
  } catch (err) {
    console.error(`[status-lock] orphan-child cleanup failed for #${id}:`, (err as Error).message)
  }
}

/** Statuses a machine must never overwrite. Human (or explicit reopen) only. */
export const LOCKED_STATUSES = new Set(['done', 'cancelled'])

export function isLockedStatus(status: string | null | undefined): boolean {
  return !!status && LOCKED_STATUSES.has(status)
}

/**
 * Re-read the row. True if it is gone or the human already parked it in
 * done/cancelled — poller/internal must not write status over that.
 */
export function skipMachineStatusWrite(db: Database, id: number): boolean {
  const row = db.prepare('SELECT status FROM objectives WHERE id = ?').get(id) as { status: string } | undefined
  return !row || isLockedStatus(row.status)
}

/**
 * Machine status UPDATE that cannot clobber done/cancelled.
 *
 * `sql` must contain `WHERE id = ?`; `id` is the last bound parameter.
 * Re-reads, then the UPDATE itself requires `status NOT IN ('done','cancelled')`
 * so a human click between SELECT and this write still sticks.
 */
export function runMachineStatusUpdate(
  db: Database,
  sql: string,
  ...params: unknown[]
): { changes: number } {
  const id = Number(params[params.length - 1])
  if (!Number.isFinite(id) || skipMachineStatusWrite(db, id)) {
    if (Number.isFinite(id)) {
      console.log(`[status-lock] skip machine status write for #${id}`)
    }
    return { changes: 0 }
  }
  const guarded = /status NOT IN\s*\(\s*'done'/i.test(sql)
    ? sql
    : sql.replace(/WHERE id = \?/i, "WHERE id = ? AND status NOT IN ('done', 'cancelled')")
  if (guarded === sql && !/status NOT IN\s*\(\s*'done'/i.test(sql)) {
    throw new Error('runMachineStatusUpdate: SQL must include WHERE id = ?')
  }
  const result = db.prepare(guarded).run(...params)
  // Central hook for machine writes INTO done/cancelled (poller worker-end apply,
  // AI-review verdicts, …): reap the card's worktree (obj 718070). Deferred and
  // re-gated inside the reaper, so a false positive here is harmless.
  const terminal = result.changes > 0 ? targetsTerminalStatus(sql, params) : null
  if (terminal) {
    scheduleObjectiveWorktreeReap(id, { db })
    onMachineTerminal(db, id, terminal)
  }
  return result
}

/** Does this status UPDATE set status to done/cancelled (literal or bound)? */
function targetsTerminalStatus(sql: string, params: unknown[]): 'done' | 'cancelled' | null {
  const literal = /SET\s+status\s*=\s*'(done|cancelled)'/i.exec(sql)
  if (literal) return literal[1].toLowerCase() as 'done' | 'cancelled'
  if (!/SET\s+status\s*=\s*\?/i.test(sql)) return null
  // `status = ?` is the first SET placeholder in every caller.
  return params[0] === 'done' || params[0] === 'cancelled' ? params[0] : null
}
