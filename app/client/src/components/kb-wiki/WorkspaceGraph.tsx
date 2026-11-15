import { useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Crosshair, Maximize2, Minimize2, Minus, Network, Plus } from 'lucide-react'
import { matchPages, shortTitle, visibleGraph, type WorkspaceGraphNode, type WorkspaceGraphResponse } from '../../lib/kbWiki'
import {
  boundsOf, fitView, layoutInputFor, layoutSignature, nodeRadius, positionsOf, reheat, simAt, tick, unpackPositions, zoomAt, ALPHA_MIN,
  type LayoutInput, type Positions, type Simulation, type View,
} from '../../lib/kbGraphLayout'
import { computeLayout, computeLayoutSync, SYNC_LAYOUT_MAX_NODES } from '../../lib/kbGraphLayoutRunner'
import { useKbResource } from '../../lib/kbResource'
import { kbGraphSpec, saveLayout, savedLayout } from '../../lib/kbContextData'
import { Alert, EmptyState, IconButton, SearchInput, Skeleton, cn } from '../ui'
import { Modal } from '../ui/Modal'
import { kindName, toneOf } from './kinds'

/* WorkspaceGraph (obj 900674) — the whole knowledge base as one Obsidian-style
   graph: every page a dot, every connection a line, read from the kb_edges
   table that #720162 added (GET /api/kb-wiki/graph). Pages that link a lot are
   bigger; hover a page to light up its neighbours, click to open it, drag to
   pull it around, scroll or pinch-buttons to zoom. Plain SVG + a small force
   layout (lib/kbGraphLayout) — no graph library, and only theme tokens, so it
   reads the same in light and dark. */

const HEIGHT = 560
const HEIGHT_PHONE = 420
/** Hubs whose names are always shown, however far out you zoom. */
const ALWAYS_LABELLED = 12
/** Past this many pages, the dots leave the Tab order — the "Find a page" box is the keyboard route. */
const MAX_TABBABLE = 150
const LABEL_ZOOM = 1.15
const DRAG_SLOP = 4

type Drag =
  | { kind: 'pan'; id: number; sx: number; sy: number; vx: number; vy: number; moved: boolean }
  | { kind: 'node'; id: number; index: number; sx: number; sy: number; moved: boolean }

/** What the graph draws: the visible pages and links, and the settled layout they sit in (always a matching pair). */
interface Drawn {
  shown: { nodes: WorkspaceGraphNode[]; links: WorkspaceGraphResponse['links'] }
  sim: Simulation
}

/** A layout stored for exactly this graph: rebuild it at rest, with no ticks at all. */
function simFromSaved(input: LayoutInput, pos: Record<string, [number, number]>): Simulation | null {
  const xs = new Float64Array(input.ids.length)
  const ys = new Float64Array(input.ids.length)
  for (let i = 0; i < input.ids.length; i++) {
    const p = pos[input.ids[i]]
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
    xs[i] = p[0]; ys[i] = p[1]
  }
  return simAt(input, xs, ys)
}

export function WorkspaceGraph({
  workspace,
  onOpenNote,
  refreshKey = 0,
  fill = false,
}: {
  workspace: string
  /** Open a page; `root` is the absolute folder `rel` is relative to. */
  onOpenNote: (rel: string, root?: string) => void
  refreshKey?: number
  /** Grow to the height of the parent (a flex column) instead of a fixed height. */
  fill?: boolean
}) {
  // Cached per user (obj 900867): a return visit draws the last graph at once; the server is asked again in the background.
  const graphRes = useKbResource(kbGraphSpec(workspace), { refreshKey })
  const { data, error, loading } = graphRes
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(() => new Set())
  const [showIsolated, setShowIsolated] = useState(true)
  const [query, setQuery] = useState('')
  const [hover, setHover] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [size, setSize] = useState({ w: 800, h: HEIGHT })
  const [view, setView] = useState<View | null>(null)
  // Bumped every animation frame while the layout moves (after a drag).
  const [, setFrame] = useState(0)

  // The box and the <svg> are also kept as state: going full screen re-mounts
  // them inside the dialog, and the size observer / wheel listener must follow.
  const box = useRef<HTMLDivElement | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null)
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null)
  const boxRef = useCallback((el: HTMLDivElement | null) => { box.current = el; setBoxEl(el) }, [])
  const svgCallbackRef = useCallback((el: SVGSVGElement | null) => { svgRef.current = el; setSvgEl(el) }, [])
  const fullBtn = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const drag = useRef<Drag | null>(null)
  const raf = useRef<number | null>(null)

  const wanted = useMemo(() => (data ? visibleGraph(data, { hiddenKinds, showIsolated }) : null), [data, hiddenKinds, showIsolated])

  // ── Layout (obj 900867) ──
  // 1. The server's layout (sent with the graph, cached with it) places every drawn
  //    page → drawn at once, zero ticks. Hiding a kind keeps everyone else in place.
  // 2. The layout saved in this browser for exactly this graph → zero ticks.
  // 3. A small graph → settled inline (a few ms), seeded from what we have.
  // 4. A big graph → settled in a Web Worker, seeded from what we have, while the
  //    previous drawing (or a skeleton) stays on screen and the page stays responsive.
  const serverPos = useMemo<Positions | null>(() => (data?.layout ? unpackPositions(data.nodes.map(n => n.rel), data.layout.pos) : null), [data])
  const input = useMemo(() => (wanted ? layoutInputFor(wanted.nodes, wanted.links) : null), [wanted])
  const sig = useMemo(() => (input ? layoutSignature(input) : null), [input])
  const instant = useMemo<{ sim: Simulation; fresh: boolean } | null>(() => {
    if (!input || !sig) return null
    if (serverPos) {
      const sim = simFromSaved(input, serverPos)
      if (sim) return { sim, fresh: false }
    }
    const saved = savedLayout(workspace)
    if (saved && saved.sig === sig) {
      const sim = simFromSaved(input, saved.pos)
      if (sim) return { sim, fresh: false }
    }
    if (input.ids.length <= SYNC_LAYOUT_MAX_NODES) return { sim: computeLayoutSync(input, saved?.pos ?? serverPos).sim, fresh: true }
    return null
  }, [input, sig, workspace, serverPos])
  const [settledRaw, setSettled] = useState<(Drawn & { sig: string; ws: string }) | null>(null)
  const settled = settledRaw?.ws === workspace ? settledRaw : null
  useEffect(() => {
    if (!input || !sig || !wanted) return
    if (instant) {
      if (instant.fresh) saveLayout(workspace, { sig, pos: positionsOf(instant.sim) })
      return
    }
    const ctrl = new AbortController()
    computeLayout(input, { seed: savedLayout(workspace)?.pos ?? serverPos, signal: ctrl.signal })
      .then(run => {
        if (!run || ctrl.signal.aborted) return
        saveLayout(workspace, { sig, pos: positionsOf(run.sim) })
        setSettled({ shown: wanted, sim: run.sim, sig, ws: workspace })
      })
      .catch(() => {})
    return () => ctrl.abort()
  }, [input, sig, wanted, instant, workspace, serverPos])
  // What is on screen: this graph when its layout is ready, else the last one drawn (never a mismatched pair).
  const drawn: Drawn | null = wanted && instant ? { shown: wanted, sim: instant.sim } : settled
  const laying = !!wanted && !instant && settled?.sig !== sig
  const sim = drawn?.sim ?? null
  const shown = drawn?.shown ?? null

  const byRel = useMemo(() => new Map((shown?.nodes ?? []).map((n, i) => [n.rel, { node: n, i }])), [shown])
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const l of shown?.links ?? []) {
      if (!m.has(l.a)) m.set(l.a, new Set())
      if (!m.has(l.b)) m.set(l.b, new Set())
      m.get(l.a)!.add(l.b); m.get(l.b)!.add(l.a)
    }
    return m
  }, [shown])
  // The best-connected people, companies, projects and topics keep their names at any zoom (not sources: there are many, and they read as files).
  const hubs = useMemo(() => new Set([...(shown?.nodes ?? [])].filter(n => n.kind !== 'source' && n.degree > 0).sort((a, b) => b.degree - a.degree).slice(0, ALWAYS_LABELLED).map(n => n.rel)), [shown])
  const matches = useMemo(() => (shown ? matchPages(shown.nodes, query) : []), [shown, query])
  const matchSet = useMemo(() => new Set(matches.map(m => m.rel)), [matches])

  // ── Size ──
  useEffect(() => {
    const el = boxEl
    if (!el) return
    const fit = () => {
      const w = Math.max(280, Math.round(el.clientWidth || 800))
      const h = expanded || fill ? Math.max(360, Math.round(el.clientHeight || window.innerHeight - 160)) : (w < 640 ? HEIGHT_PHONE : HEIGHT)
      setSize(s => (s.w === w && s.h === h ? s : { w, h }))
    }
    fit()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [boxEl, expanded, fill, data])

  const fit = useCallback(() => {
    if (sim) setView(fitView(boundsOf(sim.nodes), size.w, size.h))
  }, [sim, size.w, size.h])
  // Re-fit when the drawn set or the box changes.
  useEffect(() => { fit() }, [fit])

  // Full screen is a ui/Modal dialog (Escape closes it, focus is trapped). The
  // graph re-mounts inside it, so the "Full screen" button that opened it is
  // gone by the time it closes: put focus back on the inline one.
  const wasExpanded = useRef(false)
  useEffect(() => {
    if (wasExpanded.current && !expanded) fullBtn.current?.focus()
    wasExpanded.current = expanded
  }, [expanded])

  // Wheel zoom needs a non-passive listener to keep the page from scrolling.
  // Keyed on the element itself: going full screen mounts a new <svg>.
  useEffect(() => {
    const el = svgEl
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      setView(v => (v ? zoomAt(v, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top) : v))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [sim, svgEl])

  useEffect(() => () => { if (raf.current !== null) cancelAnimationFrame(raf.current) }, [])

  // ── Animation (only while something moves) ──
  const animate = useCallback(() => {
    if (!sim || raf.current !== null) return
    const step = () => {
      tick(sim)
      setFrame(f => f + 1)
      if (sim.alpha > ALPHA_MIN || drag.current?.kind === 'node') raf.current = requestAnimationFrame(step)
      else raf.current = null
    }
    raf.current = requestAnimationFrame(step)
  }, [sim])

  // ── Pointer: drag a dot, pan the background, click to open ──
  const toGraph = (clientX: number, clientY: number) => {
    const r = svgRef.current!.getBoundingClientRect()
    const v = view ?? { x: 0, y: 0, k: 1 }
    return { x: (clientX - r.left - v.x) / v.k, y: (clientY - r.top - v.y) / v.k }
  }

  /** The dot under the pointer: the nearest one within its tap radius (≥ 22px on screen), so close dots never steal each other's taps. */
  const nodeAt = (clientX: number, clientY: number): { node: WorkspaceGraphNode; i: number } | undefined => {
    if (!sim || !shown || !svgRef.current) return undefined
    const p = toGraph(clientX, clientY)
    const k = view?.k ?? 1
    let best = -1, bestD = Infinity
    for (let i = 0; i < sim.nodes.length; i++) {
      const n = sim.nodes[i]
      const d = Math.hypot(n.x - p.x, n.y - p.y)
      if (d <= Math.max(nodeRadius(n.degree) + 4 / k, 22 / k) && d < bestD) { best = i; bestD = d }
    }
    return best < 0 ? undefined : { node: shown.nodes[best], i: best }
  }

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || !view) return
    const hit = nodeAt(e.clientX, e.clientY)
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (hit) drag.current = { kind: 'node', id: e.pointerId, index: hit.i, sx: e.clientX, sy: e.clientY, moved: false }
    else drag.current = { kind: 'pan', id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false }
  }

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d) {
      const rel = nodeAt(e.clientX, e.clientY)?.node.rel ?? null
      setHover(h => (h === rel ? h : rel))
      return
    }
    if (d.id !== e.pointerId) return
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < DRAG_SLOP) return
    d.moved = true
    if (d.kind === 'pan') {
      setView(v => (v ? { ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy } : v))
    } else if (sim) {
      const p = toGraph(e.clientX, e.clientY)
      const n = sim.nodes[d.index]
      n.fx = p.x; n.fy = p.y
      reheat(sim)
      animate()
    }
  }

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (d.kind === 'node' && sim) {
      const n = sim.nodes[d.index]
      n.fx = null; n.fy = null
      if (!d.moved) onOpenNote(n.id, data?.root)
    }
  }

  const zoomBy = (factor: number) => setView(v => (v ? zoomAt(v, factor, size.w / 2, size.h / 2) : v))
  const focusOn = (rel: string) => {
    const hit = byRel.get(rel)
    if (!hit || !sim) return
    const p = sim.nodes[hit.i]
    setView(v => { const k = Math.max(v?.k ?? 1, 1.4); return { k, x: size.w / 2 - p.x * k, y: size.h / 2 - p.y * k } })
    setHover(rel)
  }

  const toggleKind = (kind: string) => setHiddenKinds(s => {
    const next = new Set(s)
    if (next.has(kind)) next.delete(kind); else next.add(kind)
    return next
  })

  // ── Render ──
  if (loading && !data) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Loading the graph…</span>
        <Skeleton className="h-9 w-full sm:w-72" />
        <Skeleton className="h-[420px] w-full rounded-md sm:h-[560px]" />
      </div>
    )
  }
  if (error && !data) return <Alert tone="alarm" title="Couldn't load the graph">{error}</Alert>
  if (!data) return null
  if (data.nodes.length === 0) {
    return (
      <EmptyState
        compact
        icon={<Network className="h-5 w-5" aria-hidden="true" />}
        title="Nothing to graph yet"
        description="Upload files above or import your chats and calls. Every page they create shows up here as a dot, linked to the people, companies and topics it mentions."
      />
    )
  }
  if (!shown || !sim) {
    // A big graph is being arranged off the main thread (first visit, or the graph changed a lot).
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <span className="sr-only">Arranging {data.nodes.length} pages…</span>
        <Skeleton className="h-9 w-full sm:w-72" />
        <Skeleton className="h-[420px] w-full rounded-md sm:h-[560px]" />
      </div>
    )
  }

  const kinds = Object.entries(data.counts.by_kind).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const focus = hover && byRel.has(hover) ? hover : null
  const lit = focus ? new Set([focus, ...(neighbours.get(focus) ?? [])]) : null
  const searching = query.trim().length > 0
  const v = view ?? { x: size.w / 2, y: size.h / 2, k: 1 }
  const showAllLabels = v.k >= LABEL_ZOOM
  const tabbable = shown.nodes.length <= MAX_TABBABLE
  const pos = (rel: string) => sim.nodes[byRel.get(rel)!.i]
  const focusNode: WorkspaceGraphNode | null = focus ? byRel.get(focus)!.node : null
  const fp = focus ? pos(focus) : null
  const dim = (rel: string) => (lit ? !lit.has(rel) : searching ? !matchSet.has(rel) : false)
  const fontSize = 12 / v.k
  // Names that would overlap one already placed are skipped (the focused page and its neighbours win, then the hubs).
  const labels = new Set<string>()
  {
    const want = shown.nodes.filter(n => n.rel === focus || (lit?.has(n.rel) ?? false) || (searching && matchSet.has(n.rel)) || (!lit && !searching && (showAllLabels || hubs.has(n.rel))))
    want.sort((a, b) => Number(b.rel === focus) - Number(a.rel === focus) || b.degree - a.degree)
    const boxes: Array<[number, number, number, number]> = []
    for (const n of want) {
      const p = pos(n.rel)
      const text = shortTitle(n.title, n.rel === focus ? 40 : 22)
      const w = text.length * fontSize * (n.rel === focus ? 0.66 : 0.6)
      const x0 = p.x - w / 2, y0 = p.y + nodeRadius(n.degree) + 2 / v.k, x1 = x0 + w, y1 = y0 + fontSize * 1.25
      if (n.rel !== focus && boxes.some(b => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1])) continue
      boxes.push([x0, y0, x1, y1])
      labels.add(n.rel)
    }
  }

  // Group the links by how they look; faded first, highlighted last (drawn on top).
  const linkLayers: Array<{ key: string; d: string; count: number; on: boolean; faded: boolean; dashed: boolean }> = []
  {
    const byLook = new Map<string, { key: string; d: string[]; on: boolean; faded: boolean; dashed: boolean }>()
    for (const l of shown.links) {
      const a = pos(l.a), b = pos(l.b)
      const on = focus !== null && (l.a === focus || l.b === focus)
      const faded = !!((lit && !on) || (searching && !lit && !(matchSet.has(l.a) || matchSet.has(l.b))))
      const dashed = l.kinds.length === 1 && l.kinds[0] === 'cited_by'
      const key = `${on ? 2 : faded ? 0 : 1}${dashed ? 'd' : 's'}`
      let layer = byLook.get(key)
      if (!layer) byLook.set(key, (layer = { key, d: [], on, faded, dashed }))
      layer.d.push(`M${a.x} ${a.y}L${b.x} ${b.y}`)
    }
    for (const layer of [...byLook.values()].sort((x, y) => x.key.localeCompare(y.key))) {
      linkLayers.push({ ...layer, d: layer.d.join(''), count: layer.d.length })
    }
  }

  const body = (
    <div
      className={cn(
        'flex flex-col gap-3',
        fill && 'min-h-0 flex-1',
        expanded && 'min-h-0 flex-1',
      )}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <SearchInput
          value={query}
          onChange={e => { setQuery(e.target.value); setHover(null) }}
          onKeyDown={e => {
            if (e.key === 'Enter' && matches[0]) { e.preventDefault(); onOpenNote(matches[0].rel, data.root) }
          }}
          placeholder="Find a page"
          aria-label="Find a page in the graph (Enter opens the best match)"
          wrapClassName="w-full sm:w-72"
        />
        <span className="text-xs text-fg-3" aria-live="polite">
          {searching
            ? `${matches.length} match${matches.length === 1 ? '' : 'es'}${matches[0] ? ` — Enter opens “${shortTitle(matches[0].title, 28)}”` : ''}`
            : `${shown.nodes.length} page${shown.nodes.length === 1 ? '' : 's'} · ${shown.links.length} connection${shown.links.length === 1 ? '' : 's'}${laying ? ' · arranging the latest pages…' : ''}`}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show or hide page kinds">
        {kinds.map(([kind, count]) => {
          const on = !hiddenKinds.has(kind)
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => toggleKind(kind)}
              className={cn(
                'inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors duration-fast focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]',
                on ? 'border-line bg-surface-2 text-fg-1 hover:border-line-strong' : 'border-dashed border-line-soft text-fg-3 hover:text-fg-2',
              )}
            >
              <span className={cn('h-2 w-2 rounded-full', toneOf(kind).bg, !on && 'opacity-30')} aria-hidden="true" />
              {kindName(kind)}
              <span className="font-mono text-xs text-fg-3">{count}</span>
            </button>
          )
        })}
        <label className="ml-auto inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-xs text-fg-2 sm:min-h-[28px]">
          <input type="checkbox" className="h-4 w-4 accent-accent" checked={showIsolated} onChange={e => setShowIsolated(e.target.checked)} />
          Unconnected pages
        </label>
      </div>

      <div
        ref={boxRef}
        className={cn('relative overflow-hidden rounded-md border border-line-soft bg-surface-1', (expanded || fill) && 'min-h-[360px] flex-1')}
      >
        <svg
          ref={svgCallbackRef}
          width={size.w}
          height={size.h}
          viewBox={`0 0 ${size.w} ${size.h}`}
          className={cn('block touch-none select-none', (expanded || fill) && 'absolute inset-0', drag.current ? 'cursor-grabbing' : focus ? 'cursor-pointer' : 'cursor-grab')}
          role="group"
          aria-label={`Graph of ${shown.nodes.length} Context pages and ${shown.links.length} connections between them`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => { if (!drag.current) setHover(null) }}
        >
          <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
            {/* Links (obj 900867): a handful of <path>s — one per look (highlighted, faded,
                dashed) — instead of one <line> per link. 5,500 links used to be 5,500 DOM
                nodes React rebuilt on every hover; now they are at most six. */}
            <g aria-hidden="true">
              {linkLayers.map(layer => (
                <path
                  key={layer.key}
                  d={layer.d}
                  data-link-count={layer.count}
                  fill="none"
                  className={cn(layer.on ? 'stroke-accent' : 'stroke-line-strong', layer.faded && 'opacity-15')}
                  strokeWidth={(layer.on ? 1.6 : 0.9) / Math.sqrt(v.k)}
                  strokeDasharray={layer.dashed ? `${3 / v.k} ${3 / v.k}` : undefined}
                />
              ))}
            </g>
            {shown.nodes.map(n => {
              const p = pos(n.rel)
              const r = nodeRadius(n.degree)
              const isFocus = n.rel === focus
              const faded = dim(n.rel)
              return (
                <g
                  key={n.rel}
                  data-rel={n.rel}
                  role="button"
                  tabIndex={tabbable ? 0 : -1}
                  aria-label={`Open ${n.title} (${kindName(n.kind)}, ${n.degree} connection${n.degree === 1 ? '' : 's'})`}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenNote(n.rel, data.root) } }}
                  onFocus={() => focusOn(n.rel)}
                  onBlur={() => setHover(h => (h === n.rel ? null : h))}
                  className={cn('outline-none transition-opacity duration-fast', faded && 'opacity-20')}
                >
                  {(isFocus || (searching && matchSet.has(n.rel))) && (
                    <circle cx={p.x} cy={p.y} r={r + 3.5 / v.k} className="fill-none stroke-accent" strokeWidth={2 / v.k} />
                  )}
                  <circle cx={p.x} cy={p.y} r={r} className={cn(toneOf(n.kind).fill, 'stroke-surface-1')} strokeWidth={1.2 / v.k} />
                </g>
              )
            })}
            {/* Names in their own layer, above every dot, so a neighbour never covers one. */}
            <g aria-hidden="true" className="pointer-events-none">
              {shown.nodes.filter(n => labels.has(n.rel)).map(n => {
                const p = pos(n.rel)
                const isFocus = n.rel === focus
                return (
                  <text
                    key={n.rel}
                    x={p.x}
                    y={p.y + nodeRadius(n.degree) + fontSize + 2 / v.k}
                    textAnchor="middle"
                    paintOrder="stroke"
                    strokeWidth={3.5 / v.k}
                    strokeLinejoin="round"
                    fontSize={fontSize}
                    className={cn('stroke-surface-1', isFocus ? 'fill-fg-0 font-semibold' : 'fill-fg-1', dim(n.rel) && 'opacity-20')}
                  >
                    {shortTitle(n.title, isFocus ? 40 : 22)}
                  </text>
                )
              })}
            </g>
          </g>
        </svg>

        {focusNode && fp && !drag.current && (
          <div
            className="pointer-events-none absolute z-10 max-w-[260px] rounded-md border border-line bg-surface-2 px-3 py-2 shadow-lg"
            style={{
              left: Math.min(size.w - 270, Math.max(8, fp.x * v.k + v.x + 14)),
              top: Math.min(size.h - 80, Math.max(8, fp.y * v.k + v.y - 12)),
            }}
          >
            <div className="flex items-center gap-1.5 text-xs uppercase tracking-eyebrow text-fg-3">
              <span className={cn('h-2 w-2 rounded-full', toneOf(focusNode.kind).bg)} aria-hidden="true" />
              {kindName(focusNode.kind)}
            </div>
            <div className="mt-0.5 text-sm font-medium leading-snug text-fg-0">{focusNode.title}</div>
            <div className="mt-0.5 text-xs text-fg-2">
              {focusNode.degree} connection{focusNode.degree === 1 ? '' : 's'} · click to open
            </div>
          </div>
        )}

        <div className="absolute right-2 top-2 flex flex-col gap-1 rounded-md border border-line-soft bg-surface-2/90 p-0.5 backdrop-blur">
          <IconButton label="Zoom in" onClick={() => zoomBy(1.3)}><Plus className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label="Zoom out" onClick={() => zoomBy(1 / 1.3)}><Minus className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton label="Fit the whole graph" onClick={fit}><Crosshair className="h-4 w-4" aria-hidden="true" /></IconButton>
          <IconButton
            ref={fullBtn}
            label={expanded ? 'Exit full screen' : 'Full screen'}
            onClick={() => setExpanded(x => !x)}
            data-autofocus={expanded || undefined}
          >
            {expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </IconButton>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-fg-3">
        Bigger dots link to more pages. Hover a page to light up what it connects to, click to open it, drag it to pull its
        neighbours along. Dashed lines are “cited by a source” only.
        {data.truncated && ` The ${data.nodes.length} best-connected of ${data.counts.pages} pages are drawn.`}
        {!!data.counts.unresolved && ` ${data.counts.unresolved} link${data.counts.unresolved === 1 ? ' points' : 's point'} at a page that is not in this Context.`}
      </p>
    </div>
  )

  if (!expanded) return body
  // Full screen: a ui/Modal dialog covering the viewport (page behind inert,
  // focus trapped, Escape closes, focus returns to the inline button).
  return (
    <Modal
      open
      onClose={() => setExpanded(false)}
      labelledBy={titleId}
      panelClassName="inset-0 m-0 flex h-full max-h-none w-full max-w-none flex-col rounded-none border-0 overflow-x-hidden overflow-y-hidden bg-surface-0 p-3 shadow-none sm:p-5"
    >
      <span id={titleId} hidden>Context graph, full screen</span>
      {body}
    </Modal>
  )
}
