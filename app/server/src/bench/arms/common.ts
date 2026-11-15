import type { Arm, ArmOutcome, TaskSpec, Transcript } from '../types.js'

export interface ArmContext {
  task: TaskSpec
  /** Fresh copy of the task's starting repo. The arm leaves its work here. */
  workdir: string
  runId: string
  seed: number
  model: string | null
  /** Hard spend cap for THIS run in USD (live only; null in mock mode). */
  capUsd: number | null
}

export interface ArmResult {
  outcome: ArmOutcome
  /** Present when the arm can be recorded for later replay (live runs). */
  transcript?: Transcript
}

export interface ArmRunner {
  arm: Arm
  run(ctx: ArmContext): Promise<ArmResult>
}

/**
 * The words BOTH arms are given. Keeping them identical is the point: the only
 * difference between arms is what wraps the agent, not what it is asked.
 */
export function taskPrompt(task: TaskSpec, repoHint = 'the current directory'): string {
  return [
    `You are working in a small Node.js (ESM, no dependencies) repository at ${repoHint}.`,
    '',
    task.prompt,
    '',
    'Make the change directly in the files; do not ask questions. Use only Node.js built-ins.',
    'You may write and run your own tests with `node --test`, but the change itself is what gets graded.',
  ].join('\n')
}

export function failedOutcome(error: string, wall_ms: number, model: string | null, extra: Partial<ArmOutcome> = {}): ArmOutcome {
  return {
    status: 'error',
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 },
    cost_usd: 0,
    wall_ms,
    review_iterations: 0,
    human_interventions: 0,
    model,
    error,
    notes: [],
    ...extra,
  }
}
