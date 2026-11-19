import { useState } from 'react'
import { ChatDecision } from '../decisions/ChatDecision'
import { ArrowRight, BookOpen, CalendarDays, Clock, Download, LayoutGrid, Mail, X, type LucideIcon } from 'lucide-react'
import { Badge, Button, Modal, cn } from '../ui'
import { StatusDot } from '../design/primitives'
import { renderMarkdown } from '../../lib/markdown'
import {
  COLOUR_CLASSES,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatImage,
  type ChatMessage,
  type EmailDraftPayload,
  type EventDraftPayload,
} from './types'
import { CardNumber } from '../CardNumber'

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

export function time(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * Thumbnails for a message's attached images (obj 901028), shared by both the
 * person's and the bot's bubbles. Click a thumbnail to open it full size in a
 * lightbox with a download link and its alt text as a caption.
 */
export function ChatImageGallery({ images, className }: { images: ChatImage[]; className?: string }) {
  const [openId, setOpenId] = useState<number | null>(null)
  if (images.length === 0) return null
  const open = images.find(img => img.id === openId) ?? null
  return (
    <>
      <div className={cn('flex flex-wrap gap-1.5', className)}>
        {images.map(img => (
          <button
            key={img.id}
            type="button"
            onClick={() => setOpenId(img.id)}
            className="block overflow-hidden rounded-md border border-line-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            <img src={img.url} alt={img.alt_text || img.name} className="max-h-48 object-contain" />
          </button>
        ))}
      </div>
      <Modal open={open !== null} onClose={() => setOpenId(null)} size="lg" labelledBy="chat-image-lightbox-title">
        {open && (
          <div className="flex flex-col">
            <div className="flex items-center justify-between gap-2 border-b border-line-soft px-4 py-3">
              <span id="chat-image-lightbox-title" className="truncate text-sm font-medium text-fg-1">
                {open.alt_text || open.name}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={open.url}
                  download={open.name}
                  className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-fg-1 hover:bg-surface-2"
                >
                  <Download aria-hidden="true" className="h-3.5 w-3.5" />
                  Download
                </a>
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => setOpenId(null)}
                  className="grid h-8 w-8 place-items-center rounded-md text-fg-2 hover:bg-surface-2 hover:text-fg-1"
                >
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="flex max-h-[75vh] items-center justify-center overflow-auto bg-surface-2 p-3">
              <img src={open.url} alt={open.alt_text || open.name} className="max-h-full max-w-full rounded" />
            </div>
            {open.alt_text && (
              <p className="border-t border-line-soft px-4 py-2 text-xs text-fg-2">{open.alt_text}</p>
            )}
          </div>
        )}
      </Modal>
    </>
  )
}

/**
 * One of the person's messages. `queued` (obj 900949): sent while the bot was
 * working and not delivered to it yet — the bubble is quieter and carries a
 * small "Queued" chip until the bot picks it up. `sending` = not yet stored.
 */
export function UserBubble({ m, queued, sending }: { m: Pick<ChatMessage, 'content' | 'images' | 'created_at'>; queued?: boolean; sending?: boolean }) {
  const images = m.images ?? []
  const waiting = queued || sending
  return (
    <div className="flex flex-col items-end gap-1" data-testid={waiting ? 'queued-bubble' : undefined}>
      <div
        className={cn(
          'max-w-[85%] rounded-lg rounded-br-sm border px-3.5 py-2.5 text-base leading-relaxed sm:max-w-[70%]',
          waiting ? 'border-dashed border-line-strong bg-surface-2 text-fg-1' : 'border-line bg-surface-3 text-fg-0',
        )}
      >
        {images.length > 0 && <ChatImageGallery images={images} className="mb-2" />}
        {m.content && <p className="whitespace-pre-wrap break-words">{m.content}</p>}
        {waiting ? (
          <p className="mt-1 flex justify-end">
            <Badge tone="accent">
              <Clock aria-hidden="true" className="h-3 w-3" />
              {sending ? 'Sending…' : 'Queued'}
            </Badge>
          </p>
        ) : (
          <p className="mt-1 text-right text-xs text-fg-2">{time(m.created_at)}</p>
        )}
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
  const images = m.images ?? []
  return (
    <div className="flex items-start gap-2.5">
      <AgentAvatar agent={agent} size="sm" />
      <div className="min-w-0 max-w-[90%] sm:max-w-[75%]">
        <div className="rounded-lg rounded-tl-sm border border-line-soft bg-surface-1 px-3.5 py-2.5">
          {images.length > 0 && <ChatImageGallery images={images} className="mb-2" />}
          {m.content && <div className="cc-prose break-words text-base" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />}
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
  // obj 900949: the person pressed Stop. That is not a failure, so it reads as
  // a quiet note rather than a red alert.
  if (m.meta?.kind === 'stopped') {
    return (
      <p className="mx-auto max-w-[90%] text-center text-sm text-fg-2" data-testid="stopped-line">
        {m.content || 'Stopped.'}
      </p>
    )
  }
  // obj 901395: the reply was moved to another Claude account. Not a failure:
  // one small, quiet line with the seat labels (never an email or a credential).
  if (m.meta?.kind === 'seat_moved') {
    return (
      <p className="mx-auto max-w-[90%] text-center text-xs text-fg-2" data-testid="seat-moved-line">
        <span aria-hidden="true">↻ </span>
        {m.content}
      </p>
    )
  }
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
  // obj 901028: attach_image's image lands on this TOOL row (not the final
  // assistant text), so this is where it has to render.
  const images = m.images ?? []
  return (
    <div className="ml-9 flex flex-col gap-1.5">
      <div className={cn('flex items-center gap-2 text-xs', failed ? 'text-warning' : 'text-fg-2')}>
        <Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 break-words">{m.content}</span>
      </div>
      {images.length > 0 && <ChatImageGallery images={images} />}
      {/* obj 901059: a raise_decision call renders the briefing itself, with its Q&A thread and Choose/Deny. */}
      {!failed && typeof m.meta?.decision_id === 'number' && <ChatDecision id={m.meta.decision_id} />}
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
        {draft.connector.startsWith('google:') && (
          <p className="pt-1 text-xs text-fg-2">
            {isEmail
              ? `From ${draft.connector.slice('google:'.length)}.${(p as EmailDraftPayload).remote_id ? ' Also saved in your Gmail Drafts.' : ''} Nothing is sent until you press Send.`
              : `For the calendar of ${draft.connector.slice('google:'.length)}. Nothing is added until you press Add to calendar; guests are not emailed.`}
          </p>
        )}
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
  // obj 901080: the whole chip opens the card (a stretched link), and the #number
  // sits above that link so a click on it copies the number instead. The link is
  // in-app (/o/<id>); card.url is the absolute public link bots paste elsewhere.
  return (
    <div
      data-testid="chat-card-chip"
      className="group relative ml-9 flex max-w-[560px] items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3.5 py-2.5 transition-all duration-fast focus-within:ring-2 focus-within:ring-accent/50 hover:-translate-y-px hover:border-line-strong hover:bg-surface-3"
    >
      <StatusDot status={card.status} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5 text-base font-medium text-fg-0">
          <CardNumber id={card.id} className="relative z-10 text-fg-2" />
          <a
            href={`/o/${card.id}`}
            className="min-w-0 truncate after:absolute after:inset-0 after:rounded-lg after:content-[''] focus-visible:outline-none"
          >
            {card.title}
          </a>
        </span>
        <span className="block text-xs text-fg-2">On the board · {CARD_STATE[card.status] ?? card.status}</span>
      </span>
      <span aria-hidden="true" className="inline-flex items-center gap-1 text-xs font-medium text-fg-1 transition-colors duration-fast group-hover:text-accent-hover">Open<ArrowRight className="h-3.5 w-3.5" /></span>
    </div>
  )
}
