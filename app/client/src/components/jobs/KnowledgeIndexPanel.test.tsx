// @vitest-environment jsdom
//
// Jobs → Knowledge index: renders the running job (progress, counts, current
// file, Stop), disables Re-index while running, and renders nothing on a 403.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { KnowledgeIndexPanel } from './KnowledgeIndexPanel'
import type { KbSearchStatus } from '../../lib/kbSearch'

const { apiMock, store, ApiErrorMock } = vi.hoisted(() => {
  class ApiErrorMock extends Error {
    constructor(public status: number, public body: unknown, message: string) {
      super(message)
    }
  }
  const store: { res: unknown; fail: number | null } = { res: null, fail: null }
  const apiMock = {
    get: vi.fn(() => (store.fail ? Promise.reject(new ApiErrorMock(store.fail, null, 'Forbidden')) : Promise.resolve(structuredClone(store.res)))),
    post: vi.fn(() => Promise.resolve({ started: true })),
  }
  return { apiMock, store, ApiErrorMock }
})

vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: ApiErrorMock }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const STATUS: KbSearchStatus = {
  config: {
    provider: 'local', model: 'm', base_url: '', api_key_secret: '', api_key_configured: null,
    dimensions: 384, model_id: 'local:m', local_model_present: true,
  },
  availability: { available: true },
  index: { docs: 10, chunks: 40, docsCurrentModel: 4, dim: 384 },
  job: {
    id: 1, kind: 'backfill', status: 'running', trigger: 'manual', model_id: 'local:m', total: 10, processed: 4,
    embedded: 3, skipped: 1, failed: 0, removed: 0, chunks: 12, current_path: '/kb/notes/a.md', error: null,
    started_at: '2026-11-14 05:00:00', updated_at: '2026-11-14 05:01:00', finished_at: null,
  },
  queue: 0,
  providers: {
    local: { model: 'm', baseUrl: '', apiKeySecret: '', dimensions: 384 },
    openai: { model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', apiKeySecret: 'OPENAI_API_KEY', dimensions: 1536 },
    voyage: { model: 'voyage-3', baseUrl: 'https://api.voyageai.com/v1', apiKeySecret: 'VOYAGE_API_KEY', dimensions: 1024 },
    off: null,
  },
}

let root: Root
let host: HTMLDivElement

async function mount() {
  await act(async () => { root.render(<KnowledgeIndexPanel />) })
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  store.res = STATUS
  store.fail = null
  apiMock.get.mockClear()
  apiMock.post.mockClear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('KnowledgeIndexPanel', () => {
  it('shows the running job with progress, counts, current file and Stop', async () => {
    await mount()
    expect(apiMock.get).toHaveBeenCalledWith('/admin/kb-search')
    const text = host.textContent ?? ''
    expect(text).toContain('Knowledge index (semantic search)')
    expect(text).toContain('Backfill')
    expect(text).toContain('Running')
    expect(text).toContain('4/10 · 40%')
    expect(text).toContain('Reading /kb/notes/a.md')
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('40')
    const buttons = Array.from(host.querySelectorAll('button'))
    const reindex = buttons.find(b => b.textContent?.includes('Re-index now')) as HTMLButtonElement
    expect(reindex.disabled).toBe(true)
    const stop = buttons.find(b => b.textContent?.includes('Stop')) as HTMLButtonElement
    await act(async () => { stop.click() })
    expect(apiMock.post).toHaveBeenCalledWith('/admin/kb-search/cancel')
  })

  it('renders nothing for a non-admin (403)', async () => {
    store.fail = 403
    await mount()
    expect(host.innerHTML).toBe('')
  })
})
