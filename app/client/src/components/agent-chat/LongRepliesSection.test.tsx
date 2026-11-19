import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { LongRepliesSection } from './LongRepliesSection'
import type { ChatAgentInfo } from './types'

/* obj 901491 — the per-bot budget of one long reply: shows the effective
   limit, an admin saves steps + minutes (PUT, empty = default), a bad value is
   never sent, a non-admin sees it read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const AGENT = { slug: 'operation-kit-dev', name: 'Operation Kit Dev' } as unknown as ChatAgentInfo

let host: HTMLDivElement
let root: Root
let own: { max_steps: number | null; max_minutes: number | null }
let installEnabled = true
let requests: { url: string; method: string; body: unknown }[] = []

const payload = () => ({
  turn_limits: {
    slug: AGENT.slug,
    install_enabled: installEnabled,
    ...own,
    updated_at: null,
    effective: { max_steps: own.max_steps ?? 60, max_minutes: own.max_minutes ?? 30 },
    defaults: { max_steps: 60, max_minutes: 30, foreground_seconds: 20 },
    ranges: { steps: { min: 8, max: 200 }, minutes: { min: 2, max: 240 } },
  },
  recent: [{ id: 7, status: 'limit', background: true, steps: 60, tool_calls: 71, limit_reason: 'steps', started_at: '', finished_at: '' }],
})

beforeEach(() => {
  own = { max_steps: null, max_minutes: null }
  installEnabled = true
  requests = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init?.method ?? 'GET', body })
    if (init?.method === 'PUT') own = { max_steps: body.max_steps, max_minutes: body.max_minutes }
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
  await act(async () => { root.render(<LongRepliesSection agent={AGENT} isAdmin={isAdmin} />) })
  await act(async () => { await Promise.resolve() })
}

const field = (k: 'steps' | 'minutes') => host.querySelector<HTMLInputElement>(`[data-testid="long-replies-${k}"]`)!
const saveButton = () => [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('Save limits')) as HTMLButtonElement | undefined
const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? ''

async function type(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  await act(async () => {
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('LongRepliesSection', () => {
  it('shows the default budget and the last reply', async () => {
    await render(true)
    expect(requests[0]).toMatchObject({ url: '/api/agent-chat/agents/operation-kit-dev/turn-limits', method: 'GET' })
    expect(text('long-replies-state')).toBe('60 steps · 30 min')
    expect(field('steps').value).toBe('')
    expect(text('long-replies-last')).toContain('Last reply: 60 steps, 71 actions, stopped at its limit and said so (ran in the background).')
    expect(saveButton()!.disabled).toBe(true)
  })

  it('an admin saves a new budget; empty goes back to the default', async () => {
    await render(true)
    await type(field('steps'), '120')
    await type(field('minutes'), '45')
    await act(async () => { saveButton()!.click() })
    await act(async () => { await Promise.resolve() })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { max_steps: 120, max_minutes: 45 } })
    expect(text('long-replies-state')).toBe('120 steps · 45 min')

    await type(field('steps'), '')
    await act(async () => { saveButton()!.click() })
    await act(async () => { await Promise.resolve() })
    expect(requests.at(-1)).toMatchObject({ method: 'PUT', body: { max_steps: null, max_minutes: 45 } })
    expect(text('long-replies-state')).toBe('60 steps · 45 min')
  })

  it('never sends a value outside the range', async () => {
    await render(true)
    await type(field('steps'), '5000')
    expect(saveButton()!.disabled).toBe(true)
    expect(host.textContent).toContain('A whole number from 8 to 200, or empty.')
    await type(field('steps'), 'lots')
    expect(saveButton()!.disabled).toBe(true)
    expect(requests.filter(r => r.method === 'PUT')).toEqual([])
  })

  it('is read-only for a non-admin, and says when long replies are off for the install', async () => {
    installEnabled = false
    await render(false)
    expect(saveButton()).toBeUndefined()
    expect(field('steps').disabled).toBe(true)
    expect(text('long-replies-last')).toBe('Only an admin can change these limits.')
    expect(text('long-replies-state')).toBe('Off for this install')
    expect(text('long-replies-off')).toContain('stops at 8 steps')
  })
})
