/**
 * Counts on the Workflows page's workspace filter (obj 900868).
 *
 * Bug: the tabs always counted agent-job runs + workflow RUNS, whatever the page
 * showed. On the Workflows view (which lists workflow DEFINITIONS) "All 9" sat on
 * top of an empty "No workflows yet" list, because those 9 were runs. A count must
 * describe the rows the current view would show for that workspace, so:
 *
 *   view = 'workflows'  → workflow definitions in the workspace
 *   view = 'runs'       → agent-job runs (unless kind = 'flow') + workflow runs (unless kind = 'agent')
 *
 * These mirror the `jobs` / `visibleFlowRuns` / `visibleFlows` filters in
 * JobsBoard.tsx; keep the two in step.
 */
export type CountView = 'runs' | 'workflows'
export type CountKind = 'all' | 'agent' | 'flow'

export interface WorkspaceTabCountsInput {
  view: CountView
  kind: CountKind
  jobs: ReadonlyArray<{ workspace?: string | null }>
  flowRuns: ReadonlyArray<{ workspace: string }>
  flows: ReadonlyArray<{ workspace: string }>
}

/** Rows the current view would show for `ws` (null = every workspace). */
export function countForWorkspace(input: WorkspaceTabCountsInput, ws: string | null): number {
  const inWs = (w: string | null | undefined) => ws == null || w === ws
  if (input.view === 'workflows') return input.flows.filter(f => inWs(f.workspace)).length
  const jobs = input.kind === 'flow' ? 0 : input.jobs.filter(j => inWs(j.workspace)).length
  const runs = input.kind === 'agent' ? 0 : input.flowRuns.filter(r => inWs(r.workspace)).length
  return jobs + runs
}
