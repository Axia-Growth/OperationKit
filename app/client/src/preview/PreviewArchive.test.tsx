// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewArchive } from './PreviewArchive'
import { byRole, cleanup, click, press, render } from '../test/render'

/* obj 900819 — Done / Retired is one choice: a ui/SegmentedControl radio
   group (UI SDK) instead of two aria-pressed buttons. */

const { loadCancelled } = vi.hoisted(() => ({ loadCancelled: vi.fn(async () => {}) }))
vi.mock('../hooks/useArchiveLibrary', () => ({
  useArchiveLibrary: () => ({
    done: [], cancelled: [], doneLoading: false, cancelledLoading: false, cancelledLoaded: false,
    error: null, loadCancelled, applyUpdate: () => {},
  }),
}))
vi.mock('../hooks/useWorkspaces', () => ({ useWorkspaces: () => ({ shortOf: (s: string) => s, workspaces: [], labelOf: (s: string) => s }) }))
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: { role: 'admin', workspaces: [] } }) }))
vi.mock('../context/nav', () => ({ useNavigate: () => () => {} }))
vi.mock('../hooks/useSlashSearch', () => ({ useSlashSearch: () => [false, () => {}] }))
vi.mock('../components/SessionViewer', () => ({ SessionViewer: () => null }))
vi.mock('../components/ObjectiveModal', () => ({ ObjectiveModal: () => null }))
vi.mock('../components/ObjectiveSearchPanel', () => ({ ObjectiveSearchPanel: () => null }))
vi.mock('../lib/api', () => ({ api: { get: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } }))

afterEach(cleanup)

describe('PreviewArchive list switch', () => {
  it('is a named radio group; ArrowRight picks Retired and loads it, a click goes back', async () => {
    const { container } = await render(<PreviewArchive workspaces={[]} />)
    const group = byRole(container, 'radiogroup')[0]
    expect(group.getAttribute('aria-label')).toBe('Archive list')
    const [done, retired] = byRole(group, 'radio')
    expect(done.textContent).toBe('Done0')
    expect(retired.textContent).toBe('Retired') // count unknown until loaded
    expect(done.getAttribute('aria-checked')).toBe('true')
    expect([done, retired].filter(r => r.tabIndex === 0)).toEqual([done])
    expect(loadCancelled).not.toHaveBeenCalled()
    done.focus()
    await press('ArrowRight')
    expect(retired.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(retired)
    expect(loadCancelled).toHaveBeenCalled()
    await click(done)
    expect(done.getAttribute('aria-checked')).toBe('true')
  })
})
