import { useEffect, useState, useRef, useCallback, useId } from 'react'
import { Command, CommandInput, CommandItem, CommandList, CommandStatus } from '@ui-sdk/react/command'
import type { ObjectiveStatus, Workspace } from '@operationkit/shared'
import {
  searchObjectives,
  searchObjectivesAi,
  ApiError,
  type ObjectiveSearchResult,
  type ObjectiveAiSearchResult,
} from '../lib/api'
import { useWorkspaces } from '../hooks/useWorkspaces'
import { NavIcon } from './nav-icons'
import { STATUS_META, StatusDot } from './design/primitives'
import { Modal } from './ui/Modal'
import { SegmentedControl } from './ui/SegmentedControl'

/* ─────────────────────────────────────────────────────────
   Objective search (obj 702389)
   A ⌘K-style overlay that searches objectives ACROSS ALL
   stages (incl. done / cancelled) via the server-side search
   endpoints (obj 702388). The Done column is a lazily-paginated
   backlog never fully loaded client-side, so this is the only
   way to find a completed objective by keyword/idea.

   Two modes in one panel:
     • Keyword — GET /objectives/search, debounced as you type.
     • AI      — POST /objectives/search/ai, run on submit; shows
                 a per-result reason, or a graceful message on 502.
   Selecting a result hands its id up; the board fetches the full
   objective and opens ObjectiveModal (reopen works for done).
   ───────────────────────────────────────────────────────── */

interface ObjectiveSearchPanelProps {
  open: boolean
  workspace: Workspace
  onClose: () => void
  onSelect: (id: number) => void
}

type Mode = 'keyword' | 'ai'

// Small status pill reusing the board's STATUS_META tokens so done/cancelled
// read the same in search as on the board.
function StatusBadge({ status }: { status: ObjectiveStatus }) {
  const meta = STATUS_META[status] ?? STATUS_META.queue
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-sm border border-line-soft bg-surface-3 px-1.5 py-0.5 text-xs font-medium ${meta.tone}`}
    >
      <StatusDot status={status} size={6} />
      {meta.label}
    </span>
  )
}

export function ObjectiveSearchPanel({ open, workspace, onClose, onSelect }: ObjectiveSearchPanelProps) {
  const { shortOf } = useWorkspaces()
  const [mode, setMode] = useState<Mode>('keyword')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)
  const [kwResults, setKwResults] = useState<ObjectiveSearchResult[]>([])
  const [aiResults, setAiResults] = useState<ObjectiveAiSearchResult[]>([])
  const titleId = useId()
  // Guards against out-of-order keyword responses (last query wins).
  const seqRef = useRef(0)

  // Reset everything each time the panel opens; focus the input.
  useEffect(() => {
    if (!open) return
    setMode('keyword')
    setQuery('')
    setLoading(false)
    setAiError(null)
    setKwResults([])
    setAiResults([])
  }, [open])

  // Debounced keyword search as the user types (250ms). AI mode does NOT
  // auto-run — it fires on submit (Enter / button) to bound API cost.
  useEffect(() => {
    if (!open || mode !== 'keyword') return
    const q = query.trim()
    if (!q) {
      setKwResults([])
      setLoading(false)
      return
    }
    const seq = ++seqRef.current
    setLoading(true)
    const t = setTimeout(async () => {
      try {
        const { results } = await searchObjectives(q, workspace, 30)
        if (seq === seqRef.current) {
          setKwResults(results)
        }
      } catch {
        if (seq === seqRef.current) setKwResults([])
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, mode, workspace, open])

  const runAiSearch = useCallback(async () => {
    const q = query.trim()
    if (!q) return
    const seq = ++seqRef.current
    setLoading(true)
    setAiError(null)
    try {
      const { results } = await searchObjectivesAi(q, workspace)
      if (seq !== seqRef.current) return
      setAiResults(results)
      if (results.length === 0) setAiError(null)
    } catch (err) {
      if (seq !== seqRef.current) return
      setAiResults([])
      if (err instanceof ApiError && err.status === 502) {
        setAiError('AI search unavailable (API key not configured)')
      } else {
        setAiError('AI search failed — try again')
      }
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [query, workspace])

  if (!open) return null

  const results: Array<ObjectiveSearchResult | ObjectiveAiSearchResult> =
    mode === 'keyword' ? kwResults : aiResults

  function switchMode(next: Mode) {
    if (next === mode) return
    setMode(next)
    setAiError(null)
    setLoading(false)
    seqRef.current++ // invalidate any in-flight request from the previous mode
    if (next === 'ai') setAiResults([])
  }

  const showEmpty = !loading && query.trim() && results.length === 0 && !aiError

  const select = (id: number) => { onClose(); onSelect(id) }
  const status = aiError
    ? aiError
    : loading
      ? 'Searching…'
      : showEmpty
        ? 'No matches'
        : mode === 'ai' && !query.trim()
          ? 'Type a natural-language query and press Enter.'
          : null

  // A real dialog (obj 900819): the board behind goes inert, Esc and an outside
  // click close it, focus returns to where it was. Results are a UI SDK Command
  // list with server-side filtering, so focus stays in the field and the
  // highlighted result is announced (aria-activedescendant).
  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      panelClassName="top-[10vh] bottom-auto mt-0 flex max-h-[72vh] max-w-xl flex-col overflow-hidden bg-surface-2"
    >
      <h2 id={titleId} className="sr-only">Search objectives</h2>
      <Command
        loop
        filter={false}
        query={query}
        onQueryChange={(q) => { setQuery(q); if (mode === 'ai') setAiResults([]) }}
        status={loading ? 'loading' : 'idle'}
        onAction={(value) => select(Number(value))}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2.5">
          <NavIcon name="search" className="h-4 w-4 shrink-0 text-fg-3" />
          <CommandInput
            data-autofocus=""
            aria-label={mode === 'keyword' ? 'Search objectives' : 'Describe the objective you are looking for'}
            placeholder={mode === 'keyword' ? 'Search objectives (all stages)…' : 'Describe what you’re looking for, then Enter…'}
            onKeyDown={(e) => {
              // AI mode: Enter submits the query until results for it are shown.
              if (e.key === 'Enter' && mode === 'ai' && aiResults.length === 0) {
                e.preventDefault()
                void runAiSearch()
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-base text-fg-0 placeholder-fg-3 outline-none"
          />
          <kbd className="shrink-0 font-mono text-xs text-fg-3">esc</kbd>
        </div>

        <div className="flex items-center gap-2 border-b border-line-soft px-3 py-1.5">
          <SegmentedControl
            label="Search mode"
            items={[{ key: 'keyword', label: 'Keyword' }, { key: 'ai', label: 'AI' }]}
            value={mode}
            onChange={(k) => switchMode(k as Mode)}
          />
          {mode === 'ai' && (
            <button
              type="button"
              onClick={() => void runAiSearch()}
              disabled={loading || !query.trim()}
              className="ml-auto inline-flex h-7 items-center rounded-md bg-accent px-2.5 text-sm font-medium text-accent-fg transition-colors duration-fast ease-out hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-40"
            >
              {loading ? 'Searching…' : 'Search'}
            </button>
          )}
        </div>

        <CommandStatus className={status ? `px-3 py-3 text-base ${aiError ? 'text-[color:var(--ok-alarm)]' : 'text-fg-3'}` : 'sr-only'}>
          {status ?? `${results.length} ${results.length === 1 ? 'result' : 'results'}`}
        </CommandStatus>

        <CommandList className="min-h-0 flex-1 overflow-y-auto py-1">
          {results.map(r => {
            const snippet = 'snippet' in r ? r.snippet : r.reason
            const agent = 'agent_context' in r ? r.agent_context : null
            return (
              <CommandItem
                key={r.id}
                value={String(r.id)}
                label={r.title || 'Untitled'}
                className="flex cursor-pointer flex-col gap-1 px-3 py-2 transition-colors duration-fast ease-out hover:bg-surface-3 data-[highlighted]:bg-surface-3"
              >
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.status} />
                  <span className="min-w-0 flex-1 truncate text-base text-fg-0">{r.title || 'Untitled'}</span>
                  <span className="shrink-0 text-xs uppercase text-fg-3 font-semibold tracking-eyebrow">{shortOf(r.workspace as Workspace)}</span>
                </div>
                {(snippet || agent) && (
                  <div className="flex items-center gap-1.5 text-xs leading-snug text-fg-3">
                    {agent && <span className="shrink-0 font-mono text-fg-2">{agent}</span>}
                    {agent && snippet && <span className="shrink-0 text-fg-3">·</span>}
                    {snippet && <span className="line-clamp-2">{snippet}</span>}
                  </div>
                )}
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>
    </Modal>
  )
}
