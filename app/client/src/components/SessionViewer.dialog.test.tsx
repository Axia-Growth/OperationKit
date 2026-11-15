// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Objective } from '@operationkit/shared'
import { cleanup, click, press, render } from '../test/render'

/* SessionViewer drawer/dialog chromes on ui/Modal (UI SDK Dialog): a named
   modal dialog, Escape closes it, focus returns to the opener, and the `f`
   fullscreen shortcut still works. Page chrome stays a plain page region. */

vi.mock('../lib/api', () => ({
  api: {
    get: (url: string) => Promise.resolve(/\/objectives\/\d+$/.test(url) ? {} : []),
    post: () => Promise.resolve({}),
  },
}))
vi.mock('../hooks/useAgents', () => ({ useAgents: () => ({ labelOf: (s: string) => s }) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null }) }))
vi.mock('./session-viewer/ThreadPane', () => ({ ThreadPane: () => null }))
vi.mock('./session-viewer/Composer', () => ({ Composer: () => <textarea aria-label="Message" /> }))
vi.mock('./session-viewer/BriefPanel', () => ({ BriefPanel: () => null }))
vi.mock('../preview/DesignCanvas', () => ({ DesignCanvas: () => null }))

const { SessionViewer } = await import('./SessionViewer')
const { SIZE_KEY } = await import('./session-viewer/types')

const settle = () => new Promise((r) => setTimeout(r, 0))
const objective = { id: 42, title: 'Fix the login bug', status: 'working', workspace: 'acme' } as unknown as Objective
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

function opener() {
  const b = document.createElement('button')
  b.textContent = 'Open card'
  document.body.appendChild(b)
  b.focus()
  return b
}

describe('SessionViewer — modal chromes', () => {
  beforeEach(() => { localStorage.removeItem(SIZE_KEY) })
  afterEach(async () => {
    await cleanup()
  })

  for (const chrome of ['drawer', 'dialog'] as const) {
    it(`${chrome}: named modal dialog; Escape closes and focus returns to the opener`, async () => {
      const trigger = opener()
      const onClose = vi.fn()
      const view = await render(<SessionViewer objective={objective} onClose={onClose} chrome={chrome} />)
      const d = dialog()!
      expect(d).toBeTruthy()
      expect(d.getAttribute('aria-modal')).toBe('true')
      expect(document.getElementById(d.getAttribute('aria-labelledby')!)?.textContent).toBe('Fix the login bug')
      expect(d.contains(document.activeElement)).toBe(true)

      await press('Escape')
      expect(onClose).toHaveBeenCalledTimes(1)
      await view.unmount()
      await settle()
      expect(document.activeElement).toBe(trigger)
    })
  }

  it('drawer: the `f` shortcut still toggles fullscreen (and not while typing)', async () => {
    opener()
    await render(<SessionViewer objective={objective} onClose={() => {}} />)
    expect(dialog()!.className).not.toContain('sm:w-screen')

    await press('f')
    expect(localStorage.getItem(SIZE_KEY)).toBe('full')
    expect(dialog()!.className).toContain('sm:w-screen')
    // Same dialog, still open and holding focus.
    expect(dialog()!.contains(document.activeElement)).toBe(true)

    const box = dialog()!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
    box.focus()
    await press('f', box)
    expect(localStorage.getItem(SIZE_KEY)).toBe('full')

    await press('F', dialog()!)
    expect(localStorage.getItem(SIZE_KEY)).toBe('half')
  })

  it('drawer: the Close session button closes it', async () => {
    opener()
    const onClose = vi.fn()
    await render(<SessionViewer objective={objective} onClose={onClose} />)
    await click(dialog()!.querySelector('button[aria-label="Close session"]'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('page: a plain named page region, Escape and `f` keep their shortcuts', async () => {
    const onClose = vi.fn()
    const onOpenInNewTab = vi.fn()
    const view = await render(<SessionViewer objective={objective} onClose={onClose} chrome="page" onOpenInNewTab={onOpenInNewTab} />)
    expect(dialog()).toBeNull()
    expect(document.querySelector('[aria-modal]')).toBeNull()
    const region = view.container.querySelector<HTMLElement>('[role="region"]')!
    expect(document.getElementById(region.getAttribute('aria-labelledby')!)?.textContent).toBe('Fix the login bug')

    await press('f', document.body)
    expect(onOpenInNewTab).toHaveBeenCalledTimes(1)
    await press('Escape', document.body)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
