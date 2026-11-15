/** obj 900867 — the knowledge-base graph is laid out once on the server, per graph version, off the event loop. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { layoutInputFor, layoutNow, packPositions, unpackPositions, type LayoutInput, type Positions } from '../../../../shared/kb-graph-layout.js'
import { clearGraphLayoutCache, computeInWorker, workspaceGraphLayout, type LayoutCompute } from './graph-layout.js'

function graph(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ rel: `p/${i}.md` }))
  const links = Array.from({ length: n - 1 }, (_, i) => ({ a: `p/${i}.md`, b: `p/${i + 1}.md` }))
  return { nodes, links }
}

/** The worker's job, inline: what a test passes as `compute`. */
const inline: LayoutCompute = async (input, seed) => packPositions(layoutNow(input, seed).sim)

beforeEach(() => clearGraphLayoutCache())

describe('workspaceGraphLayout', () => {
  it('lays out every page once and serves the cached layout for the same graph', async () => {
    const compute = vi.fn(inline)
    const g = graph(30)
    const first = await workspaceGraphLayout('garden', g, { compute })
    expect(first?.pos).toHaveLength(60)
    expect(first!.pos.every(Number.isFinite)).toBe(true)
    const again = await workspaceGraphLayout('garden', g, { compute })
    expect(again).toEqual(first)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('re-lays out a changed graph starting from the previous positions', async () => {
    const seeds: Array<Positions | null> = []
    const compute: LayoutCompute = async (input, seed) => { seeds.push(seed); return inline(input, seed) }
    await workspaceGraphLayout('garden', graph(30), { compute })
    const grown = await workspaceGraphLayout('garden', graph(32), { compute })
    expect(grown?.pos).toHaveLength(64)
    expect(seeds[0]).toBeNull()
    expect(Object.keys(seeds[1] ?? {})).toHaveLength(30)
  })

  it('keeps workspaces apart', async () => {
    const compute = vi.fn(inline)
    await workspaceGraphLayout('a', graph(10), { compute })
    await workspaceGraphLayout('b', graph(10), { compute })
    expect(compute).toHaveBeenCalledTimes(2)
  })

  it('answers without a layout when it is not ready in time, and has it for the next request', async () => {
    let finish!: () => void
    const gate = new Promise<void>(r => { finish = r })
    const compute = vi.fn<LayoutCompute>(async (input, seed) => { await gate; return inline(input, seed) })
    const g = graph(12)
    expect(await workspaceGraphLayout('slow', g, { compute, waitMs: 10 })).toBeNull()
    // A second request while it runs shares the same job.
    const pending = workspaceGraphLayout('slow', g, { compute, waitMs: 1000 })
    finish()
    expect((await pending)?.pos).toHaveLength(24)
    expect(compute).toHaveBeenCalledTimes(1)
  })

  it('returns null (never throws) for an empty graph or a failed layout', async () => {
    expect(await workspaceGraphLayout('empty', { nodes: [], links: [] }, { compute: inline })).toBeNull()
    const broken: LayoutCompute = async () => { throw new Error('boom') }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await workspaceGraphLayout('broken', graph(5), { compute: broken })).toBeNull()
    warn.mockRestore()
  })

  it('the packed positions line up with the browser\'s own layout input', async () => {
    const g = graph(8)
    const out = await workspaceGraphLayout('garden', g, { compute: inline })
    const input = layoutInputFor(g.nodes, g.links)
    const pos = unpackPositions(input.ids, out!.pos)!
    expect(Object.keys(pos)).toEqual(input.ids)
  })
})

describe('computeInWorker', () => {
  it('settles a real layout in a worker thread, the same as inline', async () => {
    const g = graph(40)
    const input: LayoutInput = layoutInputFor(g.nodes, g.links)
    const viaWorker = await computeInWorker(input, null)
    expect(viaWorker).toEqual(packPositions(layoutNow(input, null).sim))
  }, 30_000)
})
