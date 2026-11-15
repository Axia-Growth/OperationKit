import { useState } from 'react'
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react'
import { FLOW_TOOLS_MAX, FLOW_TOOL_MAX_CHARS, normalizeFlowTools, splitFlowTools } from '../../../../shared/flow/details'
import type { FlowToolInfo } from '../../../../shared/flow/api'
import { fetchFlowTools, setFlowToolEnabled } from '../../hooks/useFlows'
import { Switch, cn } from '../ui'

/**
 * Tools a workflow should use (obj 900868): a short list of names (HubSpot,
 * Slack, Google Sheets, an okit tool slug…), shown as chips. Type a name and
 * press Enter or a comma; paste a comma- or line-separated list; × removes one.
 * Pending text is added on blur, so Save never drops what was typed.
 */
export const FLOW_FIELD =
  'w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-sm text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'
export const FLOW_LABEL = 'mb-1 block text-xs font-medium text-fg-1'

export function FlowToolsInput({
  id,
  value,
  onChange,
  describedBy,
  workspace,
}: {
  id: string
  value: string[]
  onChange: (next: string[]) => void
  describedBy?: string
  /** obj 900911: when set, the field can list the Tools a workflow step can call in this workspace. */
  workspace?: string
}) {
  const [draft, setDraft] = useState('')
  const full = value.length >= FLOW_TOOLS_MAX

  const commit = (text: string) => {
    const added = splitFlowTools(text).map(t => t.slice(0, FLOW_TOOL_MAX_CHARS))
    if (added.length) onChange(normalizeFlowTools([...value, ...added]).slice(0, FLOW_TOOLS_MAX))
    setDraft('')
  }

  return (
    <div
      className={cn(FLOW_FIELD, 'flex min-h-[40px] flex-wrap items-center gap-1.5 py-1.5 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/30')}
      data-testid="flow-tools-input"
    >
      {value.map(t => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-xs text-fg-0">
          {t}
          <button
            type="button"
            className="rounded p-0.5 text-fg-3 hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            aria-label={`Remove ${t}`}
            onClick={() => onChange(value.filter(v => v !== t))}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-describedby={describedBy}
        className="min-w-[10rem] flex-1 bg-transparent text-sm text-fg-0 placeholder:text-fg-3 focus:outline-none"
        value={draft}
        disabled={full}
        maxLength={FLOW_TOOL_MAX_CHARS * 4}
        placeholder={full ? `Up to ${FLOW_TOOLS_MAX} tools` : value.length ? 'Add another…' : 'e.g. HubSpot, Slack, Google Sheets'}
        onChange={e => {
          const v = e.target.value
          if (/[,\n]/.test(v)) commit(v)
          else setDraft(v)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(draft)
          } else if (e.key === 'Backspace' && !draft && value.length) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={() => { if (draft.trim()) commit(draft) }}
      />
      {workspace && (
        <AvailableFlowTools
          workspace={workspace}
          chosen={value}
          disabled={full}
          onPick={slug => onChange(normalizeFlowTools([...value, slug]).slice(0, FLOW_TOOLS_MAX))}
        />
      )}
    </div>
  )
}

const EFFECT_WORDS: Record<string, string> = {
  read: 'Reads data',
  write: 'Changes data',
  send: 'Sends messages',
  spend: 'Spends money',
}

/**
 * The Tools registered with the workflow engine (obj 900911), loaded when the
 * builder opens the list. Each shows what it does and whether this workspace
 * has it switched on; a Tool that is off refuses when a run reaches it. An
 * owner/admin can switch it on or off here.
 */
export function AvailableFlowTools({
  workspace,
  chosen,
  onPick,
  disabled,
}: {
  workspace: string
  chosen: string[]
  onPick: (slug: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<{ ws: string; tools: FlowToolInfo[]; canManage: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    const r = await fetchFlowTools(workspace)
    setLoading(false)
    if (!r.ok) { setError(r.error); return }
    setState({ ws: workspace, tools: r.data.tools, canManage: r.data.can_manage })
  }

  const toggle = () => {
    const next = !open
    setOpen(next)
    if (next && (!state || state.ws !== workspace)) void load()
  }

  const flip = async (slug: string, enabled: boolean) => {
    setBusy(slug)
    const r = await setFlowToolEnabled(workspace, slug, enabled)
    setBusy(null)
    if (!r.ok) { setError(r.error); return }
    setState({ ws: workspace, tools: r.data.tools, canManage: r.data.can_manage })
  }

  const shown = state && state.ws === workspace ? state : null

  return (
    <div className="w-full basis-full border-t border-line pt-1.5" data-testid="flow-tools-available">
      <button
        type="button"
        className="inline-flex items-center gap-1 rounded text-xs text-fg-2 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-expanded={open}
        onClick={toggle}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Tools a step can call
      </button>
      {open && (
        <div className="mt-1.5 space-y-1">
          {loading && <p className="text-xs text-fg-3">Loading tools…</p>}
          {error && <p className="text-xs text-danger" role="alert">Could not load tools: {error}</p>}
          {shown && shown.tools.length === 0 && (
            <p className="text-xs text-fg-3">No tools are set up for workflows yet. A tool becomes available here once its definition says how to run it.</p>
          )}
          {shown && shown.tools.length > 0 && (
            <ul className="space-y-1" aria-label="Tools a step can call">
              {shown.tools.map(t => {
                const picked = chosen.includes(t.slug)
                return (
                  <li key={t.slug} className="flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-2 py-1 text-xs" data-testid={`flow-tool-${t.slug}`}>
                    <span className="font-medium text-fg-0">{t.slug}</span>
                    <span className="text-fg-2">{EFFECT_WORDS[t.effect ?? 'send'] ?? 'Sends messages'}{t.idempotent ? ', safe to retry' : ''}</span>
                    <span className={t.enabled ? 'text-success' : 'text-fg-3'}>{t.enabled ? 'On for this workspace' : 'Off for this workspace'}</span>
                    {t.description && <span className="basis-full text-fg-3">{t.description}</span>}
                    <span className="ml-auto flex items-center gap-1">
                      {shown.canManage && t.source === 'okit' && (
                        <Switch
                          checked={t.enabled}
                          busy={busy === t.slug}
                          onChange={on => void flip(t.slug, on)}
                          aria-label={`${t.enabled ? 'Turn off' : 'Turn on'} ${t.slug} for this workspace`}
                        />
                      )}
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-fg-1 hover:bg-surface-3 hover:text-fg-0 disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                        disabled={picked || disabled}
                        onClick={() => onPick(t.slug)}
                        aria-label={picked ? `${t.slug} added` : `Add ${t.slug}`}
                      >
                        <Plus className="h-3 w-3" />{picked ? 'Added' : 'Add'}
                      </button>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

/** Read-only chips for the detail view. */
export function FlowToolsList({ tools }: { tools: string[] }) {
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Tools">
      {tools.map(t => (
        <li key={t} className="rounded-md border border-line bg-surface-2 px-2 py-0.5 text-xs text-fg-0">{t}</li>
      ))}
    </ul>
  )
}
