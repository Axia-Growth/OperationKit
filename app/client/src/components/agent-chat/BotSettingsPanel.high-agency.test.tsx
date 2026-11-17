import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, useState } from 'react'
import { BotSettingsPanel } from './BotSettingsPanel'
import { clearChatCache } from './chat-cache'
import { chooseOption } from '../../test/render'
import { runsPerDay, wakeTimes, type HighAgencyLevel } from '../../../../shared/high-agency'
import type { AgentsResponse, ChatAgentInfo, HighAgencyInfo } from './types'

/* obj 900914 — Found on OVH (Nov 15, 2026): Operator set the CTO bot's High Agency
   to level 10, then pressed the panel's other Save (model, tools) and the bot was
   back at level 1 — one wake a day. Saving one section must never silently
   change another. These run the WHOLE settings panel against a small stateful
   fake server, so every request the panel sends is on the record.

   The reproduced mechanism on main: granting Workspace access remounted the
   High Agency section, which threw away the admin's unsaved edits and reset the
   form (level 1, off for a new bot), and the High Agency Save then wrote EVERY
   field the form showed, touched or not. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SLUG = 'your-org-cto'

const CTO: ChatAgentInfo = {
  slug: SLUG, name: 'CTO', description: '', avatar: 'CT', colour: 'blue', knowledge_folders: [],
  tools: ['list_objectives'], model: null, provider: null, version: null, author: null, source: 'file',
  answered_by: { id: 'claude', model: 'claude-sonnet-5' },
  all_tools: false, effective_tools: ['list_objectives'],
  file_defaults: { provider: null, model: null, tools: ['list_objectives'] },
  config: null,
}

const META = {
  tool_catalog: [
    { name: 'list_objectives', label: 'List cards', description: 'List board cards.', group: 'board' },
    { name: 'web_search', label: 'Web search', description: 'Search the public web.', group: 'web' },
  ],
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', engine: 'claude', enabled: true, is_default: true, is_planner: true, sort_order: 1 },
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 2 },
  ],
  default_models: { claude: 'claude-sonnet-5' },
  web: { available: true, backends: ['firecrawl'] },
  providers: { claude: true, anthropic: false, openai: false, xai: false, 'openai-compatible': false, demo: true },
} as unknown as AgentsResponse

interface Req { url: string; method: string; body: Record<string, unknown> | null }

// ── the fake server: High Agency + Workspace access + bot config, with state ──
let ha: HighAgencyInfo
let granted: string[]
let requests: Req[]

function haInfo(over: Partial<HighAgencyInfo>): HighAgencyInfo {
  const level = (over.level ?? 1) as HighAgencyLevel
  return {
    slug: SLUG, enabled: false, level, runs_per_day: runsPerDay(level), workspace: null, allow_cards: true, allow_workflows: true,
    run_as_user_id: null, routine_id: null, updated_by: null, updated_at: null, wake_times: wakeTimes(SLUG, level),
    timezone: 'America/New_York', cron: '', wake_model: null, next_wake_at: null, routine: null, last_wake: null, ...over,
  }
}

const json = (x: unknown, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } })

function serve(url: string, method: string, body: Record<string, unknown> | null): Response {
  if (url.endsWith('/high-agency')) {
    if (method === 'PUT') {
      const next = { ...ha }
      for (const k of ['enabled', 'level', 'workspace', 'allow_cards', 'allow_workflows'] as const) {
        if (body && k in body) (next as Record<string, unknown>)[k] = body[k]
      }
      if (next.workspace && !granted.includes(next.workspace)) {
        return json({ error: `CTO is not granted workspace "${next.workspace}".`, code: 'workspace_not_granted', grant_options: [next.workspace] }, 403)
      }
      if (next.enabled && !next.workspace) next.workspace = granted[0] ?? null
      if (next.enabled && !next.workspace) {
        return json({ error: 'CTO has no workspace it may wake in. Grant it one under Workspace access on this settings page, then save High Agency again.', code: 'no_wake_workspace', grant_options: ['your-org', 'operationkit'] }, 409)
      }
      ha = haInfo({ ...next, level: next.level, runs_per_day: runsPerDay(next.level as HighAgencyLevel), wake_times: wakeTimes(SLUG, next.level as HighAgencyLevel), updated_by: 'operator',
        routine: next.enabled ? { id: 900552, enabled: true, last_run_at: null, auto_paused_at: null, auto_pause_reason: null } : ha.routine })
    }
    return json({ high_agency: ha, levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], max_new_projects_per_wake: 1, workspace_options: granted })
  }
  if (url.endsWith('/workspaces')) {
    if (method === 'POST' && body?.workspace) granted = [...granted, String(body.workspace)]
    return json({
      access: { slug: SLUG, mode: 'restricted', configured: true, workspaces: granted, grants: granted.map(w => ({ workspace: w, granted_by: 'operator', granted_at: '2026-11-15 14:50:00' })), updated_by: 'operator', updated_at: '' },
      workspace_options: [{ slug: 'your-org', name: 'Example Growth' }, { slug: 'operationkit', name: 'Operation Kit' }],
    }, method === 'POST' ? 201 : 200)
  }
  if (url.includes('/card-wakes')) return json({ card_wakes: { slug: 'cto', enabled: true, is_default: true, updated_at: null, install_enabled: true, thread_title: 'Card wakes' }, recent: [] })
  if (url.includes('/delegations')) return json({ bot: null, workspace_options: [], grants: [], can_manage: false })
  if (url.endsWith('/config')) {
    return json({ agent: { ...CTO, model: (body?.model as string) ?? null, config: method === 'DELETE' ? null : { ...body, updated_by: 'operator', updated_at: '' } } })
  }
  return json({ error: 'not found' }, 404)
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  clearChatCache()
  requests = []
  granted = []
  ha = haInfo({})
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method, body })
    return serve(url, method, body)
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

/** The real parent passes the saved agent back in, so render through a stateful wrapper. */
function Page() {
  const [agent, setAgent] = useState(CTO)
  return <BotSettingsPanel agent={agent} meta={META} isAdmin onSaved={setAgent} onClose={() => {}} />
}

async function render() {
  await act(async () => { root.render(<Page />) })
}

const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t)
const sw = () => host.querySelector<HTMLButtonElement>('button[role="switch"]')!
const slider = () => host.querySelector<HTMLInputElement>('input[type="range"]')!
const haBadge = () => document.getElementById(`high-agency-title-${SLUG}`)!.parentElement!.querySelector('span')!.textContent
const writes = (part: string) => requests.filter(r => r.method !== 'GET' && r.url.includes(part))

async function click(el: Element | undefined) {
  if (!el) throw new Error('no such element')
  await act(async () => { (el as HTMLElement).click() })
}
async function slide(level: number) {
  const el = slider()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, String(level))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('obj 900914: saving the main bot settings never changes High Agency', () => {
  it('High Agency at level 10, then Save model and tools: one PUT to /config, nothing to High Agency, still level 10 every hour', async () => {
    granted = ['your-org']
    ha = haInfo({ enabled: true, level: 10, workspace: 'your-org', allow_cards: false, routine: { id: 900552, enabled: true, last_run_at: null, auto_paused_at: null, auto_pause_reason: null } })
    await render()
    expect(haBadge()).toBe('On · level 10')

    await chooseOption(host.querySelector<HTMLElement>(`#bot-model-${SLUG}`)!, 'Claude Opus 5.5 (claude-opus-5-5)')
    expect(host.textContent).toContain('Unsaved changes')
    await click(button('Save model and tools'))

    expect(writes('/config')).toHaveLength(1)
    expect(writes('/config')[0].body).toMatchObject({ model: 'claude-opus-5-5' })
    expect(writes('/high-agency')).toHaveLength(0)
    // The saved setting and the form both still say level 10, every hour.
    expect(ha).toMatchObject({ enabled: true, level: 10, workspace: 'your-org', allow_cards: false, allow_workflows: true })
    expect(ha.wake_times).toHaveLength(24)
    expect(slider().value).toBe('10')
    expect(haBadge()).toBe('On · level 10')
    expect(button('Save High Agency')!.disabled).toBe(true)
    expect(host.querySelector('[data-testid="high-agency-unsaved"]')).toBeNull()
    expect(host.textContent).toContain('Saved model and tools. Workspace access, approvals and High Agency are saved in their own sections and did not change.')

    // Even a High Agency save straight after only sends what was changed there.
    const allowCards = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.closest('label')?.textContent?.includes('File and run its next project'))!
    expect(allowCards.checked).toBe(false)
    await click(allowCards)
    await click(button('Save High Agency'))
    expect(writes('/high-agency').at(-1)!.body).toEqual({ allow_cards: true })
    expect(ha.level).toBe(10)
  })

  it('granting Workspace access keeps the admin\'s unsaved High Agency edits (it used to reset the form to level 1, off)', async () => {
    await render()
    await click(sw())
    await slide(10)
    await click(button('Save High Agency'))
    expect(writes('/high-agency')).toHaveLength(1)
    expect(ha.enabled).toBe(false) // refused: no workspace yet

    // Grant through the Workspace access section, the way Operator did.
    await click(button('Grant access'))
    expect(granted).toEqual(['your-org'])
    expect(slider().value).toBe('10')
    expect(sw().getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[data-testid="high-agency-unsaved"]')?.textContent).toContain('level 1 → 10 (24 wakes a day)')

    await click(button('Save High Agency'))
    expect(writes('/high-agency').at(-1)!.body).toEqual({ enabled: true, level: 10 })
    expect(ha).toMatchObject({ enabled: true, level: 10, workspace: 'your-org' })
    expect(haBadge()).toBe('On · level 10')
  })

  it('changing only where wake cards go never re-sends the level', async () => {
    granted = ['your-org', 'operationkit']
    ha = haInfo({ enabled: true, level: 10, workspace: 'your-org' })
    await render()
    await chooseOption(document.getElementById(`high-agency-workspace-${SLUG}`)!, 'operationkit')
    await click(button('Save High Agency'))
    expect(writes('/high-agency').at(-1)!.body).toEqual({ workspace: 'operationkit' })
    expect(ha).toMatchObject({ enabled: true, level: 10, workspace: 'operationkit' })
  })

  it('a level change is shown as pending before anything is written', async () => {
    granted = ['your-org']
    ha = haInfo({ enabled: true, level: 10, workspace: 'your-org' })
    await render()
    await slide(1)
    expect(writes('/high-agency')).toHaveLength(0)
    expect(haBadge()).toBe('On · level 10 · unsaved changes')
    expect(host.querySelector('[data-testid="high-agency-unsaved"]')!.textContent).toBe('Unsaved High Agency changes: level 10 → 1 (1 wake a day).')
  })
})

describe('obj 900914: "no workspace it may wake in" offers the grant right there', () => {
  it('explains where access is granted and grants + saves in one click', async () => {
    await render()
    await click(sw())
    await slide(10)
    await click(button('Save High Agency'))

    const offer = host.querySelector('[data-testid="high-agency-grant-offer"]')!
    expect(offer.textContent).toContain('Grant it one under Workspace access on this settings page')
    expect(button('Grant access to your-org and save')).toBeTruthy()
    expect(button('Grant access to operationkit and save')).toBeTruthy()

    await click(button('Grant access to your-org and save'))
    expect(requests.filter(r => r.method === 'POST' && r.url.endsWith('/workspaces')).map(r => r.body)).toEqual([{ workspace: 'your-org' }])
    expect(writes('/high-agency').at(-1)!.body).toEqual({ enabled: true, level: 10, workspace: 'your-org' })
    expect(ha).toMatchObject({ enabled: true, level: 10, workspace: 'your-org' })
    expect(host.querySelector('[data-testid="high-agency-grant-offer"]')).toBeNull()
    expect(haBadge()).toBe('On · level 10')
    expect(host.textContent).toContain('Saved High Agency: turn on, level 1 → 10 (24 wakes a day), wake cards go to your-org. On at level 10 (24 wakes a day). Nothing else on this page changed.')
    // Workspace access re-read and shows the new grant.
    expect(document.getElementById(`bot-ws-title-${SLUG}`)!.parentElement!.textContent).toContain('1 workspace')
  })
})
