import { forwardRef, useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import type { DecisionView } from '@operationkit/shared'
import { api } from '../../lib/api'
import { Button, cn } from '../ui'
import { LinkedText } from './DecisionLinks'

/* The Q&A thread on a decision (obj 901059, shared by the card / chat briefing
   and the Needs you stack, obj 901084): the person asks, the bot that raised the
   decision answers in the same thread. While an answer is pending it polls
   until it lands. Choose / Deny stay available beside it. */

export const DECISION_QA_POLL_MS = 3000

/** Tell the top-nav badge (and any open queue) that a decision changed. */
export const NEEDS_YOU_CHANGED_EVENT = 'cc:needs-you-changed'
export function notifyNeedsYouChanged(): void {
  try {
    window.dispatchEvent(new Event(NEEDS_YOU_CHANGED_EVENT))
  } catch {
    /* non-browser */
  }
}

export const DecisionQA = forwardRef<HTMLInputElement, {
  decision: DecisionView
  onChange: (d: DecisionView) => void
  /** Who answers. */
  who: string
  pollMs?: number
  /** Taller thread for the stack's side panel. */
  variant?: 'inline' | 'panel'
}>(function DecisionQA({ decision, onChange, who, pollMs = DECISION_QA_POLL_MS, variant = 'inline' }, inputRef) {
  const [question, setQuestion] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)

  const pending = decision.thread.some(m => m.role === 'human' && m.status === 'pending')
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ decision: DecisionView }>(`/decisions/${decision.id}`)
      onChange(r.decision)
    } catch {
      /* next tick */
    }
  }, [decision.id, onChange])

  useEffect(() => {
    if (!pending) return
    timer.current = setTimeout(() => void refresh(), pollMs)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [pending, decision, refresh, pollMs])

  // Keep the newest message in view in the side panel.
  useEffect(() => {
    const el = listRef.current
    if (el && variant === 'panel') el.scrollTop = el.scrollHeight
  }, [decision.thread.length, variant])

  const ask = async (e: FormEvent) => {
    e.preventDefault()
    const body = question.trim()
    if (!body) return
    setBusy(true)
    setError(null)
    try {
      const r = await api.post<{ decision: DecisionView }>(`/decisions/${decision.id}/questions`, { body })
      setQuestion('')
      onChange(r.decision)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your question did not go through')
    } finally {
      setBusy(false)
    }
  }

  const panel = variant === 'panel'
  return (
    <div className={cn(panel ? 'flex min-h-0 flex-1 flex-col' : 'mt-3 border-t border-line-soft pt-3')} data-testid="decision-qa">
      <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-eyebrow text-fg-3">
        <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden="true" /> Questions
      </p>
      {decision.thread.length > 0 ? (
        <ul
          ref={listRef}
          className={cn('mt-2 space-y-1.5', panel && 'min-h-0 flex-1 overflow-y-auto pr-1')}
          aria-label="Questions and answers"
          data-testid="decision-thread"
        >
          {decision.thread.map(m => (
            <li
              key={m.id}
              data-role={m.role}
              className={cn(
                'rounded-md px-2.5 py-1.5 text-sm',
                m.role === 'human' ? 'bg-surface-2 text-fg-0' : m.role === 'bot' ? 'border border-line bg-surface-1 text-fg-0' : 'text-fg-2',
              )}
            >
              <span className="font-medium">{m.role === 'human' ? (m.author ?? 'You') : m.role === 'bot' ? (m.author ?? who) : 'Update'}: </span>
              <span className="whitespace-pre-wrap break-words"><LinkedText text={m.body} /></span>
              {m.role === 'human' && m.status === 'pending' && (
                <span className="ml-1 text-xs text-fg-3">({who} is answering…)</span>
              )}
            </li>
          ))}
        </ul>
      ) : panel ? (
        <p className="mt-2 flex-1 text-sm text-fg-3">Not sure? Ask {who} anything about this decision before you choose. Its answer lands here.</p>
      ) : null}
      <form onSubmit={ask} className="mt-2 flex gap-2">
        <label htmlFor={`decision-q-${decision.id}`} className="sr-only">Ask {who} a question about this decision</label>
        <input
          ref={inputRef}
          id={`decision-q-${decision.id}`}
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder={`Ask ${who} a question…`}
          className="min-w-0 flex-1 rounded-md border border-line bg-surface-field px-2.5 py-1.5 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
        />
        <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={!question.trim()}>Ask</Button>
      </form>
      {error && <p role="alert" className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  )
})
