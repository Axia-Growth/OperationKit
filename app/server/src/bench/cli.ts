/**
 * Board-vs-single-agent benchmark CLI (audit #19, obj 900908). Run from app/server:
 *
 *   npx tsx src/bench/cli.ts run --mode mock                       # CI-safe: replays transcripts, no model calls
 *   npx tsx src/bench/cli.ts run --mode live --budget-usd 3 --model <id> --arms baseline
 *   npx tsx src/bench/cli.ts run --mode live --budget-usd 10 --model <id> \
 *       --workspace <ws> --project cc-bench-fixture --bench-repo /path/to/cc-bench-fixture
 *   npx tsx src/bench/cli.ts board-setup --bench-repo /path/to/cc-bench-fixture
 *
 * Full reference: docs/bench/README.md.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { baselineArm } from './arms/baseline.js'
import { boardArm } from './arms/board.js'
import type { ArmRunner } from './arms/common.js'
import { replayArm } from './arms/replay.js'
import { BudgetError, BudgetGuard, parseBudget } from './budget.js'
import { renderMarkdown } from './report.js'
import { runBench, writeResults } from './runner.js'
import { writeSyntheticTranscripts } from './synthetic.js'
import { DEFAULT_TASKSET_ROOT, DEFAULT_TASKSET_VERSION, loadTaskSet, selectTasks } from './tasks.js'
import { ARMS, type Arm, type BenchMode } from './types.js'

export const DEFAULT_SEED = 19
export const DEFAULT_TRANSCRIPTS = path.join(DEFAULT_TASKSET_ROOT, 'transcripts', DEFAULT_TASKSET_VERSION)

export class UsageError extends Error {}

export interface ParsedArgs {
  command: string
  flags: Map<string, string | true>
}

const BOOLEAN_FLAGS = new Set(['keep-workdirs', 'register', 'help'])

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv
  const flags = new Map<string, string | true>()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`)
    const eq = a.indexOf('=')
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq)
    const inline = eq < 0 ? undefined : a.slice(eq + 1)
    if (BOOLEAN_FLAGS.has(k)) { flags.set(k, true); continue }
    const v = inline ?? rest[++i]
    if (v === undefined || v.startsWith('--')) throw new UsageError(`--${k} needs a value`)
    flags.set(k, v)
  }
  return { command, flags }
}

const str = (f: ParsedArgs['flags'], k: string): string | undefined => {
  const v = f.get(k)
  return typeof v === 'string' ? v : undefined
}

/** A positive finite number flag, or undefined when absent. "90m" or "15s" is a usage error. */
function positive(f: ParsedArgs['flags'], k: string): number | undefined {
  const raw = str(f, k)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${k} must be a positive number, got ${JSON.stringify(raw)}`)
  return n
}

const RUN_FLAGS = new Set([
  'mode', 'tasks', 'arms', 'seed', 'model', 'budget-usd', 'taskset', 'transcripts', 'out', 'record',
  'keep-workdirs', 'board-url', 'workspace', 'project', 'bench-repo', 'poll-ms', 'timeout-min', 'claude-bin', 'run-id', 'setting-sources',
])

export interface RunConfig {
  mode: BenchMode
  tasksSelector: string
  arms: Arm[]
  seed: number
  model: string | null
  budgetUsd: number | null
  tasksetDir: string
  transcriptsDir: string
  outDir: string
  recordDir?: string
  keepWorkdirs: boolean
  runId: string
  board?: { baseUrl: string; apiKey: string; workspace: string; project: string; benchRepo: string; pollMs?: number; timeoutMs?: number }
  claudeBin?: string
  settingSources?: string
  /** Per-run wall-clock limit for either arm (arm defaults apply when absent). */
  timeoutMs?: number
}

/**
 * Validate everything BEFORE any spend. Live mode without --budget-usd, without an
 * explicit --model, or with an unconfigured board arm is refused here.
 */
export function resolveRunConfig(f: ParsedArgs['flags'], env: NodeJS.ProcessEnv = process.env, today = new Date()): RunConfig {
  for (const k of f.keys()) if (!RUN_FLAGS.has(k)) throw new UsageError(`unknown flag --${k}`)
  const mode = (str(f, 'mode') ?? 'mock') as BenchMode
  if (mode !== 'mock' && mode !== 'live') throw new UsageError('--mode must be mock or live')
  const arms = (str(f, 'arms') ?? ARMS.join(',')).split(',').map((s) => s.trim()) as Arm[]
  for (const a of arms) if (!ARMS.includes(a)) throw new UsageError(`unknown arm ${a} (board, baseline)`)
  const seed = Number(str(f, 'seed') ?? DEFAULT_SEED)
  if (!Number.isInteger(seed) || seed < 0) throw new UsageError('--seed must be a non-negative integer')

  let budgetUsd: number | null = null
  if (mode === 'live') budgetUsd = parseBudget(str(f, 'budget-usd'))
  else if (f.has('budget-usd')) budgetUsd = parseBudget(str(f, 'budget-usd'))

  const model = str(f, 'model') ?? null
  if (mode === 'live' && !model) throw new UsageError('live mode needs --model <id> so both arms provably run the same model')

  const runId = str(f, 'run-id') ?? `${today.toISOString().slice(0, 10)}-${mode}-s${seed}`
  const cfg: RunConfig = {
    mode,
    tasksSelector: str(f, 'tasks') ?? (mode === 'live' ? 'smoke' : 'all'),
    arms,
    seed,
    model,
    budgetUsd,
    tasksetDir: path.resolve(str(f, 'taskset') ?? path.join(DEFAULT_TASKSET_ROOT, DEFAULT_TASKSET_VERSION)),
    transcriptsDir: path.resolve(str(f, 'transcripts') ?? DEFAULT_TRANSCRIPTS),
    outDir: path.resolve(str(f, 'out') ?? path.join('bench-results', runId)),
    recordDir: str(f, 'record') ? path.resolve(str(f, 'record')!) : undefined,
    keepWorkdirs: f.has('keep-workdirs'),
    runId,
    claudeBin: str(f, 'claude-bin'),
    settingSources: str(f, 'setting-sources'),
    timeoutMs: positive(f, 'timeout-min') === undefined ? undefined : positive(f, 'timeout-min')! * 60_000,
  }
  if (mode === 'live' && arms.includes('board')) {
    const need = { workspace: str(f, 'workspace'), project: str(f, 'project'), 'bench-repo': str(f, 'bench-repo') }
    const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => `--${k}`)
    if (!env.BENCH_BOARD_API_KEY) missing.push('env BENCH_BOARD_API_KEY')
    if (missing.length) throw new UsageError(`the live board arm needs ${missing.join(', ')} (or pass --arms baseline)`)
    const benchRepo = path.resolve(need['bench-repo']!)
    if (!fs.existsSync(path.join(benchRepo, BENCH_REPO_MARKER))) {
      throw new UsageError(`${benchRepo} is not a bench fixture repo (no ${BENCH_REPO_MARKER}); create it with \`board-setup\` — never point the board arm at a real project`)
    }
    cfg.board = {
      baseUrl: str(f, 'board-url') ?? 'http://localhost:3002',
      apiKey: env.BENCH_BOARD_API_KEY!,
      workspace: need.workspace!,
      project: need.project!,
      benchRepo,
      pollMs: positive(f, 'poll-ms'),
      timeoutMs: cfg.timeoutMs,
    }
  }
  return cfg
}

export function buildRunners(cfg: RunConfig): ArmRunner[] {
  return cfg.arms.map((arm) => {
    if (cfg.mode === 'mock') return replayArm(arm, cfg.transcriptsDir)
    if (arm === 'baseline') return baselineArm({ claudeBin: cfg.claudeBin, settingSources: cfg.settingSources, timeoutMs: cfg.timeoutMs })
    return boardArm(cfg.board!)
  })
}

export const BENCH_REPO_MARKER = '.cc-bench-repo'

/**
 * Create the throwaway git repo the board arm works in: every task's starting repo
 * under tasks/<id>/, one commit, and a marker file the run command checks for.
 */
export function boardSetup(benchRepo: string, tasksetDir: string): string {
  const set = loadTaskSet(tasksetDir)
  const repo = path.resolve(benchRepo)
  if (fs.existsSync(repo) && fs.readdirSync(repo).length && !fs.existsSync(path.join(repo, BENCH_REPO_MARKER))) {
    throw new UsageError(`${repo} exists, is not empty and is not a bench repo; refusing to touch it`)
  }
  fs.mkdirSync(repo, { recursive: true })
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' })
  if (!fs.existsSync(path.join(repo, '.git'))) git('init', '-q', '-b', 'main')
  fs.rmSync(path.join(repo, 'tasks'), { recursive: true, force: true })
  for (const t of set.tasks) fs.cpSync(path.join(t.dir, 'repo'), path.join(repo, 'tasks', t.id), { recursive: true })
  fs.writeFileSync(path.join(repo, BENCH_REPO_MARKER), `${set.version} ${set.hash}\n`)
  fs.writeFileSync(path.join(repo, 'README.md'), `# cc-bench fixture repo\n\nThrowaway repo for the Command Center board-vs-single-agent benchmark (task set ${set.version}). Each task lives in tasks/<id>/. Nothing here ships.\n`)
  git('add', '-A')
  const dirty = git('status', '--porcelain').trim()
  if (dirty) git('-c', 'user.name=cc-bench', '-c', 'user.email=cc-bench@localhost', 'commit', '-q', '-m', `bench task set ${set.version} (${set.hash.slice(0, 12)})`)
  return git('rev-parse', 'HEAD').trim()
}

const HELP = `usage:
  cli.ts run [--mode mock|live] [--tasks smoke|all|id,id] [--arms board,baseline] [--seed N]
             [--model ID] [--budget-usd USD] [--out DIR] [--record DIR] [--transcripts DIR]
             [--taskset DIR] [--keep-workdirs] [--run-id ID] [--claude-bin PATH]
             [--setting-sources project,local]   (baseline: which Claude settings apply)
             board arm (live): --workspace WS --project NAME --bench-repo PATH [--board-url URL]
                               [--poll-ms N]   (env BENCH_BOARD_API_KEY)
             [--timeout-min N]   per-run wall-clock limit (default 20 baseline, 90 board)
  cli.ts board-setup --bench-repo PATH [--taskset DIR]
  cli.ts make-synthetic [--out DIR] [--taskset DIR]   (regenerates the mock-mode fixtures)
Live mode refuses to start without --budget-usd and --model. See docs/bench/README.md.`

export async function main(argv: string[]): Promise<number> {
  let args: ParsedArgs
  try {
    args = parseArgs(argv)
  } catch (e) {
    console.error(`${(e as Error).message}\n${HELP}`)
    return 2
  }
  try {
    if (args.command === 'board-setup') {
      const repo = str(args.flags, 'bench-repo')
      if (!repo) throw new UsageError('board-setup needs --bench-repo PATH')
      const head = boardSetup(repo, path.resolve(str(args.flags, 'taskset') ?? path.join(DEFAULT_TASKSET_ROOT, DEFAULT_TASKSET_VERSION)))
      console.log(`bench repo ready at ${path.resolve(repo)} (HEAD ${head.slice(0, 12)}).`)
      console.log('Register it as a project on a throwaway workspace (Settings -> Workspaces -> Repos, or POST /api/admin/workspaces/<ws>/repos {"name":"cc-bench-fixture","repo_path":"<path>"}).')
      return 0
    }
    if (args.command === 'make-synthetic') {
      const set = loadTaskSet(path.resolve(str(args.flags, 'taskset') ?? path.join(DEFAULT_TASKSET_ROOT, DEFAULT_TASKSET_VERSION)))
      const out = path.resolve(str(args.flags, 'out') ?? DEFAULT_TRANSCRIPTS)
      console.log(`wrote ${writeSyntheticTranscripts(set, out).length} synthetic transcripts to ${out}`)
      return 0
    }
    if (args.command !== 'run') {
      console.log(HELP)
      return args.command === 'help' ? 0 : 2
    }
    const cfg = resolveRunConfig(args.flags)
    const taskSet = loadTaskSet(cfg.tasksetDir)
    const tasks = selectTasks(taskSet, cfg.tasksSelector)
    const result = await runBench({
      mode: cfg.mode,
      taskSet,
      tasks,
      runners: buildRunners(cfg),
      seed: cfg.seed,
      model: cfg.model,
      budget: cfg.budgetUsd === null ? null : new BudgetGuard(cfg.budgetUsd),
      runId: cfg.runId,
      recordDir: cfg.recordDir,
      keepWorkdirs: cfg.keepWorkdirs,
      log: (l) => console.error(l),
    })
    const out = writeResults(cfg.outDir, result)
    console.log(renderMarkdown(result))
    console.error(`wrote ${out.json} and ${out.md}`)
    return 0
  } catch (e) {
    if (e instanceof UsageError || e instanceof BudgetError) {
      console.error(`refused: ${e.message}`)
      return 2
    }
    console.error(`bench failed: ${(e as Error).stack ?? e}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
