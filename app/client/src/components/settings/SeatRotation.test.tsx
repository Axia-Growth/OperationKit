// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactElement } from 'react'

// obj 901395 — what the person sees: the small "moved to another account"
// line in chat, the parked seat's reset time and reason in Settings, and the
// three rotation settings.

const apiMock = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))
vi.mock('../../lib/api', () => ({
  api: apiMock,
  ApiError: class ApiError extends Error { body: unknown = null },
}))

import { ErrorLine } from '../agent-chat/ChatItems'
import { healthBadge, fmtResetTime } from './SettingsSeats'
import { SeatRotationPanel } from './SeatRotationPanel'

const row = (content: string, meta: Record<string, unknown> | null) =>
  ({ id: 1, role: 'error', content, provider: 'claude', model: 'm', tool_name: null, meta, images: [], created_at: '2026-11-18 01:00:00' }) as never

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  flushSync(() => root.unmount())
  host.remove()
})
const render = (el: ReactElement) => flushSync(() => root.render(el))
async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
  }
}
const byLabel = (text: string) => {
  const label = [...host.querySelectorAll('label')].find(l => l.textContent?.trim().startsWith(text))
  if (!label) throw new Error(`no label "${text}"`)
  return host.querySelector(`#${CSS.escape(label.getAttribute('for') || '')}`) as HTMLInputElement
}
const setValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  flushSync(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}


describe('chat: a reply that moved to another account', () => {
  it('is one quiet line with the seat labels — not the red "Couldn\'t answer" alert', () => {
    render(<ErrorLine m={row('Seat 2 reached its usage limit, so this reply moved to Seat 3. Nothing was run twice.', { kind: 'seat_moved', seat_to: 'Seat 3', seat_from: ['Seat 2'] })} />)
    const line = host.querySelector('[data-testid="seat-moved-line"]')!
    expect(line.textContent).toContain('Seat 2 reached its usage limit, so this reply moved to Seat 3.')
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.textContent).not.toContain("Couldn't answer")
  })

  it('the all-accounts-limited message is still a real alert, with its reason', () => {
    render(<ErrorLine m={row('All 3 Claude accounts are at their usage limit. The first one resets at 9:00 PM EST (in about 38 minutes).', null)} />)
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('All 3 Claude accounts are at their usage limit.')
  })
})

describe('Settings: a parked seat', () => {
  it('shows when it is back and why', () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString()
    expect(healthBadge({ health: 'cooling_down', cooldownUntil: soon, cooldownReason: 'limit' }).text).toMatch(/^Cooling down until .+ \(usage limit\)$/)
    expect(healthBadge({ health: 'cooling_down', cooldownUntil: soon, cooldownReason: 'empty_turn' }).text).toMatch(/^Cooling down until .+ \(empty reply\)$/)
    // An older server sends no reason: unchanged text.
    expect(healthBadge({ health: 'cooling_down', cooldownUntil: soon }).text).toMatch(/^Cooling down until [^()]+$/)
  })

  it('a reset on another day carries the weekday', () => {
    const now = new Date(2026, 10, 17, 20, 0)
    expect(fmtResetTime(new Date(2026, 10, 17, 21, 30).toISOString(), now)).not.toMatch(/Tue|Wed/)
    expect(fmtResetTime(new Date(2026, 10, 18, 9, 0).toISOString(), now)).toMatch(/^Wed /)
  })
})

describe('Settings: rotation settings', () => {
  const view = {
    values: { limitCooldownMinutes: 15, emptyTurnCooldownMinutes: 5, maxSeatsPerTurn: 4 },
    defaults: { limitCooldownMinutes: 15, emptyTurnCooldownMinutes: 5, maxSeatsPerTurn: 4 },
    bounds: { limitCooldownMinutes: { min: 1, max: 300 }, emptyTurnCooldownMinutes: { min: 0, max: 120 }, maxSeatsPerTurn: { min: 1, max: 20 } },
    env_locked: [] as string[],
  }
  beforeEach(() => {
    apiMock.get.mockReset()
    apiMock.put.mockReset()
  })

  it('loads the three numbers and saves only what changed', async () => {
    apiMock.get.mockResolvedValue(view)
    apiMock.put.mockResolvedValue({ ...view, values: { ...view.values, maxSeatsPerTurn: 6 } })
    render(<SeatRotationPanel />)
    await flush()
    const input = byLabel('Accounts to try per reply')
    expect(input.value).toBe('4')
    expect(byLabel('Rest after a usage limit (minutes)').value).toBe('15')
    expect(byLabel('Rest after an empty reply (minutes)').value).toBe('5')
    const save = () => [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Save')) as HTMLButtonElement
    expect(save().disabled).toBe(true)
    setValue(input, '6')
    expect(save().disabled).toBe(false)
    flushSync(() => save().click())
    await flush()
    expect(apiMock.put).toHaveBeenCalledWith('/admin/seats/rotation', { maxSeatsPerTurn: 6 })
    expect(host.textContent).toContain('Saved')
  })

  it('a value set by the server configuration is shown locked', async () => {
    apiMock.get.mockResolvedValue({ ...view, env_locked: ['maxSeatsPerTurn'] })
    render(<SeatRotationPanel />)
    await flush()
    expect(byLabel('Accounts to try per reply').disabled).toBe(true)
    expect(host.textContent).toContain('Set by the server configuration. Change it there.')
  })
})
