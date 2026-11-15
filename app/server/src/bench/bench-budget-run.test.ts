/**
 * Budget enforcement + the end-to-end mock run (obj 900908).
 *   - live mode refuses to start without an explicit budget (and without --model);
 *   - the guard stops BEFORE a task whose projected spend would cross the budget;
 *   - the shipped mock mode runs both arms on the same seeded order and emits
 *     results.json + summary.md with zero model calls.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ArmRunner } from './arms/common.js'
import { BudgetError, BudgetGuard, parseBudget } from './budget.js'
import { buildRunners, main, parseArgs, resolveRunConfig, UsageError } from './cli.js'
import { runBench, writeResults } from './runner.js'
import { loadTaskSet, selectTasks } from './tasks.js'
import type { Arm, ArmOutcome, TaskSpec } from './types.js'

const set = loadTaskSet()
const task = (id: string) => set.tasks.find((t) => t.id === id)!
const tmp: string[] = []
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** A fake live arm: costs a fixed amount, solves the task from its reference solution. */
function fakeArm(arm: Arm, costUsd: number, calls: string[]): ArmRunner {
  return {
    arm,
    async run(ctx) {
      calls.push(`${ctx.task.id}/${arm}/cap=${ctx.capUsd?.toFixed(2)}`)
      fs.cpSync(path.join(ctx.task.dir, 'solution'), ctx.workdir, { recursive: true })
      const outcome: ArmOutcome = {
        status: 'completed',
        tokens: { input: 1, output: 1, cache_read: 0, cache_creation: 0, total: 2 },
        cost_usd: costUsd,
        wall_ms: 1000,
        review_iterations: arm === 'board' ? 1 : 0,
        human_interventions: 0,
        model: 'm',
        notes: [],
      }
      return { outcome }
    },
  }
}

describe('parseBudget', () => {
  it.each([undefined, '', '0', '-1', 'abc', 'NaN', 'Infinity'])('refuses %j', (raw) => {
    expect(() => parseBudget(raw)).toThrow(BudgetError)
  })
  it('accepts a positive dollar amount', () => {
    expect(parseBudget('4.5')).toBe(4.5)
  })
})

describe('BudgetGuard', () => {
  const t = { est_usd: { board: 1.5, baseline: 0.2 } } as TaskSpec

  it('projects from the prior estimate, then from the most expensive observed run', () => {
    const g = new BudgetGuard(10)
    expect(g.project('board', t)).toBe(1.5)
    g.record('board', 3)
    g.record('board', 0.5)
    expect(g.project('board', t)).toBe(3)
    expect(g.spentUsd).toBe(3.5)
  })

  it('refuses a task whose projected spend would exceed the budget', () => {
    const g = new BudgetGuard(2)
    expect(g.check(t, ['board', 'baseline'])).toMatchObject({ ok: true, projected_usd: 1.7 })
    g.record('baseline', 0.5)
    const d = g.check(t, ['board', 'baseline'])
    expect(d.ok).toBe(false)
    expect(!d.ok && d.reason).toMatch(/would exceed the \$2\.00 budget/)
  })

  it('caps each run at what is left after reserving the arms still to run', () => {
    const g = new BudgetGuard(5)
    g.record('baseline', 1)
    expect(g.perRunCap(t, ['baseline', 'board'])).toBeCloseTo(2.5)
    expect(g.perRunCap(t, ['board'])).toBeCloseTo(4)
  })

  it('ignores negative / non-finite costs and refuses a non-positive budget', () => {
    const g = new BudgetGuard(1)
    g.record('board', Number.NaN)
    g.record('board', -5)
    expect(g.spentUsd).toBe(0)
    expect(() => new BudgetGuard(0)).toThrow(BudgetError)
  })
})

describe('runBench budget stop (live mode)', () => {
  it('refuses to run live without a budget', async () => {
    await expect(runBench({ mode: 'live', taskSet: set, tasks: set.tasks, runners: [], seed: 1, model: 'm', budget: null })).rejects.toThrow(/requires a budget/)
  })

  it('stops before the task that would cross the budget, keeping every run paired', async () => {
    const calls: string[] = []
    // est board 1.5 + baseline 0.15..0.25 per task; actual cost 1.0 + 0.1.
    const result = await runBench({
      mode: 'live',
      taskSet: set,
      tasks: set.tasks,
      runners: [fakeArm('board', 1.0, calls), fakeArm('baseline', 0.1, calls)],
      seed: 7,
      model: 'm',
      budget: new BudgetGuard(4),
      workParent: os.tmpdir(),
    })
    expect(result.stopped).not.toBeNull()
    expect(result.stopped!.reason).toMatch(/would exceed/)
    // spent never exceeds the budget, and every task that ran has both arms.
    expect(result.spent_usd).toBeLessThanOrEqual(4)
    expect(result.runs.length % 2).toBe(0)
    expect(result.paired_task_ids.length).toBe(result.runs.length / 2)
    expect(result.paired_task_ids.length).toBeGreaterThan(0)
    expect(result.paired_task_ids.length).toBeLessThan(set.tasks.length)
    expect(result.stopped!.before_task).toBe(result.task_order[result.paired_task_ids.length])
    // every run got a finite per-run cap
    for (const c of calls) expect(c).toMatch(/cap=\d+\.\d\d$/)
  })

  it('stops once actual spend overshoots, even when estimates are tiny', async () => {
    const cheap = { ...set, tasks: set.tasks.map((t) => ({ ...t, est_usd: { board: 0.01, baseline: 0.01 } })) }
    const result = await runBench({
      mode: 'live',
      taskSet: cheap,
      tasks: cheap.tasks,
      runners: [fakeArm('baseline', 2.5, [])],
      seed: 1,
      model: 'm',
      budget: new BudgetGuard(2),
    })
    // First run overshoots ($2.50 > $2); the projection then uses the observed $2.50 and stops.
    expect(result.runs).toHaveLength(1)
    expect(result.stopped).not.toBeNull()
  })
})

describe('runner resilience', () => {
  it('records a crashing arm as an error run and keeps going (mock mode)', async () => {
    const boom: ArmRunner = { arm: 'board', async run() { throw new Error('boom') } }
    const result = await runBench({ mode: 'mock', taskSet: set, tasks: selectTasks(set, 't01-sum-range,t02-slugify'), runners: [boom, fakeArm('baseline', 0.1, [])], seed: 1, model: null, budget: null })
    expect(result.runs).toHaveLength(4)
    const crashed = result.runs.filter((r) => r.arm === 'board')
    expect(crashed.every((r) => r.status === 'error' && /arm crashed: boom/.test(r.error!) && !r.score.success)).toBe(true)
    expect(result.runs.filter((r) => r.arm === 'baseline').every((r) => r.score.success)).toBe(true)
  })

  it('in live mode a crashed run is charged its whole cap, and the guard then stops', async () => {
    const boom: ArmRunner = { arm: 'board', async run() { throw new Error('boom') } }
    const result = await runBench({ mode: 'live', taskSet: set, tasks: selectTasks(set, 't01-sum-range,t02-slugify'), runners: [boom, fakeArm('baseline', 0.1, [])], seed: 1, model: 'm', budget: new BudgetGuard(10) })
    const crashed = result.runs.find((r) => r.arm === 'board')!
    expect(crashed).toMatchObject({ status: 'error', cost_unknown: true })
    expect(result.spent_usd).toBeGreaterThan(9)
    expect(result.spent_usd).toBeLessThanOrEqual(10)
    expect(result.stopped).not.toBeNull()
  })

  it('stops instead of starting an arm with less than a cent left', async () => {
    const tiny = { ...set, tasks: set.tasks.map((t) => ({ ...t, est_usd: { board: 0.5, baseline: 0.5 } })) }
    const result = await runBench({ mode: 'live', taskSet: tiny, tasks: selectTasks(tiny, 't01-sum-range'), runners: [fakeArm('board', 1.995, []), fakeArm('baseline', 0.1, [])], seed: 2, model: 'm', budget: new BudgetGuard(2) })
    // Whichever arm ran first, the run never starts an arm with no money left.
    expect(result.spent_usd).toBeLessThanOrEqual(2.0951)
    if (result.runs[0].arm === 'board') {
      expect(result.runs).toHaveLength(1)
      expect(result.stopped?.reason).toMatch(/no budget left for baseline/)
      expect(result.paired_task_ids).toEqual([])
    }
  })
})

describe('CLI refusals happen before any spend', () => {
  const flags = (s: string) => parseArgs(['run', ...s.split(' ').filter(Boolean)]).flags

  it('live without --budget-usd is refused', () => {
    expect(() => resolveRunConfig(flags('--mode live --model m --arms baseline'))).toThrow(BudgetError)
  })
  it('live without --model is refused', () => {
    expect(() => resolveRunConfig(flags('--mode live --budget-usd 1 --arms baseline'))).toThrow(UsageError)
  })
  it('the live board arm needs workspace, project, a bench repo and an API key', () => {
    expect(() => resolveRunConfig(flags('--mode live --budget-usd 1 --model m'), {})).toThrow(/--workspace, --project, --bench-repo, env BENCH_BOARD_API_KEY/)
  })
  it('the live board arm refuses a repo that is not a bench fixture repo', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'not-bench-'))
    tmp.push(d)
    expect(() => resolveRunConfig(flags(`--mode live --budget-usd 1 --model m --workspace w --project p --bench-repo ${d}`), { BENCH_BOARD_API_KEY: 'x' })).toThrow(/not a bench fixture repo/)
  })
  it('keeps "=" inside inline values and rejects non-numeric poll/timeout values', () => {
    expect(parseArgs(['run', '--run-id=a=b']).flags.get('run-id')).toBe('a=b')
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-repo-'))
    tmp.push(d)
    fs.writeFileSync(path.join(d, '.cc-bench-repo'), 'v1\n')
    const base = `--mode live --budget-usd 1 --model m --workspace w --project p --bench-repo ${d}`
    expect(() => resolveRunConfig(flags(`${base} --timeout-min 90m`), { BENCH_BOARD_API_KEY: 'x' })).toThrow(/--timeout-min must be a positive number/)
    expect(() => resolveRunConfig(flags(`${base} --poll-ms 0`), { BENCH_BOARD_API_KEY: 'x' })).toThrow(/--poll-ms must be a positive number/)
    expect(resolveRunConfig(flags(`${base} --poll-ms 5000 --timeout-min 30`), { BENCH_BOARD_API_KEY: 'x' }).board).toMatchObject({ pollMs: 5000, timeoutMs: 1_800_000 })
  })

  it('unknown flags are refused', () => {
    expect(() => resolveRunConfig(flags('--mode mock --bugdet-usd 3'))).toThrow(/unknown flag --bugdet-usd/)
  })
  it('defaults: live runs the smoke subset, mock runs everything', () => {
    expect(resolveRunConfig(flags('--mode live --budget-usd 1 --model m --arms baseline')).tasksSelector).toBe('smoke')
    expect(resolveRunConfig(flags('--mode mock')).tasksSelector).toBe('all')
  })

  it('main() exits 2 and starts no arm when live mode has no budget', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const code = await main(['run', '--mode', 'live', '--model', 'm', '--arms', 'baseline', '--claude-bin', '/nonexistent/claude'])
    expect(code).toBe(2)
    expect(err.mock.calls.flat().join('\n')).toMatch(/refused: live mode needs an explicit --budget-usd/)
  })
})

describe('mock mode end to end (the CI path: no model calls)', () => {
  it('runs both arms on the same seeded task order and writes results JSON + summary table', async () => {
    const cfg = resolveRunConfig(parseArgs(['run', '--mode', 'mock']).flags)
    const result = await runBench({ mode: 'mock', taskSet: set, tasks: selectTasks(set, cfg.tasksSelector), runners: buildRunners(cfg), seed: cfg.seed, model: null, budget: null })

    expect(result.arms).toEqual(['board', 'baseline'])
    expect(result.task_order).toHaveLength(set.tasks.length)
    expect(result.paired_task_ids).toHaveLength(set.tasks.length)
    for (const id of result.task_order) {
      const pair = result.runs.filter((r) => r.task_id === id)
      expect(pair.map((r) => r.arm).sort()).toEqual(['baseline', 'board'])
      expect(new Set(pair.map((r) => r.order_index)).size).toBe(1)
    }
    // Outcomes designed into the synthetic transcripts (see synthetic.ts).
    const outcome = (id: string, arm: Arm) => result.runs.find((r) => r.task_id === id && r.arm === arm)!
    expect(outcome('t06-csv-quotes', 'baseline').score.success).toBe(false)
    expect(outcome('t06-csv-quotes', 'board').score.success).toBe(true)
    expect(outcome('t06-csv-quotes', 'board').review_iterations).toBe(2)
    expect(outcome('t07-semver-compare', 'board').score.success).toBe(false) // reviewer passed it; checks did not
    expect(outcome('t03-parse-duration', 'board').human_interventions).toBe(1)
    expect(result.summary.board).toMatchObject({ runs: 12, successes: 11, human_interventions_total: 1 })
    expect(result.summary.baseline).toMatchObject({ runs: 12, successes: 10, review_iterations_mean: 0 })
    expect(result.deltas!.success_rate_pp).toBeCloseTo(8.33, 1)
    expect(result.deltas!.cost_ratio).toBeGreaterThan(1)

    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-out-'))
    tmp.push(out)
    const files = writeResults(out, result)
    const json = JSON.parse(fs.readFileSync(files.json, 'utf8'))
    expect(json.schema).toBe('cc-bench-result/1')
    expect(json.taskset_hash).toBe(set.hash)
    const md = fs.readFileSync(files.md, 'utf8')
    expect(md).toContain('| Metric | Board | Baseline | Delta (board - baseline) |')
    expect(md).toContain('| Success | 11/12 (91.7%) | 10/12 (83.3%) | +8.3 pp |')
    expect(md).toMatch(/SYNTHETIC/)
  })

  it('is reproducible: same seed, same task order and the same numbers', async () => {
    const run = async () => {
      const cfg = resolveRunConfig(parseArgs(['run', '--mode', 'mock', '--tasks', 'smoke', '--seed', '42']).flags)
      const r = await runBench({ mode: 'mock', taskSet: set, tasks: selectTasks(set, cfg.tasksSelector), runners: buildRunners(cfg), seed: 42, model: null, budget: null })
      return { order: r.task_order, runs: r.runs.map((x) => [x.task_id, x.arm, x.score.success, x.cost_usd, x.wall_ms, x.tokens.total]) }
    }
    expect(await run()).toEqual(await run())
  })

  it('a mock budget applies the same stop rule to recorded costs', async () => {
    const cfg = resolveRunConfig(parseArgs(['run', '--mode', 'mock', '--budget-usd', '3']).flags)
    const r = await runBench({ mode: 'mock', taskSet: set, tasks: set.tasks, runners: buildRunners(cfg), seed: cfg.seed, model: null, budget: new BudgetGuard(cfg.budgetUsd!) })
    expect(r.stopped).not.toBeNull()
    expect(r.spent_usd).toBeLessThanOrEqual(3)
    expect(r.runs.length).toBeLessThan(24)
  })

  it('main() runs mock mode and writes both files', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-main-'))
    tmp.push(out)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await main(['run', '--mode', 'mock', '--tasks', 'smoke', '--out', out])).toBe(0)
    expect(fs.existsSync(path.join(out, 'results.json'))).toBe(true)
    expect(fs.existsSync(path.join(out, 'summary.md'))).toBe(true)
    expect(log.mock.calls.flat().join('\n')).toContain('Board vs single agent: mock run')
  })
})

// Keep the smoke subset cheap: a live smoke run must fit comfortably in a few dollars.
it('smoke subset projected cost (both arms) stays under $5', () => {
  const g = new BudgetGuard(100)
  const total = set.smoke.reduce((s, id) => s + g.project('board', task(id)) + g.project('baseline', task(id)), 0)
  expect(total).toBeLessThan(5)
})
