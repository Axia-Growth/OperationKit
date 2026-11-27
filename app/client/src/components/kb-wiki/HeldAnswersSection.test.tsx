// @vitest-environment jsdom
/** obj 901746 — saved answers held out of search are listed on the Cleanup tab and a person approves or keeps them out. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { HeldAnswersSection } from './HeldAnswersSection'

const HELD = [
  { rel: 'answers/2026-11-20-when-does-greenway-deliver.md', title: 'When does Greenway deliver?', kind: 'ungrounded', reason: '1 claim is not backed by the pages it cites: "delivers on Fridays".', checked_at: '2026-11-20' },
  { rel: 'answers/2026-11-21-who-runs-the-store.md', title: 'Who runs the store?', kind: 'stale', reason: 'A page it cites changed after it was saved (people/sam-okafor), so it may be out of date.', checked_at: '2026-11-21' },
]

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('HeldAnswersSection', () => {
  let host: HTMLDivElement
  let root: Root
  let held: typeof HELD
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    held = [...HELD]
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const { rel } = JSON.parse(String(init.body)) as { rel: string }
        held = held.filter(h => h.rel !== rel)
        return ok({ rel, status: 'reviewed' })
      }
      return ok({ answers: held })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    root.unmount()
    host.remove()
    vi.unstubAllGlobals()
  })

  it('lists each held answer with why, opens it, and Approve / Keep out send the decision', async () => {
    const onOpen = vi.fn()
    flushSync(() => root.render(<HeldAnswersSection workspace="garden" onOpenNote={onOpen} />))
    await flush()
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/kb-wiki/answers/held?workspace=garden')
    const text = host.textContent ?? ''
    expect(text).toContain('Saved answers to check')
    expect(text).toContain('Not backed by its pages')
    expect(text).toContain('Its pages changed')
    expect(text).toContain('delivers on Fridays')
    expect(host.querySelectorAll('[data-testid="held-answer"]').length).toBe(2)

    ;[...host.querySelectorAll('button')].find(b => b.textContent === 'When does Greenway deliver?')!.click()
    expect(onOpen).toHaveBeenCalledWith('answers/2026-11-20-when-does-greenway-deliver.md')

    ;[...host.querySelectorAll('button')].find(b => b.textContent?.includes('Approve'))!.click()
    await flush()
    const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST')!
    expect(String(post[0])).toBe('/api/kb-wiki/answers/review?workspace=garden')
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ workspace: 'garden', rel: HELD[0].rel, decision: 'approve' })
    expect(host.querySelectorAll('[data-testid="held-answer"]').length).toBe(1)

    ;[...host.querySelectorAll('button')].find(b => b.textContent?.includes('Keep out'))!.click()
    await flush()
    const last = fetchMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST').at(-1)!
    expect(JSON.parse(String((last[1] as RequestInit).body))).toMatchObject({ rel: HELD[1].rel, decision: 'keep_out' })
    // Nothing left: the section disappears instead of showing an empty list.
    expect(host.textContent).not.toContain('Saved answers to check')
  })
})
