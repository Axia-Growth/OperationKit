import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { Worker } from 'worker_threads'
import {
  layoutInputFor, layoutSignature, unpackPositions, type LayoutInput, type Positions,
} from '../../../../shared/kb-graph-layout.js'

/**
 * Server-side layout of a workspace's knowledge-base graph (obj 900867).
 *
 * Settling a 2,000-page force layout takes the browser ~0.5–2 s, and every
 * browser used to pay that on every cold visit to Context. The server now lays
 * out the DEFAULT view (every page, every link) once per graph version, off
 * the event loop in a worker thread, and sends the positions with the graph
 * (GET /api/kb-wiki/graph → `layout`). The browser draws them with zero ticks.
 *
 * - Cached per workspace by the graph's signature (pages, order, links), so an
 *   unchanged graph is a map lookup.
 * - A changed graph is laid out starting from the previous positions, so a
 *   few new pages settle in a fraction of a cold layout.
 * - The request waits for a running layout at most LAYOUT_WAIT_MS; past that
 *   it answers without one and the browser lays out itself, as before. The
 *   layout keeps running and the next request gets it.
 * - Only a layout — positions, never page content — is cached; it is derived
 *   from a response the caller was already allowed to read.
 */

export interface GraphLayoutPayload {
  /** layoutSignature() of the graph these positions belong to. */
  sig: string
  /** [x0, y0, x1, y1, …] in the response's node order (shared/kb-graph-layout packPositions). */
  pos: number[]
}

export type LayoutCompute = (input: LayoutInput, seed: Positions | null) => Promise<number[]>

export const LAYOUT_WAIT_MS = 2500
const LAYOUT_TIMEOUT_MS = 30_000
const MAX_CONCURRENT = 2

const cache = new Map<string, { sig: string; ids: string[]; pos: number[] }>()
const inflight = new Map<string, Promise<number[]>>()
let running = 0

const here = fileURLToPath(import.meta.url)
const workerFile = path.join(path.dirname(here), 'graph-layout.worker.mjs')
/** The shared layout module the worker loads: .ts under tsx, .js when the server runs compiled. */
const layoutModuleUrl = new URL(`../../../../shared/kb-graph-layout.${here.endsWith('.ts') ? 'ts' : 'js'}`, import.meta.url).href

/** Settle `input` in a worker thread. Rejects if the worker cannot start, crashes or runs past the timeout. */
export const computeInWorker: LayoutCompute = (input, seed) => new Promise((resolve, reject) => {
  if (!fs.existsSync(workerFile)) { reject(new Error('layout worker missing')); return }
  let w: Worker
  try {
    w = new Worker(workerFile, { workerData: { moduleUrl: layoutModuleUrl, input, seed } })
  } catch (err) { reject(err); return }
  const timer = setTimeout(() => { void w.terminate(); reject(new Error('layout timed out')) }, LAYOUT_TIMEOUT_MS)
  w.once('message', (pos: number[]) => { clearTimeout(timer); resolve(pos); void w.terminate() })
  w.once('error', err => { clearTimeout(timer); reject(err) })
  w.once('exit', code => { clearTimeout(timer); if (code !== 0) reject(new Error(`layout worker exited ${code}`)) })
})

/**
 * The default-view layout for `graph` in `workspace`, or null when none is
 * ready within `waitMs` (or the graph is empty, or the layout could not run).
 */
export async function workspaceGraphLayout(
  workspace: string,
  graph: { nodes: ReadonlyArray<{ rel: string }>; links: ReadonlyArray<{ a: string; b: string }> },
  opts: { waitMs?: number; compute?: LayoutCompute } = {},
): Promise<GraphLayoutPayload | null> {
  const input = layoutInputFor(graph.nodes, graph.links)
  if (input.ids.length === 0) return null
  const sig = layoutSignature(input)
  const hit = cache.get(workspace)
  if (hit && hit.sig === sig) return { sig, pos: hit.pos }

  const key = `${workspace}\n${sig}`
  let job = inflight.get(key)
  if (!job) {
    if (running >= MAX_CONCURRENT) return null
    running++
    const seed = hit ? unpackPositions(hit.ids, hit.pos) : null
    job = (opts.compute ?? computeInWorker)(input, seed)
      .then(pos => {
        if (!Array.isArray(pos) || pos.length !== input.ids.length * 2) throw new Error('bad layout')
        cache.set(workspace, { sig, ids: input.ids, pos })
        return pos
      })
      .finally(() => { running--; inflight.delete(key) })
    job.catch(err => console.warn(`[kb-graph-layout] ${workspace}: ${(err as Error).message}`))
    inflight.set(key, job)
  }
  const waitMs = opts.waitMs ?? LAYOUT_WAIT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const pos = await Promise.race([
    job,
    new Promise<null>(r => { timer = setTimeout(() => r(null), waitMs) }),
  ]).catch(() => null).finally(() => clearTimeout(timer))
  return pos ? { sig, pos } : null
}

/** Tests: forget every cached layout. */
export function clearGraphLayoutCache(): void {
  cache.clear()
}
