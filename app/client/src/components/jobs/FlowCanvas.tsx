import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Background, Controls, Handle, MiniMap, Position, ReactFlow, type NodeProps, type NodeTypes,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './flow-canvas.css'
import { useBoardTheme } from '../../preview/BoardShell'
import type { FlowNodeRunStatus } from '../../../../shared/flow/types'
import type { FlowNodeChange } from '../../../../shared/flow/diff'
import { buildFlowGraph, type FlowNodeData, type FlowRFNode } from '../../lib/flow-graph'
import { cn } from '../ui'
import { EFFECT_STYLE, KIND_TINT, STATUS_STYLE } from './flow-colors'

/**
 * Read-only workflow canvas, viewer V2 (card B7, docs/design/WORKFLOWS.md §6.2).
 * React Flow + dagre; a pure function of (definition, run overlay, version diff).
 *
 * READ-ONLY BY CONSTRUCTION: nothing here can change a definition. No
 * onNodesChange / onEdgesChange / onConnect* / onReconnect* / onNodeDrag* /
 * delete handlers are registered, nodes are not draggable or connectable,
 * handles are not connectable, delete/selection keys are off, and there is no
 * edit toolbar. The only interaction is click-to-inspect (and pan/zoom).
 */

export { STATUS_STYLE, EFFECT_STYLE }

function ChangeTag({ change, author }: { change?: FlowNodeChange; author?: string }) {
  if (!change) return null
  return (
    <span
      className="absolute -right-2 -top-2.5 rounded-full border border-accent bg-surface-0 px-1.5 py-px font-mono text-xs font-semibold uppercase tracking-eyebrow text-accent-hover shadow-sm"
      title={`${change === 'added' ? 'added' : 'changed'} in this version${author ? ` by ${author}` : ''}`}
      data-testid="flow-node-change"
    >
      {change === 'added' ? 'new' : 'changed'}
    </span>
  )
}

function statusOutline(status?: FlowNodeRunStatus): React.CSSProperties {
  if (!status) return {}
  const s = STATUS_STYLE[status]
  return { outline: `3px ${s.style} ${s.color}`, outlineOffset: 2 }
}

// Handles exist only so React Flow can anchor edges; they are never connectable.
const HIDDEN_HANDLE = '!h-1 !w-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

const FlowStepNode = memo(function FlowStepNode({ data }: NodeProps<FlowRFNode>) {
  const d = data as FlowNodeData
  const tint = KIND_TINT[d.kind]
  const eff = d.effect ? EFFECT_STYLE[d.effect] : undefined
  const pill = d.kind === 'trigger' || d.kind === 'end'
  return (
    <div
      className={cn(
        'relative flex h-full w-full cursor-pointer flex-col justify-center gap-0.5 border bg-surface-1 px-3 py-1.5 text-left shadow-sm transition-shadow',
        pill ? 'rounded-full px-5' : d.kind === 'llm' ? 'rounded-2xl' : 'rounded-lg',
        d.kind === 'agent' && 'border-[3px] border-double',
        d.status === 'skipped' && 'opacity-55',
        d.status === 'running' && 'animate-pulse',
        d.selected && 'ring-2 ring-accent ring-offset-2 ring-offset-surface-0',
      )}
      style={{
        background: eff?.bg ?? tint?.bg,
        borderColor: eff?.border ?? tint?.accent ?? undefined,
        borderLeftWidth: pill ? undefined : 4,
        borderLeftColor: tint?.accent ?? eff?.border,
        ...statusOutline(d.status),
      }}
      data-testid={`flow-node-${d.id}`}
      data-kind={d.kind}
      data-effect={d.effect ?? ''}
      data-status={d.status ?? ''}
      data-change={d.change ?? ''}
      title={d.label ? `${d.label} (${d.id})` : d.id}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} isConnectableStart={false} isConnectableEnd={false} className={HIDDEN_HANDLE} />
      <ChangeTag change={d.change} author={d.changeAuthor} />
      {d.label && <div className="truncate text-xs font-medium text-fg-2">{d.label}</div>}
      <div className="truncate text-sm font-semibold text-fg-0">{d.title}</div>
      <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
        {eff && (
          <span className="shrink-0 rounded px-1 font-mono text-xs font-semibold" style={{ color: eff.border, border: `1px solid ${eff.border}` }}>
            {eff.text}
          </span>
        )}
        {d.effect === 'read' && d.kind !== 'trigger' && <span className="shrink-0 font-mono text-xs text-fg-3">read</span>}
        <span className="truncate">{[d.approval, ...d.lines].filter(Boolean).join(' · ')}</span>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} isConnectableStart={false} isConnectableEnd={false} className={HIDDEN_HANDLE} />
    </div>
  )
})

const FlowLoopNode = memo(function FlowLoopNode({ data }: NodeProps<FlowRFNode>) {
  const d = data as FlowNodeData
  return (
    <div
      className={cn(
        'relative h-full w-full cursor-pointer rounded-xl border-2 border-dashed border-line-strong bg-surface-2/40',
        d.selected && 'ring-2 ring-accent ring-offset-2 ring-offset-surface-0',
      )}
      style={statusOutline(d.status)}
      data-testid={`flow-node-${d.id}`}
      data-kind="loop"
      data-status={d.status ?? ''}
      data-change={d.change ?? ''}
    >
      <Handle type="target" position={Position.Top} isConnectable={false} isConnectableStart={false} isConnectableEnd={false} className={HIDDEN_HANDLE} />
      <ChangeTag change={d.change} author={d.changeAuthor} />
      <div className="min-w-0 px-3 pt-1.5">
        <div className="truncate text-sm font-semibold text-fg-0" title={d.label ? `${d.label} — ${d.title}` : d.title}>
          {d.label ? `${d.label} — ` : ''}{d.title}
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-2">
          <span className="shrink-0">{d.lines.join(' · ')}</span>
          {d.loopCounts && (
            <span className="truncate rounded bg-surface-1 px-1 font-mono text-fg-1" data-testid={`flow-loop-counts-${d.id}`} title={d.loopCounts}>
              {d.loopCounts}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} isConnectable={false} isConnectableStart={false} isConnectableEnd={false} className={HIDDEN_HANDLE} />
    </div>
  )
})

const NODE_TYPES: NodeTypes = { flowStep: FlowStepNode, flowLoop: FlowLoopNode }

export interface FlowCanvasProps {
  definition: { nodes?: unknown; version?: number } | null | undefined
  status?: Readonly<Record<string, FlowNodeRunStatus>>
  steps?: readonly { node_id: string; iteration: number; attempt: number; status: string }[]
  changes?: Readonly<Record<string, FlowNodeChange>>
  changeAuthor?: string
  approvedNodes?: readonly string[]
  version?: number
  selectedNodeId?: string | null
  onSelectNode?: (nodeId: string | null) => void
  className?: string
}

export function FlowCanvas({
  definition, status, steps, changes, changeAuthor, approvedNodes, version, selectedNodeId, onSelectNode, className,
}: FlowCanvasProps) {
  const { theme } = useBoardTheme()
  const graph = useMemo(
    () => buildFlowGraph(definition, { status, steps, changes, changeAuthor, approvedNodes, version }),
    [definition, status, steps, changes, changeAuthor, approvedNodes, version],
  )
  const nodes = useMemo(
    () => (selectedNodeId ? graph.nodes.map(n => (n.id === selectedNodeId ? { ...n, data: { ...n.data, selected: true } } : n)) : graph.nodes),
    [graph.nodes, selectedNodeId],
  )
  // Readable default view: fit the WIDTH (zoom 0.45–1) and anchor at the top, so a
  // long flow opens legible at its trigger instead of shrunk to a sliver; pan or
  // use the fit-view control for the rest. Recomputed when the definition changes.
  const wrapRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const set = () => setWidth(el.clientWidth)
    set()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(set) : null
    ro?.observe(el)
    return () => ro?.disconnect()
  }, [graph.nodes.length > 0])
  const PAD = 24
  const zoom = width > 0 ? Math.min(1, Math.max(0.45, (width - 2 * PAD) / Math.max(1, graph.width))) : 1
  const height = Math.round(Math.min(820, Math.max(320, graph.height * zoom + 2 * PAD)))
  const viewport = { x: Math.max(PAD, (width - graph.width * zoom) / 2), y: PAD, zoom }

  if (graph.nodes.length === 0) {
    return <div className="flex h-40 items-center justify-center rounded-lg border border-line text-xs text-fg-3">No nodes to draw.</div>
  }
  return (
    <div ref={wrapRef} className={cn('ok-flow overflow-hidden rounded-lg border border-line bg-surface-0', className)} style={{ height }} data-testid="flow-canvas">
      <ReactFlow
        key={width > 0 ? `w${Math.round(width / 50)}-${graph.nodes.length}-${String(version ?? '')}` : 'measuring'}
        defaultViewport={viewport}
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={NODE_TYPES}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        edgesFocusable={false}
        edgesReconnectable={false}
        elementsSelectable
        selectNodesOnDrag={false}
        connectOnClick={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        zoomOnDoubleClick={false}
        zoomOnScroll={false}
        panOnScroll={false}
        preventScrolling={false}
        panOnDrag
        fitView={width === 0}
        fitViewOptions={{ padding: 0.12 }}
        minZoom={0.15}
        maxZoom={1.6}
        onNodeClick={(_, n) => onSelectNode?.(n.id)}
        onPaneClick={() => onSelectNode?.(null)}
        colorMode={theme}
        // MIT-licensed; the attribution stays, muted in our tokens (flow-canvas.css).
        proOptions={{ hideAttribution: false }}
      >
        <Background gap={20} size={1} />
        <Controls showInteractive={false} position="bottom-right" />
        <MiniMap pannable={false} zoomable={false} position="top-right" className="!hidden md:!block" />
      </ReactFlow>
    </div>
  )
}

/** What colours and outlines mean — kept next to the canvas. */
export function FlowCanvasLegend() {
  const item = 'inline-flex items-center gap-1.5'
  const sw = 'inline-block h-3 w-3 rounded-sm border-2'
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-2" data-testid="flow-canvas-legend">
      <span className={item}>⏰ trigger</span>
      <span className={item}>🔧 tool</span>
      <span className={item}>🔌 MCP connector</span>
      <span className={item}><span className={sw} style={{ background: KIND_TINT.llm!.bg, borderColor: KIND_TINT.llm!.accent }} />🧠 LLM</span>
      <span className={item}><span className={sw} style={{ borderColor: KIND_TINT.agent!.accent, borderStyle: 'double' }} />🤖 agent</span>
      <span className={item}><span className={sw} style={{ borderStyle: 'dashed' }} />🔁 loop group</span>
      {Object.entries(EFFECT_STYLE).map(([k, v]) => (
        <span key={k} className={item}><span className={sw} style={{ background: v.bg, borderColor: v.border }} />{v.text}</span>
      ))}
      <span className="text-fg-3">·</span>
      {Object.entries(STATUS_STYLE).map(([k, v]) => (
        <span key={k} className={item}><span className={sw} style={{ borderColor: v.color, borderStyle: v.style }} />{v.label}</span>
      ))}
      <span className={item}>
        <span className="rounded-full border border-accent px-1 font-mono text-xs uppercase text-accent-hover">changed</span> vs previous version
      </span>
    </div>
  )
}
