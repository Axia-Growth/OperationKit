// @vitest-environment jsdom
/**
 * obj 900863 — one model list, one dropdown. Settings → Models, the card modal
 * and every bot's "Default model" must offer the same registry rows in the same
 * format. This file proves the pickers share their source: the same rows render
 * the same option text in Settings → Models and on two different bots, and no
 * picker builds its own list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ModelRow } from '@operationkit/shared'
import { click, optionsOf } from '../test/render'
import { modelOptions, modelOptionLabel, modelOptionGroups, providerForModel } from '../lib/model-options'

const { apiMock } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))
vi.mock('../lib/api', () => ({ api: apiMock }))

import { ModelsModule } from './ModelsModule'
import { BotSettingsPanel } from './agent-chat/BotSettingsPanel'
import type { AgentsResponse, ChatAgentInfo } from './agent-chat/types'

const ROWS: ModelRow[] = [
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 1 },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', engine: 'claude', enabled: true, is_default: true, is_planner: true, sort_order: 4 },
  { id: 'claude-opus-5', label: 'Claude Opus 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 5 },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', engine: 'claude', enabled: true, is_default: false, is_planner: false, sort_order: 18 },
  { id: 'grok-4', label: 'Grok 4', engine: 'grok', enabled: true, is_default: false, is_planner: false, sort_order: 40 },
  { id: 'gpt-5.5', label: 'GPT-5.5 (Codex)', engine: 'codex', enabled: true, is_default: false, is_planner: false, sort_order: 30 },
]

const bot = (slug: string, model: string | null): ChatAgentInfo => ({
  slug, name: slug, description: '', avatar: 'B', colour: 'blue', knowledge_folders: [], tools: [], model, provider: null,
  version: null, author: null, source: 'file', answered_by: { id: 'claude', model: model ?? 'claude-sonnet-5' },
  all_tools: false, effective_tools: [], file_defaults: { provider: null, model: null, tools: [] },
  config: model ? { provider: null, model, tools: null, all_tools: false, updated_by: 'x', updated_at: '' } : null,
})

const META = { models: ROWS, tool_catalog: [], default_models: { claude: 'claude-sonnet-5' }, providers: {} } as unknown as AgentsResponse

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/models/all') return { models: ROWS }
    if (path === '/models/refresh') return { report: null, auto_refresh_hours: 24 }
    return {}
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function openEntries(selector: string): Promise<string[]> {
  const trigger = container.querySelector<HTMLElement>(selector)!
  await click(trigger)
  const out = optionsOf(trigger).map(o => o.textContent!.trim())
  await click(trigger)
  return out
}
const onlyModels = (xs: string[]) => xs.filter(t => !t.startsWith('Default') && t !== 'Other model id…' && t !== '— none —')

describe('model pickers share one source list (obj 900863)', () => {
  it('Settings → Models and two different bots render the same options, in the same format', async () => {
    await act(async () => { root.render(<ModelsModule />) })
    await act(async () => { await Promise.resolve() })
    const settings = onlyModels(await openEntries('#models-default-select'))

    await act(async () => { root.render(<BotSettingsPanel agent={bot('operation-kit-dev', 'claude-opus-5')} meta={META} isAdmin onSaved={() => {}} onClose={() => {}} />) })
    const dev = onlyModels(await openEntries('#bot-model-operation-kit-dev'))

    await act(async () => { root.render(<BotSettingsPanel agent={bot('cto', null)} meta={META} isAdmin onSaved={() => {}} onClose={() => {}} />) })
    const cto = onlyModels(await openEntries('#bot-model-cto'))

    const expected = modelOptions(ROWS).map(o => o.label)
    expect(settings).toEqual(expected)
    expect(dev).toEqual(expected)
    expect(cto).toEqual(expected)
  })

  it('every picker renders through the shared ModelPicker, none builds its own option list', () => {
    const src = (p: string) => readFileSync(resolve(__dirname, p), 'utf8')
    for (const f of ['ModelsModule.tsx', 'ObjectiveModal.tsx', 'agent-chat/BotSettingsPanel.tsx']) {
      const s = src(f)
      expect(s, f).toMatch(/import \{ ModelPicker \} from '(\.\.?\/)+(components\/)?ModelPicker'/)
      expect(s, f).toContain('<ModelPicker')
      // The old per-surface lists: a <datalist> of ids, or hand-mapped <option>s over model rows.
      expect(s, f).not.toMatch(/<datalist/)
      expect(s, f).not.toMatch(/(models|rows|suggestions)\.map\(\s*\(?m\)?\s*=>\s*(\(\s*)?<option/)
    }
  })
})

describe('lib/model-options', () => {
  it('formats a model as "Label (id)" and a bare id as itself', () => {
    expect(modelOptionLabel({ id: 'claude-opus-5-5', label: 'Claude Opus 5.5' })).toBe('Claude Opus 5.5 (claude-opus-5-5)')
    expect(modelOptionLabel({ id: 'x-1', label: 'x-1' })).toBe('x-1')
  })

  it('groups by provider in a fixed order: Anthropic, OpenAI, xAI', () => {
    expect(modelOptionGroups(ROWS).map(g => g.label)).toEqual(['Anthropic Models', 'OpenAI Models', 'xAI Models'])
    expect(modelOptions(ROWS).map(o => o.value)).toEqual(['claude-fable-5-2', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5', 'gpt-5.5', 'grok-4'])
  })

  it('maps a picked model to a provider that can run it', () => {
    expect(providerForModel('claude', 'claude')).toBeNull()
    expect(providerForModel('claude', 'anthropic')).toBeNull()
    expect(providerForModel('grok', 'claude')).toBe('xai')
    expect(providerForModel('codex', 'xai')).toBe('openai')
    expect(providerForModel('claude', 'demo')).toBe('claude')
    expect(providerForModel('grok', 'openai-compatible')).toBeNull()
  })
})
