/* Where the knowledge-base graph layout runs (obj 900867).

   - Small graphs (≤ SYNC_LAYOUT_MAX_NODES pages) settle inline: a few ms, and
     the first paint already has every dot in place.
   - Bigger graphs settle in a Web Worker, so the page — the tree, the search
     box, the toolbar — stays responsive while the dots are arranged.
   - Where a worker can't start (old browser, test DOM), the same ticks run on
     the main thread in short slices that yield between frames, so the page
     still paints and answers input. */
import { createSimulation, layoutNow, seedPositions, settle, simAt, tick, ALPHA_MIN, type LayoutInput, type Positions, type Simulation } from './kbGraphLayout'

export const SYNC_LAYOUT_MAX_NODES = 200

/** Snap a finished layout to the 0.1px grid it is stored on, so a first visit and a return visit draw the very same picture. */
function snapped(run: LayoutRun): LayoutRun {
  for (const n of run.sim.nodes) { n.x = Math.round(n.x * 10) / 10; n.y = Math.round(n.y * 10) / 10 }
  return run
}
/** Main-thread budget per slice in the no-worker fallback. */
const SLICE_MS = 8
const MAX_TICKS = 300

export interface LayoutRun {
  sim: Simulation
  ticks: number
  where: 'sync' | 'worker' | 'sliced'
}

let worker: Worker | null | undefined
let nextId = 1
const pending = new Map<number, (r: { xs: Float64Array; ys: Float64Array; ticks: number } | null) => void>()

function getWorker(): Worker | null {
  if (worker !== undefined) return worker
  try {
    if (typeof Worker === 'undefined') { worker = null; return null }
    worker = new Worker(new URL('./kbGraphLayout.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (e: MessageEvent<{ id: number; xs: Float64Array; ys: Float64Array; ticks: number }>) => {
      const done = pending.get(e.data.id)
      pending.delete(e.data.id)
      done?.(e.data)
    }
    worker.onerror = () => {
      // The worker failed to load or crashed: fall back for this and every later layout.
      for (const done of pending.values()) done(null)
      pending.clear()
      worker?.terminate()
      worker = null
    }
  } catch {
    worker = null
  }
  return worker
}

function inWorker(input: LayoutInput, seed: Positions | null, exact: boolean): Promise<{ xs: Float64Array; ys: Float64Array; ticks: number } | null> {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  const id = nextId++
  return new Promise(resolve => {
    pending.set(id, resolve)
    try {
      w.postMessage({ id, input, seed, exact })
    } catch {
      pending.delete(id)
      resolve(null)
    }
  })
}

function sliced(input: LayoutInput, seed: Positions | null, exact: boolean, signal?: AbortSignal): Promise<LayoutRun | null> {
  const sim = createSimulation(input.ids, input.degrees, input.pairs)
  seedPositions(sim, seed, exact)
  let ticks = 0
  return new Promise(resolve => {
    const step = () => {
      if (signal?.aborted) { resolve(null); return }
      const until = performance.now() + SLICE_MS
      while (sim.alpha > ALPHA_MIN && ticks < MAX_TICKS && performance.now() < until) { tick(sim); ticks++ }
      if (sim.alpha > ALPHA_MIN && ticks < MAX_TICKS) setTimeout(step, 0)
      else { sim.alpha = Math.min(sim.alpha, ALPHA_MIN); resolve({ sim, ticks, where: 'sliced' }) }
    }
    step()
  })
}

/**
 * Lay out `input`, starting from `seed` when given (`exact`: the seed is this
 * very graph, so nothing needs to move). Resolves null if `signal` aborted.
 */
export async function computeLayout(
  input: LayoutInput,
  opts: { seed?: Positions | null; exact?: boolean; signal?: AbortSignal; forceAsync?: boolean } = {},
): Promise<LayoutRun | null> {
  const seed = opts.seed ?? null
  const exact = !!opts.exact
  if (!opts.forceAsync && input.ids.length <= SYNC_LAYOUT_MAX_NODES) {
    const { sim, ticks } = layoutNow(input, seed, exact)
    return snapped({ sim, ticks, where: 'sync' })
  }
  const viaWorker = await inWorker(input, seed, exact)
  if (opts.signal?.aborted) return null
  if (viaWorker) return snapped({ sim: simAt(input, viaWorker.xs, viaWorker.ys), ticks: viaWorker.ticks, where: 'worker' })
  const run = await sliced(input, seed, exact, opts.signal)
  return run && snapped(run)
}

/** Settle synchronously (small graphs; also used by tests). */
export function computeLayoutSync(input: LayoutInput, seed?: Positions | null, exact = false): LayoutRun {
  const sim = createSimulation(input.ids, input.degrees, input.pairs)
  seedPositions(sim, seed, exact)
  return snapped({ sim, ticks: settle(sim), where: 'sync' })
}

/** Tests: forget the worker so the next call re-detects. */
export function __resetLayoutWorker(): void {
  worker?.terminate?.()
  worker = undefined
  pending.clear()
}
