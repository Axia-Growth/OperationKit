// @vitest-environment jsdom
/** obj 900674 — the workspace-wide knowledge-base graph: draws every page and connection from GET /api/kb-wiki/graph. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { WorkspaceGraph } from './WorkspaceGraph'
import { __resetKbResource } from '../../lib/kbResource'

const GRAPH = {
  root: '/kb/garden',
  nodes: [
    { rel: 'people/tom.md', title: 'Tom Whitfield', kind: 'person', degree: 2 },
    { rel: 'organizations/greenway.md', title: 'Greenway Growers', kind: 'organization', degree: 2 },
    { rel: 'sources/call.md', title: 'Supplier call', kind: 'source', degree: 2 },
    { rel: 'organizations/riverbend.md', title: 'Riverbend Nursery', kind: 'organization', degree: 0 },
  ],
  links: [
    { a: 'organizations/greenway.md', b: 'people/tom.md', kinds: ['related'], label: 'works for', weight: 1 },
    { a: 'people/tom.md', b: 'sources/call.md', kinds: ['cited_by'], label: null, weight: 1 },
    { a: 'organizations/greenway.md', b: 'sources/call.md', kinds: ['cited_by'], label: null, weight: 1 },
  ],
  counts: { pages: 4, links: 3, isolated: 1, by_kind: { organization: 2, person: 1, source: 1 } },
  truncated: false,
}

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}

describe('WorkspaceGraph', () => {
  let host: HTMLDivElement
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    fetchMock = vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    root.unmount()
    host.remove()
    vi.unstubAllGlobals()
  })

  const nodes = () => [...host.querySelectorAll('g[data-rel]')].map(g => g.getAttribute('data-rel'))
  // Links are drawn as a few <path>s grouped by look (obj 900867); each carries how many links it holds.
  const linkPaths = () => [...host.querySelectorAll<SVGPathElement>('svg[aria-label^="Graph of"] path[data-link-count]')]
  const links = () => linkPaths().reduce((n, p) => n + Number(p.getAttribute('data-link-count')), 0)

  it('loads the workspace graph and draws every page and connection', async () => {
    const open = vi.fn()
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={open} />))
    await flush()
    expect(fetchMock.mock.calls[0][0]).toBe('/api/kb-wiki/graph?workspace=garden')
    expect(nodes()).toHaveLength(4)
    expect(links()).toBe(3)
    expect(linkPaths().length).toBeLessThanOrEqual(6)
    expect(host.textContent).toContain('4 pages · 3 connections')
    // Every node has a real position.
    for (const c of host.querySelectorAll('g[data-rel] circle')) expect(Number.isFinite(Number(c.getAttribute('cx')))).toBe(true)

    // Keyboard: a dot is a button that opens its page.
    const tom = host.querySelector<SVGGElement>('g[data-rel="people/tom.md"]')!
    expect(tom.getAttribute('aria-label')).toBe('Open Tom Whitfield (Person, 2 connections)')
    tom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(open).toHaveBeenCalledWith('people/tom.md', '/kb/garden')

    // Focusing a page lights its 2 links (one accent layer) and fades the third.
    flushSync(() => tom.dispatchEvent(new FocusEvent('focusin', { bubbles: true })))
    const accent = linkPaths().filter(p => p.getAttribute('class')?.includes('stroke-accent'))
    expect(accent.reduce((n, p) => n + Number(p.getAttribute('data-link-count')), 0)).toBe(2)
    expect(linkPaths().filter(p => p.getAttribute('class')?.includes('opacity-15')).reduce((n, p) => n + Number(p.getAttribute('data-link-count')), 0)).toBe(1)
    expect(links()).toBe(3)
  })

  it('a tap on a dot opens that page (nearest dot wins)', async () => {
    const open = vi.fn()
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={open} />))
    await flush()
    const svg = host.querySelector<SVGSVGElement>('svg[aria-label^="Graph of"]')!
    const m = svg.querySelector('g[transform]')!.getAttribute('transform')!.match(/translate\(([-\d.e]+) ([-\d.e]+)\) scale\(([-\d.e]+)\)/)!
    const [tx, ty, k] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dot = [...host.querySelectorAll('g[data-rel="organizations/greenway.md"] circle')].pop()!
    const x = Number(dot.getAttribute('cx')) * k + tx
    const y = Number(dot.getAttribute('cy')) * k + ty
    const fire = (type: string) => svg.dispatchEvent(new MouseEvent(type, { clientX: x + 1, clientY: y - 1, button: 0, bubbles: true }))
    flushSync(() => { fire('pointermove') })
    // Hover lights the page and names it in the card.
    expect(host.textContent).toContain('click to open')
    fire('pointerdown'); fire('pointerup')
    expect(open).toHaveBeenCalledWith('organizations/greenway.md', '/kb/garden')
  })

  it('hides a kind from the legend and drops unconnected pages on request', async () => {
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    await flush()
    const chip = [...host.querySelectorAll('button[aria-pressed]')].find(b => b.textContent?.includes('Source'))!
    flushSync(() => (chip as HTMLButtonElement).click())
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(nodes()).not.toContain('sources/call.md')
    expect(links()).toBe(1)

    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    flushSync(() => box.click())
    expect(nodes()).not.toContain('organizations/riverbend.md')
  })

  it('shows a plain empty state for a workspace with no pages', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ nodes: [], links: [], counts: { pages: 0, links: 0, isolated: 0, by_kind: {} }, truncated: false }), { status: 200 }))
    flushSync(() => root.render(<WorkspaceGraph workspace="empty" onOpenNote={() => {}} />))
    await flush()
    expect(host.textContent).toContain('Nothing to graph yet')
  })
})

/** obj 900867 — a return visit to the graph is drawn from the cache: no skeleton, no re-layout. */
describe('WorkspaceGraph — return visits', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })
  const positions = () => Object.fromEntries([...host.querySelectorAll('g[data-rel]')].map(g => {
    const c = g.querySelector('circle:last-of-type')!
    return [g.getAttribute('data-rel'), `${c.getAttribute('cx')},${c.getAttribute('cy')}`]
  }))

  it('draws the cached graph in the first frame, at the saved positions, before the server answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200 })))
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    await flush()
    const first = positions()
    expect(Object.keys(first)).toHaveLength(4)
    flushSync(() => root.unmount())

    // Come back with the server slow to answer: the graph is on screen straight away.
    let answer!: (r: Response) => void
    const slow = vi.fn(() => new Promise<Response>(r => { answer = r }))
    vi.stubGlobal('fetch', slow)
    __resetKbResource() // a later visit, not a quick back-and-forth: it does re-ask the server
    root = createRoot(host)
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    expect(positions()).toEqual(first)
    await flush()
    expect(slow).toHaveBeenCalledTimes(1)
    expect(positions()).toEqual(first)
    // Same graph from the server: nothing moves.
    answer(new Response(JSON.stringify(GRAPH), { status: 200 }))
    await flush()
    expect(positions()).toEqual(first)
  })

  it('swaps in a changed graph from the server once it arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200 })))
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    await flush()
    flushSync(() => root.unmount())
    const grown = {
      ...GRAPH,
      nodes: [...GRAPH.nodes, { rel: 'people/ana.md', title: 'Ana', kind: 'person', degree: 1 }],
      links: [...GRAPH.links, { a: 'people/ana.md', b: 'people/tom.md', kinds: ['related'], label: null, weight: 1 }],
      counts: { ...GRAPH.counts, pages: 5, links: 4 },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(grown), { status: 200 })))
    __resetKbResource() // time passes: the last fetch is no longer "a moment ago"
    root = createRoot(host)
    flushSync(() => root.render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />))
    expect(host.querySelectorAll('g[data-rel]')).toHaveLength(4) // cached first
    await flush()
    expect(host.querySelectorAll('g[data-rel]')).toHaveLength(5)
    expect(host.textContent).toContain('5 pages · 4 connections')
  })

  it('lays a big graph out without blocking: a skeleton first, then every page', async () => {
    const n = 260
    const big = {
      root: '/kb/big',
      nodes: Array.from({ length: n }, (_, i) => ({ rel: `p/${i}.md`, title: `Page ${i}`, kind: 'topic', degree: i === 0 ? 0 : 1 })),
      links: Array.from({ length: n - 1 }, (_, i) => ({ a: `p/${i}.md`, b: `p/${i + 1}.md`, kinds: ['related'], label: null, weight: 1 })),
      counts: { pages: n, links: n - 1, isolated: 0, by_kind: { topic: n } },
      truncated: false,
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(big), { status: 200 })))
    flushSync(() => root.render(<WorkspaceGraph workspace="big" onOpenNote={() => {}} />))
    await flush()
    expect(host.querySelector('[aria-busy="true"]')?.textContent).toContain(`Arranging ${n} pages`)
    for (let i = 0; i < 400 && !host.querySelector('g[data-rel]'); i++) await flush()
    expect(host.querySelectorAll('g[data-rel]')).toHaveLength(n)
  })
})
