import { useMemo, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { Alert, Button, cn } from '../ui'
import { HighAgencySection } from './HighAgencySection'
import { CardWakesSection } from './CardWakesSection'
import { LongRepliesSection } from './LongRepliesSection'
import { DevOpsSection } from './DevOpsSection'
import { RepoRightsSection } from './RepoRightsSection'
import { WorkspaceAccessSection } from './WorkspaceAccessSection'
import { FullAccessSection } from './FullAccessSection'
import { SecretAccessSection } from './SecretAccessSection'
import { DelegationSection } from './DelegationSection'
import {
  PROVIDER_LABELS,
  type AgentsResponse,
  type BotConfigPatch,
  type ChatAgentInfo,
  type ProviderId,
  type ToolCatalogEntry,
  type ToolGroup,
} from './types'
import { Select } from '../ui/Select'
import { ModelPicker } from '../ModelPicker'
import { modelOptionLabel, providerForModel } from '../../lib/model-options'
import type { ModelRow } from '@operationkit/shared'

/* A bot's settings, on the bot's own page (obj 900671).

   Before this, a bot's model, provider and tools could only be changed by
   editing its agent file on the server. Now an admin sets them here:
     - Default model (+ AI provider): which model answers this bot.
     - Tools: tick exactly the tools this bot may use, or switch on
       "All tools" to give it every tool, including ones added later.
   Saving writes an override on the server (the agent file is never touched);
   "Reset to file" removes the override. Everyone else sees the same panel
   read-only, so a person can tell what a bot can do before asking it.

   High Agency (obj 900748) sits at the bottom with its own Save: it is a
   schedule, not a model/tools override, so "Reset to file" never touches it.

   obj 900862: Workspace access, Approve on my behalf and High Agency sit below
   the long tool list, out of sight on an ordinary laptop screen even now that
   the panel scrolls (obj 900864). A "Jump to" row reaches each in one click. */

const SECTION_LINKS: Array<{ label: string; idPrefix: string }> = [
  { label: 'Model and tools', idPrefix: 'bot-model-tools-title' },
  { label: 'Workspace access', idPrefix: 'bot-ws-title' },
  { label: 'Full access', idPrefix: 'bot-full-access-title' },
  { label: 'Approve on my behalf', idPrefix: 'bot-delegation-title' },
  { label: 'High Agency', idPrefix: 'high-agency-title' },
  { label: 'Card wakes', idPrefix: 'bot-card-wakes-title' },
]

const GROUP_LABELS: Record<ToolGroup, string> = {
  web: 'Web',
  knowledge: 'Knowledge',
  board: 'Board',
  images: 'Images',
  bots: 'Other bots',
  connectors: 'Email & calendar',
  integrations: 'Integrations',
  secrets: 'Secrets',
  sandbox: 'Card sandbox and browser',
}

const GROUP_ORDER: ToolGroup[] = ['web', 'knowledge', 'board', 'images', 'bots', 'connectors', 'integrations', 'secrets', 'sandbox']

const PROVIDERS: ProviderId[] = ['claude', 'anthropic', 'openai', 'xai', 'openai-compatible', 'demo']

type Meta = Pick<AgentsResponse, 'tool_catalog' | 'models' | 'model_suggestions' | 'default_models' | 'web' | 'providers'>

/** The picker entry that opens a free-text model id (custom endpoints, ids not in the registry). */
const CUSTOM_MODEL = '__cc_custom_model__'

/** Old servers only send per-provider id suggestions; shape them as registry rows. */
function registryRowsFromSuggestions(ids: string[], provider: ProviderId): ModelRow[] {
  const engine: ModelRow['engine'] = provider === 'xai' ? 'grok' : provider === 'openai' ? 'codex' : 'claude'
  return ids.map((id, i) => ({ id, label: id, engine, enabled: true, is_default: false, is_planner: false, sort_order: i }))
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every(x => s.has(x))
}

export function BotSettingsPanel({
  agent,
  meta,
  isAdmin,
  onSaved,
  onClose,
  fill = false,
}: {
  agent: ChatAgentInfo
  meta: Meta
  isAdmin: boolean
  onSaved: (agent: ChatAgentInfo) => void
  onClose: () => void
  /** Grow to the whole pane (a phone, where the chat steps aside; obj 901203). */
  fill?: boolean
}) {
  const catalog: ToolCatalogEntry[] = meta.tool_catalog ?? []
  const fileDefaults = agent.file_defaults ?? { provider: agent.provider, model: agent.model, tools: agent.tools }
  const cfg = agent.config ?? null

  const [provider, setProvider] = useState<ProviderId | ''>(cfg?.provider ?? '')
  const [model, setModel] = useState<string>(cfg?.model ?? '')
  const [allTools, setAllTools] = useState<boolean>(agent.all_tools ?? false)
  const [tools, setTools] = useState<string[]>(() => {
    const base = cfg?.tools ?? fileDefaults.tools
    return base.filter(t => catalog.some(c => c.name === t))
  })
  const [saving, setSaving] = useState(false)
  // obj 900797: a grant/revoke can change where High Agency may wake (or switch
  // it off), so the High Agency section re-reads after one. obj 900914: it
  // re-reads IN PLACE (it used to be remounted via `key`, which threw away the
  // admin's unsaved High Agency edits and reset the form to the cached setting).
  const [accessVersion, setAccessVersion] = useState(0)
  // High Agency's inline "Grant access to <ws> and save" → Workspace access re-reads.
  const [grantVersion, setGrantVersion] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const panelRef = useRef<HTMLElement>(null)

  // Scroll THIS panel to a section. Not scrollIntoView: that also scrolls the
  // page shell, which is overflow-hidden but still programmatically scrollable,
  // and leaves the header shifted off-screen with a blank band below.
  const jumpTo = (targetId: string) => {
    const panel = panelRef.current
    const el = document.getElementById(targetId)
    if (!panel || !el) return false
    const top = el.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 12
    panel.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' })
    return true
  }

  // The provider a turn would use if saved now: the picked one, else the one
  // answering today (the file's, the install default, or automatic).
  const effectiveProvider: ProviderId = provider || fileDefaults.provider || agent.answered_by.id
  const modelFallback = fileDefaults.model || meta.default_models?.[effectiveProvider] || ''
  // obj 900863: every bot offers the SAME list — the install's enabled model
  // registry, the rows Settings → Models and the card modal use — in the same
  // dropdown. The old free-text field + datalist was filtered by the browser
  // against whatever was already typed, so a bot with a saved model (e.g.
  // "claude-opus-5") only ever showed the Opus ids, while a bot with an empty
  // field showed everything. A server without `models` falls back to its
  // per-provider suggestions.
  const models: ModelRow[] = useMemo(
    () => meta.models ?? registryRowsFromSuggestions(meta.model_suggestions?.[effectiveProvider] ?? [], effectiveProvider),
    [meta.models, meta.model_suggestions, effectiveProvider],
  )
  const [customModel, setCustomModel] = useState(false)
  const fallbackRow = models.find(m => m.id === modelFallback)
  const defaultLabel = modelFallback
    ? `Default — ${fallbackRow ? modelOptionLabel(fallbackRow) : modelFallback}`
    : 'Default (install default)'
  const pickModel = (v: string) => {
    setSaved(false)
    if (v === CUSTOM_MODEL) { setCustomModel(true); return }
    setCustomModel(false)
    setModel(v)
    // The full list spans providers: picking an xAI model on a Claude bot
    // switches the provider too, so the saved pair can actually run.
    const row = models.find(m => m.id === v)
    const next = row ? providerForModel(row.engine, effectiveProvider) : null
    if (next) setProvider(next)
  }

  const byGroup = useMemo(() => {
    const m = new Map<ToolGroup, ToolCatalogEntry[]>()
    for (const t of catalog) m.set(t.group, [...(m.get(t.group) ?? []), t])
    return GROUP_ORDER.filter(g => m.has(g)).map(g => ({ group: g, tools: m.get(g)! }))
  }, [catalog])

  const webPicked = allTools || tools.includes('web_search')
  const webMissing = webPicked && meta.web && !meta.web.available

  const toggle = (name: string) => {
    setSaved(false)
    setTools(cur => (cur.includes(name) ? cur.filter(t => t !== name) : [...cur, name]))
  }

  // obj 900914: this Save covers ONLY model, provider and tools. Track what it
  // would change, so the section says when it has unsaved edits.
  const snapshot = (p: string, m: string, all: boolean, t: string[]) => JSON.stringify([p, m.trim(), all, [...t].sort()])
  const [baseline, setBaseline] = useState(() => snapshot(provider, model, allTools, tools))
  const modelToolsDirty = isAdmin && snapshot(provider, model, allTools, tools) !== baseline

  const save = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    // A file that says `tools: [all]` would win back over a null override, so
    // switching "All tools" off for such a bot must always send the explicit list.
    const fileAll = fileDefaults.tools.some(t => t === 'all' || t === '*')
    const body: BotConfigPatch = {
      provider: provider || null,
      model: model.trim() || null,
      all_tools: allTools,
      // Same as the file → no override, so a later file change still applies.
      tools: !fileAll && sameSet(tools, fileDefaults.tools.filter(t => catalog.some(c => c.name === t))) ? null : tools,
    }
    try {
      const r = await api.put<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/config`, body)
      onSaved(r.agent)
      setBaseline(snapshot(provider, model, allTools, tools))
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save these settings')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const r = await api.del<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(agent.slug)}/config`)
      setProvider('')
      setModel('')
      setCustomModel(false)
      setAllTools(r.agent.all_tools ?? false)
      const fileTools = r.agent.tools.filter(t => catalog.some(c => c.name === t))
      setTools(fileTools)
      setBaseline(snapshot('', '', r.agent.all_tools ?? false, fileTools))
      onSaved(r.agent)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not reset this bot')
    } finally {
      setSaving(false)
    }
  }

  const inputCls =
    'min-h-[40px] w-full rounded-md border border-line bg-surface-0 px-2 text-sm text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60'
  const enabledNames = new Set(agent.effective_tools ?? agent.tools)

  return (
    /* The panel is its own scroll area inside the conversation column (obj 900864).
       It used to be an unshrinkable flex child ~2000px tall in a ~850px pane: the
       bottom (Save, High Agency) was clipped, and its absolutely positioned
       visually-hidden inputs/labels had no positioned ancestor, so they stretched
       the DOCUMENT; a wheel over the panel then scrolled the whole app off-screen
       and left a band of bare page background (black in dark mode). `min-h-0` +
       `overflow-y-auto` let it shrink to the pane and scroll; `relative` keeps
       those hidden controls inside it; `overscroll-contain` stops the scroll
       chaining to the page. */
    <section
      ref={panelRef}
      aria-label={`Settings for ${agent.name}`}
      data-testid="bot-settings-panel"
      className={cn('relative min-h-0 shrink overflow-y-auto overscroll-contain border-b border-line bg-surface-1 px-3 py-3 sm:px-6', fill && 'flex-1 border-b-0')}
    >
      <div className="mx-auto flex max-w-[760px] flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-display text-base font-semibold text-fg-0">Bot settings</h3>
          {/* A real, visible button (Operator's 2026-11-12 walkthrough: the old ghost
              "Done" read as plain text on this surface, so he closed the panel
              with the header Settings toggle instead). Secondary, not primary,
              so it never competes with Save below; the `!` overrides are needed
              because cn() does not de-dupe the secondary variant's own fill/border/text. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            aria-label={`Done: close settings for ${agent.name}`}
            className="min-h-[44px] min-w-[72px] font-medium sm:min-h-0 !border-line-strong !bg-surface-2 !text-fg-0 hover:!bg-surface-3"
          >
            Done
          </Button>
        </div>

        <nav aria-label={`Jump to a section of ${agent.name}'s settings`} className="-mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-fg-2">
          <span>Jump to:</span>
          {SECTION_LINKS.map(l => (
            <a
              key={l.idPrefix}
              href={`#${l.idPrefix}-${agent.slug}`}
              onClick={e => {
                if (jumpTo(`${l.idPrefix}-${agent.slug}`)) e.preventDefault()
              }}
              className="rounded px-1.5 py-0.5 text-accent-hover underline-offset-2 hover:underline focus:outline-none focus:ring-2 focus:ring-accent/30"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id={`bot-model-tools-title-${agent.slug}`} className="font-display text-sm font-semibold text-fg-0">Model and tools</h4>
          {modelToolsDirty && (
            <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs text-warning">Unsaved changes</span>
          )}
        </div>

        {!isAdmin && (
          <p className="text-xs text-fg-2">Only an admin can change a bot&apos;s model or tools.</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`bot-model-${agent.slug}`} className="mb-1 block text-xs font-medium text-fg-1">Default model</label>
            <ModelPicker
              id={`bot-model-${agent.slug}`}
              models={models}
              value={customModel ? CUSTOM_MODEL : model}
              disabled={!isAdmin || saving}
              leading={[{ value: '', label: defaultLabel }]}
              trailing={[{ value: CUSTOM_MODEL, label: 'Other model id…' }]}
              onChange={pickModel}
            />
            {customModel && (
              <input
                id={`bot-model-custom-${agent.slug}`}
                aria-label="Model id"
                value={model}
                disabled={!isAdmin || saving}
                placeholder="Model id, e.g. a custom endpoint's model"
                onChange={e => { setModel(e.target.value); setSaved(false) }}
                className={cn(inputCls, 'mt-2')}
              />
            )}
            <p className="mt-1 text-xs text-fg-2">
              Answers now with <span className="text-fg-1">{PROVIDER_LABELS[agent.answered_by.id]}{agent.answered_by.model ? ` · ${agent.answered_by.model}` : ''}</span>. Leave empty for the default.
            </p>
          </div>
          <div>
            <label htmlFor={`bot-provider-${agent.slug}`} className="mb-1 block text-xs font-medium text-fg-1">AI provider</label>
            <Select className="w-full"
              id={`bot-provider-${agent.slug}`}
              value={provider}
              disabled={!isAdmin || saving}
              onChange={v => { setProvider(v as ProviderId | ''); setSaved(false) }}
            >
              <option value="">{fileDefaults.provider ? `${PROVIDER_LABELS[fileDefaults.provider]} (from the bot file)` : 'Automatic (install default)'}</option>
              {PROVIDERS.map(p => (
                <option key={p} value={p}>
                  {PROVIDER_LABELS[p]}{meta.providers && !meta.providers[p] ? ' — not set up' : ''}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <fieldset className="flex flex-col gap-2" disabled={!isAdmin || saving}>
          <legend className="mb-1 text-xs font-medium text-fg-1">Tools</legend>
          <label className="flex items-start gap-2 rounded-md border border-line bg-surface-0 px-3 py-2">
            <input
              type="checkbox"
              checked={allTools}
              onChange={e => { setAllTools(e.target.checked); setSaved(false) }}
              className="mt-0.5"
              aria-describedby={`bot-all-tools-help-${agent.slug}`}
            />
            <span>
              <span className="block text-sm font-medium text-fg-0">All tools</span>
              <span id={`bot-all-tools-help-${agent.slug}`} className="block text-xs text-fg-2">
                Every tool below, plus any added later. Email and calendar stay draft-only. Secrets must be ticked on their own.
              </span>
            </span>
          </label>
          {byGroup.map(({ group, tools: entries }) => (
            <div key={group}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">{GROUP_LABELS[group]}</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {entries.map(t => {
                  // obj 900749: an explicit-only tool (secret use) is never implied by "All tools".
                  const implied = allTools && !t.explicit_only
                  const checked = implied || (isAdmin ? tools.includes(t.name) : enabledNames.has(t.name))
                  return (
                    <label key={t.name} className={cn('flex items-start gap-2 rounded-md px-2 py-1.5', implied && 'opacity-70')}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={implied}
                        onChange={() => toggle(t.name)}
                        className="mt-0.5"
                        aria-label={t.label}
                      />
                      <span>
                        <span className="block text-sm text-fg-0">{t.label}</span>
                        <span className="block text-xs text-fg-2">{t.description}</span>
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          ))}
        </fieldset>

        {webMissing && (
          <Alert tone="amber">
            Web search is not set up on this install yet. Add one search key in Settings → Secrets (TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, FIRECRAWL_API_KEY, EXA_API_KEY or SERPER_API_KEY). Reading a page by its URL works without one.
          </Alert>
        )}
        {error && <Alert tone="alarm">{error}</Alert>}

        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            {/* obj 900914: each section has its own, labelled Save. This one sends
                model, provider and tools only (PUT …/config) — never High
                Agency, workspace access or approvals. */}
            <Button variant="primary" size="sm" loading={saving} onClick={() => void save()}>Save model and tools</Button>
            <Button variant="ghost" size="sm" disabled={saving || !cfg} onClick={() => void reset()}>Reset model and tools to file</Button>
            {saved && (
              <span role="status" className="text-xs text-fg-2">
                Saved model and tools. Workspace access, approvals and High Agency are saved in their own sections and did not change.
              </span>
            )}
            {cfg?.updated_by && !saved && (
              <span className="text-xs text-fg-2">Changed by {cfg.updated_by}</span>
            )}
          </div>
        )}

        <WorkspaceAccessSection agent={agent} isAdmin={isAdmin} version={grantVersion} onChanged={() => setAccessVersion(v => v + 1)} />

        {/* obj 900972: per-workspace Full access. Re-reads when the workspace list changes on either side. */}
        <FullAccessSection
          agent={agent}
          isAdmin={isAdmin}
          version={accessVersion + grantVersion}
          onChanged={summary => onSaved({ ...agent, full_access: summary })}
        />

        {/* obj 901484: which secrets this bot may use, on one screen with one Save. */}
        <SecretAccessSection agent={agent} isAdmin={isAdmin} version={accessVersion + grantVersion} onSaved={onSaved} />

        <DelegationSection agent={agent} isAdmin={isAdmin} />

        <HighAgencySection agent={agent} isAdmin={isAdmin} accessVersion={accessVersion} onAccessChanged={() => setGrantVersion(v => v + 1)} />

        <CardWakesSection agent={agent} isAdmin={isAdmin} />

        <LongRepliesSection agent={agent} isAdmin={isAdmin} />

        <DevOpsSection agent={agent} isAdmin={isAdmin} />

        <RepoRightsSection agent={agent} isAdmin={isAdmin} />
      </div>
    </section>
  )
}
