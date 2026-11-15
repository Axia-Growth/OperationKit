import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, ArrowLeftRight, ArrowRight } from 'lucide-react'
import { api } from '../../lib/api'
import { renderMarkdown } from '../../lib/markdown'
import { Alert, Badge, Button, SkeletonText, cn } from '../ui'
import { AgentAvatar } from './ChatItems'
import type { BotConversation, BotConversationEntry, BotConversationResponse, BotConversationsResponse, ChatAgentInfo } from './types'

/* Bot messages (obj 900859): the threads this bot has with OTHER bots.

   A bot can message another bot (the message_bot tool). The other bot is woken
   with the message and its answer comes back as the reply on the same thread.
   This panel is where a person reads those threads: the list of this bot's
   conversations, then one thread with every message, reply, the tools the other
   bot used while answering, and the delivery status of each message.

   READ-ONLY on purpose: bots write these threads; a person reads them (and
   talks to a bot in its own chat). It opens beside the conversation like the
   "i" and Settings panels, so the Bots sidebar (obj 900798) is untouched.
   The server only returns threads in workspaces the person belongs to (an
   admin: every workspace). */

const POLL_MS = 5000

type Names = Map<string, Pick<ChatAgentInfo, 'name' | 'avatar' | 'colour'>>

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function botOf(names: Names, slug: string): Pick<ChatAgentInfo, 'name' | 'avatar' | 'colour'> {
  return names.get(slug) ?? { name: slug, avatar: '', colour: 'blue' as ChatAgentInfo['colour'] }
}

/** What a message's delivery status means to a person. */
function deliveryBadge(e: BotConversationEntry) {
  if (e.kind !== 'message') return null
  if (e.status === 'delivered') return <Badge tone="verify">Answered</Badge>
  if (e.status === 'failed') return <Badge tone="alarm">Not delivered</Badge>
  if (e.status === 'delivering') return <Badge tone="info">Working on it</Badge>
  return <Badge tone="amber">{e.attempts > 0 ? `Waiting · retry ${e.attempts + 1}` : 'Waiting'}</Badge>
}

function Entry({ e, names, self }: { e: BotConversationEntry; names: Names; self: string }) {
  const from = botOf(names, e.from_slug)
  if (e.kind === 'tool') {
    return (
      <p className={cn('ml-9 text-xs', e.ok === false ? 'text-warning' : 'text-fg-2')} data-testid="bot-thread-tool">
        {from.name} used <span className="font-mono">{e.tool_name}</span>: {e.body}
      </p>
    )
  }
  if (e.kind === 'error' || e.kind === 'notice') {
    return (
      <p role={e.kind === 'error' ? 'alert' : undefined} className="mx-auto max-w-[90%] rounded-md border border-warning/30 bg-warning/10 px-3 py-1.5 text-sm text-fg-1">
        {e.body}
      </p>
    )
  }
  const mine = e.from_slug === self
  return (
    <div className={cn('flex items-start gap-2.5', mine && 'flex-row-reverse')} data-testid="bot-thread-entry">
      <AgentAvatar agent={from} size="sm" />
      <div className={cn('min-w-0 max-w-[85%]', mine && 'text-right')}>
        <p className="mb-0.5 flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-fg-2">
          <span className="font-medium text-fg-1">{from.name}</span>
          <span className="inline-flex items-center gap-1">{e.kind === 'reply' ? 'replied' : <><ArrowRight aria-hidden="true" className="h-3 w-3" /><span className="sr-only">to </span>{botOf(names, e.to_slug ?? '').name}</>}</span>
          <span>· {when(e.created_at)}</span>
          {e.sent_for && e.kind === 'message' && <span>· for {e.sent_for}</span>}
          {deliveryBadge(e)}
        </p>
        <div className={cn('rounded-lg border px-3.5 py-2.5 text-left', mine ? 'rounded-tr-sm border-line bg-surface-3' : 'rounded-tl-sm border-line-soft bg-surface-1')}>
          <div className="cc-prose break-words text-base" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.body) }} />
        </div>
        {e.kind === 'message' && e.status === 'failed' && e.last_error && <p className="mt-1 px-1 text-xs text-danger">{e.last_error}</p>}
      </div>
    </div>
  )
}

export function BotMessagesPanel({
  id,
  agent,
  agents,
  conversationId,
  onPick,
  onClose,
}: {
  id?: string
  agent: ChatAgentInfo
  /** Every bot the page knows, for names and avatars. */
  agents: ChatAgentInfo[]
  /** null = the list; a number = that thread. */
  conversationId: number | null
  onPick: (id: number | null) => void
  onClose: () => void
}) {
  const names: Names = new Map(agents.map(a => [a.slug, a]))
  const [list, setList] = useState<BotConversation[] | null>(null)
  const [thread, setThread] = useState<BotConversationResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(async () => {
    try {
      const r = await api.get<BotConversationsResponse>(`/agent-chat/bot-conversations?bot=${encodeURIComponent(agent.slug)}`)
      setList(Array.isArray(r?.conversations) ? r.conversations : [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load bot messages')
    }
  }, [agent.slug])

  const loadThread = useCallback(async (cid: number) => {
    try {
      setThread(await api.get<BotConversationResponse>(`/agent-chat/bot-conversations/${cid}`))
      setError(null)
    } catch (e) {
      setThread(null)
      setError(e instanceof Error ? e.message : 'Could not open this thread')
    }
  }, [])

  useEffect(() => {
    setError(null)
    if (conversationId === null) {
      setThread(null)
      void loadList()
    } else {
      void loadThread(conversationId)
    }
  }, [conversationId, loadList, loadThread])

  // A message still waiting for its reply: keep reading until it lands.
  const waiting = conversationId !== null
    ? !!thread?.messages.some(m => m.kind === 'message' && (m.status === 'pending' || m.status === 'delivering'))
    : !!list?.some(c => (c.pending ?? 0) > 0)
  useEffect(() => {
    if (!waiting) return
    const t = setInterval(() => void (conversationId === null ? loadList() : loadThread(conversationId)), POLL_MS)
    return () => clearInterval(t)
  }, [waiting, conversationId, loadList, loadThread])

  const c = thread?.conversation
  const other = c ? (c.initiator_slug === agent.slug ? c.recipient_slug : c.initiator_slug) : null

  return (
    <section id={id} aria-label={`Bot messages for ${agent.name}`} className="max-h-[60vh] overflow-y-auto border-b border-line bg-surface-1 px-3 py-4 sm:px-6">
      <div className="mx-auto max-w-[760px] space-y-3">
        <div className="flex items-start gap-2">
          {conversationId !== null && (
            <Button variant="ghost" size="sm" onClick={() => onPick(null)} aria-label="Back to all bot messages">
              <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
              All
            </Button>
          )}
          <div className="min-w-0 flex-1">
            <h3 className="font-display text-lg font-semibold text-fg-0">
              {c && other ? (
                <span className="inline-flex items-center gap-1.5">
                  {agent.name}
                  <ArrowLeftRight aria-hidden="true" className="h-4 w-4 text-fg-3" /><span className="sr-only">and</span>
                  {botOf(names, other).name}
                </span>
              ) : 'Bot messages'}
            </h3>
            <p className="text-sm text-fg-2">
              {c
                ? `Bot conversation #${c.id} · ${c.workspace}${c.subject ? ` · ${c.subject}` : ''}`
                : `Threads between ${agent.name} and other bots. A bot messages another bot; the other bot answers on the same thread. Read-only.`}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close bot messages">
            Close
          </Button>
        </div>

        {error && <Alert tone="alarm">{error}</Alert>}

        {conversationId === null && !list && !error && <SkeletonText lines={3} />}
        {conversationId === null && list && list.length === 0 && (
          <p className="text-sm text-fg-2">
            No bot messages yet. When {agent.name} messages another bot (or another bot messages {agent.name}), the thread shows up here.
          </p>
        )}
        {conversationId === null && list && list.length > 0 && (
          <ul className="divide-y divide-line-soft rounded-lg border border-line" aria-label="Bot conversations">
            {list.map(x => {
              const o = x.initiator_slug === agent.slug ? x.recipient_slug : x.initiator_slug
              const ob = botOf(names, o)
              return (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => onPick(x.id)}
                    className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors duration-fast hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    <AgentAvatar agent={ob} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-1.5 text-sm">
                        <span className="font-medium text-fg-0">{x.initiator_slug === agent.slug ? `To ${ob.name}` : `From ${ob.name}`}</span>
                        <span className="text-xs text-fg-2">#{x.id} · {x.workspace} · {when(x.last_message_at ?? x.created_at)}</span>
                        {(x.pending ?? 0) > 0 && <Badge tone="amber">Waiting</Badge>}
                        {(x.failed ?? 0) > 0 && <Badge tone="alarm">Not delivered</Badge>}
                      </span>
                      <span className="block truncate text-sm text-fg-2">{x.last_preview ?? x.subject}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {conversationId !== null && !thread && !error && <SkeletonText lines={4} />}
        {thread && (
          <div className="flex flex-col gap-3" aria-label="Bot thread" aria-live="polite">
            {thread.messages.map(e => (
              <Entry key={e.id} e={e} names={names} self={agent.slug} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
