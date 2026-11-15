// @vitest-environment jsdom
/**
 * Polish F5 (obj 900806): Branding's destructive actions ask first.
 * "Reset to default" wiped the name and every colour with one click, right
 * next to Save; "Clear" removed an uploaded logo with no question. Both now
 * open a confirm dialog, and only confirming calls the API.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrandingPanel } from './BrandingPanel'
import { DEFAULT_BRANDING } from '../../hooks/useBranding'
import { cleanup, click, render } from '../../test/render'

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin', workspaces: [] } }),
}))

const dialog = () => document.querySelector<HTMLElement>('[role="alertdialog"]')
const buttonIn = (root: ParentNode, name: string) =>
  Array.from(root.querySelectorAll('button')).find(b => b.textContent?.trim() === name) as HTMLButtonElement | undefined

const fetchMock = vi.fn()
const calls = (method: string, url: string) =>
  fetchMock.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method)

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({
    ok: true,
    json: async () => ({ ...DEFAULT_BRANDING, wordmark_url: '/api/branding/wordmark' }),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0))
}

describe('BrandingPanel destructive actions confirm first', () => {
  it('Reset to default sits in a Danger zone, away from Save', async () => {
    const { container } = await render(<BrandingPanel />)
    const reset = buttonIn(container, 'Reset to default')!
    const save = buttonIn(container, 'Save')!
    expect(reset).toBeTruthy()
    expect(save).toBeTruthy()
    // Not in the same action row as Save.
    expect(reset.parentElement).not.toBe(save.parentElement)
    expect(reset.closest('section')?.textContent).toContain('Reset branding')
  })

  it('Reset to default asks first; Cancel does not reset', async () => {
    const { container } = await render(<BrandingPanel />)
    await click(buttonIn(container, 'Reset to default')!)
    expect(dialog()).toBeTruthy()
    expect(dialog()!.textContent).toContain('Reset branding to the default?')
    expect(calls('POST', '/api/branding/reset')).toHaveLength(0)

    await click(buttonIn(dialog()!, 'Cancel')!)
    await settle()
    expect(calls('POST', '/api/branding/reset')).toHaveLength(0)
  })

  it('confirming Reset calls the reset API once', async () => {
    const { container } = await render(<BrandingPanel />)
    await click(buttonIn(container, 'Reset to default')!)
    await click(buttonIn(dialog()!, 'Reset branding')!)
    await settle()
    expect(calls('POST', '/api/branding/reset')).toHaveLength(1)
  })

  it('Clear logo asks first and only deletes on confirm', async () => {
    const { container } = await render(<BrandingPanel />)
    const clear = buttonIn(container, 'Clear')!
    expect(clear).toBeTruthy()
    await click(clear)
    expect(dialog()).toBeTruthy()
    expect(dialog()!.textContent).toContain('Clear the wordmark (light bg)?')
    expect(calls('DELETE', '/api/branding/upload/wordmark')).toHaveLength(0)

    await click(buttonIn(dialog()!, 'Clear')!)
    await settle()
    expect(calls('DELETE', '/api/branding/upload/wordmark')).toHaveLength(1)
  })
})
