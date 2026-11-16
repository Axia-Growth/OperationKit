// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act, type MouseEvent as ReactMouseEvent } from 'react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import type { Objective } from '@operationkit/shared'
import { cleanup, click, press, render } from '../test/render'

/* obj 901083 — viewing a card and clicking one of its sub-cards opens the
   sub-card in a pop-up OVER the parent (title, status, owner, summary, PR,
   latest activity, chat) instead of navigating away. "Open full card" expands
   it; Escape / a press outside closes it back to the parent exactly where it
   was; Cmd / Ctrl / middle-click still open the full card in a new tab. */

const parent = {
  id: 100, title: 'Ship the billing revamp', status: 'working', workspace: 'acme',
  session_id: 'sess-parent', parent_id: null, updated_at: '2026-11-16T00:00:00Z',
} as unknown as Objective
const child = {
  id: 101, title: 'worker: Migrate invoices table', status: 'review', workspace: 'acme',
  session_id: null, parent_id: 100, pr_url: 'https://github.com/acme/app/pull/77', pr_number: 77,
  assigned_usernames: ['dana'], updated_at: '2026-11-16T00:00:00Z',
} as unknown as Objective
const childDetail = { ...child, last_session_summary: 'Migrated 4 tables and opened PR #77. Waiting on review.' }

const apiGet = vi.fn((url: string): Promise<unknown> => {
  if (url === '/objectives/100') return Promise.resolve(parent)
  if (url === '/objectives/101') return Promise.resolve(childDetail)
  if (url.startsWith('/objectives/101/progress')) {
    return Promise.resolve({ latest: { label: 'Running the migration tests', note: '12/14 green', created_at: '2026-11-16T00:00:00Z' }, transcript: null })
  }
  if (url.endsWith('/uploads')) return Promise.resolve({ files: [] })
  return Promise.resolve([])
})
vi.mock('../lib/api', () => ({
  api: { get: (url: string) => apiGet(url), post: () => Promise.resolve({}) },
}))
vi.mock('../hooks/useObjectives', () => ({
  useObjectives: () => ({
    objectives: [parent, child],
    changeStatus: vi.fn(), createObjective: vi.fn(), updateObjective: vi.fn(), deleteObjective: vi.fn(),
  }),
}))
vi.mock('../hooks/useAgents', () => ({ useAgents: () => ({ labelOf: (s: string) => s }) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('../components/session-viewer/ThreadPane', () => ({
  ThreadPane: ({ objectiveId }: { objectiveId: number }) => <div data-testid={`thread-${objectiveId}`} />,
}))
vi.mock('../components/session-viewer/Composer', () => ({ Composer: () => <textarea aria-label="Message" /> }))
vi.mock('../components/session-viewer/BriefPanel', () => ({ BriefPanel: () => null }))
vi.mock('../components/decisions/DecisionBriefing', () => ({ CardDecisionPanel: () => null }))
vi.mock('./DesignCanvas', () => ({ DesignCanvas: () => null }))
vi.mock('./FileRail', () => ({ FileRail: () => null }))

const { PreviewWorkspace } = await import('./PreviewWorkspace')
const { latestActivityOf, isPlainLeftClick, cardHref } = await import('./SubCardPopup')

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })
const popup = () => document.querySelector<HTMLElement>('[data-testid="sub-card-popup"]')
const row = () => document.querySelector<HTMLAnchorElement>('[data-testid="sub-card-row-101"]')!

let path = ''

/** Dispatch a click and report whether the APP prevented it (i.e. hijacked the
    link). The probe then cancels it so jsdom does not try a real navigation. */
async function clickWith(el: Element, init: MouseEventInit): Promise<boolean> {
  let prevented = true
  const probe = (e: Event) => { prevented = e.defaultPrevented; e.preventDefault() }
  document.addEventListener('click', probe)
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init })) })
  document.removeEventListener('click', probe)
  return prevented
}
function LocationProbe() {
  path = useLocation().pathname
  return null
}

async function openParentCard() {
  await render(
    <MemoryRouter initialEntries={['/o/100']}>
      <LocationProbe />
      <Routes>
        <Route path="/" element={<div data-testid="board">Board</div>} />
        <Route path="/o/:id" element={<PreviewWorkspace workspaces={['acme' as never]} />} />
      </Routes>
    </MemoryRouter>,
  )
  await settle()
  expect(path).toBe('/o/100')
}

async function openPopup() {
  await openParentCard()
  row().focus()
  await click(row())
  await settle()
  expect(popup()).toBeTruthy()
}

describe('Sub-card pop-up — the card page', () => {
  afterEach(async () => {
    await cleanup()
    apiGet.mockClear()
  })

  it('a sub-card row is a real link to the full card', async () => {
    await openParentCard()
    expect(row().getAttribute('href')).toBe('/o/101')
  })

  it('clicking a sub-card opens a pop-up over the parent instead of navigating', async () => {
    await openPopup()
    // Still on the parent card — nothing navigated.
    expect(path).toBe('/o/100')
    expect(document.querySelector('[data-testid="board"]')).toBeNull()

    const dialog = popup()!.closest<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    // Named by the sub-card's title (worker: prefix dropped).
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(title?.textContent).toBe('Migrate invoices table')

    // Status, owner, PR, summary, latest activity and its own chat.
    expect(popup()!.querySelector('[data-testid="sub-card-status"]')?.textContent).toContain('Needs You')
    expect(popup()!.textContent).toContain('#101')
    expect(popup()!.textContent).toContain('dana')
    const pr = popup()!.querySelector<HTMLAnchorElement>('[data-testid="sub-card-pr"]')!
    expect(pr.href).toBe('https://github.com/acme/app/pull/77')
    expect(pr.textContent).toContain('PR #77')
    expect(pr.target).toBe('_blank')
    expect(popup()!.querySelector('[data-testid="sub-card-summary"]')?.textContent).toContain('Migrated 4 tables')
    expect(popup()!.querySelector('[data-testid="sub-card-activity"]')?.textContent).toContain('Running the migration tests — 12/14 green')
    expect(popup()!.querySelector('[data-testid="thread-101"]')).toBeTruthy()
    expect(popup()!.querySelector('textarea[aria-label="Message"]')).toBeTruthy()
    // The embedded chat brings no second header / close control of its own.
    expect(popup()!.querySelector('button[aria-label="Close session"]')).toBeNull()

    // The parent card is still mounted underneath, and the row is marked current.
    expect(document.querySelector('[data-testid="thread-100"]')).toBeTruthy()
    expect(row().getAttribute('aria-current')).toBe('true')
    expect(apiGet).toHaveBeenCalledWith('/objectives/101/progress?limit=1')
  })

  it('Escape closes the pop-up back to the parent card (not the board), focus returns to the row', async () => {
    await openPopup()
    await press('Escape')
    await settle()
    expect(popup()).toBeNull()
    expect(path).toBe('/o/100')
    expect(document.querySelector('[data-testid="board"]')).toBeNull()
    expect(document.querySelector('[data-testid="thread-100"]')).toBeTruthy()
    expect(document.activeElement).toBe(row())

    // With the pop-up gone, Escape on the page keeps its old meaning.
    await press('Escape', document.body)
    await settle()
    expect(path).toBe('/')
  })

  it('Escape typed in the pop-up chat box closes only the pop-up', async () => {
    await openPopup()
    const box = popup()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    box.focus()
    await press('Escape', box)
    await settle()
    expect(popup()).toBeNull()
    expect(path).toBe('/o/100')
  })

  it('a press outside the pop-up closes it back to the parent', async () => {
    await openPopup()
    const backdrop = Array.from(document.querySelectorAll<HTMLElement>('div')).find(d => d.className.includes('bg-[var(--scrim)]'))
    expect(backdrop).toBeTruthy()
    await click(backdrop!)
    await settle()
    expect(popup()).toBeNull()
    expect(path).toBe('/o/100')
  })

  it('the close button closes it', async () => {
    await openPopup()
    await click(popup()!.querySelector('[data-testid="sub-card-close"]'))
    await settle()
    expect(popup()).toBeNull()
    expect(path).toBe('/o/100')
  })

  it('"Open full card" expands to the full sub-card page', async () => {
    await openPopup()
    const open = popup()!.querySelector<HTMLAnchorElement>('[data-testid="sub-card-open-full"]')!
    expect(open.textContent).toContain('Open full card')
    expect(open.getAttribute('href')).toBe('/o/101')
    await click(open)
    await settle()
    expect(path).toBe('/o/101')
    expect(popup()).toBeNull()
  })

  it('Cmd / Ctrl / middle-click on a sub-card row leave the browser to open a new tab', async () => {
    await openParentCard()
    for (const init of [{ metaKey: true }, { ctrlKey: true }, { button: 1 }] as MouseEventInit[]) {
      expect(await clickWith(row(), init)).toBe(false)
      expect(popup()).toBeNull()
      expect(path).toBe('/o/100')
    }
  })

  it('Cmd-click on "Open full card" is left to the browser too', async () => {
    await openPopup()
    const open = popup()!.querySelector<HTMLAnchorElement>('[data-testid="sub-card-open-full"]')!
    expect(await clickWith(open, { metaKey: true })).toBe(false)
    expect(path).toBe('/o/100')
  })
})

describe('Sub-card pop-up — helpers', () => {
  it('latestActivityOf: worker snapshot, then transcript message, then last tool', () => {
    expect(latestActivityOf(null)).toBeNull()
    expect(latestActivityOf({ latest: null, transcript: null })).toBeNull()
    expect(latestActivityOf({ latest: { label: 'Step 2', note: null, created_at: 't1' } })).toEqual({ text: 'Step 2', at: 't1' })
    expect(latestActivityOf({
      latest: null,
      transcript: { last_assistant_message: 'Tests pass.', last_tool: { name: 'Bash', summary: 'npm test' }, last_event_at: 't2' },
    })).toEqual({ text: 'Tests pass.', at: 't2' })
    expect(latestActivityOf({
      latest: { label: null, note: null, created_at: 't0' },
      transcript: { last_assistant_message: null, last_tool: { name: 'Bash', summary: 'npm test' }, last_event_at: 't3' },
    })).toEqual({ text: 'Bash: npm test', at: 't3' })
  })

  it('isPlainLeftClick only for an unmodified primary click', () => {
    const ev = (init: Partial<ReactMouseEvent>) => ({ button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init }) as ReactMouseEvent
    expect(isPlainLeftClick(ev({}))).toBe(true)
    expect(isPlainLeftClick(ev({ metaKey: true }))).toBe(false)
    expect(isPlainLeftClick(ev({ ctrlKey: true }))).toBe(false)
    expect(isPlainLeftClick(ev({ shiftKey: true }))).toBe(false)
    expect(isPlainLeftClick(ev({ altKey: true }))).toBe(false)
    expect(isPlainLeftClick(ev({ button: 1 }))).toBe(false)
    expect(cardHref(7)).toBe('/o/7')
  })
})
