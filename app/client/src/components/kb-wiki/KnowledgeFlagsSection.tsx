import { useCallback, useEffect, useState } from 'react'
import { Check, Flag, X } from 'lucide-react'
import { KB_FLAG_KIND_LABEL, type KbFlag, type KbFlagKind } from '@operationkit/shared'
import { labelFromRel } from '../../lib/kbWiki'
import { Alert, Badge, Button } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

const KIND_TONE: Record<KbFlagKind, 'alarm' | 'amber' | 'info'> = {
  wrong: 'alarm',
  stale: 'amber',
  missing: 'info',
}

function when(iso?: string | null): string {
  if (!iso) return ''
  // SQLite datetime('now') is UTC without a zone marker.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/* KnowledgeFlagsSection (obj 901767) — what workers, bots and agents flagged
   as missing, wrong or out of date while they worked. Sits on the Cleanup tab
   beside the cleanup report. A flag never edited a page; closing one here only
   records what happened (the fix itself goes through the normal edit paths). */
export function KnowledgeFlagsSection({
  workspace,
  titles,
  onOpenNote,
}: {
  workspace: string
  titles: Map<string, string>
  onOpenNote: (rel: string) => void
}) {
  const [flags, setFlags] = useState<KbFlag[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      const b = await wikiApi<{ flags: KbFlag[]; total: number }>(`/flags?${wsQuery(workspace)}&status=open&limit=200`)
      setFlags(b.flags)
      setTotal(b.total)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setFlags([])
    }
  }, [workspace])

  useEffect(() => { setFlags(null); void load() }, [load])

  const close = async (id: number, status: 'resolved' | 'dismissed') => {
    setBusy(id)
    setError(null)
    try {
      await wikiApi(`/flags/${id}/status?${wsQuery(workspace)}`, { method: 'POST', json: { workspace, status } })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-labelledby="cleanup-flags" className="flex flex-col gap-1.5">
      <h4 id="cleanup-flags" className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-fg-0">
        <Flag className="h-4 w-4 text-warning" aria-hidden="true" />
        Flagged while working
        <span className="font-mono text-xs font-normal text-fg-3">{flags === null ? '…' : total}</span>
      </h4>
      <p className="max-w-[64ch] text-xs text-fg-3">
        Agents and people report notes that are missing, wrong or out of date here instead of rewriting them.
        Nothing below has changed a page. Fix the note, then mark the flag fixed.
      </p>
      {error && <Alert tone="alarm" title="Could not load flags">{error}</Alert>}
      {flags !== null && flags.length === 0 && !error && <p className="text-sm text-fg-2">No open flags.</p>}
      {flags !== null && flags.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {flags.map(f => (
            <li key={f.id} className="flex flex-col gap-1.5 py-2.5" data-testid="kb-flag">
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={KIND_TONE[f.kind]}>{KB_FLAG_KIND_LABEL[f.kind] ?? f.kind}</Badge>
                <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-fg-0">{f.subject}</p>
                {f.seen_count > 1 && <span className="font-mono text-xs text-fg-3">flagged {f.seen_count} times</span>}
              </div>
              <p className="whitespace-pre-wrap text-sm leading-snug text-fg-1">{f.detail}</p>
              {f.suggested_fix && (
                <div className="rounded-md border border-line-soft bg-surface-2 px-2.5 py-1.5 text-sm text-fg-1">
                  <span className="text-xs font-medium text-fg-3">Suggested fix</span>
                  <p className="whitespace-pre-wrap">{f.suggested_fix}</p>
                </div>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
                {f.page && (
                  <button
                    type="button"
                    onClick={() => onOpenNote(f.page!)}
                    className="inline-flex min-h-[44px] items-center rounded-md border border-line-soft bg-surface-2 px-2.5 text-xs text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]"
                  >
                    {titles.get(f.page) ?? labelFromRel(f.page)}
                  </button>
                )}
                {f.objective_id != null && <a href={`/o/${f.objective_id}`} className="text-accent hover:underline">Card #{f.objective_id}</a>}
                <span>by {f.filed_by || f.source}</span>
                <span>{when(f.created_at)}</span>
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="secondary" loading={busy === f.id} disabled={busy !== null}
                    onClick={() => { void close(f.id, 'resolved') }} leftIcon={<Check className="h-3.5 w-3.5" aria-hidden="true" />}>
                    Fixed
                  </Button>
                  <Button size="sm" variant="ghost" disabled={busy !== null}
                    onClick={() => { void close(f.id, 'dismissed') }} leftIcon={<X className="h-3.5 w-3.5" aria-hidden="true" />}>
                    Dismiss
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
