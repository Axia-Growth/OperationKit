import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { HighAgencySection } from './HighAgencySection'
import { chooseOption } from '../../test/render'
import { runsPerDay, wakeTimes, type HighAgencyLevel } from '../../../../shared/high-agency'
import type { HighAgencyInfo, HighAgencyResponse } from './types'

/* obj 900748 / 900794 — High Agency on the bot's settings panel: a visible
   on/off and a LEVEL 1-10 control (not a hidden cron). Off by default; the
   level → wakes-a-day mapping is shown; saving PUTs exactly what the admin
   picked; the wake-times preview (install timezone) follows the form before
   Save; non-admins see it read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const OFF: HighAgencyInfo = {
  slug: 'acme-cto', enabled: false, level: 1, runs_per_day: 1, workspace: null, allow_cards: true, allow_workflows: true,
  run_as_user_id: null, routine_id: null, updated_by: null, updated_at: null, wake_times: wakeTimes('acme-cto', 1),
  timezone: 'America/New_York', cron: '', wake_model: 'claude-opus-5-5', next_wake_at: null, routine: null, last_wake: null,
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: Record<string, unknown> | null }[] = []
let current: HighAgencyInfo

function payload(): HighAgencyResponse {
  return { high_agency: current, levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], max_new_projects_per_wake: 1, workspace_options: ['ops', 'sales'] }
}

beforeEach(() => {
  requests = []
  current = { ...OFF }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null
    const method = init?.method ?? 'GET'
    requests.push({ url, method, body })
    if (method === 'PUT') {
      // Like the server: a patch carries only what changed; `resume` is an action, not a stored field.
      const { resume, ...fields } = body
      const level = fields.level ?? current.level
      current = { ...current, ...fields, runs_per_day: runsPerDay(level), wake_times: wakeTimes('acme-cto', level), updated_by: 'jordan',
        routine: fields.enabled || resume ? { id: 7, enabled: true, last_run_at: null, auto_paused_at: null, auto_pause_reason: null } : current.routine }
    }
    if (method === 'POST') {
      current = { ...current, last_wake: { objective_id: 4242, status: 'queue', created_at: '2026-11-13 09:00:00' } }
      return new Response(JSON.stringify({ ...payload(), result: { ok: true, objective_id: 4242 } }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
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
  await act(async () => {
    root.render(<HighAgencySection agent={{ slug: 'acme-cto', name: 'CTO' }} isAdmin={isAdmin} />)
  })
}

const sw = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!
const control = (label: string) => {
  const l = [...host.querySelectorAll('label')].find(x => x.textContent?.trim() === label)!
  return host.querySelector<HTMLInputElement>(`#${l.htmlFor}`)!
}
const slider = () => control('High Agency level') as HTMLInputElement
const preview = () => host.querySelector('[data-testid="high-agency-preview"]')!.textContent ?? ''
const check = (text: string) => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.closest('label')?.textContent?.includes(text))!
const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t)
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
}
/** Picks an option of a ui/Select trigger; workspace options read as the slug. */
async function choose(el: HTMLElement, label: string) {
  await chooseOption(el, label)
}
async function slide(level: HighAgencyLevel) {
  const el = slider()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(level))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('HighAgencySection', () => {
  it('loads the bot\'s setting and shows it Off by default, with a 1-10 level control at level 1', async () => {
    await render(true)
    expect(requests[0]).toMatchObject({ method: 'GET', url: '/api/agent-chat/agents/acme-cto/high-agency' })
    expect(host.textContent).toContain('High Agency')
    expect(host.textContent).toContain('Off')
    expect(host.textContent).toContain('This bot never wakes on its own.')
    expect(sw().getAttribute('aria-checked')).toBe('false')
    const s = slider()
    expect(s.type).toBe('range')
    expect(s.min).toBe('1')
    expect(s.max).toBe('10')
    expect(s.value).toBe('1')
    expect(host.textContent).toContain('Level 1 · Once a day, at night')
    // The cadence picker and the UTC first-hour picker are gone.
    expect([...host.querySelectorAll('label')].some(l => /How often|First wake/.test(l.textContent ?? ''))).toBe(false)
  })

  it('documents the level → wakes-a-day mapping in the panel', async () => {
    await render(true)
    const table = host.querySelector('details table')!
    const cells = [...table.querySelectorAll('tbody td')].map(td => td.textContent)
    expect(cells).toEqual(['Wakes / day', '1', '4', '6', '9', '11', '14', '16', '19', '21', '24'])
    expect(host.textContent).toContain('Level 1 wakes once at night; level 10 every hour.')
  })

  it('previews the wake times in the install timezone, following the slider before Save', async () => {
    await render(true)
    expect(preview()).toContain(wakeTimes('acme-cto', 1).join(', '))
    expect(preview()).toContain('America/New_York')
    await slide(10)
    expect(host.textContent).toContain('Level 10 · Every hour')
    expect(preview()).toContain(wakeTimes('acme-cto', 10).join(', '))
    expect(wakeTimes('acme-cto', 10)).toHaveLength(24)
    await slide(4)
    expect(host.textContent).toContain('Level 4 · 9 times a day (every 2–3 hours)')
    expect(preview()).toContain(wakeTimes('acme-cto', 4).join(', '))
  })

  it('switching on at a level PUTs exactly what was changed, and says what was saved', async () => {
    await render(true)
    await click(sw())
    await slide(7)
    await choose(control('Wake cards go to'), 'sales')
    await click(check('Propose repeatable workflows'))
    expect(host.textContent).toContain('Level 7: wakes 16 times a day (every 1–2 hours).')

    await click(button('Save High Agency')!)
    const put = requests.find(r => r.method === 'PUT')!
    expect(put.url).toBe('/api/agent-chat/agents/acme-cto/high-agency')
    // obj 900914: only the fields the admin changed (allow_cards was left alone).
    expect(put.body).toEqual({ enabled: true, level: 7, workspace: 'sales', allow_workflows: false })
    expect(host.textContent).toContain('Saved High Agency: turn on, level 1 → 7 (16 wakes a day), wake cards go to sales, may not propose workflows. On at level 7 (16 wakes a day). Nothing else on this page changed.')
    expect(host.textContent).toContain('On · level 7')
  })

  it('shows the operating loop, the one-project cap and the model wakes run on', async () => {
    await render(true)
    expect(host.textContent).toContain('closes out the cards it owns first, then picks at most one next project')
    expect(host.textContent).toContain('At most 1 new project card per wake')
    expect(host.textContent).toContain('claude-opus-5-5')
    expect(host.textContent).toContain('those go to your decision queue')
  })

  it('Save stays disabled until something changes', async () => {
    await render(true)
    expect(button('Save High Agency')!.disabled).toBe(true)
    await slide(2)
    expect(button('Save High Agency')!.disabled).toBe(false)
  })

  it('Wake now asks the server for one wake and links the card it filed', async () => {
    await render(true)
    await click(button('Wake now')!)
    expect(requests.find(r => r.method === 'POST')?.url).toBe('/api/agent-chat/agents/acme-cto/high-agency/wake')
    expect(host.textContent).toContain('Woke CTO: card #4242.')
    expect(host.querySelector('a[href="/o/4242"]')).not.toBeNull()
  })

  // obj 900961: a plain Save used to be the resume click (it sent enabled: true).
  // Resuming is now its own button, and Save sends only what the admin changed.
  const PAUSED: HighAgencyInfo = { ...OFF, enabled: true, level: 2, workspace: 'ops', routine: { id: 7, enabled: false, last_run_at: null, auto_paused_at: '2026-11-12', auto_pause_reason: '5 consecutive failures' } }

  it('tells the admin when the wake schedule is paused; Resume wakes sends resume: true and nothing else', async () => {
    current = { ...PAUSED }
    await render(true)
    expect(host.textContent).toContain('On · paused')
    expect(host.textContent).toContain('paused on the Jobs page (5 consecutive failures)')
    expect(host.textContent).not.toContain('Save here to resume')
    expect(button('Save High Agency')!.disabled).toBe(true) // nothing changed, nothing to save
    await click(button('Resume wakes')!)
    const puts = requests.filter(r => r.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ resume: true })
  })

  it('a save on a paused schedule sends only the changed field: no enabled, no resume', async () => {
    current = { ...PAUSED }
    await render(true)
    await slide(5)
    await click(button('Save High Agency')!)
    const puts = requests.filter(r => r.method === 'PUT')
    expect(puts).toHaveLength(1)
    expect(puts[0].body).toEqual({ level: 5 })
  })

  it('a non-admin sees the paused notice without a Resume button', async () => {
    current = { ...PAUSED }
    await render(false)
    expect(host.textContent).toContain('paused on the Jobs page')
    expect(button('Resume wakes')).toBeUndefined()
  })

  it('a non-admin sees the setting read-only, with no Save or Wake now', async () => {
    current = { ...OFF, enabled: true, level: 4 }
    await render(false)
    expect(host.textContent).toContain('On · level 4')
    expect(sw().disabled || sw().closest('fieldset')!.disabled).toBe(true)
    expect(button('Save High Agency')).toBeUndefined()
    expect(button('Wake now')).toBeUndefined()
    expect(host.textContent).toContain('Only an admin can change High Agency.')
  })
})
