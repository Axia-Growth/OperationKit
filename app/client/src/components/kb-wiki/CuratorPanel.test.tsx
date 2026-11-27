// @vitest-environment jsdom
/** obj 901768 — the curator's suggestions: a person accepts or rejects; a procedure page needs an admin's sign-off first. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CuratorPanel } from './CuratorPanel'
import type { CuratorProposal, CuratorView } from '../../lib/kbWiki'

const base = { status: 'open' as const, evidence: [{ type: 'flag' as const, id: 'f1', detail: 'outdated: we use 25 cm pots now.', by: 'Garden bot', objective_id: 12 }], drafted_by: 'rule' as const }
const PROC: CuratorProposal = { ...base, id: 'cp-proc', kind: 'update', pages: ['topics/how-to-repot.md'], title: 'Review "How to repot a fern"', reason: 'Adds what was found.', procedure: true, light_touch: false, proposed_text: '# How to repot\n' }
const MERGE: CuratorProposal = { ...base, id: 'cp-merge', kind: 'merge', pages: ['organizations/a.md', 'organizations/b.md'], title: 'Merge "B" into "A"', reason: 'Same supplier.', procedure: false, light_touch: true }
const VIEW: CuratorView = { enabled: false, ai_drafts: 10, last_run_at: '2026-11-23T03:30:00Z', notes: [], stats: {}, open: [PROC, MERGE], decided: [] }

async function flush() {
  for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 0)); flushSync(() => {}) }
}

describe('CuratorPanel', () => {
  let host: HTMLDivElement
  let root: Root
  let fetchMock: ReturnType<typeof vi.fn>
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    fetchMock = vi.fn(async (url: string) => {
      const body = String(url).includes('/accept') ? { proposal: { status: 'accepted' }, changed: [] } : VIEW
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  })

  const render = async (isAdmin: boolean) => {
    act(() => { root.render(<CuratorPanel workspace="garden" pages={[]} isAdmin={isAdmin} onOpenNote={() => {}} onChanged={() => {}} />) })
    await flush()
  }
  const button = (text: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.includes(text)) as HTMLButtonElement

  it('lists suggestions with their evidence; a procedure change stays disabled until an admin ticks sign-off, then sends sign_off: true', async () => {
    await render(true)
    expect(host.textContent).toContain('Review "How to repot a fern"')
    expect(host.textContent).toContain('Procedure: needs sign-off')
    expect(host.textContent).toContain('we use 25 cm pots now')
    expect(host.textContent).toContain('from Garden bot on card #12')
    const apply = button('Sign off and apply')
    expect(apply.disabled).toBe(true)
    const box = host.querySelector('input[type="checkbox"]') as HTMLInputElement
    act(() => { box.click() })
    await flush()
    expect(button('Sign off and apply').disabled).toBe(false)
    act(() => { button('Sign off and apply').click() })
    await flush()
    const call = fetchMock.mock.calls.find(c => String(c[0]).includes('/curator/proposals/cp-proc/accept'))!
    expect(JSON.parse(String((call[1] as RequestInit).body))).toMatchObject({ workspace: 'garden', sign_off: true })
  })

  it('a member cannot sign off a procedure change but can accept a light-touch merge', async () => {
    await render(false)
    expect(button('Sign off and apply').disabled).toBe(true)
    expect((host.querySelector('input[type="checkbox"]') as HTMLInputElement).disabled).toBe(true)
    expect(host.textContent).toContain('Only an admin can sign off.')
    const accept = button('Accept')
    expect(accept.disabled).toBe(false)
  })
})
