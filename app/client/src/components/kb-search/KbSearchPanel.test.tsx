// @vitest-environment jsdom
//
// Knowledge page search: results from /docs/search render with match badges and
// scores, a result opens its page, the degraded-mode note appears when the
// server fell back to keyword, and clearing the query brings the tree back.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KbSearchPanel } from './KbSearchPanel'
import type { KbSearchResponse } from '../../lib/kbSearch'

const { apiMock, store } = vi.hoisted(() => {
  const store: { res: unknown } = { res: null }
  const apiMock = { get: vi.fn((_path: string) => Promise.resolve(structuredClone(store.res))) }
  return { apiMock, store }
})

vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: class extends Error {} }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ROOT = '/kb'

const HYBRID: KbSearchResponse = {
  mode: 'hybrid',
  mode_used: 'hybrid',
  semantic: { available: true },
  results: [
    { path: `${ROOT}/ops/Deploy Runbook.md`, snippet: 'How to deploy the server safely.', score: 0.0331, match: 'exact', heading: 'Rollback' },
    { path: `${ROOT}/notes/vectors.md`, snippet: 'Embeddings live in sqlite-vec.', score: 0.0164, match: 'both' },
    { path: `${ROOT}/kw.md`, snippet: 'keyword only', score: 0.0159, match: 'keyword' },
    { path: `${ROOT}/sem.md`, snippet: 'meaning only', score: 0.0152, match: 'semantic', similarity: 0.81 },
  ],
}

let root: Root
let host: HTMLDivElement
const onOpen = vi.fn()

function render() {
  act(() => {
    root.render(
      <KbSearchPanel root={ROOT} onOpen={onOpen}>
        <div data-testid="tree">tree</div>
      </KbSearchPanel>,
    )
  })
}

function type(value: string) {
  const input = host.querySelector('input[type="search"]') as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function settle() {
  await act(async () => { vi.advanceTimersByTime(350) })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  vi.useFakeTimers()
  apiMock.get.mockClear()
  onOpen.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('KbSearchPanel', () => {
  it('shows the tree until a query of 2+ characters, then debounced results with badges and scores', async () => {
    store.res = HYBRID
    render()
    expect(host.querySelector('[data-testid="tree"]')).not.toBeNull()

    type('d')
    await settle()
    expect(apiMock.get).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="tree"]')).not.toBeNull()

    type('deploy')
    await settle()
    expect(apiMock.get).toHaveBeenCalledTimes(1)
    expect(apiMock.get.mock.calls[0][0]).toBe('/docs/search?q=deploy&mode=hybrid&limit=20')
    expect(host.querySelector('[data-testid="tree"]')).toBeNull()

    const items = host.querySelectorAll('ul[aria-label="Search results"] > li')
    expect(items).toHaveLength(4)
    const first = items[0].textContent ?? ''
    expect(first).toContain('Deploy Runbook')
    expect(first).toContain('ops')
    expect(first).toContain('Rollback')
    expect(first).toContain('0.033')
    expect(first).toContain('Exact')
    expect(items[1].textContent).toContain('Keyword+Meaning')
    expect(items[2].textContent).toContain('Keyword')
    expect(items[3].textContent).toContain('Meaning')
    expect(host.querySelector('[data-testid="kb-search-note"]')).toBeNull()

    act(() => { (items[0].querySelector('button') as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith(`${ROOT}/ops/Deploy Runbook.md`)

    type('')
    await settle()
    expect(host.querySelector('[data-testid="tree"]')).not.toBeNull()
  })

  it('shows a muted note when the server fell back to keyword search', async () => {
    store.res = {
      mode: 'hybrid',
      mode_used: 'keyword',
      semantic: { available: false, reason: 'Semantic search is off.' },
      results: [{ path: `${ROOT}/a.md`, snippet: 'alpha', score: 0.0164, match: 'keyword' }],
    } satisfies KbSearchResponse
    render()
    type('alpha')
    await settle()
    expect(host.querySelector('[data-testid="kb-search-note"]')?.textContent).toBe('Semantic search is off — showing keyword results')
    expect(host.textContent).toContain('Keyword')
  })

  it('sends the chosen mode and shows similarity as a percent in semantic mode', async () => {
    store.res = { ...HYBRID, mode: 'semantic', mode_used: 'semantic', results: [HYBRID.results[3]] }
    render()
    act(() => { (Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'Semantic') as HTMLButtonElement).click() })
    type('meaning')
    await settle()
    expect(apiMock.get.mock.calls.at(-1)?.[0]).toBe('/docs/search?q=meaning&mode=semantic&limit=20')
    expect(host.querySelector('ul[aria-label="Search results"]')?.textContent).toContain('81%')
  })
})
