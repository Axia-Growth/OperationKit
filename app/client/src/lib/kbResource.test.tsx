// @vitest-environment jsdom
/** obj 900867 — stale-while-revalidate: cached first, server second, one request at a time. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { __resetKbCacheMemory, readKbCache, setKbCacheScope, writeKbCache } from './kbCache'
import { __resetKbResource, prefetchKb, revalidateKb, useKbResource, type KbResource, type KbResourceSpec } from './kbResource'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}

let host: HTMLDivElement
let root: Root
let seen: Array<KbResource<{ n: number }>>

function Probe({ spec, refreshKey }: { spec: KbResourceSpec<{ n: number }>; refreshKey?: number }) {
  const r = useKbResource(spec, { refreshKey })
  seen.push(r)
  return <span>{r.loading ? 'loading' : r.error ? `error: ${r.error}` : `n=${r.data?.n}${r.stale ? ' (cached)' : ''}`}</span>
}

beforeEach(() => {
  __resetKbCacheMemory()
  __resetKbResource()
  localStorage.clear()
  setKbCacheScope(1)
  seen = []
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  flushSync(() => root.unmount())
  host.remove()
})

describe('useKbResource', () => {
  it('first visit: a skeleton state, then the server\'s answer, now cached', async () => {
    const load = vi.fn(async () => ({ n: 1 }))
    flushSync(() => root.render(<Probe spec={{ key: 'k', load }} />))
    expect(host.textContent).toBe('loading')
    await flush()
    expect(host.textContent).toBe('n=1')
    expect(readKbCache<{ n: number }>('k')?.value).toEqual({ n: 1 })
  })

  it('return visit: draws the cached copy in the very first render, then revalidates in the background', async () => {
    writeKbCache('k', { n: 1 })
    let resolve!: (v: { n: number }) => void
    const load = vi.fn(() => new Promise<{ n: number }>(r => { resolve = r }))
    flushSync(() => root.render(<Probe spec={{ key: 'k', load }} />))
    expect(seen[0].data).toEqual({ n: 1 }) // no loading frame at all
    expect(host.textContent).toBe('n=1 (cached)')
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    resolve({ n: 2 })
    await flush()
    expect(host.textContent).toBe('n=2')
  })

  it('an unchanged server answer hands back the SAME object, so nothing downstream re-lays out', async () => {
    const cached = writeKbCache('k', { n: 1 }).value
    flushSync(() => root.render(<Probe spec={{ key: 'k', load: async () => ({ n: 1 }) }} />))
    await flush()
    expect(seen.at(-1)!.data).toBe(cached)
    expect(seen.at(-1)!.stale).toBe(false)
  })

  it('a failed revalidation keeps the cached copy on screen; with nothing cached it is an error', async () => {
    writeKbCache('k', { n: 1 })
    flushSync(() => root.render(<Probe spec={{ key: 'k', load: async () => { throw new Error('offline') } }} />))
    await flush()
    expect(host.textContent).toBe('n=1 (cached)')
    flushSync(() => root.render(<Probe spec={{ key: 'other', load: async () => { throw new Error('offline') } }} />))
    await flush()
    expect(host.textContent).toBe('error: offline')
  })

  it('shares one request between a hover prefetch and the page mounting, and skips a re-ask right after', async () => {
    const load = vi.fn(async () => ({ n: 1 }))
    const spec = { key: 'k', load }
    const p = prefetchKb(spec)
    flushSync(() => root.render(<Probe spec={spec} />))
    await p
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    // Unmount and come straight back: fetched a moment ago, so the cache is the answer.
    flushSync(() => root.render(<span />))
    flushSync(() => root.render(<Probe spec={spec} />))
    await flush()
    expect(load).toHaveBeenCalledTimes(1)
    expect(host.textContent).toBe('n=1')
  })

  it('refreshKey (an import finished) always asks again', async () => {
    const load = vi.fn(async () => ({ n: load.mock.calls.length }))
    flushSync(() => root.render(<Probe spec={{ key: 'k', load }} refreshKey={0} />))
    await flush()
    flushSync(() => root.render(<Probe spec={{ key: 'k', load }} refreshKey={1} />))
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(host.textContent).toBe('n=2')
  })

  it('revalidateKb dedupes concurrent calls', async () => {
    const load = vi.fn(async () => ({ n: 9 }))
    const [a, b] = await Promise.all([revalidateKb({ key: 'd', load }), revalidateKb({ key: 'd', load })])
    expect(load).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
  })

  it('a request that lands after a sign-out/sign-in is never cached for the next person', async () => {
    let resolve!: (v: { n: number }) => void
    const p = revalidateKb({ key: 'docs-tree', load: () => new Promise<{ n: number }>(r => { resolve = r }) })
    await flush() // the request is out
    setKbCacheScope(2)
    resolve({ n: 1 })
    await p
    expect(readKbCache('docs-tree')).toBeNull()
    setKbCacheScope(1)
    expect(readKbCache('docs-tree')).toBeNull()
  })
})
