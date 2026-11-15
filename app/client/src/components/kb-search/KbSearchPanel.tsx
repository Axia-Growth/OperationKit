// Knowledge page search (hybrid keyword + semantic). Sits at the top of the
// Context sidebar; while a query is active its results replace the page tree
// (passed in as `children`), and clearing the query brings the tree back.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import { Badge, SearchInput, SkeletonText, cn } from '../ui'
import {
  MATCH_LABEL, MODE_OPTIONS, degradedNote, docFolder, docTitle, formatScore, searchKb,
  type KbMatch, type KbSearchMode, type KbSearchResponse,
} from '../../lib/kbSearch'

const MIN_CHARS = 2
const DEBOUNCE_MS = 300

const MATCH_TONE: Record<KbMatch, 'accent' | 'verify' | 'neutral' | 'info'> = {
  exact: 'accent',
  both: 'verify',
  keyword: 'neutral',
  semantic: 'info',
}

interface KbSearchPanelProps {
  workspace?: string
  /** Knowledge base root, so result folders read relative to it. */
  root?: string
  selectedPath?: string | null
  onOpen: (path: string) => void
  /** Shown when no query is active (the page tree). */
  children?: ReactNode
}

export function KbSearchPanel({ workspace, root, selectedPath, onOpen, children }: KbSearchPanelProps) {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<KbSearchMode>('hybrid')
  const [res, setRes] = useState<KbSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitTick, setSubmitTick] = useState(0)
  const seq = useRef(0)

  const q = query.trim()
  const active = q.length >= MIN_CHARS

  useEffect(() => {
    if (!active) {
      seq.current++
      setRes(null)
      setError(null)
      setLoading(false)
      return
    }
    const id = ++seq.current
    setLoading(true)
    const timer = setTimeout(() => {
      searchKb(q, mode, 20, workspace)
        .then(data => { if (id === seq.current) { setRes(data); setError(null) } })
        .catch(err => { if (id === seq.current) { setRes(null); setError(err instanceof Error ? err.message : 'Search failed') } })
        .finally(() => { if (id === seq.current) setLoading(false) })
    }, submitTick > 0 ? 0 : DEBOUNCE_MS)
    return () => clearTimeout(timer)
    // submitTick re-runs the search immediately on Enter.
  }, [q, mode, workspace, active, submitTick])

  const note = res ? degradedNote(res) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        role="search"
        className="space-y-2 border-b border-line-soft p-3"
        onSubmit={e => { e.preventDefault(); setSubmitTick(t => t + 1) }}
      >
        <SearchInput
          aria-label="Search Context"
          placeholder="Search pages…"
          value={query}
          onChange={e => { setSubmitTick(0); setQuery(e.target.value) }}
        />
        <div className="flex items-center gap-1" role="group" aria-label="Search mode">
          {MODE_OPTIONS.map(o => (
            <button
              key={o.value}
              type="button"
              aria-pressed={mode === o.value}
              onClick={() => setMode(o.value)}
              className={cn(
                'min-h-[32px] flex-1 rounded-sm px-2 text-xs font-medium transition-colors duration-fast ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                mode === o.value ? 'bg-surface-3 text-fg-0' : 'text-fg-2 hover:text-fg-1',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </form>

      {!active ? (
        <div className="flex-1 overflow-y-auto py-2">{children}</div>
      ) : (
        <div className="flex-1 overflow-y-auto" aria-live="polite" aria-busy={loading || undefined}>
          {note && (
            <p className="border-b border-line-soft px-3 py-2 text-xs text-fg-3" data-testid="kb-search-note">
              {note}
            </p>
          )}
          {error ? (
            <p className="p-3 text-xs text-flag-blocked">{error}</p>
          ) : loading && !res ? (
            <div className="p-3" aria-label="Searching"><SkeletonText lines={4} /></div>
          ) : res && res.results.length === 0 ? (
            <p className="p-3 text-xs text-fg-3">No pages match “{q}”.</p>
          ) : res ? (
            <ul aria-label="Search results" className="py-1">
              {res.results.map((r, i) => {
                const folder = docFolder(r.path, root)
                const selected = selectedPath === r.path
                return (
                  <li key={`${r.path}:${i}`}>
                    <button
                      type="button"
                      onClick={() => onOpen(r.path)}
                      className={cn(
                        'block w-full px-3 py-2 text-left transition hover:bg-surface-3',
                        selected && 'bg-surface-selected shadow-[inset_3px_0_0_var(--accent-text)]',
                      )}
                    >
                      <span className="flex items-center gap-1.5">
                        <FileText className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg-0">{docTitle(r.path)}</span>
                        <span className="shrink-0 font-mono text-xs text-fg-3" title="Score">{formatScore(r, res.mode_used)}</span>
                      </span>
                      {folder && <span className="mt-0.5 block truncate font-mono text-xs text-fg-3">{folder}</span>}
                      {r.heading && <span className="mt-0.5 block truncate text-xs text-fg-1">{r.heading}</span>}
                      {r.snippet && <span className="mt-1 line-clamp-3 text-xs leading-relaxed text-fg-2">{r.snippet}</span>}
                      <span className="mt-1.5 block">
                        <Badge tone={MATCH_TONE[r.match] ?? 'neutral'}>{MATCH_LABEL[r.match] ?? r.match}</Badge>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  )
}
