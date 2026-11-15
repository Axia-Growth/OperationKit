/** obj 900867 — reusing a stored graph layout instead of re-settling from scratch. */
import { describe, it, expect, beforeEach } from 'vitest'
import { createSimulation, layoutSignature, positionsOf, seedPositions, settle, simAt, type LayoutInput } from './kbGraphLayout'
import { __resetLayoutWorker, computeLayout, computeLayoutSync, SYNC_LAYOUT_MAX_NODES } from './kbGraphLayoutRunner'

/** n pages in a chain with a few cross links. */
function chain(n: number, prefix = 'p'): LayoutInput {
  const ids = Array.from({ length: n }, (_, i) => `${prefix}${i}.md`)
  const pairs: Array<[number, number]> = []
  for (let i = 1; i < n; i++) pairs.push([i - 1, i])
  for (let i = 0; i + 7 < n; i += 5) pairs.push([i, i + 7])
  const degrees = ids.map((_, i) => pairs.filter(([a, b]) => a === i || b === i).length)
  return { ids, degrees, pairs }
}

beforeEach(() => __resetLayoutWorker())

describe('layoutSignature', () => {
  it('is stable for the same graph and changes when a page or a link changes', () => {
    const g = chain(30)
    expect(layoutSignature(g)).toBe(layoutSignature(chain(30)))
    expect(layoutSignature(g)).not.toBe(layoutSignature(chain(31)))
    expect(layoutSignature(g)).not.toBe(layoutSignature({ ...g, pairs: g.pairs.slice(1) }))
    expect(layoutSignature(g)).not.toBe(layoutSignature({ ...g, ids: g.ids.map((id, i) => (i === 3 ? 'renamed.md' : id)) }))
  })
})

describe('seedPositions', () => {
  it('the exact graph from its saved layout needs zero ticks and lands where it was', () => {
    const g = chain(60)
    const first = computeLayoutSync(g)
    expect(first.ticks).toBeGreaterThan(50)
    const saved = positionsOf(first.sim)
    const again = computeLayoutSync(g, saved, true)
    expect(again.ticks).toBe(0)
    expect(positionsOf(again.sim)).toEqual(saved)
  })

  it('a graph that grew a little settles from the known spots in far fewer ticks', () => {
    const before = chain(80)
    const saved = positionsOf(computeLayoutSync(before).sim)
    const after = chain(84)
    const cold = createSimulation(after.ids, after.degrees, after.pairs)
    const coldTicks = settle(cold)
    const warm = createSimulation(after.ids, after.degrees, after.pairs)
    expect(seedPositions(warm, saved)).toBeLessThan(1)
    const warmTicks = settle(warm)
    expect(warmTicks).toBeLessThan(coldTicks * 0.6)
    // Known pages barely move; new pages start beside a placed neighbour, not on top of one another.
    expect(Math.hypot(warm.nodes[10].x - saved['p10.md'][0], warm.nodes[10].y - saved['p10.md'][1])).toBeLessThan(40)
    for (const n of warm.nodes) expect(Number.isFinite(n.x) && Number.isFinite(n.y)).toBe(true)
  })

  it('ignores a saved layout with nothing in common', () => {
    const g = chain(20)
    const sim = createSimulation(g.ids, g.degrees, g.pairs)
    expect(seedPositions(sim, { 'other.md': [1, 2] })).toBe(1)
  })
})

describe('computeLayout', () => {
  it('settles a small graph inline', async () => {
    const run = await computeLayout(chain(SYNC_LAYOUT_MAX_NODES))
    expect(run?.where).toBe('sync')
  })

  it('settles a big graph off the critical path (time-sliced where no Worker exists) to the same rest state', async () => {
    const g = chain(SYNC_LAYOUT_MAX_NODES + 50)
    const run = await computeLayout(g)
    expect(run?.where).toBe('sliced') // the node test env has no Worker
    expect(run!.sim.alpha).toBeLessThanOrEqual(0.02)
    expect(run!.ticks).toBeGreaterThan(50)
    const again = await computeLayout(g, { seed: positionsOf(run!.sim), exact: true })
    expect(again?.ticks).toBe(0)
  })

  it('stops when aborted', async () => {
    const ctrl = new AbortController()
    const p = computeLayout(chain(SYNC_LAYOUT_MAX_NODES + 50), { signal: ctrl.signal })
    ctrl.abort()
    expect(await p).toBeNull()
  })

  it('simAt rebuilds a finished layout at rest', () => {
    const g = chain(10)
    const sim = simAt(g, Float64Array.from(g.ids.map((_, i) => i)), Float64Array.from(g.ids.map((_, i) => -i)))
    expect(sim.alpha).toBe(0)
    expect([sim.nodes[3].x, sim.nodes[3].y]).toEqual([3, -3])
  })
})
