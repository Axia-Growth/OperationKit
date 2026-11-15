/**
 * Board-vs-single-agent benchmark (audit #19, obj 900908) — shared types.
 *
 * Two ARMS run the same fixed task set in the same seeded order:
 *   - `board`    — the task goes through Command Center: card -> worker session -> AI review.
 *   - `baseline` — ONE plain `claude -p` session, same model, no board, no reviewer.
 *
 * Every run is scored the same way (hidden node:test checks + must_exist), so the
 * only thing that differs between arms is how the work was produced.
 */

export type Arm = 'board' | 'baseline'
export const ARMS: readonly Arm[] = ['board', 'baseline'] as const

export type BenchMode = 'mock' | 'live'

export interface TaskSpec {
  id: string
  title: string
  category: string
  /** What the agent is told. The hidden checks test exactly this contract. */
  prompt: string
  /** Paths (relative to the repo root) that must exist after the run. */
  must_exist: string[]
  /** Prior per-run cost estimate, used by the budget guard before any run is observed. */
  est_usd: Record<Arm, number>
  /** Absolute path of tasks/<id> (holds repo/, check/, solution/). */
  dir: string
}

export interface TaskSet {
  schema: 'cc-bench-taskset/1'
  version: string
  description: string
  smoke: string[]
  tasks: TaskSpec[]
  /** Absolute path of the task-set version directory. */
  root: string
  /** sha256 over every file in the task set — two results are comparable only if equal. */
  hash: string
}

export interface TokenUsage {
  input: number
  output: number
  cache_read: number
  cache_creation: number
  total: number
}

export type RunStatus = 'completed' | 'error' | 'timeout' | 'skipped_budget'

/** What an arm reports after producing (or failing to produce) work in a workdir. */
export interface ArmOutcome {
  status: RunStatus
  tokens: TokenUsage
  cost_usd: number
  wall_ms: number
  /** Number of AI-review rounds the work went through. Always 0 for the baseline. */
  review_iterations: number
  /** Human messages / decisions needed before the run finished (owner chat, needs_review). */
  human_interventions: number
  model: string | null
  error?: string
  /**
   * Set when the run says nothing about the task because the environment is broken
   * (e.g. the CLI is not logged in). The runner stops instead of burning the rest.
   */
  fatal?: string
  /**
   * The run may have spent money the harness could not read (a killed session, a card
   * whose cost never landed). The budget guard is charged the run's full cap.
   */
  cost_unknown?: boolean
  /** Free-form provenance (card id, session id, transcript file, replay warnings). */
  notes: string[]
}

export interface Score {
  success: boolean
  checks_passed: number
  checks_failed: number
  missing_files: string[]
  check_exit_code: number | null
  /** Last lines of the check output, for debugging a failure. */
  output_tail: string
}

export interface RunRecord extends ArmOutcome {
  task_id: string
  arm: Arm
  /** Position of the task in the seeded order (0-based). */
  order_index: number
  score: Score
}

export interface ArmSummary {
  arm: Arm
  runs: number
  successes: number
  success_rate: number
  wall_ms_total: number
  wall_ms_median: number
  tokens_total: number
  tokens_mean: number
  cost_usd_total: number
  cost_usd_mean: number
  /** Total cost / successes; null when nothing succeeded. */
  cost_per_success_usd: number | null
  review_iterations_mean: number
  human_interventions_total: number
}

export interface ArmDeltas {
  /** board minus baseline, in percentage points. */
  success_rate_pp: number
  wall_ms_median: number
  tokens_mean: number
  cost_usd_mean: number
  /** board cost / baseline cost (total); null when the baseline cost is 0. */
  cost_ratio: number | null
  review_iterations_mean: number
  human_interventions_total: number
}

export interface BenchResult {
  schema: 'cc-bench-result/1'
  harness_version: string
  mode: BenchMode
  taskset_version: string
  taskset_hash: string
  seed: number
  model: string | null
  budget_usd: number | null
  arms: Arm[]
  /** Task ids in the seeded order they were run. */
  task_order: string[]
  started_at: string
  finished_at: string
  runs: RunRecord[]
  /** Task ids where EVERY arm produced a run — the only set deltas are computed on. */
  paired_task_ids: string[]
  summary: Partial<Record<Arm, ArmSummary>>
  deltas: ArmDeltas | null
  spent_usd: number
  stopped: { reason: string; before_task: string; projected_usd: number } | null
}

/**
 * A recorded run, replayable with no model call (mock mode) — `cc-bench-transcript/1`.
 *
 * `rounds` alternate worker and reviewer turns. A worker round carries the
 * `claude --output-format stream-json` events of that session (the replayer applies
 * Write / Edit / MultiEdit tool calls) and, when recorded live, a `files` snapshot
 * of every file the round changed (authoritative when present: it captures edits
 * made through Bash too). A reviewer round carries the verdict and its cost.
 */
export interface Transcript {
  schema: 'cc-bench-transcript/1'
  arm: Arm
  task_id: string
  /** `synthetic` = hand-built for testing the harness; `live` = captured from a real run. */
  provenance: 'synthetic' | 'live'
  model: string | null
  recorded_at: string
  /** Wall time spent outside any session (queueing, poller ticks, review spawn). */
  overhead_ms?: number
  /** Measured end-to-end wall time of a live run. When present, replay reports it as-is. */
  wall_ms?: number
  rounds: TranscriptRound[]
  human_interventions?: Array<{ after_round: number; kind: string; text?: string }>
  final_status?: RunStatus
  error?: string
}

export type TranscriptRound = WorkerRound | ReviewerRound

export interface WorkerRound {
  role: 'worker'
  /** The cwd the session ran in when recorded; absolute tool paths are rebased from it. */
  cwd?: string
  events: StreamEvent[]
  /** path (relative to repo root) -> new content, or null when the file was deleted. */
  files?: Record<string, string | null>
}

export interface ReviewerRound {
  role: 'reviewer'
  verdict: 'pass' | 'fail'
  findings?: string
  cost_usd: number
  tokens?: Partial<TokenUsage>
  duration_ms: number
}

/** The subset of Claude Code stream-json events the harness reads. */
export type StreamEvent = { type: string; [k: string]: unknown }
