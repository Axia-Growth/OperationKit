import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BOT_NEEDS_YOU_KIND, NEEDS_YOU_LABELS, isNeedsYouReason, type NeedsYouReason } from '@operationkit/shared'
import { api } from '../../lib/api'
import { Button, cn } from '../ui'
import { AgentAvatar } from './ChatItems'
import { ago, usd } from './BotLiveStatus'
import type { ChatAgentInfo, ChatMessage } from './types'

/* A bot's "needs you" post in the main chat (obj 900947), with Approve and
   Reply. Neither button is a new approval path — both call EXISTING routes and
   their existing gates, as the signed-in person:

     Reply                     POST /api/objectives/:id/message  (the card owner / admin;
                                                                  stamped from the cookie)
     Approve (over ceiling)    PUT  /api/objectives/:id/spend    (cookie-only, card owner / admin)
     Approve (anything else)   POST /api/objectives/:id/message  ("Approved…", stamped VERIFIED
                                                                  only because a person typed it)

   A bot cannot press these: an API key is refused by both routes. */

export function isNeedsYouMessage(m: Pick<ChatMessage, 'role' | 'meta'>): boolean {
  return m.role === 'assistant' && m.meta?.kind === BOT_NEEDS_YOU_KIND && typeof m.meta?.objective_id === 'number' && isNeedsYouReason(m.meta?.reason)
}

/** The approval text sent to the card. Plain words; the server stamps who sent it. */
export function approvalMessage(reason: NeedsYouReason, objectiveId: number, action?: string | null): string {
  if (reason === 'approval_beyond_grant') return `Approved: go ahead with the ${(action ?? 'action').replace('_', ' ')} on card #${objectiveId}.`
  if (reason === 'blocker') return `Approved: go ahead and unblock card #${objectiveId} the way you proposed.`
  return `Approved: go ahead with what you proposed on card #${objectiveId}.`
}

/** A suggested new ceiling: 50% headroom over what was spent, rounded up to $5. */
export function suggestedCeiling(spent: number, ceiling: number): number {
  const base = Math.max(spent * 1.5, ceiling * 1.5, ceiling + 5)
  return Math.ceil(base / 5) * 5
}

type Mode = null | 'reply' | 'raise'

export function NeedsYouMessage({ m, agent }: { m: ChatMessage; agent: ChatAgentInfo }) {
  const meta = m.meta!
  const id = meta.objective_id as number
  const reason = meta.reason as NeedsYouReason
  const [mode, setMode] = useState<Mode>(null)
  const [reply, setReply] = useState('')
  const [ceiling, setCeiling] = useState(() => String(suggestedCeiling(meta.spent_usd ?? 0, meta.ceiling_usd ?? 0)))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setDone(okText)
      setMode(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not go through')
    } finally {
      setBusy(false)
    }
  }
  const approve = () => {
    if (reason === 'over_ceiling') {
      setMode('raise')
      return
    }
    void run(() => api.post(`/objectives/${id}/message`, { message: approvalMessage(reason, id, meta.action) }), `Approval sent to card #${id}.`)
  }
  const submitReply = (e: FormEvent) => {
    e.preventDefault()
    if (!reply.trim()) return
    void run(() => api.post(`/objectives/${id}/message`, { message: reply.trim() }), `Reply sent to card #${id}.`)
  }
  const submitRaise = (e: FormEvent) => {
    e.preventDefault()
    const n = Number(ceiling)
    if (!Number.isFinite(n) || n <= 0) {
      setError('Enter a ceiling in dollars')
      return
    }
    void run(() => api.put(`/objectives/${id}/spend`, { cost_usd: n }), `Ceiling on card #${id} raised to ${usd(n)}.`)
  }

  return (
    <div className="flex items-start gap-2.5" data-testid="needs-you-message" data-reason={reason}>
      <AgentAvatar agent={agent} size="sm" />
      <div className="min-w-0 max-w-[85%] flex-1 rounded-lg rounded-tl-sm border border-status-human/40 bg-surface-1 sm:max-w-[75%]">
        <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2">
          <span className="h-1.5 w-1.5 rounded-full bg-status-human" aria-hidden="true" />
          <span className="text-xs font-semibold uppercase tracking-eyebrow text-status-human">Needs you · {NEEDS_YOU_LABELS[reason]}</span>
          <span className="ml-auto text-xs text-fg-3">{ago(m.created_at)}</span>
        </div>
        <div className="space-y-3 px-3.5 py-3">
          <p className="whitespace-pre-wrap break-words text-base text-fg-0">{m.content}</p>
          <Link to={`/o/${id}`} className="inline-block text-sm text-accent hover:underline">
            <span className="font-mono">#{id}</span> {meta.title}
          </Link>
          {done ? (
            <p role="status" className="text-sm font-medium text-success">{done}</p>
          ) : (
            <>
              {mode === 'reply' && (
                <form onSubmit={submitReply} className="space-y-2">
                  <label htmlFor={`reply-${m.id}`} className="sr-only">Reply to {agent.name} on card #{id}</label>
                  <textarea
                    id={`reply-${m.id}`}
                    autoFocus
                    rows={2}
                    value={reply}
                    onChange={e => setReply(e.target.value)}
                    placeholder={`Reply on card #${id}…`}
                    className="w-full resize-none rounded-md border border-line bg-surface-field px-3 py-2 text-base text-fg-0 placeholder:text-fg-3 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
                  />
                  <div className="flex gap-2">
                    <Button type="submit" size="sm" variant="primary" loading={busy} disabled={!reply.trim()}>Send reply</Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
                  </div>
                </form>
              )}
              {mode === 'raise' && (
                <form onSubmit={submitRaise} className="flex flex-wrap items-end gap-2">
                  <label className="text-sm text-fg-1">
                    New ceiling ($)
                    <input
                      type="number"
                      min={1}
                      step={1}
                      autoFocus
                      value={ceiling}
                      onChange={e => setCeiling(e.target.value)}
                      className="mt-1 block w-28 rounded-md border border-line bg-surface-field px-2.5 py-1.5 text-base tabular-nums text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-sm"
                    />
                  </label>
                  <Button type="submit" size="sm" variant="primary" loading={busy}>Raise ceiling</Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button>
                </form>
              )}
              {mode === null && (
                <div className={cn('flex flex-wrap gap-2')}>
                  <Button size="sm" variant="primary" onClick={approve} loading={busy && mode === null}>Approve</Button>
                  <Button size="sm" variant="secondary" onClick={() => setMode('reply')} disabled={busy}>Reply</Button>
                </div>
              )}
            </>
          )}
          {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      </div>
    </div>
  )
}
