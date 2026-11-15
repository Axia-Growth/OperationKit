import { useState } from 'react'
import { ArrowRight, BookOpen, CalendarDays, LayoutGrid, Mail, type LucideIcon } from 'lucide-react'
import { Badge, Button, cn } from '../ui'
import { StatusDot } from '../design/primitives'
import { renderMarkdown } from '../../lib/markdown'
import {
  COLOUR_CLASSES,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatMessage,
  type EmailDraftPayload,
  type EventDraftPayload,
} from './types'

/* Pieces of ONE bot conversation (obj 719987): avatar, bubbles, the inline
   activity line for each tool call, draft cards with the person's Send button,
   and the live status chip for a board card the bot filed.

   These render persisted history as-is. The obj-900327 rename changed page
   chrome only — nothing here reinterprets or rewrites a stored message, so a
   conversation written before the rename renders identically after it. */

export function AgentAvatar({
  agent,
  size = 'md',
  className,
}: {
  agent: Pick<ChatAgentInfo, 'avatar' | 'colour' | 'name'>
  /** xl = the Bots sidebar's pinned rail (obj 900798). */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const dim =
    size === 'xl'
      ? 'h-[52px] w-[52px] rounded-2xl text-lg'
      : size === 'lg'
        ? 'h-12 w-12 rounded-lg text-lg'
        : size === 'sm'
          ? 'h-7 w-7 rounded-lg text-xs'
          : 'h-9 w-9 rounded-lg text-sm'
  return (
    <span
      aria-hidden="true"
      className={cn('grid shrink-0 place-items-center border font-display font-semibold tracking-normal', dim, COLOUR_CLASSES[agent.colour].tile, className)}
    >
      {agent.avatar}
    </span>
  )
}

function time(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function UserBubble({ m }: { m: ChatMessage }) {
  const images = m.images ?? []
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-line bg-surface-3 px-3.5 py-2.5 text-base leading-relaxed text-fg-0 sm:max-w-[70%]">
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {images.map(img => (
              <a key={img.id} href={img.url} target="_blank" rel="noreferrer" className="block">
                <img src={img.url} alt={img.name} className="max-h-48 rounded-md border border-line-soft" />
              </a>
            ))}
          </div>
        )}
        {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
        <p className="mt-1 text-right text-xs text-fg-2">{time(m.created_at)}</p>
      </div>
    </div>
  )
}

/** A small "Open thread" link to a bot-to-bot conversation (obj 900859). */
export function BotThreadLink({ id, onOpen, className }: { id: number; onOpen: (id: number) => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className={cn('text-xs text-accent-hover underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50', className)}
    >
      Open bot thread #{id}
    </button>
  )
}

export function AssistantBubble({ m, agent, onOpenBotThread }: { m: ChatMessage; agent: ChatAgentInfo; onOpenBotThread?: (id: number) => void }) {
  const by = m.meta?.provider_label ?? m.provider ?? 'unknown'
  // A line the server relayed from a bot-to-bot thread (obj 900859): no model
  // answered it in THIS chat, so say where it came from instead of "Answered by".
  const relayed = m.meta?.kind === 'bot_reply' || m.meta?.kind === 'bot_message_failed'
  const threadId = m.meta?.bot_conversation_id
  return (
    <div className="flex items-start gap-2.5">
      <AgentAvatar agent={agent} size="sm" />
      <div className="min-w-0 max-w-[90%] sm:max-w-[75%]">
        <div className="rounded-lg rounded-tl-sm border border-line-soft bg-surface-1 px-3.5 py-2.5">
          <div className="cc-prose break-words text-base" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
        </div>
        <p className="mt-1 flex flex-wrap items-center gap-x-1.5 px-1 text-xs text-fg-2" data-testid="answered-by">
          {relayed ? (
            <span>From a bot thread</span>
          ) : (
            <>
              <span>Answered by <span className="font-medium text-fg-1">{by}</span></span>
              {m.model && <span className="font-mono text-fg-2">· {m.model}</span>}
            </>
          )}
          <span>· {time(m.created_at)}</span>
          {relayed && threadId && onOpenBotThread && (
            <>
              <span>·</span>
              <BotThreadLink id={threadId} onOpen={onOpenBotThread} />
            </>
          )}
        </p>
      </div>
    </div>
  )
}

export function ErrorLine({ m }: { m: ChatMessage }) {
  return (
    <div role="alert" className="mx-auto max-w-[90%] rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-0">
      <span className="font-medium text-danger">Couldn't answer. </span>
      {m.content}
    </div>
  )
}

const TOOL_ICON: Record<string, LucideIcon> = {
  email: Mail,
  calendar: CalendarDays,
  board: LayoutGrid,
  knowledge: BookOpen,
}

function toolFamily(name: string | null): keyof typeof TOOL_ICON {
  if (!name) return 'knowledge'
  if (name.startsWith('email')) return 'email'
  if (name.startsWith('calendar')) return 'calendar'
  if (name.endsWith('objective') || name.endsWith('objectives')) return 'board'
  return 'knowledge'
}

export function ToolLine({ m }: { m: ChatMessage }) {
  const failed = m.meta?.ok === false
  const Icon = TOOL_ICON[toolFamily(m.tool_name)]
  return (
    <div className={cn('ml-9 flex items-center gap-2 text-xs', failed ? 'text-warning' : 'text-fg-2')}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 break-words">{m.content}</span>
    </div>
  )
}

const DRAFT_DONE: Record<ChatDraft['status'], { label: string; tone: 'verify' | 'neutral' | 'amber' }> = {
  draft: { label: 'Draft — not sent', tone: 'amber' },
  sent: { label: 'Sent by you', tone: 'verify' },
  added: { label: 'Added by you', tone: 'verify' },
  discarded: { label: 'Discarded', tone: 'neutral' },
}

function fmtRange(start: string, end: string): string {
  const s = new Date(start)
  const e = new Date(end)
  if (Number.isNaN(s.getTime())) return start
  const day = s.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day}, ${t(s)}–${Number.isNaN(e.getTime()) ? '' : t(e)}`
}

const fieldCls =
  'w-full rounded-md border border-line bg-surface-0 px-3 py-2 text-base text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30'

export function DraftCard({
  draft,
  onSend,
  onDiscard,
  onSave,
}: {
  draft: ChatDraft
  onSend: (d: ChatDraft) => Promise<void>
  onDiscard: (d: ChatDraft) => Promise<void>
  onSave: (d: ChatDraft, patch: Record<string, string>) => Promise<void>
}) {
  const [busy, setBusy] = useState<'send' | 'discard' | 'save' | null>(null)
  const [editing, setEditing] = useState(false)
  const isEmail = draft.kind === 'email'
  const p = draft.payload
  const [body, setBody] = useState(isEmail ? (p as EmailDraftPayload).body : '')
  const open = draft.status === 'draft'
  const st = DRAFT_DONE[draft.status]

  const run = async (kind: 'send' | 'discard' | 'save', fn: () => Promise<void>) => {
    setBusy(kind)
    try {
      await fn()
      if (kind === 'save') setEditing(false)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section
      aria-label={isEmail ? 'Email draft' : 'Calendar draft'}
      className={cn('ml-9 max-w-[560px] rounded-lg border bg-surface-2 transition-colors duration-base', open ? 'border-line-strong' : 'border-line-soft opacity-80')}
    >
      <header className="flex items-center justify-between gap-2 border-b border-line-soft px-3.5 py-2">
        <span className="text-xs font-semibold uppercase tracking-eyebrow text-fg-1">{isEmail ? 'Email draft' : 'Calendar draft'}</span>
        <Badge tone={st.tone}>{st.label}</Badge>
      </header>
      <div className="space-y-1.5 px-3.5 py-3 text-base">
        {isEmail ? (
          <>
            <p className="text-fg-2">To <span className="text-fg-0">{(p as EmailDraftPayload).to}</span></p>
            <p className="text-fg-2">Subject <span className="font-medium text-fg-0">{(p as EmailDraftPayload).subject}</span></p>
            {editing ? (
              <textarea
                aria-label="Email body"
                className={cn(fieldCls, 'mt-1 min-h-[160px] resize-y leading-relaxed')}
                value={body}
                onChange={e => setBody(e.target.value)}
              />
            ) : (
              <p className="mt-1 whitespace-pre-wrap rounded-md border border-line-soft bg-surface-1 px-3 py-2 leading-relaxed text-fg-0">{(p as EmailDraftPayload).body}</p>
            )}
          </>
        ) : (
          <>
            <p className="font-medium text-fg-0">{(p as EventDraftPayload).title}</p>
            <p className="text-fg-1">{fmtRange((p as EventDraftPayload).start, (p as EventDraftPayload).end)}</p>
            {(p as EventDraftPayload).with.length > 0 && <p className="text-fg-2">With {(p as EventDraftPayload).with.join(', ')}</p>}
            {(p as EventDraftPayload).note && <p className="text-fg-2">{(p as EventDraftPayload).note}</p>}
          </>
        )}
        {draft.connector === 'demo' && <p className="pt-1 text-xs text-fg-2">Demo account — sample data, nothing leaves the server.</p>}
      </div>
      {open && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3.5 py-2.5">
          {editing ? (
            <>
              <Button variant="primary" loading={busy === 'save'} onClick={() => run('save', () => onSave(draft, { body }))}>Save changes</Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => { setEditing(false); setBody((p as EmailDraftPayload).body) }}>Cancel</Button>
            </>
          ) : (
            <>
              <Button variant="primary" loading={busy === 'send'} disabled={!!busy && busy !== 'send'} onClick={() => run('send', () => onSend(draft))}>
                {isEmail ? 'Send' : 'Add to calendar'}
              </Button>
              {isEmail && <Button variant="secondary" disabled={!!busy} onClick={() => setEditing(true)}>Edit</Button>}
              <Button variant="ghost" loading={busy === 'discard'} disabled={!!busy && busy !== 'discard'} onClick={() => run('discard', () => onDiscard(draft))}>Discard</Button>
            </>
          )}
        </footer>
      )}
    </section>
  )
}

// Plain-language card states for business owners (the board's own labels are terse).
const CARD_STATE: Record<ChatCard['status'], string> = {
  planning: 'Being planned',
  queue: 'Waiting to start',
  working: 'In progress',
  ai_review: 'Being checked',
  review: 'Ready for your review',
  done: 'Done',
  cancelled: 'Cancelled',
}

export function CardChip({ card }: { card: ChatCard }) {
  return (
    <a
      href={card.url}
      className="group ml-9 flex max-w-[560px] items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 transition-all duration-fast hover:-translate-y-px hover:border-line-strong hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
    >
      <StatusDot status={card.status} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-base font-medium text-fg-0">
          <span className="font-mono text-fg-2">#{card.id}</span> {card.title}
        </span>
        <span className="block text-xs text-fg-2">On the board · {CARD_STATE[card.status] ?? card.status}</span>
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-fg-1 transition-colors duration-fast group-hover:text-accent-hover">Open<ArrowRight aria-hidden="true" className="h-3.5 w-3.5" /></span>
    </a>
  )
}
