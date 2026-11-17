import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { BotSettingsPanel } from './BotSettingsPanel'
import type { AgentsResponse, ChatAgentInfo } from './types'
import { chooseOption, click as press, optionsOf } from '../../test/render'
import { modelOptions } from '../../lib/model-options'
import type { ModelRow } from '@operationkit/shared'

/* obj 900671 — each bot's page has an editable default model, per-bot tool
   assignment and an "All tools" option. Saving PUTs exactly what the admin
   picked; a non-admin sees the same settings read-only. */

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const CATALOG: NonNullable<AgentsResponse['tool_catalog']> = [
  { name: 'web_search', label: 'Web search', description: 'Search the public web.', group: 'web' },
  { name: 'web_fetch', label: 'Read web pages', description: 'Open one public page.', group: 'web' },
  { name: 'list_objectives', label: 'List cards', description: 'List board cards.', group: 'board' },
  { name: 'create_objective', label: 'File board cards', description: 'File a card.', group: 'board' },
]

// obj 900863: the enabled model registry, the same rows GET /api/models returns.
const MODELS: ModelRow[] = [
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 1 },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', engine: 'claude', enabled: true, is_default: true, is_planner: true, sort_order: 4 },
  { id: 'claude-opus-5', label: 'Claude Opus 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 5 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 18 },
  { id: 'gpt-5.5', label: 'GPT-5.5 (Codex)', engine: 'codex', enabled: true, is_default: false, is_planner: false, sort_order: 30 },
  { id: 'grok-4', label: 'Grok 4', engine: 'grok', enabled: true, is_default: false, is_planner: false, sort_order: 40 },
]

const META = {
  tool_catalog: CATALOG,
  models: MODELS,
  model_suggestions: { claude: ['claude-opus-5-5', 'claude-sonnet-5'] },
  default_models: { claude: 'claude-sonnet-5' },
  web: { available: true, backends: ['firecrawl'] },
  providers: { claude: true, anthropic: false, openai: false, xai: true, 'openai-compatible': false, demo: true },
} as AgentsResponse

const CTO: ChatAgentInfo = {
  slug: 'acme-cto', name: 'CTO', description: '', avatar: 'CT', colour: 'blue', knowledge_folders: [],
  tools: ['list_objectives', 'create_objective'], model: null, provider: null, version: null, author: null, source: 'file',
  answered_by: { id: 'claude', model: 'claude-sonnet-5' },
  all_tools: false, effective_tools: ['list_objectives', 'create_objective', 'board_briefing'],
  file_defaults: { provider: null, model: null, tools: ['list_objectives', 'create_objective'] },
  config: null,
}

const HIGH_AGENCY_OFF = {
  high_agency: {
    slug: 'acme-cto', enabled: false, level: 1, runs_per_day: 1, workspace: null, allow_cards: true, allow_workflows: true,
    run_as_user_id: null, routine_id: null, updated_by: null, updated_at: null, wake_times: ['02:00'], timezone: 'America/New_York',
    cron: '0 7 * * *', wake_model: null, next_wake_at: null, routine: null, last_wake: null,
  },
  levels: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  max_new_projects_per_wake: 1,
}

const WORKSPACE_ACCESS = {
  access: { slug: 'acme-cto', mode: 'restricted', configured: true, workspaces: ['ops'], grants: [{ workspace: 'ops', granted_by: 'jordan', granted_at: '2026-11-13 18:00:00' }], updated_by: 'jordan', updated_at: '' },
  workspace_options: [{ slug: 'ops', name: 'Ops' }, { slug: 'sales', name: 'Sales' }],
}

let host: HTMLDivElement
let root: Root
let requests: { url: string; method: string; body: unknown }[] = []
let onSaved: Mock<(agent: ChatAgentInfo) => void>

beforeEach(() => {
  requests = []
  onSaved = vi.fn<(agent: ChatAgentInfo) => void>()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    // The High Agency section (obj 900748) loads its own setting; it has its own
    // test file, so its calls are answered here and kept out of `requests`.
    if (url.includes('/high-agency')) return new Response(JSON.stringify(HIGH_AGENCY_OFF), { status: 200, headers: { 'content-type': 'application/json' } })
    // Same for the Workspace access section (obj 900797, WorkspaceAccessSection.test.tsx).
    if (url.includes('/workspaces')) return new Response(JSON.stringify(WORKSPACE_ACCESS), { status: 200, headers: { 'content-type': 'application/json' } })
    // And the Full access section (obj 900972, FullAccessSection.test.tsx).
    if (url.includes('/full-access')) return new Response(JSON.stringify({ slug: 'acme-cto', workspaces: [], workspace_options: [], can_manage: false, audit: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    // And the Approve on my behalf section (obj 900839, DelegationSection.test.tsx).
    if (url.includes('/delegations')) return new Response(JSON.stringify({ bot: null, workspace_options: [], grants: [], can_manage: false }), { status: 200, headers: { 'content-type': 'application/json' } })
    const body = init?.body ? JSON.parse(String(init.body)) : null
    requests.push({ url, method: init?.method ?? 'GET', body })
    const agent = { ...CTO, model: body?.model ?? null, all_tools: !!body?.all_tools, config: init?.method === 'DELETE' ? null : { ...body, updated_by: 'jordan', updated_at: '' } }
    return new Response(JSON.stringify({ agent }), { status: 200, headers: { 'content-type': 'application/json' } })
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

function render(agent: ChatAgentInfo, isAdmin: boolean, meta: AgentsResponse = META) {
  act(() => {
    root.render(<BotSettingsPanel agent={agent} meta={meta} isAdmin={isAdmin} onSaved={onSaved} onClose={() => {}} />)
  })
}

const modelTrigger = (slug = 'acme-cto') => host.querySelector<HTMLElement>(`#bot-model-${slug}`)!
/** Model entries of an open picker, without the leading "Default" and trailing "Other model id…". */
const modelEntries = (trigger: Element) => optionsOf(trigger).map(o => o.textContent!.trim()).filter(t => !t.startsWith('Default') && t !== 'Other model id…')

const box = (label: string) => host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const allTools = () => [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(i => i.closest('label')?.textContent?.includes('All tools'))!
const button = (t: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t)!

function setInput(el: HTMLInputElement, value: string) {
  const proto = HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click() })
}

describe('BotSettingsPanel', () => {
  it('shows the editable default model, the tool list grouped by kind, and an All tools option', () => {
    render(CTO, true)
    const model = modelTrigger()
    expect(model.getAttribute('role')).toBe('combobox')
    expect(model.hasAttribute('data-disabled')).toBe(false)
    expect(model.textContent).toContain('Default — Claude Sonnet 5 (claude-sonnet-5)')
    expect(host.textContent).toContain('Answers now with Claude · claude-sonnet-5')
    expect(host.textContent).toContain('All tools')
    expect(host.textContent).toContain('Web')
    expect(box('Web search').checked).toBe(false)
    expect(box('List cards').checked).toBe(true)
  })

  it('saves a new default model and web tools for this bot', async () => {
    render(CTO, true)
    await chooseOption(modelTrigger(), 'Claude Opus 5.5 (claude-opus-5-5)')
    await click(box('Web search'))
    await click(box('Read web pages'))
    await click(button('Save model and tools'))
    expect(requests).toHaveLength(1)
    expect(requests[0].method).toBe('PUT')
    expect(requests[0].url).toBe('/api/agent-chat/agents/acme-cto/config')
    expect(requests[0].body).toEqual({
      provider: null,
      model: 'claude-opus-5-5',
      all_tools: false,
      tools: ['list_objectives', 'create_objective', 'web_search', 'web_fetch'],
    })
    expect(onSaved).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Saved model and tools.')
  })

  it('"All tools" ticks and locks every tool, and saves all_tools: true', async () => {
    render(CTO, true)
    await click(allTools())
    expect(box('Web search').checked).toBe(true)
    expect(box('Web search').disabled).toBe(true)
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ all_tools: true })
  })

  it('an unchanged tool list is sent as null so the agent file stays in charge', async () => {
    render(CTO, true)
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ tools: null, model: null, provider: null })
  })

  it('switching All tools off for a bot whose file says `tools: [all]` sends an explicit list', async () => {
    render({ ...CTO, tools: ['all'], all_tools: true, file_defaults: { provider: null, model: null, tools: ['all'] } }, true)
    expect(allTools().checked).toBe(true)
    await click(allTools())
    await click(box('Web search'))
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ all_tools: false, tools: ['web_search'] })
  })

  it('Reset to file deletes the override', async () => {
    render({ ...CTO, model: 'claude-opus-5-5', config: { provider: null, model: 'claude-opus-5-5', tools: null, all_tools: false, updated_by: 'jordan', updated_at: '' } }, true)
    expect(modelTrigger().textContent).toContain('Claude Opus 5.5 (claude-opus-5-5)')
    await click(button('Reset model and tools to file'))
    expect(requests[0]).toMatchObject({ method: 'DELETE', url: '/api/agent-chat/agents/acme-cto/config' })
    expect(modelTrigger().textContent).toContain('Default — Claude Sonnet 5 (claude-sonnet-5)')
  })

  it('warns when web search is picked but no search key is set up', async () => {
    render(CTO, true, { ...META, web: { available: false, backends: [] } })
    expect(host.textContent).not.toContain('Web search is not set up')
    await click(box('Web search'))
    expect(host.textContent).toContain('Web search is not set up on this install yet')
  })

  it('is read-only for a non-admin and shows what the bot can use', () => {
    render({ ...CTO, effective_tools: ['web_search', 'list_objectives'] }, false)
    expect(host.textContent).toContain('Only an admin can change')
    expect(modelTrigger().hasAttribute('data-disabled')).toBe(true)
    expect(box('Web search').checked).toBe(true)
    expect(box('File board cards').checked).toBe(false)
    expect([...host.querySelectorAll('button')].some(b => b.textContent?.trim() === 'Save model and tools')).toBe(false)
  })
})

/* obj 900749 — "Use secrets by name" is explicit opt-in: "All tools" never
   implies it, so it stays tickable (and unticked) with "All tools" on, and a
   tick is saved alongside all_tools. */
describe('explicit-only secret tool', () => {
  const META_SECRETS = {
    ...META,
    tool_catalog: [...CATALOG, { name: 'secrets', label: 'Use secrets by name', description: 'Server adds the key.', group: 'secrets', explicit_only: true }],
  } as AgentsResponse

  it('is not implied by "All tools" and can be ticked on its own', async () => {
    render({ ...CTO, all_tools: true }, true, META_SECRETS)
    expect(allTools().checked).toBe(true)
    expect(box('Web search').disabled).toBe(true)
    const secrets = box('Use secrets by name')
    expect(secrets.checked).toBe(false)
    expect(secrets.disabled).toBe(false)
    expect(host.textContent).toContain('Secrets')
    await click(secrets)
    await click(button('Save model and tools'))
    const put = requests.find(r => r.method === 'PUT')!
    expect(put.body).toMatchObject({ all_tools: true })
    expect((put.body as { tools: string[] }).tools).toContain('secrets')
  })
})

// obj 900745 — Operator missed the ghost "Done" (plain text on the dark panel) and
// closed the panel with the header Settings toggle. Done is a real button now.
describe('BotSettingsPanel Done button (obj 900745)', () => {
  it('is a visible, bordered button (not ghost text) that closes the panel', async () => {
    const onClose = vi.fn()
    act(() => {
      root.render(<BotSettingsPanel agent={CTO} meta={META} isAdmin={false} onSaved={onSaved} onClose={onClose} />)
    })
    const done = button('Done')
    expect(done).toBeTruthy()
    expect(done.getAttribute('aria-label')).toBe('Done: close settings for CTO')
    // Secondary variant + stronger hairline and fill — never the transparent ghost.
    expect(done.className).toContain('!border-line-strong')
    expect(done.className).toContain('!bg-surface-2')
    expect(done.className).not.toContain('bg-transparent')
    expect(done.className).not.toContain('border-transparent')
    await click(done)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

/* obj 900863 — Operator's Nov 14 walkthrough: Operation Kit Dev's model dropdown
   showed only the two Opus models while CTO's showed all of them, and the
   field looked nothing like the Settings → Models picker. */
describe('BotSettingsPanel model picker (obj 900863)', () => {
  const DEV: ChatAgentInfo = {
    ...CTO, slug: 'operation-kit-dev', name: 'Operation Kit Dev', model: 'claude-opus-5',
    answered_by: { id: 'claude', model: 'claude-opus-5' },
    config: { provider: null, model: 'claude-opus-5', tools: null, all_tools: false, updated_by: 'jordan', updated_at: '' },
  }

  it('a bot with a saved model and a bot with none offer the SAME full list (no Opus-only subset)', async () => {
    render(DEV, true)
    expect(modelTrigger('operation-kit-dev').textContent).toContain('Claude Opus 5 (claude-opus-5)')
    await press(modelTrigger('operation-kit-dev'))
    const dev = modelEntries(modelTrigger('operation-kit-dev'))
    await press(modelTrigger('operation-kit-dev'))
    act(() => root.unmount())
    root = createRoot(host)
    render(CTO, true)
    await press(modelTrigger())
    const cto = modelEntries(modelTrigger())
    expect(dev).toEqual(cto)
    expect(cto).toEqual(modelOptions(MODELS).map(o => o.label))
    expect(cto).toContain('Claude Fable 5.2 (claude-fable-5-2)')
    expect(cto).toContain('Grok 4 (grok-4)')
    expect(cto.length).toBe(MODELS.length)
  })

  it('offers every model whatever provider the bot is on (no per-provider subset)', async () => {
    render({ ...CTO, provider: 'xai', answered_by: { id: 'xai', model: 'grok-4' }, file_defaults: { provider: 'xai', model: null, tools: CTO.tools } }, true)
    await press(modelTrigger())
    expect(modelEntries(modelTrigger())).toEqual(modelOptions(MODELS).map(o => o.label))
  })

  it('picking a model the current provider cannot run switches the provider with it', async () => {
    render(CTO, true)
    await chooseOption(modelTrigger(), 'Grok 4 (grok-4)')
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ provider: 'xai', model: 'grok-4' })
  })

  it('a Claude model keeps a Claude bot on its provider', async () => {
    render(CTO, true)
    await chooseOption(modelTrigger(), 'Claude Fable 5.2 (claude-fable-5-2)')
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ provider: null, model: 'claude-fable-5-2' })
  })

  it('"Other model id…" opens a free-text id for custom endpoints', async () => {
    render(CTO, true)
    await chooseOption(modelTrigger(), 'Other model id…')
    const input = host.querySelector<HTMLInputElement>('#bot-model-custom-acme-cto')!
    act(() => setInput(input, 'my-local-llama'))
    await click(button('Save model and tools'))
    expect(requests[0].body).toMatchObject({ model: 'my-local-llama' })
  })

  it('a saved id that is not in the registry still shows, marked', () => {
    render({ ...CTO, model: 'gpt-4o-mini', config: { provider: null, model: 'gpt-4o-mini', tools: null, all_tools: false, updated_by: 'jordan', updated_at: '' } }, true)
    expect(modelTrigger().textContent).toContain('gpt-4o-mini (not in Settings → Models)')
  })
})

// obj 900862 — Operator's CTO walkthrough showed neither High Agency nor Approve on
// my behalf. Both always render, but the panel was a non-shrinking block inside
// the chat page's clipped shell, so on a normal screen everything below the
// tool list was cut off. The panel now scrolls itself and links to each section.
describe('BotSettingsPanel sections are reachable for every bot (obj 900862)', () => {
  it('renders Workspace access, Approve on my behalf and High Agency for an unregistered bot, with jump links', async () => {
    await act(async () => {
      root.render(<BotSettingsPanel agent={{ ...CTO, slug: 'your-org-cto', name: 'Example CTO' }} meta={META} isAdmin onSaved={onSaved} onClose={() => {}} />)
    })
    const headings = [...host.querySelectorAll('h4')].map(h => h.textContent?.trim())
    expect(headings).toEqual(expect.arrayContaining(['Workspace access', 'Approve on my behalf', 'High Agency']))
    for (const [label, id] of [
      ['Workspace access', 'bot-ws-title-your-org-cto'],
      ['Approve on my behalf', 'bot-delegation-title-your-org-cto'],
      ['High Agency', 'high-agency-title-your-org-cto'],
    ]) {
      const link = [...host.querySelectorAll('nav a')].find(a => a.textContent === label)!
      expect(link.getAttribute('href')).toBe(`#${id}`)
      expect(document.getElementById(id)?.textContent).toBe(label)
    }
  })

  // Acceptance change (2026-11-14 22:56 ET): Operator saw High Agency on NO bot. Every
  // bot in the owner's sidebar — Example CTO and two others, owner or not — renders
  // both sections and the 1-10 level slider; nothing gates them on the registry,
  // the bot's kind, or the viewer's role.
  it.each([
    ['your-org-cto', 'Example CTO', true],
    ['operation-kit-dev', 'Operation Kit Dev', true],
    ['research-desk', 'Research Desk', true],
    ['your-org-cto', 'Example CTO', false],
  ])('%s (%s, admin=%s): High Agency with a 1-10 slider and Approve on my behalf both render', async (slug, name, admin) => {
    await act(async () => {
      root.render(<BotSettingsPanel agent={{ ...CTO, slug, name }} meta={META} isAdmin={admin} onSaved={onSaved} onClose={() => {}} />)
    })
    expect(document.getElementById(`high-agency-title-${slug}`)?.textContent).toBe('High Agency')
    expect(document.getElementById(`bot-delegation-title-${slug}`)?.textContent).toBe('Approve on my behalf')
    const slider = host.querySelector<HTMLInputElement>('input[type="range"]')!
    expect(slider).toBeTruthy()
    expect([slider.min, slider.max]).toEqual(['1', '10'])
  })

  it('is its own scroll area that can shrink inside the clipped chat page', () => {
    render(CTO, true)
    const panel = host.querySelector('[data-testid="bot-settings-panel"]')!
    expect(panel.className).toContain('overflow-y-auto')
    expect(panel.className).toContain('min-h-0')
    expect(panel.className).toMatch(/(^|\s)shrink(\s|$)/)
  })

  it('a Jump-to link scrolls the panel itself (never the clipped page shell)', async () => {
    await act(async () => { root.render(<BotSettingsPanel agent={CTO} meta={META} isAdmin onSaved={onSaved} onClose={() => {}} />) })
    const panel = host.querySelector<HTMLElement>('[data-testid="bot-settings-panel"]')!
    const scrollTo = vi.fn()
    panel.scrollTo = scrollTo as unknown as typeof panel.scrollTo
    const link = [...host.querySelectorAll('nav a')].find(a => a.textContent === 'High Agency')!
    await click(link)
    expect(scrollTo).toHaveBeenCalledTimes(1)
    expect(scrollTo.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' })
  })
})

describe('Full access on the settings panel (obj 900972)', () => {
  it('has its own section, after Workspace access, and a Jump to link that points at it', async () => {
    render(CTO, true)
    await act(async () => { await Promise.resolve() })
    const title = host.querySelector('#bot-full-access-title-acme-cto')
    expect(title?.textContent).toBe('Full access')
    const link = [...host.querySelectorAll('nav a')].find(a => a.textContent === 'Full access')
    expect(link?.getAttribute('href')).toBe('#bot-full-access-title-acme-cto')
    const order = [...host.querySelectorAll('h4')].map(h => h.textContent)
    expect(order.indexOf('Full access')).toBe(order.indexOf('Workspace access') + 1)
    expect(order.indexOf('Full access')).toBeLessThan(order.indexOf('Approve on my behalf'))
  })
})
