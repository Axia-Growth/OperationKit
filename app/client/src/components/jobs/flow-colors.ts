import type { FlowNodeRunStatus } from '../../../../shared/flow/types'

/* Workflow canvas and diagram colours, all theme tokens so they read in light
   and dark and follow a white-label accent (polish F3 #900804). */

export const STATUS_STYLE: Record<FlowNodeRunStatus, { color: string; style: 'solid' | 'dashed' | 'dotted'; label: string }> = {
  // Theme tokens, so the outline reads in light and dark (polish F3 #900804).
  succeeded: { color: 'var(--success)', style: 'solid', label: 'succeeded' },
  failed: { color: 'var(--danger)', style: 'dashed', label: 'failed' },
  running: { color: 'var(--info)', style: 'solid', label: 'running' },
  waiting: { color: 'var(--warning)', style: 'dotted', label: 'waiting' },
  skipped: { color: 'var(--fg-3)', style: 'solid', label: 'skipped' },
  mocked: { color: 'var(--fg-3)', style: 'dotted', label: 'mocked' },
}

/** Kind tint (LLM and agent stand out: "where the LLM loop sits", §6.2). */
export const KIND_TINT: Partial<Record<string, { bg: string; accent: string }>> = {
  llm: { bg: 'color-mix(in srgb, var(--st-ai) 14%, transparent)', accent: 'var(--st-ai)' },
  agent: { bg: 'color-mix(in srgb, var(--info) 12%, transparent)', accent: 'var(--info)' },
  trigger: { bg: 'color-mix(in srgb, var(--fg-3) 8%, transparent)', accent: 'var(--fg-3)' },
  end: { bg: 'color-mix(in srgb, var(--fg-3) 8%, transparent)', accent: 'var(--fg-3)' },
  branch: { bg: 'color-mix(in srgb, var(--fg-3) 6%, transparent)', accent: 'var(--fg-3)' },
  check: { bg: 'color-mix(in srgb, var(--success) 7%, transparent)', accent: 'var(--success)' },
  wait: { bg: 'color-mix(in srgb, var(--warning) 8%, transparent)', accent: 'var(--warning)' },
}

/** Effect class (§3.2): write = amber, SEND / SPEND = warning colours. */
export const EFFECT_STYLE: Record<string, { bg: string; border: string; text: string }> = {
  write: { bg: 'color-mix(in srgb, var(--warning) 12%, transparent)', border: 'var(--warning)', text: 'write' },
  send: { bg: 'color-mix(in srgb, var(--danger) 10%, color-mix(in srgb, var(--warning) 6%, transparent))', border: 'color-mix(in srgb, var(--danger) 60%, var(--warning))', text: 'SEND' },
  spend: { bg: 'color-mix(in srgb, var(--danger) 14%, transparent)', border: 'var(--danger)', text: 'SPEND' },
}
