// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BuildFooter } from './BuildFooter'
import { cleanup, render } from '../../test/render'

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const health = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('BuildFooter (obj 720210; moved to System and hidden when unknown in polish F5, obj 900806)', () => {
  it('shows the running build commit from /api/health', async () => {
    const fetchMock = health({ status: 'ok', commit: '4212de2abcde' })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = await render(<BuildFooter />)
    await vi.waitFor(() => expect(container.querySelector('[data-testid="build-footer"]')?.textContent).toBe('Build 4212de2abcde'))
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.anything())
  })

  it('renders nothing when the commit is null — no "Build unknown"', async () => {
    const fetchMock = health({ status: 'ok', commit: null })
    vi.stubGlobal('fetch', fetchMock)
    const { container } = await render(<BuildFooter />)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when /api/health fails', async () => {
    const fetchMock = health({}, 500)
    vi.stubGlobal('fetch', fetchMock)
    const { container } = await render(<BuildFooter />)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
    await new Promise(r => setTimeout(r, 0))
    expect(container.textContent).not.toContain('unknown')
    expect(container.querySelector('[data-testid="build-footer"]')).toBeNull()
  })
})
