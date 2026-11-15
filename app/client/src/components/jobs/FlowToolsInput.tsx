import { useState } from 'react'
import { X } from 'lucide-react'
import { FLOW_TOOLS_MAX, FLOW_TOOL_MAX_CHARS, normalizeFlowTools, splitFlowTools } from '../../../../shared/flow/details'
import { cn } from '../ui'

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
}: {
  id: string
  value: string[]
  onChange: (next: string[]) => void
  describedBy?: string
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
