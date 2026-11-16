import { useEffect, useId, useMemo, useState, type MouseEvent } from 'react'
import { Activity, ExternalLink, GitPullRequest, Maximize2, X } from 'lucide-react'
import type { Objective } from '@operationkit/shared'
import { api } from '../lib/api'
import { relativeTime } from '../lib/time'
import { actionStatusOf } from '../lib/statusActions'
import { STATUS_META, StatusDot } from '../components/design/primitives'
import { Modal } from '../components/ui/Modal'
import { Eyebrow, IconButton, RowButton, cn } from '../components/ui'
import { OwnerTag } from '../components/OwnerTag'
import { SessionViewer } from '../components/SessionViewer'

/* ─────────────────────────────────────────────────────────
   Sub-card pop-up (obj 901083).

   Viewing a card and clicking one of its sub-cards no longer navigates away:
   the sub-card opens HERE, over the parent, with its title, status, owner,
   summary, PR link, latest activity and its live chat (the real thread +
   composer, via SessionViewer's `embed` chrome).

   - "Open full card" goes to /o/:id (a real link: Cmd/Ctrl/middle-click opens
     a new tab like any link).
   - Escape or a press outside closes it; the parent page was never left, so it
     is exactly where it was, and focus goes back to the row that opened it.
   ───────────────────────────────────────────────────────── */

/** The two "how's it going" sources the progress route returns. */
interface ProgressPeek {
  latest?: { label: string | null; note: string | null; created_at: string } | null
  transcript?: {
    last_assistant_message: string | null
    last_tool: { name: string; summary: string | null } | null
    last_event_at: string | null
  } | null
}

export interface LatestActivity {
  text: string
  at: string | null
}

/** One line for "latest activity": the worker's own snapshot wins, then the
    transcript (last message, else last tool), else nothing. */
export function latestActivityOf(p: ProgressPeek | null): LatestActivity | null {
  if (!p) return null
  const snap = p.latest
  if (snap && (snap.label || snap.note)) {
    return { text: [snap.label, snap.note].filter(Boolean).join(' — '), at: snap.created_at }
  }
  const t = p.transcript
  if (t?.last_assistant_message) return { text: t.last_assistant_message, at: t.last_event_at }
  if (t?.last_tool) {
    return { text: t.last_tool.summary ? `${t.last_tool.name}: ${t.last_tool.summary}` : t.last_tool.name, at: t.last_event_at }
  }
  return null
}

/** A plain left click with no modifier: the only click a link should hijack. */
export function isPlainLeftClick(e: MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey
}

export function cardHref(id: number): string {
  return `/o/${id}`
}

function prLabel(o: Objective): string {
  if (o.pr_number) return `PR #${o.pr_number}`
  const m = o.pr_url?.match(/\/pull\/(\d+)/)
  return m ? `PR #${m[1]}` : 'Pull request'
}

export function SubCardPopup({
  objective: initial,
  onClose,
  onOpenFull,
}: {
  /** The sub-card as the parent's list knows it (may be the slim board row). */
  objective: Objective
  onClose: () => void
  /** Plain click on "Open full card" — the host navigates to the full page. */
  onOpenFull: (o: Objective) => void
}) {
  const titleId = useId()
  const [detail, setDetail] = useState<Objective | null>(null)
  const [progress, setProgress] = useState<ProgressPeek | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)

  // Hydrate the full row (summary is withheld from the slim list) and peek at
  // the latest activity. Both best-effort: the slim row still renders.
  useEffect(() => {
    let cancelled = false
    setDetail(null)
    setProgress(null)
    setSummaryOpen(false)
    api.get<Objective>(`/objectives/${initial.id}`)
      .then(row => { if (!cancelled) setDetail(row) })
      .catch(() => {})
    api.get<ProgressPeek>(`/objectives/${initial.id}/progress?limit=1`)
      .then(p => { if (!cancelled) setProgress(p) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [initial.id])

  // Live scalar updates (status, PR, …) from the parent's list win over the
  // one-off fetch; the fetch fills the heavy text the list does not carry.
  const objective: Objective = useMemo(
    () => (detail ? { ...detail, ...stripUndefined(initial) } : initial),
    [detail, initial],
  )
  const status = actionStatusOf(objective)
  const meta = STATUS_META[status]
  const summary = (objective.last_session_summary ?? '').trim()
  const activity = latestActivityOf(progress)
  const href = cardHref(objective.id)
  const title = objective.title.replace(/^worker:\s*/i, '')

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      variant="center"
      panelClassName={cn(
        'flex flex-col overflow-hidden',
        'inset-x-2 top-[4vh] bottom-auto m-0 h-[min(880px,92vh)] max-h-none w-auto max-w-none rounded-xl',
        'sm:inset-x-auto sm:left-1/2 sm:top-[6vh] sm:h-[min(860px,88vh)] sm:w-[min(880px,calc(100vw-48px))] sm:-translate-x-1/2',
      )}
    >
      <div data-testid="sub-card-popup" className="flex min-h-0 flex-1 flex-col">
        {/* Header: what this is, whose it is, and the two ways out. */}
        <header className="flex items-start gap-3 border-b border-line px-4 pb-3 pt-3.5 sm:px-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2">
              <span className="text-fg-3">Sub-card</span>
              <span aria-hidden="true" className="text-fg-3">·</span>
              <span className="font-mono text-fg-3">#{objective.id}</span>
              <span
                data-testid="sub-card-status"
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2 px-2 py-0.5 font-medium text-fg-1"
              >
                <StatusDot status={status} size={7} />
                {meta?.label ?? status}
              </span>
            </div>
            <h2 id={titleId} className="mt-1.5 text-base font-semibold leading-snug text-fg-0 sm:text-lg [overflow-wrap:anywhere]">
              {title}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-2">
              <OwnerTag objective={objective} />
              {objective.pr_url && (
                <a
                  href={objective.pr_url}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="sub-card-pr"
                  className="inline-flex items-center gap-1 rounded text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
                  {prLabel(objective)}
                  <ExternalLink className="h-3 w-3 opacity-70" aria-hidden="true" />
                </a>
              )}
              {objective.updated_at && (
                <span className="text-fg-3">Updated {relativeTime(objective.updated_at)}</span>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <a
              href={href}
              data-testid="sub-card-open-full"
              onClick={e => {
                // Cmd/Ctrl/Shift/middle-click keep the browser's own link behaviour.
                if (!isPlainLeftClick(e)) return
                e.preventDefault()
                onOpenFull(objective)
              }}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-md border border-transparent bg-accent px-3 text-sm font-medium text-accent-fg',
                'shadow-[inset_0_-1px_0_rgba(0,0,0,0.12)] transition-colors duration-fast ease-out hover:bg-accent-hover active:bg-accent-press',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface-1',
              )}
            >
              <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Open full card</span>
            </a>
            <IconButton label="Close (Esc)" size="sm" onClick={onClose} data-testid="sub-card-close">
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </header>

        {/* Summary + latest activity: the "where is it" at a glance. */}
        {(summary || activity) && (
          <section aria-label="Summary" className="max-h-[32%] shrink-0 overflow-y-auto border-b border-line bg-surface-0 px-4 py-3 sm:px-5">
            {summary && (
              <div data-testid="sub-card-summary">
                <Eyebrow className="block">Summary</Eyebrow>
                <p className={cn('mt-1 whitespace-pre-line text-sm leading-relaxed text-fg-1', !summaryOpen && 'line-clamp-3')}>
                  {summary}
                </p>
                {summary.length > 240 && (
                  <RowButton
                    onClick={() => setSummaryOpen(v => !v)}
                    aria-expanded={summaryOpen}
                    className="mt-1 rounded text-xs font-medium text-accent-hover hover:underline"
                  >
                    {summaryOpen ? 'Show less' : 'Show more'}
                  </RowButton>
                )}
              </div>
            )}
            {activity && (
              <div data-testid="sub-card-activity" className={cn('flex items-start gap-2 text-xs text-fg-2', summary && 'mt-2.5')}>
                <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg-1">Latest activity</span>
                  {activity.at && <span className="text-fg-3"> · {relativeTime(activity.at)}</span>}
                  <span className="mt-0.5 block line-clamp-2 [overflow-wrap:anywhere]">{activity.text}</span>
                </span>
              </div>
            )}
          </section>
        )}

        {/* The sub-card's own chat: same thread + composer as the full card. */}
        <div className="relative min-h-0 flex-1" data-testid="sub-card-chat">
          <SessionViewer objective={objective} chrome="embed" onClose={onClose} />
        </div>
      </div>
    </Modal>
  )
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}
