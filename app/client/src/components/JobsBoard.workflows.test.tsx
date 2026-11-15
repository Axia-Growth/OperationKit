import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import type { RoutineSummary } from '../hooks/useRoutines'
import type { FlowDetailResponse, FlowRunSummary, FlowSummary } from '../../../shared/flow/api'

/**
 * obj 900640 (card B4) — Jobs → Workflows: the kind filter, workflow runs in the
 * existing lanes, a workflow routine in the existing auto-pause banner, and the
 * Workflows tab with the Mermaid diagram. Hooks are mocked; Mermaid is mocked to
 * echo its source so the test can read what would be drawn.
 */

const flowRunNow = vi.fn(async (_id: number) => ({ ok: true, run_id: 99 }))

function routine(over: Partial<RoutineSummary>): RoutineSummary {
  return {
    id: 1, name: 'r', cron_expr: '0 * * * *', cadence: 'Hourly at :00', enabled: true, max_queue_depth: 1,
    last_run_at: null, next_run_at: null, created_at: '2026-11-01T00:00:00Z', title: 'Routine', workspace: 'acme',
    agent_context: 'general', project: null, category: 'general', pending: 0, strategy_objective_id: null,
    strategy_title: null, ...over,
  }
}

function run(over: Partial<FlowRunSummary>): FlowRunSummary {
  return {
    id: 1, flow_id: 12, flow_slug: 'daily-booking-triage', flow_name: 'Daily booking triage', workspace: 'acme',
    version: 3, mode: 'live', status: 'succeeded', goal_met: null, spent_usd: 0, trigger_source: 'schedule',
    objective_id: 500, created_at: '2026-11-12T08:00:00Z', started_at: '2026-11-12T08:00:00Z',
    ended_at: '2026-11-12T08:00:04Z', error: null, goal: null, self_test_id: null, ...over,
  }
}

const FLOW: FlowSummary = {
  id: 12, slug: 'daily-booking-triage', name: 'Daily booking triage', workspace: 'acme', status: 'active',
  published_version: 3, latest_version: 3, objective_id: 500, created_by: 'user:1', created_at: '2026-11-12T00:00:00Z',
  updated_at: '2026-11-12T00:00:00Z', notes: null, tools: [], trigger: { on: 'schedule', cron: '0 8 * * 1-5' }, node_count: 8,
  kinds: { trigger: 1, tool: 1, loop: 1, llm: 1, mcp: 2, check: 1, end: 1 },
  routine: {
    id: 77, cron_expr: '0 8 * * 1-5', cadence: 'Weekdays at 08:00', enabled: false, next_run_at: null, last_run_at: null,
    consecutive_failures: 5, auto_pause_threshold: 5, auto_paused_at: '2026-11-12T09:00:00Z',
    auto_pause_reason: 'auto-paused: 5 failures, last error flow run #9 ended failed (check_failed)',
  },
  last_run: run({ id: 9, status: 'failed', error: { type: 'check_failed', title: 'check "upsert" failed' } }),
}

const MERMAID = 'flowchart TD\n  n_classify{{"LLM · classify"}}\n  class n_classify llm\n  class n_fetch succeeded\n'
const DETAIL: FlowDetailResponse = {
  flows_enabled: true, flow: FLOW, version: 3, definition: {} as never,
  versions: [{ version: 3, author: 'user:1', sha256: 'x', parent_version: null, created_at: '2026-11-12T00:00:00Z', published: true }],
  mermaid: MERMAID, node_status: { fetch: 'succeeded', upsert: 'failed' }, status_run_id: 9,
  runs: [FLOW.last_run as FlowRunSummary],
  publish: { version: 3, nodes_requiring_approval: ['notify'], nodes_missing_mocks: [], self_test: null, approvals: null },
  changes: null,
}

let routinesFixture: RoutineSummary[] = []
let runsFixture: FlowRunSummary[] = []
let flowsFixture: FlowSummary[] = []

vi.mock('../hooks/useRoutines', async importOriginal => {
  const actual = await importOriginal<typeof import('../hooks/useRoutines')>()
  return {
    ...actual,
    useRoutines: () => ({
      routines: routinesFixture, routinesEnabled: true, strategies: [], loading: false, error: null,
      refresh: async () => {}, runNow: async () => ({ ok: true }), createStrategyJob: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
    }),
  }
})
vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: [{ id: 300, title: 'Nightly agent job', status: 'working', routine_id: 5, workspace: 'acme', created_at: '2026-11-12T07:00:00Z' }],
    loading: false, error: null, changeStatus: async () => {}, connectionState: 'open',
  }),
}))
vi.mock('../hooks/useWorkspaces', () => ({
  useWorkspaces: () => ({ labelOf: (s: string) => s, workspaces: [{ slug: 'acme', name: 'Acme' }] }),
}))
vi.mock('./SessionViewer', () => ({ SessionViewer: () => null }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin' } }) }))
vi.mock('./settings/QueueAutostartPanel', () => ({ QueueAutostartPanel: () => null }))
vi.mock('./jobs/HostCronJobs', () => ({ HostCronJobs: () => null }))
vi.mock('../hooks/useFlows', () => ({
  useFlows: () => ({ flows: flowsFixture, runs: runsFixture, flowsEnabled: true, loading: false, error: null, refresh: async () => {}, runNow: flowRunNow }),
  useFlowDetail: (id: number | null) => ({ detail: id === 12 ? DETAIL : null, error: null, loading: false, reload: async () => {} }),
  fetchFlowRun: async () => { throw new Error('not in this test') },
  fetchFlowNode: async () => { throw new Error('not in this test') },
  useFlowLiveEvents: () => {},
}))
vi.mock('../lib/mermaid', () => ({
  renderMermaidIn: async (el: HTMLElement | null) => {
    el?.querySelectorAll<HTMLElement>('.mermaid-block').forEach(p => { p.textContent = `RENDERED:${p.getAttribute('data-mermaid-source')}` })
  },
}))

const { JobsBoard } = await import('./JobsBoard')
const { Toaster, toast } = await import('./ui/Toaster')

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function settle() {
  for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0))
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  flowRunNow.mockClear()
  flowsFixture = [FLOW]
  window.history.replaceState(null, '', '/jobs')
  routinesFixture = [
    routine({ id: 5, title: 'Nightly agent job', kind: 'ai' }),
    routine({
      id: 77, title: 'Daily booking triage', kind: 'flow', flow_id: 12, enabled: false, consecutive_failures: 5,
      auto_pause_threshold: 5, auto_paused_at: '2026-11-12T09:00:00Z', auto_pause_reason: FLOW.routine!.auto_pause_reason,
    }),
  ]
  runsFixture = [run({ id: 9, status: 'failed', error: { type: 'check_failed', title: 'check "upsert" failed' } }), run({ id: 10, status: 'running', ended_at: null })]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  flushSync(() => root.unmount())
  container.remove()
})

/** A lane row's run badge (exact text), not the banner's prose that also mentions the run. */
const hasRunBadge = (id: number) => Array.from(container.querySelectorAll('span')).some(e => e.textContent === `run #${id}`)

async function mount() {
  flushSync(() => root.render(<JobsBoard workspace={'acme' as never} />))
  await settle()
}

function clickTab(label: string) {
  const btn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim().startsWith(label)) as HTMLButtonElement
  expect(btn, `tab ${label}`).toBeTruthy()
  btn.click()
}

describe('JobsBoard — opens on the flow-chart view (obj 900675)', () => {
  it('bare /jobs opens the Workflows tab, titled Workflows', async () => {
    await mount()
    expect(container.querySelector('[data-testid="workflows-panel"]')).not.toBeNull()
    expect(container.querySelector('h1, h2')?.textContent).toContain('Workflows')
    expect(window.location.search).toBe('')
  })

  it('the Runs tab shows the lanes and writes ?view=runs', async () => {
    await mount()
    clickTab('Runs')
    await settle()
    expect(container.querySelector('[data-testid="workflows-panel"]')).toBeNull()
    expect(container.textContent).toContain('Nightly agent job')
    expect(window.location.search).toContain('view=runs')
  })

  it('names strategy, scheduled task and workflow apart (one word each, glossary)', async () => {
    await mount()
    expect(container.textContent).toContain('A workflow is a chain of steps')
    // The rarer create sits in the menu beside "New workflow" (obj 900807).
    const more = container.querySelector('[data-testid="workflows-create-menu"]') as HTMLElement
    more.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    more.click()
    await settle()
    expect(document.body.textContent).toContain('New scheduled task')
    expect(document.body.textContent).not.toContain('New strategy job')
    clickTab('Runs')
    await settle()
    expect(container.textContent).toContain('Scheduled tasks')
    expect(container.textContent).toContain('A task can belong to a strategy')
    expect(container.textContent).not.toMatch(/strategy workflow/i)
  })

  it.each([['/jobs?view=jobs'], ['/jobs?kind=agent'], ['/jobs#host-cron']])('%s still lands on the lanes', async url => {
    window.history.replaceState(null, '', url)
    await mount()
    expect(container.querySelector('[data-testid="workflows-panel"]')).toBeNull()
    expect(container.textContent).toContain('Nightly agent job')
  })
})

describe('JobsBoard — workflows (B4)', () => {
  it('a workflow routine that auto-paused shows in the existing banner', async () => {
    await mount()
    const banner = container.querySelector('[data-testid="auto-paused-routines"]')
    expect(banner?.textContent).toContain('Daily booking triage')
    expect(banner?.textContent).toContain('auto-paused: 5 failures, last error flow run #9')
  })

  it('workflow runs sit in the same lanes as agent jobs; the kind filter narrows both', async () => {
    window.history.replaceState(null, '', '/jobs?view=runs')
    await mount()
    const text = () => container.textContent ?? ''
    expect(text()).toContain('Nightly agent job')
    expect(hasRunBadge(9)).toBe(true) // failed → Needs Review
    expect(hasRunBadge(10)).toBe(true) // running → Running
    expect(text()).toContain('check_failed')

    clickTab('Bot runs')
    await settle()
    expect(hasRunBadge(9)).toBe(false)
    expect(hasRunBadge(10)).toBe(false)
    expect(text()).toContain('Nightly agent job')
    expect(window.location.search).toContain('kind=agent')
  })

  it('kind=flow hides agent jobs and keeps workflow runs and the workflow routine', async () => {
    window.history.replaceState(null, '', '/jobs?kind=flow')
    await mount()
    const text = container.textContent ?? ''
    expect(hasRunBadge(9)).toBe(true)
    expect(hasRunBadge(10)).toBe(true)
    // agent routine row and agent lane row are gone; the workflow routine remains (with its badge)
    expect(Array.from(container.querySelectorAll('button')).some(b => b.textContent === 'Diagram')).toBe(true)
    expect(text).not.toContain('Nightly agent job')
  })

  it('?view=workflows&flow=12 opens the Workflows tab with the diagram, legend and node-status caption', async () => {
    window.history.replaceState(null, '', '/jobs?view=workflows&flow=12')
    await mount()
    const panel = container.querySelector('[data-testid="workflows-panel"]')
    expect(panel).not.toBeNull()
    const detail = container.querySelector('[data-testid="flow-detail"]')
    expect(detail?.textContent).toContain('home card #500')
    expect(detail?.textContent).toContain('Schedule auto-paused')
    // B7: the React Flow canvas is the default view; the B4 Mermaid chart is one click away.
    expect(container.querySelector('[data-testid="flow-canvas-legend"]')).not.toBeNull()
    const mermaidToggle = Array.from(detail!.querySelectorAll('button')).find(b => b.textContent === 'Mermaid') as HTMLButtonElement
    mermaidToggle.click()
    await settle()
    const diagram = container.querySelector('[data-testid="flow-diagram"]')
    expect(diagram?.textContent).toBe(`RENDERED:${MERMAID}`)
    expect(container.querySelector('[data-testid="flow-diagram-legend"]')?.textContent).toContain('LLM')
    expect(container.querySelector('[data-testid="flow-status-caption"]')?.textContent).toContain('run #9')

    const runNow = Array.from(detail!.querySelectorAll('button')).find(b => b.textContent?.includes('Run now')) as HTMLButtonElement
    runNow.click()
    await settle()
    expect(flowRunNow).toHaveBeenCalledWith(12)
  })
})

/* obj 900819 — Canvas / Mermaid is one choice: a ui/SegmentedControl radio
   group (UI SDK) instead of two aria-pressed buttons. */
describe('workflow chart view switch', () => {
  it('is a named radio group with one tab stop; ArrowRight switches to the Mermaid chart', async () => {
    window.history.replaceState(null, '', '/jobs?view=workflows&flow=12')
    await mount()
    const detail = container.querySelector('[data-testid="flow-detail"]')!
    const group = detail.querySelector('[role="radiogroup"][aria-label="Chart view"]') as HTMLElement
    expect(group).not.toBeNull()
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')]
    expect(radios.map(r => r.textContent)).toEqual(['Canvas', 'Mermaid'])
    expect(radios[0].getAttribute('aria-checked')).toBe('true')
    expect(radios.filter(r => r.tabIndex === 0)).toHaveLength(1)
    radios[0].focus()
    radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    await settle()
    expect(radios[1].getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(radios[1])
    expect(container.querySelector('[data-testid="flow-diagram"]')?.textContent).toBe(`RENDERED:${MERMAID}`)
  })
})

/* obj 900819 — Run now feedback is a ui/Toaster toast (UI SDK, announced in
   a live region) naming the job, not a bare inline span. */
describe('Run now feedback toasts', () => {
  afterEach(() => { toast.dismiss() })

  const region = () => document.querySelector('[data-slot="toast-region"]') as HTMLElement
  const runNowIn = (scope: ParentNode) =>
    Array.from(scope.querySelectorAll('button')).find(b => b.textContent?.includes('Run now')) as HTMLButtonElement

  it('a workflow Run now toasts "Queued: <workflow>" in the named status region', async () => {
    window.history.replaceState(null, '', '/jobs?view=workflows&flow=12')
    flushSync(() => root.render(<><JobsBoard workspace={'acme' as never} /><Toaster /></>))
    await settle()
    runNowIn(container.querySelector('[data-testid="flow-detail"]')!).click()
    await settle()
    expect(flowRunNow).toHaveBeenCalledWith(12)
    expect(region().getAttribute('aria-label')).toBe('Status messages')
    const t = region().querySelector('[data-slot="toast"]')!
    expect(t.textContent).toContain('Queued: Daily booking triage')
    expect(t.getAttribute('data-type')).toBe('success')
  })

  it('a routine Run now toasts "Started: <routine>"', async () => {
    window.history.replaceState(null, '', '/jobs?view=runs')
    flushSync(() => root.render(<><JobsBoard workspace={'acme' as never} /><Toaster /></>))
    await settle()
    const row = Array.from(container.querySelectorAll('tr')).find(tr => tr.textContent?.includes('Nightly agent job') && runNowIn(tr))!
    runNowIn(row).click()
    await settle()
    expect(region().querySelector('[data-slot="toast"]')?.textContent).toContain('Started: Nightly agent job')
  })
})

describe('JobsBoard — workspace counts match the list shown (obj 900868)', () => {
  /** The count on a Workspace filter option, e.g. "All" → 0. Since obj 900807 the
      workspace filter is one Select on the toolbar row (it was a second chip row),
      so open it, read the option ("All workspaces (0)", "acme (1)") and close it. */
  async function wsCount(label: string): Promise<number> {
    const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Workspace"]')
    expect(trigger, 'workspace filter').toBeTruthy()
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? (globalThis.PointerEvent ?? MouseEvent) : MouseEvent
      trigger!.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0 }))
    }
    await settle()
    const want = label === 'All' ? 'All workspaces' : label
    const item = Array.from(document.querySelectorAll('[role="option"]')).find(o => o.textContent?.trim().startsWith(`${want} (`))
    expect(item, `workspace option ${label}`).toBeTruthy()
    const n = Number(/\((\d+)\)\s*$/.exec(item!.textContent!.trim())?.[1])
    ;(document.activeElement ?? trigger!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await settle()
    return n
  }

  it('Workflows view with no workflows says All 0, not the run count', async () => {
    flowsFixture = []
    runsFixture = Array.from({ length: 9 }, (_, i) => run({ id: 100 + i }))
    await mount()
    expect(container.querySelector('[data-testid="workflows-panel"]')).not.toBeNull()
    expect(container.textContent).toContain('No workflows yet')
    expect(await wsCount('All')).toBe(0)
    expect(await wsCount('acme')).toBe(0)
  })

  it('Workflows view counts workflow definitions per workspace', async () => {
    flowsFixture = [FLOW, { ...FLOW, id: 13, slug: 'other', name: 'Other', workspace: 'beta' }]
    await mount()
    expect(await wsCount('All')).toBe(2)
    expect(await wsCount('acme')).toBe(1)
    expect(await wsCount('beta')).toBe(1)
  })

  it('Runs view counts the runs of the picked kind only', async () => {
    window.history.replaceState(null, '', '/jobs?view=runs')
    await mount()
    // 1 agent job + 2 workflow runs
    expect(await wsCount('All')).toBe(3)
    clickTab('Bot runs')
    await settle()
    expect(await wsCount('All')).toBe(1)
    // The run-kind filter's "Workflows", not the view tab of the same name.
    const kind = container.querySelector('[aria-label="Run kind"]')!
    ;(Array.from(kind.querySelectorAll('button, [role="radio"]')).find(b => b.textContent?.trim() === 'Workflows') as HTMLElement).click()
    await settle()
    expect(await wsCount('All')).toBe(2)
  })
})
