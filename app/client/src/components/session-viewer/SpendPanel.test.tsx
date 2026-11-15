// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import type { SpendGuardView } from '@operationkit/shared'
import { SpendPanel } from './SpendPanel'
import { byRole, cleanup, click, render } from '../../test/render'

/* obj 900909 — the card shows the ceiling, spend so far and the projection,
   names where the ceiling came from in plain words, shows the guard's last
   action and a refused start, and lets the owner change the ceiling. */

const base: SpendGuardView = {
  objective_id: 42,
  ceiling_usd: 150,
  ceiling_source: 'default:high',
  ceiling_is_default: true,
  spent_usd: 61.5,
  projected_usd: 121.5,
  burn_usd_per_min: 2,
  horizon_minutes: 30,
  stage: 'none',
  stage_at: null,
  last_action: null,
  last_action_at: null,
  last_refusal: null,
  last_refusal_at: null,
  degrade_allowed: true,
  projection_guard_enabled: true,
  spawn_guard_enabled: true,
  over_ceiling: false,
}

function mockFetch(view: SpendGuardView, onPut?: (body: unknown) => SpendGuardView | { status: number; error: string }) {
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PUT') {
      const out = onPut?.(JSON.parse(String(init.body)))
      if (out && 'error' in out) return new Response(JSON.stringify({ error: out.error }), { status: out.status })
      return new Response(JSON.stringify(out ?? view), { status: 200 })
    }
    return new Response(JSON.stringify(view), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

async function settle() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
}

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
})

const text = (el: Element | null) => el?.textContent ?? ''

describe('SpendPanel', () => {
  it('shows ceiling, spent and projected for a running card', async () => {
    const fetch = mockFetch(base)
    const { container } = await render(<SpendPanel objectiveId={42} status="working" />)
    await settle()
    expect(fetch.mock.calls[0][0]).toBe('/api/objectives/42/spend')
    expect(text(container.querySelector('[data-testid="spend-ceiling"]'))).toBe('$150.00')
    expect(text(container.querySelector('[data-testid="spend-spent"]'))).toBe('$61.50')
    expect(text(container.querySelector('[data-testid="spend-projected"]'))).toBe('$121.50')
    expect(container.textContent).toContain('Default for high effort')
    expect(container.textContent).toContain('$2.00 a minute, next 30 min')
    expect(container.textContent).toContain('Within budget')
    // No raw source code or setting names reach the screen.
    expect(container.textContent).not.toMatch(/default:high|spend_/)
    expect(byRole(container, 'progressbar')[0].getAttribute('aria-valuenow')).toBe('41')
  })

  it('shows the guard stage, its last action and a refused start', async () => {
    mockFetch({
      ...base,
      ceiling_source: 'objective',
      ceiling_is_default: false,
      ceiling_usd: 50,
      spent_usd: 52,
      projected_usd: null,
      burn_usd_per_min: null,
      stage: 'parked',
      over_ceiling: true,
      last_action: 'Parked by the spend guard: $52.00 spent of a $50.00 ceiling.',
      last_refusal: 'Respawn refused by the spend guard: this card has spent $52.00 against its $50.00 ceiling (set on this card).',
    })
    const { container } = await render(<SpendPanel objectiveId={42} status="review" />)
    await settle()
    expect(container.textContent).toContain('Set on this card')
    expect(container.textContent).toContain('Parked')
    expect(container.textContent).toContain('Not running')
    expect(container.textContent).toContain('Start refused')
    expect(text(container.querySelector('[data-testid="spend-last-action"]'))).toContain('Parked by the spend guard')
  })

  it('the owner can raise the ceiling; a refusal is shown under the form', async () => {
    let attempt = 0
    const fetch = mockFetch(base, body => {
      attempt++
      if (attempt === 1) return { status: 403, error: 'Only the card\'s owner or an admin can change its spend ceiling' }
      return { ...base, ceiling_usd: (body as { cost_usd: number }).cost_usd, ceiling_source: 'objective', ceiling_is_default: false }
    })
    const { container } = await render(<SpendPanel objectiveId={42} status="working" />)
    await settle()
    const change = Array.from(container.querySelectorAll('button')).find(b => b.textContent === 'Change ceiling')!
    await click(change)
    const input = container.querySelector('input[type="number"]') as HTMLInputElement
    expect(input.value).toBe('225')
    const submit = () => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Save ceiling'))!
    await click(submit())
    await settle()
    expect(container.textContent).toContain('Only the card\'s owner or an admin can change its spend ceiling')
    await click(submit())
    await settle()
    const put = fetch.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'PUT')
    expect(JSON.parse(String((put[1][1] as RequestInit).body))).toEqual({ cost_usd: 225 })
    expect(text(container.querySelector('[data-testid="spend-ceiling"]'))).toBe('$225.00')
    expect(container.textContent).toContain('Set on this card')
  })

  it('the cheaper-tier switch saves the card\'s choice', async () => {
    const fetch = mockFetch(base, body => ({ ...base, degrade_allowed: (body as { degrade_allowed: boolean }).degrade_allowed }))
    const { container } = await render(<SpendPanel objectiveId={42} status="working" />)
    await settle()
    const sw = byRole(container, 'switch')[0]
    expect(sw.getAttribute('aria-checked')).toBe('true')
    await click(sw)
    await settle()
    const put = fetch.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PUT')!
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ degrade_allowed: false })
    expect(byRole(container, 'switch')[0].getAttribute('aria-checked')).toBe('false')
  })
})
