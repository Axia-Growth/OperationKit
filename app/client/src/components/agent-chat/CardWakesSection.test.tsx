import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { CardWakesSection } from './CardWakesSection'
import type { ChatAgentInfo } from './types'

/* obj 901328 — the per-bot Card wakes switch: ON with no setup, an admin can
   turn it off (PUT {enabled:false}), a non-admin sees it read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = { slug: 'example-cto', name: 'Example CTO' } as unknown as ChatAgentInfo

let host: HTMLDivElement
let root: Root
let enabled = true
let limits: Record<string, unknown> | undefined
let requests: { url: string; method: string; body: unknown }[] = []

const payload = () => ({
  card_wakes: { slug: 'example-cto', enabled, is_default: enabled, updated_at: null, install_enabled: true, thread_title: 'Card wakes', ...(limits ? { limits } : {}) },
  recent: [{ id: 3, objective_id: 901, workspace: 'operationkit', need_kind: 'review', status: 'done', skip_reason: null, last_error: null, created_at: '' }],
})

beforeEach(() => {
  enabled = true
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init?.method ?? 'GET', body })
    if (init?.method === 'PUT') enabled = !!body.enabled
    return new Response(JSON.stringify(payload()), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

async function render(isAdmin: boolean) {
  await act(async () => { root.render(<CardWakesSection agent={AGENT} isAdmin={isAdmin} />) })
  await act(async () => { await Promise.resolve() })
}

const sw = () => host.querySelector<HTMLElement>('[role="switch"]')!

describe('CardWakesSection', () => {
  it('is on by default and names the Card wakes thread', async () => {
    await render(true)
    expect(requests[0]).toMatchObject({ url: '/api/agent-chat/agents/example-cto/card-wakes', method: 'GET' })
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).toContain('Card wakes')
    expect(host.textContent).toContain('Last: card #901, done')
  })

  it('shows the debounce and the hourly cap when the server sends them (obj 901394)', async () => {
    limits = { debounce_seconds: 60, max_per_hour: 12, window_minutes: 10, tools: 'chat', posts_to_chat: true }
    try {
      await render(true)
      const line = host.querySelector('[data-testid="card-wake-limits"]')!
      expect(line.textContent).toContain('within 60 seconds')
      expect(line.textContent).toContain('At most 12 wake turns an hour')
      expect(host.textContent).toContain('A wake is never an approval')
      expect(host.textContent).toContain('posted in your chat with it')
    } finally {
      limits = undefined
    }
  })

  it('an admin turns it off with one PUT', async () => {
    await render(true)
    await act(async () => { sw().click() })
    await act(async () => { await Promise.resolve() })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { enabled: false } })
    expect(sw().getAttribute('aria-checked')).toBe('false')
  })

  it('is read-only for a non-admin', async () => {
    await render(false)
    expect(sw().hasAttribute('data-disabled') || sw().hasAttribute('disabled')).toBe(true)
    expect(host.textContent).toContain('Only an admin can turn card wakes off.')
  })
})
