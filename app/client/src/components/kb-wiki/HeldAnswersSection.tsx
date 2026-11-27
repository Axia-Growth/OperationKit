import { useCallback, useEffect, useState } from 'react'
import { Archive, Check, ShieldAlert } from 'lucide-react'
import { HELD_ANSWER_KIND_LABEL, type HeldAnswer } from '../../lib/kbWiki'
import { Alert, Badge, Button } from '../ui'
import { wikiApi, wsQuery } from './wikiApi'

/* HeldAnswersSection (obj 901746, public issues #120 / #153) — saved Ask
   answers that cite a page that does not back them up, or whose pages changed
   after they were saved. Each one is kept out of search (so nothing can cite
   it again) until a person here approves it or keeps it out for good. */
export function HeldAnswersSection({
  workspace,
  onOpenNote,
  refreshKey = 0,
}: {
  workspace: string
  onOpenNote: (rel: string) => void
  /** Bump to reload (e.g. after a cleanup run). */
  refreshKey?: number
}) {
  const [answers, setAnswers] = useState<HeldAnswer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!workspace) return
    try {
      const b = await wikiApi<{ answers: HeldAnswer[] }>(`/answers/held?${wsQuery(workspace)}`)
      setAnswers(b.answers)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
      setAnswers([])
    }
  }, [workspace])

  useEffect(() => { setAnswers(null); void load() }, [load, refreshKey])

  const review = async (rel: string, decision: 'approve' | 'keep_out') => {
    setBusy(rel)
    setError(null)
    try {
      await wikiApi(`/answers/review?${wsQuery(workspace)}`, { method: 'POST', json: { workspace, rel, decision } })
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  // Nothing held = nothing to show; the cleanup report already says so.
  if (answers !== null && answers.length === 0 && !error) return null

  return (
    <section aria-labelledby="cleanup-held-answers" className="flex flex-col gap-1.5">
      <h4 id="cleanup-held-answers" className="flex items-center gap-2 font-display text-base font-semibold tracking-tight text-fg-0">
        <ShieldAlert className="h-4 w-4 text-warning" aria-hidden="true" />
        Saved answers to check
        <span className="font-mono text-xs font-normal text-fg-3">{answers === null ? '…' : answers.length}</span>
      </h4>
      <p className="max-w-[64ch] text-xs text-fg-3">
        These answers are kept out of search, so nothing can quote them, until you check them against the pages they cite.
        Approve one to put it back. Keep it out to keep it on file without it ever being searched.
      </p>
      {error && <Alert tone="alarm" title="Could not load saved answers">{error}</Alert>}
      {answers !== null && answers.length > 0 && (
        <ul className="flex flex-col divide-y divide-line-soft">
          {answers.map(a => (
            <li key={a.rel} className="flex flex-col gap-1.5 py-2.5" data-testid="held-answer">
              <div className="flex flex-wrap items-start gap-2">
                <Badge tone={a.kind === 'stale' ? 'amber' : 'alarm'}>{HELD_ANSWER_KIND_LABEL[a.kind ?? 'ungrounded']}</Badge>
                <button
                  type="button"
                  onClick={() => onOpenNote(a.rel)}
                  className="min-w-0 flex-1 text-left text-sm font-medium leading-snug text-fg-0 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {a.title}
                </button>
              </div>
              {a.reason && <p className="text-sm leading-snug text-fg-1">{a.reason}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" loading={busy === a.rel} disabled={busy !== null}
                  onClick={() => { void review(a.rel, 'approve') }} leftIcon={<Check className="h-3.5 w-3.5" aria-hidden="true" />}>
                  Approve
                </Button>
                <Button size="sm" variant="ghost" disabled={busy !== null}
                  onClick={() => { void review(a.rel, 'keep_out') }} leftIcon={<Archive className="h-3.5 w-3.5" aria-hidden="true" />}>
                  Keep out
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
