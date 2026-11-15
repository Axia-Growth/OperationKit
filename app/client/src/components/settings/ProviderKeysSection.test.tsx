// @vitest-environment jsdom
/**
 * Settings → Models → API key providers (polish F5, obj 900806): the stored keys
 * are a DataTable, and Remove sits in the row's "⋯" menu — it still asks first
 * and only deletes after the operator confirms.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, click, byRole } from '../../test/render'
import { ProviderKeysSection } from './ProviderKeysSection'

const { apiMock, confirmMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
  confirmMock: vi.fn(),
}))
vi.mock('../../lib/api', () => ({ api: apiMock }))
vi.mock('../ui', async () => {
  const actual = await vi.importActual<typeof import('../ui')>('../ui')
  return { ...actual, useConfirm: () => ({ confirm: confirmMock, confirmDialog: null }) }
})

const STORED = [
  { key: 'PROVIDER_API_KEY__OPENAI', version: 2, updatedAt: '2026-11-01T00:00:00Z' },
  { key: 'SOME_OTHER_SECRET', version: 1, updatedAt: '2026-11-01T00:00:00Z' },
]

beforeEach(() => {
  apiMock.get.mockReset().mockResolvedValue(STORED)
  apiMock.del.mockReset().mockResolvedValue({ ok: true })
  confirmMock.mockReset()
})
afterEach(async () => { await cleanup() })

async function openRemove() {
  await click(document.querySelector('[aria-label="Actions for OpenAI"]'))
  await click(byRole(document, 'menuitem').find(i => i.textContent?.trim() === 'Remove')!)
}

describe('ProviderKeysSection', () => {
  it('lists only provider keys, in a table', async () => {
    const { container } = await render(<ProviderKeysSection />)
    const table = container.querySelector('table[aria-label="Provider API keys"]')!
    expect(table.textContent).toContain('OpenAI')
    expect(table.textContent).toContain('v2')
    expect(container.textContent).not.toContain('SOME_OTHER_SECRET')
  })

  it('Remove asks first and does nothing when cancelled', async () => {
    confirmMock.mockResolvedValue(false)
    await render(<ProviderKeysSection />)
    await openRemove()
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Remove OpenAI?', danger: true }))
    expect(apiMock.del).not.toHaveBeenCalled()
  })

  it('Remove deletes the key once confirmed', async () => {
    confirmMock.mockResolvedValue(true)
    await render(<ProviderKeysSection />)
    await openRemove()
    expect(apiMock.del).toHaveBeenCalledWith('/secrets?scopeType=global&key=PROVIDER_API_KEY__OPENAI')
  })
})
