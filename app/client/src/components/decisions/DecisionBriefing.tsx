import { useCallback, useEffect, useState } from 'react'
import { Check, Minus } from 'lucide-react'
import {
  DENY_CHOICE,
  chosenLabel,
  type DecisionOption,
  type DecisionView,
} from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { Badge, Button, cn } from '../ui'
import { DECISION_QA_POLL_MS, DecisionQA, notifyNeedsYouChanged } from './DecisionQA'

/* Decision briefing (obj 901059).

   Operator opened a card a bot wanted a decision on and could not see what the
   decision was; he approved anyway and nothing visibly happened. This renders
   the decision itself, everywhere it is asked (top of the card, the bot chat):

     context → ONE question → 2-4 options with pros / cons / what happens next,
     the recommended one marked → a Q&A thread with the bot that raised it →
     Choose / Deny → a plain one-line OUTCOME that says what was chosen and what
     happens next. A choice on a finished card never no-ops silently: the outcome
     says nothing was sent and offers "Reopen and apply".

   Token classes only (bg-surface-*, text-fg-*, border-line, status colours), so
   it reads the same in light and dark mode. */

export interface DecisionDecideResponse {
  decision: DecisionView
  outcome: DecisionView['outcome']
  outcome_text: string
  can_reopen: boolean
}

const POLL_MS = DECISION_QA_POLL_MS

export function useDecision(id: number | null, initial?: DecisionView | null) {
  const [decision, setDecision] = useState<DecisionView | null>(initial ?? null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    if (id == null) return
    try {
      const r = await api.get<{ decision: DecisionView }>(`/decisions/${id}`)
      setDecision(r.decision)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the decision')
    }
  }, [id])
  useEffect(() => {
    if (!initial) void load()
  }, [load, initial])
  return { decision, setDecision, error, reload: load }
}

export function OptionCard({
  opt,
  recommended,
  chosen,
  canChoose,
  busy,
  onChoose,
  shortcut,
}: {
  opt: DecisionOption
  recommended: boolean
  chosen: boolean
  canChoose: boolean
  busy: boolean
  onChoose: () => void
  /** Keyboard key that chooses this option (the Needs you stack). */
  shortcut?: string
}) {
  return (
    <li
      data-testid="decision-option"
      data-key={opt.key}
      className={cn(
        'rounded-md border bg-surface-1 px-3 py-2.5',
        chosen ? 'border-success/60' : recommended ? 'border-[color:var(--accent-line)]' : 'border-line',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-line bg-surface-2 px-1 font-mono text-xs text-fg-1">{opt.key}</span>
        <span className="font-medium text-fg-0">{opt.label}</span>
        {recommended && <Badge tone="accent">Recommended</Badge>}
        {chosen && <Badge tone="verify">Chosen</Badge>}
      </div>
      <div className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <ul aria-label={`Pros of ${opt.label}`} className="space-y-0.5">
          {opt.pros.map((p, i) => (
            <li key={i} className="flex gap-1.5 text-fg-1">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
              <span><span className="sr-only">Pro: </span>{p}</span>
            </li>
          ))}
        </ul>
        <ul aria-label={`Cons of ${opt.label}`} className="space-y-0.5">
          {opt.cons.map((c, i) => (
            <li key={i} className="flex gap-1.5 text-fg-1">
              <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
              <span><span className="sr-only">Con: </span>{c}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-sm text-fg-2">
        <span className="font-medium text-fg-1">Next: </span>
        {opt.next}
      </p>
      {canChoose && (
        <div className="mt-2">
          <Button size="sm" variant={recommended ? 'primary' : 'secondary'} loading={busy} onClick={onChoose}>
            Choose {opt.key}
          </Button>
          {shortcut && <kbd className="ml-2 rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-fg-3" aria-label={`Shortcut ${shortcut}`}>{shortcut}</kbd>}
        </div>
      )}
    </li>
  )
}

export function DecisionBriefing({
  decision: initial,
  onChange,
  botName,
  compact = false,
  pollMs = POLL_MS,
}: {
  decision: DecisionView
  onChange?: (d: DecisionView) => void
  /** Who answers questions in the thread. */
  botName?: string
  compact?: boolean
  /** How often to check for the bot's answer while a question is pending. */
  pollMs?: number
}) {
  const [decision, setDecision] = useState<DecisionView>(initial)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denyOpen, setDenyOpen] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => setDecision(initial), [initial])

  const update = useCallback(
    (d: DecisionView) => {
      setDecision(d)
      onChange?.(d)
    },
    [onChange],
  )

  const b = decision.briefing
  const open = decision.state === 'open'
  const who = botName ?? decision.agent_slug ?? 'the bot'

  const decide = async (choice: string, opts: { reopen?: boolean } = {}) => {
    setBusy(opts.reopen ? 'reopen' : choice)
    setError(null)
    try {
      const r = await api.post<DecisionDecideResponse>(`/decisions/${decision.id}/decide`, {
        choice,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(opts.reopen ? { reopen: true } : {}),
      })
      update(r.decision)
      setDenyOpen(false)
      notifyNeedsYouChanged()
    } catch (e) {
      // obj 901084: an ask that outlived its card comes back cleared — show that, not a dead button.
      const stale = e instanceof ApiError ? (e.body as { code?: string; decision?: DecisionView } | null) : null
      if (stale?.code === 'decision_stale' && stale.decision) {
        update(stale.decision)
        notifyNeedsYouChanged()
      }
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'That did not go through')
    } finally {
      setBusy(null)
    }
  }

  const eyebrow = open ? 'Decision needed' : decision.state === 'decided' ? 'Decided' : 'Withdrawn'

  return (
    <section
      data-testid="decision-briefing"
      data-state={decision.state}
      aria-label={`Decision: ${b.question || 'no question given'}`}
      className={cn(
        'rounded-lg border bg-surface-1 text-fg-0',
        open ? 'border-status-human/50' : 'border-line',
        compact ? 'p-3' : 'p-4',
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn('h-1.5 w-1.5 rounded-full', open ? 'bg-status-human' : 'bg-fg-3')} aria-hidden="true" />
        <span className={cn('text-xs font-semibold uppercase tracking-eyebrow', open ? 'text-status-human' : 'text-fg-3')}>{eyebrow}</span>
        <span className="text-xs text-fg-3">card #{decision.objective_id}</span>
      </div>

      {decision.incomplete && (
        <p role="note" data-testid="decision-flag" className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          No briefing given — ask {who} below what it needs before you choose.{b.question ? '' : ' It does not say what is being decided.'}
        </p>
      )}

      <h3 className="mt-2 text-base font-semibold text-fg-0">{b.question || 'What is being decided was not stated.'}</h3>
      {b.context && <p className="mt-1 text-sm text-fg-1">{b.context}</p>}

      {b.options.length > 0 && (
        <ol className="mt-3 space-y-2" aria-label="Options">
          {b.options.map(o => (
            <OptionCard
              key={o.key}
              opt={o}
              recommended={o.key === b.recommended}
              chosen={decision.chosen === o.key}
              canChoose={open}
              busy={busy === o.key}
              onChoose={() => void decide(o.key)}
            />
          ))}
        </ol>
      )}
      {b.recommended_why && (
        <p className="mt-2 text-sm text-fg-2">
          <span className="font-medium text-fg-1">Why {b.recommended}: </span>
          {b.recommended_why}
        </p>
      )}

      {/* The result — what was chosen, what happens next. Never a dead click. */}
      {decision.state === 'decided' && (
        <div
          role="status"
          data-testid="decision-outcome"
          data-outcome={decision.outcome ?? ''}
          className={cn(
            'mt-3 rounded-md border px-3 py-2 text-sm',
            decision.outcome === 'card_done' || decision.outcome === 'failed'
              ? 'border-warning/40 bg-warning/10 text-fg-0'
              : 'border-success/40 bg-success/10 text-fg-0',
          )}
        >
          <p className="font-medium">{chosenLabel(b, decision.chosen)}{decision.decided_by ? ` · ${decision.decided_by}` : ''}</p>
          <p className="mt-0.5">{decision.outcome_text ?? 'Recorded.'}</p>
          {decision.outcome === 'card_done' && decision.chosen !== DENY_CHOICE && decision.can_reopen !== false && (
            <div className="mt-2">
              <Button size="sm" variant="primary" loading={busy === 'reopen'} onClick={() => void decide(decision.chosen as string, { reopen: true })}>
                Reopen and apply
              </Button>
            </div>
          )}
        </div>
      )}
      {decision.state === 'withdrawn' && (
        <p role="status" data-testid="decision-withdrawn" className="mt-3 text-sm text-fg-2">
          This decision no longer needs an answer{decision.withdrawn_reason ? `: ${decision.withdrawn_reason.replace(/^superseded/, 'replaced')}` : ''}.
        </p>
      )}

      {/* Q&A thread with the bot that raised it */}
      <DecisionQA decision={decision} onChange={update} who={who} pollMs={pollMs} />

      {/* Approve / deny stays available alongside the thread */}
      {open && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {decision.incomplete && (
            <Button size="sm" variant="primary" loading={busy === 'approve'} onClick={() => void decide('approve')}>Approve as proposed</Button>
          )}
          {!denyOpen ? (
            <Button size="sm" variant="ghost" onClick={() => setDenyOpen(true)}>{decision.incomplete ? 'Deny' : 'None of these (deny)'}</Button>
          ) : (
            <div className="flex w-full flex-wrap items-center gap-2">
              <label htmlFor={`decision-note-${decision.id}`} className="sr-only">Why not (optional)</label>
              <input
                id={`decision-note-${decision.id}`}
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Why not? (optional)"
                className="min-w-0 flex-1 rounded-md border border-line bg-surface-field px-2.5 py-1.5 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
              />
              <Button size="sm" variant="danger" loading={busy === DENY_CHOICE} onClick={() => void decide(DENY_CHOICE)}>Deny</Button>
              <Button size="sm" variant="ghost" onClick={() => setDenyOpen(false)}>Cancel</Button>
            </div>
          )}
        </div>
      )}

      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </section>
  )
}

/**
 * Top-of-card panel: the card's open decision, or its latest decided one (so
 * the outcome stays visible after approve/deny). Renders nothing otherwise.
 */
export function CardDecisionPanel({ objectiveId, botName }: { objectiveId: number; botName?: string }) {
  const [decision, setDecision] = useState<DecisionView | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await api.get<{ decisions: DecisionView[] }>(`/decisions?objective_id=${objectiveId}`)
        if (!alive) return
        const open = r.decisions.find(d => d.state === 'open')
        const latest = r.decisions.find(d => d.state === 'decided')
        setDecision(open ?? latest ?? null)
      } catch {
        if (alive) setDecision(null)
      }
    }
    void load()
    const t = setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [objectiveId])
  if (!decision) return null
  return (
    <div className="border-b border-line bg-surface-2/40" data-testid="card-decision-panel">
      <div className="mx-auto max-w-4xl px-4 py-3">
        <DecisionBriefing decision={decision} onChange={setDecision} botName={botName} />
      </div>
    </div>
  )
}
