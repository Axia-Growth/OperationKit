// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { cleanup, click, press, render } from '../../test/render'
import { WorkspaceGraph } from './WorkspaceGraph'

/* Full screen on ui/Modal (UI SDK Dialog): a named modal dialog, Escape leaves
   it, and focus returns to the inline "Full screen" button. */

const GRAPH = {
  root: '/kb/garden',
  nodes: [
    { rel: 'people/tom.md', title: 'Tom Whitfield', kind: 'person', degree: 1 },
    { rel: 'organizations/greenway.md', title: 'Greenway Growers', kind: 'organization', degree: 1 },
  ],
  links: [{ a: 'organizations/greenway.md', b: 'people/tom.md', kinds: ['related'], label: null, weight: 1 }],
  counts: { pages: 2, links: 1, isolated: 0, by_kind: { organization: 1, person: 1 } },
  truncated: false,
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)) }
const fullButton = () => document.querySelector<HTMLButtonElement>('button[aria-label="Full screen"]')

describe('WorkspaceGraph — full screen', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(GRAPH), { status: 200, headers: { 'Content-Type': 'application/json' } })))
  })
  afterEach(async () => {
    await cleanup()
    vi.unstubAllGlobals()
  })

  it('opens as a named modal dialog; Escape exits and focus returns to the Full screen button', async () => {
    await render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />)
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    await click(fullButton())
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Context graph, full screen')
    // The graph moved into the dialog; focus starts on its exit button.
    expect(dialog.querySelectorAll('g[data-rel]')).toHaveLength(2)
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Exit full screen')

    await press('Escape')
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.querySelectorAll('g[data-rel]')).toHaveLength(2)
    expect(document.activeElement).toBe(fullButton())
  })

  it('the Exit full screen button leaves it too', async () => {
    await render(<WorkspaceGraph workspace="garden" onOpenNote={() => {}} />)
    await settle()
    await click(fullButton())
    await click(document.querySelector('[role="dialog"] button[aria-label="Exit full screen"]'))
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(fullButton())
  })
})
