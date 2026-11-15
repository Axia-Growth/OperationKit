/**
 * Hard run budget for live mode.
 *
 * - Live mode refuses to start without an explicit, positive, finite budget
 *   (`parseBudget` throws; the CLI exits 2 before any model call).
 * - Before each TASK the guard projects what running every arm on it would cost
 *   and refuses when `spent + projection > budget`. The projection for an arm is
 *   the larger of the task's prior estimate (`est_usd`) and the most expensive run
 *   that arm has actually produced so far, so one surprisingly dear run makes the
 *   guard more conservative, never less.
 * - Each run is also handed a hard per-run cap (`perRunCap`) so a single runaway
 *   session is bounded: the baseline passes it to `claude --max-budget-usd`, the
 *   board arm cancels the card when its recorded cost crosses it.
 * - Stopping is task-granular, so every task that ran has a run from every arm
 *   (the paired set the deltas are computed on).
 */
import type { Arm, TaskSpec } from './types.js'

export class BudgetError extends Error {}

/** Parse --budget-usd. Missing, zero, negative or non-numeric is a refusal. */
export function parseBudget(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    throw new BudgetError('live mode needs an explicit --budget-usd <dollars>; refusing to start without one')
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new BudgetError(`--budget-usd must be a positive number of dollars, got ${JSON.stringify(raw)}`)
  return n
}

export type BudgetDecision =
  | { ok: true; projected_usd: number }
  | { ok: false; projected_usd: number; reason: string }

export class BudgetGuard {
  readonly budgetUsd: number
  private spent = 0
  private readonly maxObserved: Partial<Record<Arm, number>> = {}

  constructor(budgetUsd: number) {
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new BudgetError('budget must be a positive number')
    this.budgetUsd = budgetUsd
  }

  get spentUsd(): number {
    return this.spent
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.spent)
  }

  /** Projected cost of one run of `arm` on `task`. */
  project(arm: Arm, task: TaskSpec): number {
    return Math.max(task.est_usd[arm], this.maxObserved[arm] ?? 0)
  }

  /** May the next task (all `arms` on it) start? */
  check(task: TaskSpec, arms: readonly Arm[]): BudgetDecision {
    const projected = arms.reduce((s, a) => s + this.project(a, task), 0)
    if (this.spent + projected > this.budgetUsd) {
      return {
        ok: false,
        projected_usd: projected,
        reason: `projected spend $${(this.spent + projected).toFixed(2)} (spent $${this.spent.toFixed(2)} + next task $${projected.toFixed(2)}) would exceed the $${this.budgetUsd.toFixed(2)} budget`,
      }
    }
    return { ok: true, projected_usd: projected }
  }

  /**
   * Hard cap for one run: whatever is left after reserving the projections of the
   * arms that still have to run on this task.
   */
  perRunCap(task: TaskSpec, remainingArms: readonly Arm[]): number {
    const reserve = remainingArms.slice(1).reduce((s, a) => s + this.project(a, task), 0)
    return Math.max(0, this.budgetUsd - this.spent - reserve)
  }

  record(arm: Arm, costUsd: number): void {
    const c = Number.isFinite(costUsd) && costUsd > 0 ? costUsd : 0
    this.spent += c
    this.maxObserved[arm] = Math.max(this.maxObserved[arm] ?? 0, c)
  }

  /** True once actual spend has reached the budget (a run overshot its cap). */
  get exhausted(): boolean {
    return this.spent >= this.budgetUsd
  }
}
