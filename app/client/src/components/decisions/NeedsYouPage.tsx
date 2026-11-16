import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, CornerDownLeft, History, Keyboard, Layers, TriangleAlert } from 'lucide-react'
import {
  DENY_CHOICE,
  NO_BRIEFING_TEXT,
  OWN_ANSWER_CHOICE,
  chosenLabel,
  STACK_SHORTCUTS,
  URGENCY_LABELS,
  hasNoBriefing,
  optionFor,
  stackActionForKey,
  stackAfterAnswer,
  stackMove,
  type DecidedHistoryItem,
  type DecisionOutcome,
  type DecisionQueueItem,
  type DecisionView,
} from '@operationkit/shared'
import { api, ApiError } from '../../lib/api'
import { Badge, Button, EmptyState, Modal, PageContainer, PageHeader, Skeleton, cn } from '../ui'
import { ago } from '../agent-chat/BotLiveStatus'
import { DecisionBriefing, OptionCard, type DecisionDecideResponse } from './DecisionBriefing'
import { CardThreadLink, DecisionLinkList, LinkedText, OwnAnswerForm } from './DecisionLinks'
import { DecisionQA, notifyNeedsYouChanged } from './DecisionQA'

/* The "Needs you" stack (obj 901084).

   One queue of every decision waiting on the person, across bots and cards,
   shown ONE at a time, most urgent first, then oldest. Each card is the PR 815
   briefing laid out to be decided quickly:

     where things stand (context) → the one question → options with pros, cons
     and what happens next → the recommendation → Approve / option / Deny,
     with a Q&A side thread to ask the bot first, and Skip / Back.

   After a choice the one-line result shows, then the next decision slides in.
   A finished card whose job ended by asking shows "Reopen and apply" instead
   of moving on. Everything has a keyboard shortcut (STACK_SHORTCUTS, shared
   with the tests). Token classes only, so light and dark mode match. */

interface QueueItem extends DecisionQueueItem {
  card: DecisionQueueItem['card'] & { bot_name?: string | null }
}

interface QueueResponse {
  items: QueueItem[]
  count: number
  cleared: number
}

interface Result {
  decisionId: number
  outcome: DecisionOutcome | 'stale'
  text: string
  /** A job that ended by asking: offer Reopen and apply instead of moving on. */
  canReopen: boolean
  chosen: string | null
}

/** How long the result line stays before the next decision slides in. */
export const AUTO_ADVANCE_MS = 1800
const POLL_MS = 30_000

function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
}

function Kbd({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return <kbd aria-label={label} className={cn('inline-flex items-center rounded border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-xs text-fg-3', className)}>{children}</kbd>
}

function keyLabel(k: string): ReactNode {
  if (k === 'ArrowRight') return <ArrowRight className="h-3 w-3" aria-label="Right arrow" />
  if (k === 'ArrowLeft') return <ArrowLeft className="h-3 w-3" aria-label="Left arrow" />
  return k
}

export function NeedsYouPage({ autoAdvanceMs = AUTO_ADVANCE_MS, pollMs = POLL_MS }: { autoAdvanceMs?: number; pollMs?: number }) {
  const navigate = useNavigate()
  const [items, setItems] = useState<QueueItem[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [currentId, setCurrentId] = useState<number | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [denyOpen, setDenyOpen] = useState(false)
  const [note, setNote] = useState('')
  const [help, setHelp] = useState(false)
  const [answered, setAnswered] = useState(0)
  const [cleared, setCleared] = useState(0)
  const qaRef = useRef<HTMLInputElement | null>(null)
  const noteRef = useRef<HTMLInputElement | null>(null)
  const answerRef = useRef<HTMLTextAreaElement | null>(null)
  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The ids as they were when the current result was shown (for "what comes next").
  const idsAtAnswer = useRef<number[]>([])

  const load = useCallback(async (): Promise<QueueItem[] | null> => {
    try {
      const r = await api.get<QueueResponse>('/decisions/queue')
      setItems(r.items)
      setLoadError(null)
      if (r.cleared) setCleared(c => c + r.cleared)
      return r.items
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load what needs you')
      return null
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Keep the stack fresh while the person is looking at it (not mid-result).
  useEffect(() => {
    if (result) return
    const t = setInterval(() => void load(), pollMs)
    return () => clearInterval(t)
  }, [load, pollMs, result])

  const ids = useMemo(() => (items ?? []).map(i => i.decision.id), [items])

  // Pin the stack to a real item: first load, or the current one left the queue.
  useEffect(() => {
    if (result) return
    if (!ids.length) {
      if (currentId !== null) setCurrentId(null)
      return
    }
    if (currentId == null || !ids.includes(currentId)) setCurrentId(stackMove(ids, currentId, 'stay'))
  }, [ids, currentId, result])

  useEffect(() => () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
  }, [])

  const current = items?.find(i => i.decision.id === currentId) ?? null
  const position = current ? ids.indexOf(current.decision.id) + 1 : 0

  const resetForMove = () => {
    setDenyOpen(false)
    setNote('')
    setError(null)
  }

  const move = useCallback((dir: 'next' | 'prev') => {
    setCurrentId(id => stackMove(ids, id, dir))
    resetForMove()
  }, [ids])

  /** After a result: reload, then show the decision that was behind the answered one. */
  const advance = useCallback(async () => {
    if (advanceTimer.current) clearTimeout(advanceTimer.current)
    advanceTimer.current = null
    const answeredId = result?.decisionId ?? currentId
    const fresh = (await load()) ?? []
    const nextIds = fresh.map(i => i.decision.id)
    setCurrentId(answeredId == null ? stackMove(nextIds, null, 'stay') : stackAfterAnswer(idsAtAnswer.current, answeredId, nextIds))
    setResult(null)
    resetForMove()
  }, [load, result, currentId])

  const updateDecision = useCallback((d: DecisionView) => {
    setItems(prev => (prev ?? []).map(i => (i.decision.id === d.id ? { ...i, decision: d } : i)))
  }, [])

  const showResult = (r: Result) => {
    idsAtAnswer.current = ids
    setResult(r)
    notifyNeedsYouChanged()
    if (!r.canReopen) {
      if (advanceTimer.current) clearTimeout(advanceTimer.current)
      advanceTimer.current = setTimeout(() => void advanceRef.current(), autoAdvanceMs)
    }
  }
  // The timer must call the latest advance (it closes over `result`).
  const advanceRef = useRef(advance)
  useEffect(() => {
    advanceRef.current = advance
  }, [advance])

  const decide = async (choice: string, opts: { reopen?: boolean; answer?: string } = {}): Promise<boolean> => {
    if (!current || busy) return false
    const d = current.decision
    setBusy(opts.reopen ? 'reopen' : choice)
    setError(null)
    try {
      const r = await api.post<DecisionDecideResponse>(`/decisions/${d.id}/decide`, {
        choice,
        ...(note.trim() && choice === DENY_CHOICE ? { note: note.trim() } : {}),
        ...(opts.answer ? { answer: opts.answer } : {}),
        ...(opts.reopen ? { reopen: true } : {}),
      })
      updateDecision(r.decision)
      if (!opts.reopen) setAnswered(n => n + 1)
      showResult({
        decisionId: d.id,
        outcome: r.outcome ?? 'recorded',
        text: r.outcome_text,
        canReopen: !!r.can_reopen && r.decision.chosen !== DENY_CHOICE,
        chosen: r.decision.chosen,
      })
      return true
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { code?: string; decision?: DecisionView } | null) : null
      if (body?.code === 'decision_stale') {
        if (body.decision) updateDecision(body.decision)
        showResult({ decisionId: d.id, outcome: 'stale', text: (e as Error).message, canReopen: false, chosen: null })
      } else {
        setError(e instanceof Error ? e.message : 'That did not go through')
      }
      return false
    } finally {
      setBusy(null)
    }
  }

  const approveChoice = (d: DecisionView): string | null => {
    if (hasNoBriefing(d) && d.briefing.options.length === 0) return 'approve'
    return optionFor(d.briefing, d.briefing.recommended) ? d.briefing.recommended : null
  }

  const submitDeny = (e: FormEvent) => {
    e.preventDefault()
    void decide(DENY_CHOICE)
  }

  // ── keyboard ────────────────────────────────────────────────────────────
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
    if (isTypingTarget(e.target)) {
      if (e.key === 'Escape') {
        ;(e.target as HTMLElement).blur()
        if (denyOpen) setDenyOpen(false)
      }
      return
    }
    if (e.key === 'Escape') {
      if (help) setHelp(false)
      else if (denyOpen) setDenyOpen(false)
      return
    }
    const hit = stackActionForKey(e.key)
    if (!hit) return
    // A focused button or link answers Enter itself.
    const tag = (e.target as HTMLElement | null)?.tagName
    if (e.key === 'Enter' && (tag === 'BUTTON' || tag === 'A')) return
    if (hit.action === 'help') {
      e.preventDefault()
      setHelp(h => !h)
      return
    }
    if (help || !current) return
    if (result) {
      // Mid-result: any move (or Enter) goes straight on.
      if (hit.action === 'next' || hit.action === 'approve' || hit.action === 'prev') {
        e.preventDefault()
        void advance()
      }
      return
    }
    const d = current.decision
    switch (hit.action) {
      case 'approve': {
        const c = approveChoice(d)
        if (c) {
          e.preventDefault()
          void decide(c)
        }
        return
      }
      case 'option': {
        const opt = d.briefing.options[hit.index ?? -1]
        if (opt) {
          e.preventDefault()
          void decide(opt.key)
        }
        return
      }
      case 'deny':
        e.preventDefault()
        setDenyOpen(true)
        setTimeout(() => noteRef.current?.focus(), 0)
        return
      case 'answer':
        e.preventDefault()
        answerRef.current?.focus()
        return
      case 'next':
      case 'prev':
        e.preventDefault()
        move(hit.action)
        return
      case 'ask':
        e.preventDefault()
        qaRef.current?.focus()
        return
      case 'open':
        e.preventDefault()
        navigate(`/o/${current.card.id}`)
        return
    }
  }
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyHandler.current(e)
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])

  // ── render ──────────────────────────────────────────────────────────────
  const total = ids.length
  const header = (
    <PageHeader
      title="Needs you"
      description="Every decision waiting on you, across bots and cards. One at a time, most urgent first."
      actions={
        <div className="flex items-center gap-2">
          {total > 0 && (
            <span data-testid="stack-position" className="text-sm tabular-nums text-fg-2">
              {position || 1} of {total}
            </span>
          )}
          <Button size="sm" variant="ghost" leftIcon={<Keyboard className="h-3.5 w-3.5" aria-hidden="true" />} onClick={() => setHelp(true)}>
            Shortcuts <Kbd className="ml-1">?</Kbd>
          </Button>
        </div>
      }
    />
  )

  const helpModal = (
    <Modal open={help} onClose={() => setHelp(false)} labelledBy="stack-help-title" size="sm">
      <div className="p-5">
        <h2 id="stack-help-title" className="text-base font-semibold text-fg-0">Keyboard shortcuts</h2>
        <ul className="mt-3 space-y-2" data-testid="stack-shortcuts">
          {STACK_SHORTCUTS.map(s => (
            <li key={s.action} className="flex items-center justify-between gap-4 text-sm text-fg-1">
              <span>{s.label}</span>
              <span className="flex shrink-0 gap-1">
                {(s.action === 'option' ? ['1', '–', '4'] : s.keys).map(k => (k === '–' ? <span key="dash" className="text-fg-3">–</span> : <Kbd key={k}>{keyLabel(k)}</Kbd>))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-fg-3">Shortcuts pause while you type in a box. Esc leaves the box.</p>
        <div className="mt-4 flex justify-end">
          <Button size="sm" variant="secondary" onClick={() => setHelp(false)}>Close</Button>
        </div>
      </div>
    </Modal>
  )

  if (items === null) {
    return (
      <PageContainer>
        {header}
        {loadError ? (
          <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-fg-0">
            {loadError} <button type="button" className="ml-1 text-accent hover:underline" onClick={() => void load()}>Try again</button>
          </p>
        ) : (
          <div className="space-y-3" aria-busy="true" aria-label="Loading what needs you">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {helpModal}
      </PageContainer>
    )
  }

  if (!current) {
    return (
      <PageContainer>
        {header}
        <div className="rounded-lg border border-line bg-surface-1" data-testid="stack-empty">
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-success" aria-hidden="true" />}
            title="Nothing needs you right now"
            description={
              answered > 0
                ? `You answered ${answered} decision${answered === 1 ? '' : 's'}. New asks from bots and cards land here.`
                : 'When a bot or a card needs you to decide something, it lands here, most urgent first.'
            }
          />
          {cleared > 0 && (
            <p className="pb-6 text-center text-xs text-fg-3">{cleared} stale ask{cleared === 1 ? ' was' : 's were'} cleared: the card finished, so no answer was needed.</p>
          )}
        </div>
        <RecentDecisions refreshKey={answered} />
        {helpModal}
      </PageContainer>
    )
  }

  const d = current.decision
  const b = d.briefing
  const noBriefing = hasNoBriefing(d)
  const who = current.card.bot_name || current.card.bot || d.agent_slug || 'the bot'
  const urgency = URGENCY_LABELS[current.urgency]
  const approve = approveChoice(d)
  const recommended = optionFor(b, b.recommended)
  const behind = Math.min(2, total - 1)
  const locked = !!result || !!busy

  return (
    <PageContainer>
      {header}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* The stack: the current decision on top, the rest peeking out behind. */}
        <div className="relative min-w-0" style={{ paddingBottom: `${behind * 6}px` }}>
          {Array.from({ length: behind }).map((_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="absolute inset-x-0 top-0 rounded-lg border border-line bg-surface-1"
              style={{ bottom: `${(behind - i - 1) * 6}px`, transform: `translateY(${(i + 1) * 6}px) scale(${1 - (i + 1) * 0.02})`, opacity: 1 - (i + 1) * 0.3 }}
            />
          ))}
          <article
            key={d.id}
            data-testid="stack-card"
            data-decision-id={d.id}
            aria-label={`Decision ${position} of ${total}: ${b.question || 'no question given'}`}
            className={cn(
              'relative cc-land rounded-lg border bg-surface-1 p-4 text-fg-0 shadow-sm sm:p-5',
              current.urgency === 'blocking' ? 'border-status-human/50' : 'border-line',
            )}
          >
            {/* Where it fits: urgency, card, bot, age */}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={current.urgency === 'blocking' ? 'accent' : 'neutral'} className="gap-1">
                <span className={cn('h-1.5 w-1.5 rounded-full', current.urgency === 'blocking' ? 'bg-status-human' : 'bg-fg-3')} aria-hidden="true" />
                <span title={urgency.why}>{urgency.label}</span>
              </Badge>
              <Link to={`/o/${current.card.id}`} className="min-w-0 truncate text-fg-1 hover:text-accent hover:underline" data-testid="stack-card-link">
                <span className="font-mono">#{current.card.id}</span> {current.card.title}
              </Link>
              <span className="text-fg-3">·</span>
              <span className="text-fg-2">{who}</span>
              {current.card.workspace && (
                <>
                  <span className="text-fg-3">·</span>
                  <span className="text-fg-3">{current.card.workspace}</span>
                </>
              )}
              <span className="ml-auto text-fg-3">asked {ago(d.created_at)}</span>
            </div>
            <p className="mt-1 text-xs text-fg-3">{urgency.why}</p>

            {noBriefing && (
              <div role="note" data-testid="stack-no-briefing" className="mt-3 flex gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg-0">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <div>
                  <p className="font-medium">{NO_BRIEFING_TEXT}</p>
                  {d.raw_note && <p className="mt-1 whitespace-pre-wrap break-words text-fg-1">What {who} said: “<LinkedText text={d.raw_note} />”</p>}
                </div>
              </div>
            )}

            {!noBriefing && d.flags.includes('auto_briefing') && (
              <p data-testid="stack-auto-briefing" className="mt-3 text-xs text-fg-3">
                {who} stopped without a briefing, so this one was written automatically from its {d.flags.includes('auto_briefing_fallback') ? 'note' : 'note and session summary'}.
              </p>
            )}

            {b.context && !(noBriefing && b.context === d.raw_note) && (
              <section className="mt-4" aria-labelledby={`ctx-${d.id}`}>
                <h3 id={`ctx-${d.id}`} className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">Where things stand</h3>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm text-fg-1"><LinkedText text={b.context} /></p>
              </section>
            )}

            <section className="mt-4" aria-labelledby={`q-${d.id}`}>
              <h3 className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">The decision</h3>
              <h2 id={`q-${d.id}`} data-testid="stack-question" className="mt-1 break-words text-lg font-semibold leading-snug text-fg-0">
                {b.question ? <LinkedText text={b.question} /> : 'What is being decided was not stated.'}
              </h2>
            </section>

            {b.options.length > 0 && (
              <ol className="mt-3 space-y-2" aria-label="Options">
                {b.options.map((o, i) => (
                  <OptionCard
                    key={o.key}
                    opt={o}
                    recommended={o.key === b.recommended}
                    chosen={d.chosen === o.key}
                    canChoose={d.state === 'open' && !result}
                    busy={busy === o.key}
                    onChoose={() => void decide(o.key)}
                    shortcut={String(i + 1)}
                  />
                ))}
              </ol>
            )}

            {recommended && b.recommended_why && (
              <p className="mt-3 rounded-md border border-[color:var(--accent-line)] bg-surface-2 px-3 py-2 text-sm text-fg-1" data-testid="stack-recommendation">
                <span className="font-medium text-fg-0">Recommended: {recommended.key}) {recommended.label}. </span>
                <LinkedText text={b.recommended_why} />
              </p>
            )}

            <DecisionLinkList decision={d} />

            {/* The result, then the next one slides in. */}
            {result && result.decisionId === d.id ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="stack-result"
                data-outcome={result.outcome}
                className={cn(
                  'mt-4 rounded-md border px-3 py-2.5 text-sm text-fg-0',
                  result.outcome === 'card_done' || result.outcome === 'failed' || result.outcome === 'stale'
                    ? 'border-warning/40 bg-warning/10'
                    : 'border-success/40 bg-success/10',
                )}
              >
                <p className="break-words"><LinkedText text={result.text} /></p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {result.canReopen && result.chosen && (
                    <Button size="sm" variant="primary" loading={busy === 'reopen'} onClick={() => void decide(result.chosen as string, { reopen: true })}>
                      Reopen and apply
                    </Button>
                  )}
                  <Button size="sm" variant={result.canReopen ? 'ghost' : 'secondary'} onClick={() => void advance()} disabled={busy === 'reopen'}>
                    {result.canReopen ? 'Leave it closed, next' : total > 1 ? 'Next now' : 'Done'} <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                  {!result.canReopen && <span className="text-xs text-fg-3">Moving on in a moment…</span>}
                  <CardThreadLink objectiveId={current.card.id} className="ml-auto" />
                </div>
              </div>
            ) : (
              // obj 901139: pinned to the bottom of the page scroller, so Approve / Deny /
              // own answer stay reachable while a long briefing scrolls under them.
              <div data-testid="stack-actions" className="sticky bottom-0 z-10 -mx-4 mt-4 rounded-b-lg border-t border-line-soft bg-surface-1 px-4 pb-1 pt-3 sm:-mx-5 sm:px-5">
                {denyOpen ? (
                  <form onSubmit={submitDeny} className="flex flex-wrap items-center gap-2" data-testid="stack-deny-form">
                    <label htmlFor={`stack-note-${d.id}`} className="sr-only">Why not (optional)</label>
                    <input
                      id={`stack-note-${d.id}`}
                      ref={noteRef}
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      placeholder="Why not? (optional, goes to the bot)"
                      className="min-w-0 flex-1 rounded-md border border-line bg-surface-field px-2.5 py-1.5 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
                    />
                    <Button type="submit" size="sm" variant="danger" loading={busy === DENY_CHOICE}>Deny</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setDenyOpen(false)}>Cancel</Button>
                  </form>
                ) : (
                  <div className="flex flex-wrap items-center gap-2">
                    {approve && (
                      <Button size="sm" variant="primary" loading={busy === approve} disabled={locked} onClick={() => void decide(approve)}>
                        {approve === 'approve' ? 'Approve as proposed' : `Approve ${approve}`}
                        <CornerDownLeft className="ml-1.5 h-3.5 w-3.5 opacity-70" aria-hidden="true" />
                      </Button>
                    )}
                    <Button size="sm" variant="danger" disabled={locked} onClick={() => { setDenyOpen(true); setTimeout(() => noteRef.current?.focus(), 0) }}>
                      Deny <Kbd className="ml-1.5">D</Kbd>
                    </Button>
                    <span className="ml-auto flex items-center gap-1">
                      <Button size="sm" variant="ghost" aria-label="Previous decision" disabled={total < 2 || locked} onClick={() => move('prev')}>
                        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                      <Button size="sm" variant="ghost" disabled={total < 2 || locked} onClick={() => move('next')}>
                        Skip <ArrowRight className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </span>
                  </div>
                )}
                <OwnAnswerForm
                  className="mt-3"
                  decisionId={d.id}
                  who={who}
                  inputRef={answerRef}
                  busy={busy === OWN_ANSWER_CHOICE}
                  disabled={locked && busy !== OWN_ANSWER_CHOICE}
                  onSubmit={answer => decide(OWN_ANSWER_CHOICE, { answer })}
                />
                {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
              </div>
            )}
          </article>
        </div>

        {/* Q&A side thread: ask the bot before choosing. */}
        <aside
          aria-label={`Ask ${who} about this decision`}
          data-testid="stack-qa"
          className="relative flex min-h-[14rem] flex-col rounded-lg border border-line bg-surface-1 p-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-10rem)]"
        >
          <DecisionQA key={d.id} ref={qaRef} decision={d} onChange={updateDecision} who={who} variant="panel" />
          <p className="mt-2 text-xs text-fg-3">Press <Kbd>Q</Kbd> to ask, <Kbd>Esc</Kbd> to go back to the decision.</p>
        </aside>
      </div>
      {total > 1 && !result && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-fg-3">
          <Layers className="h-3.5 w-3.5" aria-hidden="true" /> {total - 1} more after this one.
        </p>
      )}
      <RecentDecisions refreshKey={answered} />
      {helpModal}
    </PageContainer>
  )
}

interface HistoryItem extends DecidedHistoryItem {
  card: DecidedHistoryItem['card'] & { bot_name?: string | null }
}

/**
 * "Your recent decisions" (obj 901139). Operator approved a decision, found it again
 * under his previous decisions, and it only said "Decided" with no way back to the
 * card. Each row here names the card, links its thread, and opens to the full
 * briefing, the choice (or own answer), the outcome line and every link it
 * mentioned (the PRs of a "merge these PRs" ask).
 */
export function RecentDecisions({ refreshKey = 0, limit = 15 }: { refreshKey?: number; limit?: number }) {
  const [items, setItems] = useState<HistoryItem[] | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    api
      .get<{ items: HistoryItem[] }>(`/decisions/queue/history?limit=${limit}`)
      .then(r => { if (alive) setItems(r.items) })
      .catch(() => { if (alive) setItems([]) })
    return () => { alive = false }
  }, [refreshKey, limit])
  if (!items?.length) return null
  const replace = (d: DecisionView) => setItems(prev => (prev ?? []).map(i => (i.decision.id === d.id ? { ...i, decision: d } : i)))
  return (
    <section className="mt-6" aria-labelledby="recent-decisions-title" data-testid="recent-decisions">
      <h2 id="recent-decisions-title" className="flex items-center gap-1.5 text-sm font-semibold text-fg-0">
        <History className="h-4 w-4 text-fg-3" aria-hidden="true" /> Your recent decisions
      </h2>
      <ul className="mt-2 divide-y divide-line-soft rounded-lg border border-line bg-surface-1">
        {items.map(i => {
          const d = i.decision
          const open = openId === d.id
          const label = d.chosen === OWN_ANSWER_CHOICE ? 'Own answer' : (chosenLabel(d.briefing, d.chosen) ?? 'Decided')
          return (
            <li key={d.id} data-testid="recent-decision" data-decision-id={d.id}>
              <button
                type="button"
                aria-expanded={open}
                aria-controls={`recent-${d.id}`}
                onClick={() => setOpenId(open ? null : d.id)}
                className="flex w-full min-w-0 items-start gap-2 px-3 py-2.5 text-left hover:bg-surface-2"
              >
                {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden="true" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-fg-3" aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm text-fg-0">{d.briefing.question || 'No question given'}</span>
                  <span className="mt-0.5 block truncate text-xs text-fg-2">
                    {label} · <span className="font-mono">#{i.card.id}</span> {i.card.title}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-fg-3">{ago(d.decided_at ?? d.updated_at)}</span>
              </button>
              {open && (
                <div id={`recent-${d.id}`} className="px-3 pb-3">
                  <DecisionBriefing decision={d} onChange={replace} botName={i.card.bot_name ?? i.card.bot ?? undefined} compact />
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
