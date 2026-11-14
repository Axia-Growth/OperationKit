// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectMcpServerDialog } from './ConnectMcpServerDialog'
import { byRole, cleanup, click, press, render } from '../../test/render'

/* obj 900819 — "Where the server comes from" is a ui/Tabs tablist (UI SDK
   tabs): named, one tab stop, arrow keys switch source. */

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn(), post: vi.fn() } }))
vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: class extends Error {} }))

afterEach(cleanup)

describe('ConnectMcpServerDialog source tabs', () => {
  it('arrow keys switch Paste a URL → From the catalog, and picking an entry returns to the URL tab', async () => {
    apiMock.get.mockResolvedValue([{ id: 'docs', name: 'Docs search', mcp_url: 'https://mcp.docs.test/mcp' }])
    await render(
      <ConnectMcpServerDialog open onClose={() => {}} workspaces={[{ value: 'example', label: 'Example' }]} defaultWorkspace="example" onConnected={() => {}} />,
    )
    const list = byRole(document.body, 'tablist').find(l => l.getAttribute('aria-label') === 'Where the server comes from')!
    expect(list).toBeTruthy()
    const tabs = byRole(list, 'tab')
    expect(tabs.map(t => t.textContent)).toEqual(['Paste a URL', 'From the catalog'])
    expect(tabs[0].getAttribute('aria-selected')).toBe('true')
    expect(tabs.filter(t => t.tabIndex === 0)).toHaveLength(1)

    tabs[0].focus()
    await press('ArrowRight')
    expect(document.activeElement).toBe(tabs[1])
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    await vi.waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/mcp-servers/catalog'))
    const entry = await vi.waitFor(() => {
      const b = [...document.body.querySelectorAll('button')].find(x => x.textContent?.startsWith('Docs search'))
      if (!b) throw new Error('catalog not rendered')
      return b
    })
    await click(entry)
    expect(byRole(list, 'tab')[0].getAttribute('aria-selected')).toBe('true')
    expect((document.body.querySelector('input[type="url"]') as HTMLInputElement).value).toBe('https://mcp.docs.test/mcp')
  })
})
