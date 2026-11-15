/**
 * Runs the selected arms over the selected tasks in a seeded order, scores every
 * run with the same hidden checks, enforces the budget in live mode, and returns a
 * `cc-bench-result/1` document.
 */
import fs from 'node:fs'
import path from 'node:path'
import { failedOutcome, type ArmRunner } from './arms/common.js'
import { BudgetGuard } from './budget.js'
import { aggregate, renderMarkdown } from './report.js'
import { prepareWorkdir, scoreWorkdir } from './scoring.js'
import { armOrder, seededShuffle } from './tasks.js'
import { writeTranscript } from './transcript.js'
import type { Arm, BenchMode, BenchResult, RunRecord, TaskSet, TaskSpec } from './types.js'

export const HARNESS_VERSION = 'cc-bench/1.0.0'
/** Below one cent there is nothing a session can do; stop instead of starting it. */
const MIN_RUN_CAP_USD = 0.01

export interface RunBenchOptions {
  mode: BenchMode
  taskSet: TaskSet
  tasks: TaskSpec[]
  runners: ArmRunner[]
  seed: number
  model: string | null
  /** Required in live mode (the CLI refuses without it). */
  budget: BudgetGuard | null
  runId?: string
  /** Save each live run as a replayable transcript under this directory. */
  recordDir?: string
  keepWorkdirs?: boolean
  workParent?: string
  now?: () => Date
  log?: (line: string) => void
}

export async function runBench(o: RunBenchOptions): Promise<BenchResult> {
  if (o.mode === 'live' && !o.budget) throw new Error('live mode requires a budget')
  const now = o.now ?? (() => new Date())
  const log = o.log ?? (() => {})
  const arms = o.runners.map((r) => r.arm)
  if (new Set(arms).size !== arms.length) throw new Error('each arm may appear once')
  const byArm = new Map(o.runners.map((r) => [r.arm, r]))
  const runId = o.runId ?? `${o.mode}-${o.seed}`
  const ordered = seededShuffle(o.tasks, o.seed)
  const started = now().toISOString()
  const runs: RunRecord[] = []
  let stopped: BenchResult['stopped'] = null

  tasks: for (const [i, task] of ordered.entries()) {
    if (o.budget) {
      const d = o.budget.check(task, arms)
      if (!d.ok || o.budget.exhausted) {
        stopped = { reason: d.ok ? 'budget exhausted' : d.reason, before_task: task.id, projected_usd: d.projected_usd }
        log(`STOP before ${task.id}: ${stopped.reason}`)
        break
      }
    }
    const order = armOrder(arms, o.seed, i)
    for (const [j, arm] of order.entries()) {
      const capUsd = o.budget ? o.budget.perRunCap(task, order.slice(j)) : null
      if (capUsd !== null && capUsd < MIN_RUN_CAP_USD) {
        // An earlier arm on this task overspent its projection: nothing is left for this one.
        stopped = { reason: `no budget left for ${arm} (cap ${capUsd.toFixed(4)})`, before_task: `${task.id}/${arm}`, projected_usd: o.budget!.project(arm, task) }
        log(`STOP before ${task.id}/${arm}: ${stopped.reason}`)
        break tasks
      }
      const workdir = prepareWorkdir(task, o.workParent)
      log(`[${i + 1}/${ordered.length}] ${task.id} / ${arm}${capUsd !== null ? ` (cap $${capUsd.toFixed(2)})` : ''}`)
      try {
        let result: Awaited<ReturnType<ArmRunner['run']>>
        try {
          result = await byArm.get(arm as Arm)!.run({ task, workdir, runId, seed: o.seed, model: o.model, capUsd })
        } catch (e) {
          // One broken run (a missing transcript, an unreadable file) must not throw
          // away the runs already made. Record it and carry on.
          result = { outcome: failedOutcome(`arm crashed: ${(e as Error).message}`, 0, o.model, { ...(o.mode === 'live' ? { cost_unknown: true } : {}) }) }
        }
        const { outcome, transcript } = result
        o.budget?.record(arm, outcome.cost_unknown && capUsd !== null ? Math.max(outcome.cost_usd, capUsd) : outcome.cost_usd)
        const score = scoreWorkdir(task, workdir)
        if (o.recordDir && transcript) outcome.notes.push(`recorded ${path.relative(process.cwd(), writeTranscript(o.recordDir, transcript))}`)
        runs.push({ ...outcome, task_id: task.id, arm, order_index: i, score })
        log(`    -> ${score.success ? 'pass' : 'FAIL'} ${score.checks_passed}/${score.checks_passed + score.checks_failed} checks, $${outcome.cost_usd.toFixed(4)}, ${(outcome.wall_ms / 1000).toFixed(1)}s, ${outcome.review_iterations} reviews`)
      } finally {
        if (!o.keepWorkdirs) fs.rmSync(workdir, { recursive: true, force: true })
      }
      const fatal = runs[runs.length - 1]?.fatal
      if (fatal) {
        const next = order[j + 1] ? `${task.id}/${order[j + 1]}` : ordered[i + 1]?.id
        if (next) stopped = { reason: `environment: ${fatal}`, before_task: next, projected_usd: 0 }
        log(`STOP: ${fatal}`)
        break tasks
      }
    }
  }

  const agg = aggregate(runs, arms)
  return {
    schema: 'cc-bench-result/1',
    harness_version: HARNESS_VERSION,
    mode: o.mode,
    taskset_version: o.taskSet.version,
    taskset_hash: o.taskSet.hash,
    seed: o.seed,
    model: o.model,
    budget_usd: o.budget?.budgetUsd ?? null,
    arms,
    task_order: ordered.map((t) => t.id),
    started_at: started,
    finished_at: now().toISOString(),
    runs,
    ...agg,
    spent_usd: Math.round((o.budget ? o.budget.spentUsd : runs.reduce((s, r) => s + r.cost_usd, 0)) * 1e6) / 1e6,
    stopped,
  }
}

export function writeResults(outDir: string, result: BenchResult): { json: string; md: string } {
  fs.mkdirSync(outDir, { recursive: true })
  const json = path.join(outDir, 'results.json')
  const md = path.join(outDir, 'summary.md')
  fs.writeFileSync(json, JSON.stringify(result, null, 2) + '\n')
  fs.writeFileSync(md, renderMarkdown(result))
  return { json, md }
}
