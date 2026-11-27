import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitBranch, Play, Plus, Workflow, ExternalLink, AlertTriangle } from 'lucide-react'
import type { FlowLiveEvent, FlowRunDetailResponse, FlowRunSummary, FlowSummary } from '../../../../shared/flow/api'
import type { FlowNodeChange } from '../../../../shared/flow/diff'
import { useFlowDetail, fetchFlowRun, useFlowLiveEvents } from '../../hooks/useFlows'
import { describeCron, formatCost, formatDateTime, formatDuration, formatRelativeTime, friendlyError, humanize } from '../../lib/format'
import { Alert, Badge, Button, DataTable, cn, type Column } from '../ui'
import { FlowDiagram, FlowDiagramLegend } from './FlowDiagram'
import { FlowCanvas, FlowCanvasLegend } from './FlowCanvas'
import { FlowNodeInspector } from './FlowNodeInspector'
import { FlowSelfTestPanel } from './FlowSelfTestPanel'
import { NewWorkflowDialog, type NewWorkflowResult } from './NewWorkflowDialog'
import { FlowRunWaitsPanel } from './FlowRunWaitsPanel'
import { FlowAboutSection } from './FlowAboutSection'
import { Select } from '../ui/Select'
import { SegmentedControl } from '../ui/SegmentedControl'
import { toast } from '../ui/Toaster'

const CHART_VIEWS = [
  { key: 'canvas', label: 'Canvas' },
  { key: 'mermaid', label: 'Mermaid' },
]

/**
 * Jobs → Workflows (obj 900640, card B4; docs/design/WORKFLOWS.md §6, §7.1).
 * A read-only list of workflows and, for the selected one, the flow chart with
 * per-node status from its latest run, its versions and its runs. There is
 * deliberately no editor (R5: nobody edits visually).
 *
 * Card B7 (obj 900643): the chart is the React Flow canvas (FlowCanvas) — loop
 * groups, kind/effect styling, a live status overlay pushed over the WebSocket
 * (`flow_step`), click-to-inspect (FlowNodeInspector, redacted server-side) and
 * changed-node tags for the version picker. The B4 Mermaid chart stays one
 * click away.
 */

const RUN_TONE: Record<string, 'verify' | 'alarm' | 'info' | 'amber' | 'neutral'> = {
  succeeded: 'verify',
  failed: 'alarm',
  running: 'info',
  queued: 'info',
  waiting: 'amber',
  repairing: 'amber',
  cancelled: 'neutral',
}

export function RunStatusBadge({ run }: { run: Pick<FlowRunSummary, 'status' | 'goal_met'> | null }) {
  if (!run) return <span className="text-fg-3">Never run</span>
  const goalMissed = run.status === 'succeeded' && run.goal_met === 0
  return (
    <Badge tone={goalMissed ? 'amber' : RUN_TONE[run.status] ?? 'neutral'}>
      {goalMissed ? 'Goal not met' : humanize(run.status)}
    </Badge>
  )
}

function kindsLine(kinds: Record<string, number>): string {
  const order = ['trigger', 'tool', 'mcp', 'llm', 'agent', 'branch', 'loop', 'wait', 'check', 'end']
  const label: Record<string, string> = { llm: 'LLM', mcp: 'MCP', agent: 'bot' }
  return order.filter(k => kinds[k]).map(k => `${label[k] ?? k} ${kinds[k]}`).join(' · ')
}

function duration(run: FlowRunSummary): string {
  if (!run.started_at) return '—'
  const end = run.ended_at ? Date.parse(run.ended_at) : Date.now()
  return formatDuration(Math.max(0, end - Date.parse(run.started_at)))
}

/** A routine/trigger cron runs on the server clock (UTC). */
const scheduleWords = (cron: string | null | undefined) => describeCron(cron, { utc: true })

function TimeAgo({ at, className }: { at: string | null | undefined; className?: string }) {
  const t = formatDateTime(at)
  return <span className={className} title={t.title}>{t.label}</span>
}

export function WorkflowsPanel({
  flows,
  flowsEnabled,
  loading,
  labelOf,
  selectedId,
  onSelect,
  onRunNow,
  onRunLifecycle,
  workspaces = [],
  defaultWorkspace = null,
  onCreated,
  onOpenRunLog,
  onDetailsSaved,
  newOpen: newOpenProp,
  onNewOpenChange,
}: {
  flows: FlowSummary[]
  flowsEnabled: boolean
  loading: boolean
  labelOf: (ws: string) => string
  selectedId: number | null
  onSelect: (id: number | null) => void
  onRunNow: (flowId: number) => Promise<{ ok: boolean; reason?: string }>
  /** A run of the shown flow started or finished (live `flow_step` event): refresh the table's Last run. */
  onRunLifecycle?: () => void
  /** Workspaces "New workflow" may file into (B6). Empty hides the button. */
  workspaces?: string[]
  defaultWorkspace?: string | null
  onCreated?: (r: NewWorkflowResult) => void
  /** obj 900676: open the Executions view (per-run log) of this workflow, focused on a run. */
  onOpenRunLog?: (flow: FlowSummary, runId: number | null) => void
  /** obj 900868: Notes/Tools were saved on a workflow — refresh the list. */
  onDetailsSaved?: () => void
  /** Controlled New workflow dialog (obj 900807): the Workflows page opens it
      from its header primary, so the panel shows no button of its own. */
  newOpen?: boolean
  onNewOpenChange?: (open: boolean) => void
}) {
  const [newOpenLocal, setNewOpenLocal] = useState(false)
  const controlled = newOpenProp !== undefined
  const newOpen = controlled ? newOpenProp : newOpenLocal
  const setNewOpen = (open: boolean) => { if (controlled) onNewOpenChange?.(open); else setNewOpenLocal(open) }
  const columns: Column<FlowSummary>[] = [
    {
      key: 'name',
      header: 'Workflow',
      cell: f => (
        <div className="min-w-0">
          <div className="truncate font-medium text-fg-0" title={f.slug}>{f.name}</div>
        </div>
      ),
    },
    { key: 'workspace', header: 'Workspace', hideOnMobile: true, cell: f => <Badge tone="neutral">{labelOf(f.workspace)}</Badge> },
    {
      key: 'status',
      header: 'Version',
      cell: f => (
        <div className="flex flex-wrap items-center gap-1">
          <Badge tone={f.status === 'active' ? 'verify' : 'neutral'}>{humanize(f.status)}</Badge>
          {f.published_version != null && <Badge tone="neutral">Version {f.published_version}</Badge>}
          {f.latest_version != null && f.latest_version !== f.published_version && (
            <Badge tone="amber">Draft version {f.latest_version}</Badge>
          )}
        </div>
      ),
    },
    {
      key: 'trigger',
      header: 'Trigger',
      cell: f =>
        f.routine ? (
          <span>{scheduleWords(f.routine.cron_expr)}</span>
        ) : f.trigger ? (
          <span>{f.trigger.cron ? scheduleWords(f.trigger.cron) : humanize(f.trigger.on)}</span>
        ) : '—',
    },
    { key: 'nodes', header: 'Nodes', hideOnMobile: true, cell: f => <span className="text-xs text-fg-2">{kindsLine(f.kinds)}</span> },
    {
      key: 'last',
      header: 'Last run',
      align: 'right',
      sortable: true,
      sortValue: f => f.last_run?.created_at ?? '',
      cell: f => (
        <div className="flex items-center justify-end gap-1.5">
          {f.routine?.auto_paused_at && <Badge tone="alarm">Auto-paused</Badge>}
          <RunStatusBadge run={f.last_run} />
          {f.last_run && <TimeAgo className="text-xs text-fg-3" at={f.last_run.created_at} />}
        </div>
      ),
    },
  ]

  const selected = flows.find(f => f.id === selectedId) ?? null

  return (
    <div className="space-y-4" data-testid="workflows-panel">
      {!flowsEnabled && (
        <Alert tone="amber" title="Workflows are turned off for this install">
          Workflows, their charts and past runs stay visible here, but none run on their schedule or from Run now
          until an admin turns workflows on in Settings.
        </Alert>
      )}

      <section className="space-y-2">
        {/* Standalone, the panel carries its own create button. On the
            Workflows page the header owns it and the title already says
            "Workflows", so neither the button nor a repeat eyebrow shows. */}
        {!controlled && <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-eyebrow text-fg-3">
            <Workflow className="h-3.5 w-3.5" /> Workflows
            <span>{flows.length}</span>
          </h3>
          {workspaces.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => setNewOpen(true)}
              leftIcon={<Plus className="h-3.5 w-3.5" />}
              data-testid="new-workflow-button"
            >
              New workflow
            </Button>
          )}
        </div>}
        <p className="max-w-3xl text-sm leading-snug text-fg-2">
          A workflow is a chain of steps that runs on a schedule or a trigger, with no bot session per run. The model is used only where a
          workflow has an LLM step. A single instruction that repeats (like weekly research) is a scheduled task, listed under Runs; a strategy is the goal card either one can report to. Each one has a home card on the board. Pick a row to see its flow chart.
        </p>
        <DataTable
          columns={columns}
          rows={flows}
          rowKey={f => f.id}
          loading={loading}
          onRowClick={f => onSelect(f.id === selectedId ? null : f.id)}
          mobileTitle={f => <span className="font-medium text-fg-0">{f.name}</span>}
          rowActions={f => <FlowRunNowButton flow={f} disabled={!flowsEnabled || f.published_version == null} onRunNow={onRunNow} />}
          empty={{
            icon: <GitBranch className="h-5 w-5" />,
            title: 'No workflows yet',
            description: 'Start one with New workflow: describe the goal and a builder bot drafts and self-tests it. Bots and outside agents can do the same over the API or MCP.',
          }}
        />
      </section>

      <NewWorkflowDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        workspaces={workspaces}
        defaultWorkspace={defaultWorkspace}
        labelOf={labelOf}
        onCreated={onCreated}
      />

      {selected && (
        <FlowDetail key={selected.id} flow={selected} labelOf={labelOf} flowsEnabled={flowsEnabled} onRunNow={onRunNow} onRunLifecycle={onRunLifecycle} onOpenRunLog={onOpenRunLog} onDetailsSaved={onDetailsSaved} />
      )}
    </div>
  )
}

function FlowRunNowButton({
  flow,
  disabled,
  onRunNow,
}: {
  flow: FlowSummary
  disabled: boolean
  onRunNow: (flowId: number) => Promise<{ ok: boolean; reason?: string }>
}) {
  const [busy, setBusy] = useState(false)
  // "Queued" is a moment, not a state: a ui/Toaster toast (UI SDK, live
  // region; obj 900819), then the run's own status takes over in the table.
  const run = useCallback(async () => {
    setBusy(true)
    const r = await onRunNow(flow.id)
    setBusy(false)
    if (r.ok) toast.success(`Queued: ${flow.name}`)
    else toast.error(`Blocked: ${flow.name}`, { description: r.reason ? (/^[a-z0-9_]+$/.test(r.reason) ? humanize(r.reason) : r.reason) : 'Something went wrong. Try again in a moment.' })
  }, [flow.id, flow.name, onRunNow])
  return (
    <div className="flex items-center gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={e => { e.stopPropagation(); void run() }}
        disabled={busy || disabled}
        title={disabled ? 'Needs a published version, and workflows turned on in Settings' : undefined}
        leftIcon={<Play className={cn('h-3.5 w-3.5', busy && 'animate-pulse')} />}
      >
        {busy ? 'Queuing…' : 'Run now'}
      </Button>
    </div>
  )
}

function FlowDetail({
  flow,
  labelOf,
  flowsEnabled,
  onRunNow,
  onRunLifecycle,
  onOpenRunLog,
  onDetailsSaved,
}: {
  flow: FlowSummary
  labelOf: (ws: string) => string
  flowsEnabled: boolean
  onRunNow: (flowId: number) => Promise<{ ok: boolean; reason?: string }>
  onRunLifecycle?: () => void
  onOpenRunLog?: (flow: FlowSummary, runId: number | null) => void
  onDetailsSaved?: () => void
}) {
  const [version, setVersion] = useState<number | null>(null)
  const { detail, error, reload } = useFlowDetail(flow.id, version)
  /** A run picked from the Recent runs table; null = follow the latest run of the shown version. */
  const [runId, setRunId] = useState<number | null>(null)
  /**
   * The run the overlay draws: the picked one, else (B9) a run parked on a wait,
   * else the latest run of the shown version.
   */
  const parkedRunId = detail?.runs.find(r => r.status === 'waiting')?.id ?? null
  /** The run whose steps (and open waits) are listed below the chart: picked, or parked (B9). */
  const openRunId = runId ?? parkedRunId
  const overlayRunId = openRunId ?? detail?.status_run_id ?? null
  const overlayRunStatus = detail?.runs.find(r => r.id === overlayRunId)?.status ?? null
  const [overlayRun, setOverlayRun] = useState<FlowRunDetailResponse | null>(null)
  const [overlayTick, setOverlayTick] = useState(0)
  const [view, setView] = useState<'canvas' | 'mermaid'>('canvas')
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const runDetail = openRunId != null && overlayRun?.run.id === openRunId ? overlayRun : null

  // Fallback: keep the overlay current while a run is in flight even without a socket.
  useEffect(() => {
    if (!detail?.runs.some(r => ['queued', 'running', 'waiting', 'repairing'].includes(r.status))) return
    const t = setInterval(() => { void reload(); setOverlayTick(n => n + 1) }, 4000)
    return () => clearInterval(t)
  }, [detail, reload])

  useEffect(() => {
    if (overlayRunId == null) { setOverlayRun(null); return }
    let cancelled = false
    fetchFlowRun(flow.id, overlayRunId)
      .then(d => { if (!cancelled) setOverlayRun(d) })
      .catch(() => { if (!cancelled) setOverlayRun(null) })
    return () => { cancelled = true }
  }, [flow.id, overlayRunId, overlayRunStatus, overlayTick])

  // Live overlay (B7): the server pushes `flow_step` (ids + status) the moment a
  // step row is written; refetch the run it names (debounced in the hook).
  const overlayRef = useRef(overlayRunId)
  overlayRef.current = overlayRunId
  const lifecycleRef = useRef(onRunLifecycle)
  lifecycleRef.current = onRunLifecycle
  useFlowLiveEvents(flow.id, useCallback((events: FlowLiveEvent[]) => {
    const current = overlayRef.current
    if (events.some(e => e.run_id === current)) setOverlayTick(n => n + 1)
    // A new run started, or one finished: the runs table and "latest run" move.
    if (events.some(e => e.run_id !== current || e.event !== 'step')) void reload()
    // ...and so does the workflows table's Last run column.
    if (events.some(e => e.event !== 'step')) lifecycleRef.current?.()
  }, [reload]))

  const shownRun = overlayRun?.run ?? (detail?.status_run_id != null ? detail.runs.find(r => r.id === detail.status_run_id) ?? null : null)
  const mermaid = (overlayRun?.run.version === detail?.version ? overlayRun?.mermaid : null) || detail?.mermaid || ''
  const nodeStatus = overlayRun && overlayRun.run.version === detail?.version ? overlayRun.node_status : detail?.node_status
  const changeByNode = useMemo(() => {
    const out: Record<string, FlowNodeChange> = {}
    for (const id of detail?.changes?.changed ?? []) out[id] = 'changed'
    for (const id of detail?.changes?.added ?? []) out[id] = 'added'
    return out
  }, [detail?.changes])
  const approvedNodes = detail?.publish?.approvals && detail.publish.approvals.version === detail.version ? detail.publish.approvals.nodes : undefined

  const runColumns: Column<FlowRunSummary>[] = useMemo(() => [
    { key: 'id', header: 'Run', mono: true, cell: r => <Badge tone="neutral" mono>#{r.id}</Badge> },
    { key: 'status', header: 'Status', cell: r => <RunStatusBadge run={r} /> },
    { key: 'trigger', header: 'Trigger', hideOnMobile: true, cell: r => r.trigger_source ? humanize(r.trigger_source) : '—' },
    { key: 'version', header: 'Version', hideOnMobile: true, cell: r => `v${r.version}` },
    {
      key: 'error',
      header: 'Error',
      cell: r => r.error ? <span className="line-clamp-1 text-xs text-danger" title={r.error.type}>{r.error.title}</span> : <span className="text-fg-3">—</span>,
    },
    { key: 'dur', header: 'Took', align: 'right', hideOnMobile: true, cell: r => duration(r) },
    { key: 'cost', header: 'Cost', align: 'right', hideOnMobile: true, cell: r => (r.spent_usd > 0 ? formatCost(r.spent_usd) : '—') },
    { key: 'age', header: 'Started', align: 'right', cell: r => <TimeAgo at={r.created_at} /> },
  ], [])

  return (
    <section className="space-y-3 rounded-lg border border-line bg-surface-1 p-4" data-testid="flow-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold text-fg-0">{flow.name}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-fg-2">
            <Badge tone="neutral">{labelOf(flow.workspace)}</Badge>
            <Badge tone={flow.status === 'active' ? 'verify' : 'neutral'}>{humanize(flow.status)}</Badge>
            {flow.routine && (
              <span>
                {scheduleWords(flow.routine.cron_expr)}
                {flow.routine.enabled && flow.routine.next_run_at ? ` · next run ${formatRelativeTime(flow.routine.next_run_at)}` : ' · schedule paused'}
              </span>
            )}
            {flow.objective_id != null && (
              <a className="inline-flex items-center gap-1 text-accent-hover hover:underline" href={`/o/${flow.objective_id}`}>
                <ExternalLink className="h-3 w-3" /> home card #{flow.objective_id}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {detail && detail.versions.length > 1 && (
            <Select
              aria-label="Version"
              value={detail.version == null ? '' : String(detail.version)}
              onChange={v => { setRunId(null); setSelectedNode(null); setVersion(Number(v)) }}
            >
              {detail.versions.map(v => (
                <option key={v.version} value={v.version}>v{v.version}{v.published ? ' (published)' : ' (draft)'}</option>
              ))}
            </Select>
          )}
          <FlowRunNowButton flow={flow} disabled={!flowsEnabled || flow.published_version == null} onRunNow={async id => { const r = await onRunNow(id); void reload(); return r }} />
        </div>
      </div>

      {flow.routine?.auto_paused_at && (
        <Alert tone="alarm" title="Schedule auto-paused">
          <span className="text-xs">{flow.routine.auto_pause_reason}</span> — use Resume in the banner at the top of Workflows.
        </Alert>
      )}
      {error && (
        <Alert tone="alarm" title="Could not load workflow">
          {friendlyError(error).message}
          <details className="mt-1 text-xs text-fg-3"><summary>Details</summary>{error}</details>
        </Alert>
      )}

      <FlowAboutSection
        flow={flow}
        goal={detail?.definition?.goal?.statement || detail?.builder?.goal || null}
        doneWhen={detail?.builder?.done_when ?? detail?.publish?.end_condition?.contract.done_when ?? null}
        onSaved={() => onDetailsSaved?.()}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-fg-2">
        <span data-testid="flow-status-caption">
          {shownRun
            ? <>Step status from run <span className="font-mono">#{shownRun.id}</span> ({humanize(shownRun.status).toLowerCase()}, <TimeAgo at={shownRun.created_at} />){runDetail ? '' : ' — the latest run of this version'}</>
            : 'No runs of this version yet — the chart shows the definition only.'}
        </span>
        <div className="flex items-center gap-2">
          {runId != null && <Button variant="ghost" size="sm" onClick={() => setRunId(null)}>Back to latest run</Button>}
          <SegmentedControl label="Chart view" items={CHART_VIEWS} value={view} onChange={k => setView(k === 'mermaid' ? 'mermaid' : 'canvas')} />
        </div>
      </div>
      {detail?.changes && (
        <div className="text-xs text-fg-2" data-testid="flow-version-changes">
          <span className="font-mono">v{detail.version}</span> vs <span className="font-mono">v{detail.changes.base_version}</span>
          {' '}by <span className="font-mono">{detail.changes.author}</span>:{' '}
          {[
            detail.changes.added.length && `${detail.changes.added.length} new`,
            detail.changes.changed.length && `${detail.changes.changed.length} changed`,
            detail.changes.removed.length && `${detail.changes.removed.length} removed (${detail.changes.removed.join(', ')})`,
          ].filter(Boolean).join(' · ') || 'no node changes'}
          {(detail.changes.added.length > 0 || detail.changes.changed.length > 0) && ' — tagged on the chart'}
        </div>
      )}
      {detail && detail.version == null ? (
        <Alert tone="info" title="No version yet">
          {detail.builder
            ? <>The builder{detail.builder.objective_id != null ? <> on card <a className="text-accent-hover hover:underline" href={`/o/${detail.builder.objective_id}`}>#{detail.builder.objective_id}</a></> : null} is turning the goal into a first draft ({detail.builder.used}/{detail.builder.max} drafts used). The chart appears once a version validates.</>
            : 'This workflow has no version yet.'}
        </Alert>
      ) : view === 'canvas' ? (
        <>
          <div className={cn('grid gap-3', selectedNode && 'lg:grid-cols-[minmax(0,1fr)_360px]')}>
            {detail && detail.version != null && detail.definition
              ? (
                <FlowCanvas
                  definition={detail.definition}
                  version={detail.version}
                  status={nodeStatus}
                  steps={overlayRun && overlayRun.run.version === detail.version ? overlayRun.steps : undefined}
                  changes={changeByNode}
                  changeAuthor={detail.changes?.author}
                  approvedNodes={approvedNodes}
                  selectedNodeId={selectedNode}
                  onSelectNode={setSelectedNode}
                />
              )
              : <div className="h-40 animate-pulse rounded-lg bg-surface-2" />}
            {selectedNode && detail && detail.version != null && (
              <FlowNodeInspector
                flowId={flow.id}
                nodeId={selectedNode}
                runId={overlayRun && overlayRun.run.version === detail.version ? overlayRun.run.id : null}
                version={detail.version}
                refreshKey={overlayTick}
                onClose={() => setSelectedNode(null)}
              />
            )}
          </div>
          <FlowCanvasLegend />
        </>
      ) : (
        <>
          {mermaid ? <FlowDiagram source={mermaid} /> : <div className="h-40 animate-pulse rounded-lg bg-surface-2" />}
          <FlowDiagramLegend />
        </>
      )}

      {detail?.publish && (
        <FlowSelfTestPanel
          flowId={flow.id}
          publish={detail.publish}
          publishedVersion={detail.flow.published_version}
          flowsEnabled={flowsEnabled}
          onChanged={() => { void reload() }}
          onOpenRun={setRunId}
        />
      )}

      {runDetail && runDetail.waits?.length > 0 && (
        <FlowRunWaitsPanel
          flowId={flow.id}
          runId={runDetail.run.id}
          waits={runDetail.waits}
          onChanged={() => { setOverlayTick(n => n + 1); void reload() }}
        />
      )}

      {runDetail && runDetail.steps.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">
            Steps of run #{runDetail.run.id}{runDetail.run.mode !== 'live' ? ` (${humanize(runDetail.run.mode).toLowerCase()} self-test — nothing was sent)` : ''}
          </h4>
          <ul className="divide-y divide-line rounded-md border border-line text-xs">
            {runDetail.steps.map((s, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 px-2 py-1.5">
                <span className="w-32 truncate font-mono text-fg-0">{s.node_id}{s.iteration ? `[${s.iteration}]` : ''}</span>
                <Badge tone={s.status === 'succeeded' ? 'verify' : s.status === 'failed' ? 'alarm' : 'amber'}>
                  {s.status === 'running' && runDetail.run.status === 'waiting' ? 'Waiting' : humanize(s.status)}
                </Badge>
                <span className="text-fg-3">attempt {s.attempt}</span>
                {s.effect && <span className="text-fg-3">{humanize(s.effect).toLowerCase()}</span>}
                {s.simulated && (
                  <Badge tone="amber">{humanize(s.simulated)}</Badge>
                )}
                {s.simulated?.startsWith('would_') && s.input_preview && (
                  <span className="min-w-0 flex-1 truncate font-mono text-fg-3" title={s.input_preview}>{s.input_preview}</span>
                )}
                {s.error && (
                  <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-danger" title={s.error.detail ?? s.error.type}>
                    <AlertTriangle className="h-3 w-3 shrink-0" /> {s.error.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">Recent runs</h4>
          {onOpenRunLog && (detail?.runs.length ?? 0) > 0 && (
            <Button variant="ghost" size="sm" onClick={() => onOpenRunLog(flow, null)}>All runs</Button>
          )}
        </div>
        <DataTable
          columns={runColumns}
          rows={detail?.runs ?? []}
          rowKey={r => r.id}
          onRowClick={r => setRunId(r.id)}
          rowActions={onOpenRunLog ? r => (
            <Button variant="secondary" size="sm" onClick={ev => { ev.stopPropagation(); onOpenRunLog(flow, r.id) }}>Log</Button>
          ) : undefined}
          mobileTitle={r => <span className="font-mono">#{r.id}</span>}
          empty={{ title: 'No runs yet', description: flowsEnabled ? 'Run now, or wait for the schedule.' : 'Workflows are switched off.' }}
        />
      </div>
    </section>
  )
}
