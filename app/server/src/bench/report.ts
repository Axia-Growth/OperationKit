/** Aggregation and the markdown summary table (board vs baseline deltas). */
import type { Arm, ArmDeltas, ArmSummary, BenchResult, RunRecord } from './types.js'

function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d

/** Tasks for which every arm in `arms` has a run. */
export function pairedTaskIds(runs: RunRecord[], arms: readonly Arm[]): string[] {
  const order: string[] = []
  for (const r of runs) if (!order.includes(r.task_id)) order.push(r.task_id)
  return order.filter((id) => arms.every((a) => runs.some((r) => r.task_id === id && r.arm === a)))
}

export function summarizeArm(arm: Arm, runs: RunRecord[]): ArmSummary {
  const mine = runs.filter((r) => r.arm === arm)
  const n = mine.length
  const successes = mine.filter((r) => r.score.success).length
  const cost = mine.reduce((s, r) => s + r.cost_usd, 0)
  const tokens = mine.reduce((s, r) => s + r.tokens.total, 0)
  return {
    arm,
    runs: n,
    successes,
    success_rate: n ? round(successes / n) : 0,
    wall_ms_total: mine.reduce((s, r) => s + r.wall_ms, 0),
    wall_ms_median: median(mine.map((r) => r.wall_ms)),
    tokens_total: tokens,
    tokens_mean: n ? Math.round(tokens / n) : 0,
    cost_usd_total: round(cost),
    cost_usd_mean: n ? round(cost / n) : 0,
    cost_per_success_usd: successes ? round(cost / successes) : null,
    review_iterations_mean: n ? round(mine.reduce((s, r) => s + r.review_iterations, 0) / n, 2) : 0,
    human_interventions_total: mine.reduce((s, r) => s + r.human_interventions, 0),
  }
}

export function computeDeltas(board: ArmSummary, baseline: ArmSummary): ArmDeltas {
  return {
    success_rate_pp: round((board.success_rate - baseline.success_rate) * 100, 2),
    wall_ms_median: board.wall_ms_median - baseline.wall_ms_median,
    tokens_mean: board.tokens_mean - baseline.tokens_mean,
    cost_usd_mean: round(board.cost_usd_mean - baseline.cost_usd_mean),
    cost_ratio: baseline.cost_usd_total > 0 ? round(board.cost_usd_total / baseline.cost_usd_total, 2) : null,
    review_iterations_mean: round(board.review_iterations_mean - baseline.review_iterations_mean, 2),
    human_interventions_total: board.human_interventions_total - baseline.human_interventions_total,
  }
}

/**
 * Summaries are computed over the PAIRED tasks only, so a budget stop or a missing
 * arm can never make one arm look better by being graded on an easier subset.
 */
export function aggregate(runs: RunRecord[], arms: readonly Arm[]): Pick<BenchResult, 'paired_task_ids' | 'summary' | 'deltas'> {
  const paired = pairedTaskIds(runs, arms)
  const pairedRuns = runs.filter((r) => paired.includes(r.task_id))
  const summary: BenchResult['summary'] = {}
  for (const a of arms) summary[a] = summarizeArm(a, pairedRuns)
  const deltas = summary.board && summary.baseline ? computeDeltas(summary.board, summary.baseline) : null
  return { paired_task_ids: paired, summary, deltas }
}

const usd = (n: number | null) => (n === null ? 'n/a' : `$${n.toFixed(4)}`)
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`
const pct = (x: number) => `${(x * 100).toFixed(1)}%`
const signed = (n: number, f: (x: number) => string) => (n > 0 ? `+${f(n)}` : n < 0 ? `-${f(-n)}` : f(0))

export function renderMarkdown(r: BenchResult): string {
  const L: string[] = []
  L.push(`# Board vs single agent: ${r.mode} run`)
  L.push('')
  L.push('| | |')
  L.push('|---|---|')
  L.push(`| Mode | ${r.mode}${r.mode === 'mock' ? ' (replayed transcripts, no model calls)' : ''} |`)
  L.push(`| Task set | ${r.taskset_version} (sha256 \`${r.taskset_hash.slice(0, 12)}\`) |`)
  L.push(`| Seed | ${r.seed} |`)
  L.push(`| Model | ${r.model ?? 'recorded per run'} |`)
  L.push(`| Budget | ${r.budget_usd === null ? 'none (mock)' : `$${r.budget_usd.toFixed(2)}`}, spent $${r.spent_usd.toFixed(4)} |`)
  L.push(`| Task order | ${r.task_order.join(', ')} |`)
  L.push(`| Paired tasks | ${r.paired_task_ids.length} of ${r.task_order.length} |`)
  L.push(`| Harness | ${r.harness_version} |`)
  if (r.stopped) L.push(`| Stopped early | before \`${r.stopped.before_task}\`: ${r.stopped.reason} |`)
  L.push('')
  if (r.mode === 'mock') {
    L.push('> Mock mode replays recorded transcripts. The transcripts shipped for CI are SYNTHETIC test fixtures, so these numbers test the harness; they are not a measurement of the board.')
    L.push('')
  }

  const b = r.summary.board
  const s = r.summary.baseline
  L.push('## Summary')
  L.push('')
  if (b && s && r.deltas) {
    const d = r.deltas
    L.push('| Metric | Board | Baseline | Delta (board - baseline) |')
    L.push('|---|---:|---:|---:|')
    L.push(`| Success | ${b.successes}/${b.runs} (${pct(b.success_rate)}) | ${s.successes}/${s.runs} (${pct(s.success_rate)}) | ${signed(d.success_rate_pp, (x) => x.toFixed(1))} pp |`)
    L.push(`| Median wall time | ${secs(b.wall_ms_median)} | ${secs(s.wall_ms_median)} | ${signed(d.wall_ms_median, secs)} |`)
    L.push(`| Mean tokens | ${b.tokens_mean.toLocaleString('en-US')} | ${s.tokens_mean.toLocaleString('en-US')} | ${signed(d.tokens_mean, (x) => x.toLocaleString('en-US'))} |`)
    L.push(`| Mean cost | ${usd(b.cost_usd_mean)} | ${usd(s.cost_usd_mean)} | ${signed(d.cost_usd_mean, (x) => usd(x))} |`)
    L.push(`| Total cost | ${usd(b.cost_usd_total)} | ${usd(s.cost_usd_total)} | ${d.cost_ratio === null ? 'n/a' : `${d.cost_ratio}x`} |`)
    L.push(`| Cost per success | ${usd(b.cost_per_success_usd)} | ${usd(s.cost_per_success_usd)} | |`)
    L.push(`| Mean review iterations | ${b.review_iterations_mean} | ${s.review_iterations_mean} | ${signed(d.review_iterations_mean, (x) => String(x))} |`)
    L.push(`| Human interventions | ${b.human_interventions_total} | ${s.human_interventions_total} | ${signed(d.human_interventions_total, String)} |`)
  } else {
    L.push('| Arm | Success | Median wall | Mean tokens | Total cost | Review iterations | Human interventions |')
    L.push('|---|---:|---:|---:|---:|---:|---:|')
    for (const x of [b, s].filter(Boolean) as ArmSummary[]) {
      L.push(`| ${x.arm} | ${x.successes}/${x.runs} | ${secs(x.wall_ms_median)} | ${x.tokens_mean.toLocaleString('en-US')} | ${usd(x.cost_usd_total)} | ${x.review_iterations_mean} | ${x.human_interventions_total} |`)
    }
    L.push('')
    L.push('Only one arm ran, so there are no deltas.')
  }
  L.push('')
  L.push('## Per task')
  L.push('')
  L.push('| # | Task | Arm | Result | Checks | Wall | Tokens | Cost | Reviews | Human | Status |')
  L.push('|---:|---|---|---|---:|---:|---:|---:|---:|---:|---|')
  for (const run of [...r.runs].sort((x, y) => x.order_index - y.order_index || x.arm.localeCompare(y.arm))) {
    const sc = run.score
    const result = sc.success ? 'pass' : 'FAIL'
    const checks = `${sc.checks_passed}/${sc.checks_passed + sc.checks_failed}${sc.missing_files.length ? `, missing ${sc.missing_files.join(' ')}` : ''}`
    L.push(`| ${run.order_index + 1} | ${run.task_id} | ${run.arm} | ${result} | ${checks} | ${secs(run.wall_ms)} | ${run.tokens.total.toLocaleString('en-US')} | ${usd(run.cost_usd)} | ${run.review_iterations} | ${run.human_interventions} | ${run.status}${run.error ? `: ${run.error.replace(/\|/g, '/')}` : ''} |`)
  }
  L.push('')
  return L.join('\n')
}
