import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ShieldCheck, Sparkles, X } from 'lucide-react'
import { labelFromRel, type CuratorProposal, type CuratorView, type WikiPageSummary, type WikiSettings } from '../../lib/kbWiki'
import { Alert, Badge, Button, EmptyState, SkeletonText, Switch, Textarea } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

const KIND_LABEL: Record<CuratorProposal['kind'], string> = {
  update: 'Update',
  retire: 'Retire',
  merge: 'Merge',
  create: 'New page',
}

const EVIDENCE_LABEL: Record<string, string> = {
  flag: 'Flag',
  lint: 'Cleanup',
  correction: 'Correction',
}

function when(iso?: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/* CuratorPanel (obj 901768) — what the knowledge curator suggests: page
   updates, retirements, merges and new pages, built from knowledge flags, the
   cleanup report and corrections people typed while work ran. Nothing is
   applied until a person accepts it; a procedure page needs an admin to sign
   off, one at a time. */
export function CuratorPanel({
  workspace,
  pages,
  isAdmin,
  onOpenNote,
  onChanged,
}: {
  workspace: string
  pages: WikiPageSummary[] | null
  isAdmin: boolean
  onOpenNote: (rel: string) => void
  onChanged: () => void
}) {
  const [view, setView] = useState<CuratorView | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [signedOff, setSignedOff] = useState<Record<string, boolean>>({})
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({})

  const titles = useMemo(() => new Map((pages ?? []).map(p => [p.rel, p.title])), [pages])

  // The workspace this panel shows now: a reply for a workspace the person already left is dropped.
  const current = useRef(workspace)
  current.current = workspace

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      const v = await wikiApi<CuratorView>(`/curator?${wsQuery(workspace)}`)
      if (current.current !== workspace) return
      setView(v)
      setError(null)
    } catch (e) {
      if (current.current !== workspace) return
      setError((e as Error).message)
    } finally {
      if (current.current === workspace) setLoaded(true)
    }
  }, [workspace])

  useEffect(() => { setLoaded(false); setView(null); setNote(null); setError(null); void load() }, [load])

  const runNow = async () => {
    setRunning(true)
    setError(null)
    setNote(null)
    try {
      const b = await wikiApi<{ proposed: number; open: number }>(`/curator/run?${wsQuery(workspace)}`, { method: 'POST', json: { workspace } })
      setNote(b.proposed ? `${b.proposed} new suggestion${b.proposed === 1 ? '' : 's'}.` : 'Nothing new to suggest.')
      void load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const decide = async (p: CuratorProposal, action: 'accept' | 'reject') => {
    setBusy(p.id)
    setError(null)
    setNote(null)
    try {
      const body = action === 'accept'
        ? { workspace, ...(p.procedure ? { sign_off: signedOff[p.id] === true } : {}) }
        : { workspace, note: rejectNote[p.id] ?? '' }
      await wikiApi(`/curator/proposals/${encodeURIComponent(p.id)}/${action}?${wsQuery(workspace)}`, { method: 'POST', json: body })
      setNote(action === 'accept' ? `Done: ${p.title}.` : `Got it. "${p.title}" won't be suggested again unless something new comes up.`)
      if (action === 'accept') onChanged()
      void load()
    } catch (e) {
      setError((e as Error).message)
      void load()
    } finally {
      setBusy(null)
    }
  }

  const acceptLight = async () => {
    setBusy('light')
    setError(null)
    setNote(null)
    try {
      const b = await wikiApi<{ accepted: string[]; failed: Array<{ id: string; error: string }> }>(`/curator/accept-light?${wsQuery(workspace)}`, { method: 'POST', json: { workspace } })
      setNote(`Accepted ${b.accepted.length}.${b.failed.length ? ` ${b.failed.length} could not be applied: ${b.failed[0].error}` : ''}`)
      onChanged()
      void load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const setEnabled = async (on: boolean) => {
    setBusy('settings')
    setError(null)
    try {
      await wikiApi<{ settings: WikiSettings }>(`/lint/settings?${wsQuery(workspace)}`, { method: 'PUT', json: { workspace, curator_enabled: on } })
      setNote(on ? 'The curator will look for suggestions after each cleanup.' : 'The curator only runs when someone clicks the button.')
      void load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const pageButton = (rel: string) => (
    <button
      key={rel}
      type="button"
      onClick={() => onOpenNote(rel)}
      className="inline-flex min-h-[44px] items-center rounded-md border border-line-soft bg-surface-2 px-2.5 text-xs text-fg-1 transition-all duration-fast hover:border-line-strong hover:bg-surface-3 hover:text-fg-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:min-h-[28px]"
    >
      {titles.get(rel) ?? labelFromRel(rel)}
    </button>
  )

  if (!loaded) {
    return <div aria-busy="true"><span className="sr-only">Loading suggestions…</span><SkeletonText lines={5} /></div>
  }

  const openList = view?.open ?? []
  const lightCount = openList.filter(p => p.light_touch && !p.procedure).length

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="max-w-[64ch] text-sm leading-relaxed text-fg-2">
          The curator reads knowledge flags, the cleanup report and corrections people typed while work was running,
          then suggests page updates, pages to retire, duplicates to merge and pages to start. Nothing changes until
          you accept it. Changes to a procedure page (a runbook, skill or how-to) need an admin to sign off.
        </p>
        <Button variant="primary" loading={running} disabled={!workspace} onClick={() => { void runNow() }}
          leftIcon={<Sparkles className="h-4 w-4" aria-hidden="true" />} className="shrink-0">
          Look for suggestions now
        </Button>
      </div>

      {error && <Alert tone="alarm" title="Something went wrong">{error}</Alert>}
      {note && !error && <Alert tone="verify" title={note} />}
      {(view?.notes ?? []).map((n, i) => <Alert key={`${i}-${n}`} tone="info">{n}</Alert>)}

      {view?.last_run_at && <p className="text-sm text-fg-3">Last looked {when(view.last_run_at)}.</p>}

      <section aria-labelledby="curator-open" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 id="curator-open" className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-fg-0">
            Waiting for you
            <span className="font-mono text-xs font-normal text-fg-3">{openList.length}</span>
          </h4>
          {lightCount > 1 && (
            <Button size="sm" variant="secondary" loading={busy === 'light'} onClick={() => { void acceptLight() }}>
              Accept all {lightCount} merges and new pages
            </Button>
          )}
        </div>
        {openList.length === 0 ? (
          <EmptyState
            compact
            icon={<Sparkles className="h-5 w-5" aria-hidden="true" />}
            title="No suggestions right now"
            description="Click “Look for suggestions now”, or switch on the schedule below so the curator looks after each cleanup."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-line-soft">
            {openList.map(p => (
              <li key={p.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-start gap-2">
                  <Badge tone={p.kind === 'retire' ? 'amber' : 'accent'}>{KIND_LABEL[p.kind]}</Badge>
                  {p.procedure && <Badge tone="alarm">Procedure: needs sign-off</Badge>}
                  {p.light_touch && <Badge tone="verify">Light touch</Badge>}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-fg-0">{p.title}</p>
                    <p className="text-sm leading-snug text-fg-2">{p.reason}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">{p.pages.filter(r => p.kind !== 'create').map(pageButton)}</div>
                <ul className="flex flex-col gap-1 pl-1">
                  {p.evidence.slice(0, 5).map(e => (
                    <li key={`${e.type}-${e.id}`} className="text-xs leading-snug text-fg-3">
                      <span className="font-medium text-fg-2">{EVIDENCE_LABEL[e.type] ?? e.type}</span>
                      {e.by ? ` from ${e.by}` : ''}{e.objective_id ? ` on card #${e.objective_id}` : ''}: {e.detail}
                    </li>
                  ))}
                </ul>
                {p.proposed_text && (
                  <div>
                    <button type="button" className="text-xs text-accent underline-offset-2 hover:underline"
                      aria-expanded={!!open[p.id]} onClick={() => setOpen(o => ({ ...o, [p.id]: !o[p.id] }))}>
                      {open[p.id] ? 'Hide the page as it would read' : 'Show the page as it would read'}
                    </button>
                    {open[p.id] && (
                      <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-md border border-line-soft bg-surface-2 p-3 text-xs text-fg-1">{p.proposed_text}</pre>
                    )}
                  </div>
                )}
                {p.procedure && (
                  <label className="flex items-start gap-2 text-sm text-fg-1">
                    <input type="checkbox" className="mt-1" checked={!!signedOff[p.id]} disabled={!isAdmin}
                      onChange={e => setSignedOff(s => ({ ...s, [p.id]: e.target.checked }))} />
                    <span>
                      I have read this change to a procedure page and sign off on it.
                      {!isAdmin && <span className="block text-xs text-fg-3">Only an admin can sign off.</span>}
                    </span>
                  </label>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <Button size="sm" variant="primary" loading={busy === p.id}
                    disabled={busy !== null || (p.procedure && (!isAdmin || !signedOff[p.id]))}
                    leftIcon={p.procedure ? <ShieldCheck className="h-4 w-4" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}
                    onClick={() => { void decide(p, 'accept') }}>
                    {p.procedure ? 'Sign off and apply' : 'Accept'}
                  </Button>
                  <Textarea aria-label="Why not (optional)" placeholder="Why not (optional)" rows={1} className="min-w-[12rem] flex-1"
                    value={rejectNote[p.id] ?? ''} onChange={e => setRejectNote(r => ({ ...r, [p.id]: e.target.value }))} />
                  <Button size="sm" variant="secondary" disabled={busy !== null}
                    leftIcon={<X className="h-4 w-4" aria-hidden="true" />} onClick={() => { void decide(p, 'reject') }}>
                    No thanks
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(view?.decided ?? []).length > 0 && (
        <section aria-labelledby="curator-decided" className="flex flex-col gap-1.5">
          <h4 id="curator-decided" className="font-display text-base font-semibold tracking-tight text-fg-0">Recently decided</h4>
          <ul className="flex flex-col gap-1">
            {view!.decided.slice(0, 10).map(p => (
              <li key={p.id} className="text-sm text-fg-2">
                <Badge tone={p.status === 'accepted' ? 'verify' : 'neutral'}>{p.status === 'accepted' ? 'Accepted' : 'Said no'}</Badge>{' '}
                {p.title}{p.decided_by ? ` — ${p.decided_by}` : ''}{p.decided_at ? `, ${when(p.decided_at)}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="curator-schedule" className="flex flex-col gap-2 border-t border-line-soft pt-4">
        <h4 id="curator-schedule" className="font-display text-base font-semibold tracking-tight text-fg-0">Curator schedule</h4>
        <Switch
          checked={!!view?.enabled}
          disabled={!isAdmin}
          busy={busy === 'settings'}
          onChange={on => { void setEnabled(on) }}
          label="Look for suggestions after each cleanup"
        />
        <p className="text-xs text-fg-3">
          {isAdmin
            ? 'Off by default. This applies to every workspace and follows the cleanup schedule. It only ever suggests; nothing is changed without a person.'
            : 'Only an admin can change this.'}
        </p>
      </section>
    </div>
  )
}
