// @vitest-environment jsdom
/** obj 901767 — the Cleanup tab lists open knowledge-gap flags and a person closes them. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { KnowledgeFlagsSection } from './KnowledgeFlagsSection'

const FLAG = {
  id: 7, workspace: 'garden', kind: 'wrong', subject: 'Acme billing contact', page: 'organizations/acme.md',
  detail: 'Page says Dana; the invoice thread is signed by Lee.', suggested_fix: 'Billing contact: Lee Park',
  objective_id: 42, trace: null, source: 'worker', filed_by: 'card #42 worker', status: 'open', seen_count: 2,
  last_seen_at: '2026-11-23 06:00:00', resolution_note: null, resolved_by: null, resolved_at: null,
  created_at: '2026-11-23 05:00:00', updated_at: '2026-11-23 06:00:00',
}

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('KnowledgeFlagsSection', () => {
  let host: HTMLDivElement
  let root: Root
  let open: typeof FLAG[]
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    open = [FLAG]
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { open = []; return ok({ flag: { ...FLAG, status: 'resolved' } }) }
      return ok({ flags: open, total: open.length, open: open.length })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    root.unmount()
    host.remove()
    vi.unstubAllGlobals()
  })

  it('shows each open flag with its kind, fix, page and card, and Fixed closes it', async () => {
    const onOpen = vi.fn()
    flushSync(() => root.render(<KnowledgeFlagsSection workspace="garden" titles={new Map([['organizations/acme.md', 'Acme']])} onOpenNote={onOpen} />))
    await flush()
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/kb-wiki/flags?workspace=garden&status=open&limit=200')
    const text = host.textContent ?? ''
    expect(text).toContain('Flagged while working')
    expect(text).toContain('Wrong')
    expect(text).toContain('Acme billing contact')
    expect(text).toContain('Billing contact: Lee Park')
    expect(text).toContain('flagged 2 times')
    expect(host.querySelector('a[href="/o/42"]')?.textContent).toBe('Card #42')
    const pageBtn = [...host.querySelectorAll('button')].find(b => b.textContent === 'Acme')!
    pageBtn.click()
    expect(onOpen).toHaveBeenCalledWith('organizations/acme.md')

    const fixed = [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Fixed'))!
    fixed.click()
    await flush()
    const post = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST')!
    expect(String(post[0])).toBe('/api/kb-wiki/flags/7/status?workspace=garden')
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ workspace: 'garden', status: 'resolved' })
    expect(host.textContent).toContain('No open flags.')
  })
})
