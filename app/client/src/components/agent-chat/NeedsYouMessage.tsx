import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { BOT_NEEDS_YOU_KIND, NEEDS_YOU_LABELS, NO_BRIEFING_TEXT, isNeedsYouReason, type NeedsYouReason } from '@operationkit/shared'
import { CheckCircle2 } from 'lucide-react'
import { api, ApiError } from '../../lib/api'
import { ChatDecision } from '../decisions/ChatDecision'
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

/** A message refused because the card is already finished (obj 901059): the text that was NOT sent. */
interface Unsent {
  text: string
  okText: string
}

export function isCardDoneRefusal(e: unknown): boolean {
  return e instanceof ApiError && e.status === 409 && (e.body as { code?: string } | null)?.code === 'card_done'
}

/** Set by the server at read time (obj 901084) when the ask is over: the card ended or its decision was cleared. */
export function resolvedOf(m: Pick<ChatMessage, 'meta'>): { text: string; reason: string } | null {
  const r = m.meta?.resolved
  return r && typeof r.text === 'string' ? { text: r.text, reason: String(r.reason ?? '') } : null
}

/**
 * A stale ask collapses to ONE quiet line with no buttons (obj 901084). Operator saw
 * "NEEDS YOU · NEEDS A DECISION" on a finished card, pressed Approve and was told
 * the card was done — a dead button. Now the post says it is over and why.
 */
function ResolvedNeedsYou({ m, agent, text }: { m: ChatMessage; agent: ChatAgentInfo; text: string }) {
  const meta = m.meta!
  const id = meta.objective_id as number
  const reason = meta.reason as NeedsYouReason
  return (
    <div className="flex items-start gap-2.5" data-testid="needs-you-resolved" data-reason={reason}>
      <AgentAvatar agent={agent} size="sm" />
      <div className="flex min-w-0 max-w-[85%] flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-lg rounded-tl-sm border border-line-soft bg-surface-1 px-3.5 py-2 text-sm text-fg-2 sm:max-w-[75%]">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-fg-3" aria-hidden="true" />
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">Was: {NEEDS_YOU_LABELS[reason]}</span>
        <Link to={`/o/${id}`} className="min-w-0 truncate text-fg-1 hover:text-accent hover:underline">
          <span className="font-mono">#{id}</span> {meta.title}
        </Link>
        <span role="status" className="basis-full text-fg-2">{text}</span>
        <span className="ml-auto text-xs text-fg-3">{ago(m.created_at)}</span>
      </div>
    </div>
  )
}

export function NeedsYouMessage({ m, agent }: { m: ChatMessage; agent: ChatAgentInfo }) {
  const resolved = resolvedOf(m)
  if (resolved) return <ResolvedNeedsYou m={m} agent={agent} text={resolved.text} />
  return <LiveNeedsYouMessage m={m} agent={agent} />
}

function LiveNeedsYouMessage({ m, agent }: { m: ChatMessage; agent: ChatAgentInfo }) {
  const meta = m.meta!
  const id = meta.objective_id as number
  const reason = meta.reason as NeedsYouReason
  const [mode, setMode] = useState<Mode>(null)
  const [reply, setReply] = useState('')
  const [ceiling, setCeiling] = useState(() => String(suggestedCeiling(meta.spent_usd ?? 0, meta.ceiling_usd ?? 0)))
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unsent, setUnsent] = useState<Unsent | null>(null)

  const run = async (fn: () => Promise<unknown>, okText: string, sentText?: string) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setDone(okText)
      setMode(null)
    } catch (e) {
      // obj 901059: a finished card is not a dead click — say plainly that nothing
      // was sent, and offer to reopen it and send the same text.
      if (sentText && isCardDoneRefusal(e)) {
        setUnsent({ text: sentText, okText })
        setMode(null)
      } else {
        setError(e instanceof Error ? e.message : 'That did not go through')
      }
    } finally {
      setBusy(false)
    }
  }
  const reopenAndSend = () => {
    if (!unsent) return
    const u = unsent
    void run(async () => {
      await api.patch(`/objectives/${id}/status`, { status: 'working' })
      await api.post(`/objectives/${id}/message`, { message: u.text })
      setUnsent(null)
    }, `Card #${id} reopened and your message sent.`)
  }
  const approve = () => {
    if (reason === 'over_ceiling') {
      setMode('raise')
      return
    }
    const text = approvalMessage(reason, id, meta.action)
    void run(() => api.post(`/objectives/${id}/message`, { message: text }), `Approval sent to card #${id}. It said: "${text}"`, text)
  }
  const submitReply = (e: FormEvent) => {
    e.preventDefault()
    if (!reply.trim()) return
    const text = reply.trim()
    void run(() => api.post(`/objectives/${id}/message`, { message: text }), `Reply sent to card #${id}.`, text)
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
          {reason === 'decision' && typeof meta.decision_id === 'number' ? (
            <ChatDecision id={meta.decision_id} botName={agent.name} />
          ) : done ? (
            <p role="status" className="text-sm font-medium text-success">{done}</p>
          ) : unsent ? (
            <div role="status" data-testid="needs-you-card-done" className="space-y-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg-0">
              <p>Card #{id} is already finished, so this was not sent and nothing changed.</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="primary" loading={busy} onClick={reopenAndSend}>Reopen and send</Button>
                <Button size="sm" variant="ghost" onClick={() => setUnsent(null)} disabled={busy}>Leave it closed</Button>
              </div>
            </div>
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
              {mode === null && reason === 'decision' && (
                <p role="note" data-testid="needs-you-no-briefing" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-fg-0">{NO_BRIEFING_TEXT}</p>
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
