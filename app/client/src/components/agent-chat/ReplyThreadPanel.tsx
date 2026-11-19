import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { Paperclip, Square, X } from 'lucide-react'
import { api, isRequestTimeout } from '../../lib/api'
import { actionErrorMessage } from '../../lib/format'
import { composerEnterKeyHint, enterSends } from '../../lib/composerKeys'
import { useFileDrop, filesFromClipboard } from '../../hooks/useFileDrop'
import { Alert, Button, IconButton, cn } from '../ui'
import { ThinkingIndicator } from '../design/primitives'
import { AgentAvatar, UserBubble } from './ChatItems'
import { collectImages, humanSize, toWireImages, type PendingImage } from './attachments'
import { fetchMessages, messagesKey, useCached, writeCache } from './chat-cache'
import { mergeThread, newClientMsgId } from './thread-merge'
import { ACCEPTED_IMAGE_TYPES, type ChatAgentInfo, type ChatMessage, type LaneTurn, type ThreadResponse } from './types'

/* Reply in thread (obj 901373).

   A thread hangs off ONE message of a bot chat. This panel shows that parent
   message, the replies under it, and its own composer. What you send here goes
   to the bot with the parent and the thread's earlier replies as context, and
   the bot answers HERE — the conversation the parent sits in is not written to.

   Server-side a reply thread is a side-thread lane (thread_id), so reading,
   sending, queueing while the bot works, Stop and attachments use the same
   routes as the conversation, with this thread's id. */

/** While the bot works through this thread with no request of ours open, re-read it this often. */
const THREAD_POLL_MS = 2000
/** Tallest the thread composer grows before it scrolls inside. */
const COMPOSER_MAX_PX = 160

const toBubbleImages = (images: PendingImage[]) => images.map((i, n) => ({ id: -1 - n, name: i.name, media_type: i.media_type, size: i.size, url: i.dataUrl }))

export function ReplyThreadPanel({
  agent,
  threadId,
  parent,
  renderMessage,
  onClose,
  onChanged,
  onActivity,
  className,
}: {
  agent: ChatAgentInfo
  /** The reply thread's lane id. */
  threadId: number
  /** The message this thread hangs off, as the conversation shows it. */
  parent: ChatMessage
  /** Renders one stored message exactly as the conversation does (bubbles, drafts, cards). */
  renderMessage: (m: ChatMessage, thread: ThreadResponse | null, cacheKey: string) => ReactNode
  onClose: () => void
  /** A reply was sent or answered — the conversation refreshes its "N replies". */
  onChanged?: () => void
  /** A message landed or loaded here — the sidebar marks the bot read. */
  onActivity?: () => void
  className?: string
}) {
  const slug = agent.slug
  const base = `/agent-chat/agents/${encodeURIComponent(slug)}`
  const key = messagesKey(slug, threadId)
  const messages = useCached<ThreadResponse>(key, () => fetchMessages(slug, threadId), 'Could not load this thread')
  const thread = messages.data ?? null
  const load = messages.reload

  const [text, setText] = useState('')
  const [images, setImages] = useState<PendingImage[]>([])
  const [pending, setPending] = useState<{ id: string; text: string; images: PendingImage[] } | null>(null)
  const [outbox, setOutbox] = useState<{ key: number; id: string; text: string; images: PendingImage[] }[]>([])
  const outboxSeq = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const filePicker = useRef<HTMLInputElement>(null)

  // A different thread starts with an empty box, and the box takes focus so the
  // person can type the reply straight away.
  useEffect(() => {
    setText('')
    setImages([])
    setSendError(null)
    input.current?.focus()
  }, [key])

  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_PX ? 'auto' : 'hidden'
  }, [text])

  const working = !!pending || !!thread?.turn?.running
  const delivered = useMemo(() => (thread?.messages ?? []).filter(m => !m.meta?.queued), [thread?.messages])
  const queuedRows = useMemo(() => (thread?.messages ?? []).filter(m => m.meta?.queued), [thread?.messages])
  const storedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of thread?.messages ?? []) if (m.meta?.client_msg_id) ids.add(m.meta.client_msg_id)
    return ids
  }, [thread?.messages])
  const pendingBubble = pending && !storedIds.has(pending.id) ? pending : null
  const outboxBubbles = useMemo(() => outbox.filter(o => !storedIds.has(o.id)), [outbox, storedIds])
  const replyCount = delivered.filter(m => m.role === 'user' || m.role === 'assistant').length

  const changed = useRef(onChanged)
  changed.current = onChanged
  const serverBusy = !pending && (!!thread?.turn?.running || queuedRows.length > 0)
  useEffect(() => {
    if (!serverBusy) return
    const t = setInterval(() => void load(), THREAD_POLL_MS)
    return () => {
      clearInterval(t)
      // The bot finished on its own: the parent's reply count moved.
      changed.current?.()
    }
  }, [serverBusy, load])

  // Open at the newest reply; follow new ones as they land.
  const scrolledFor = useRef<string | null>(null)
  const hasThread = !!thread
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !hasThread) return
    if (scrolledFor.current !== key) {
      scrolledFor.current = key
      el.scrollTop = el.scrollHeight
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [key, hasThread, thread?.messages.length, pendingBubble, outboxBubbles.length])

  // What is on screen has been read (the same rule the conversation follows).
  const newestId = thread?.messages.length ? thread.messages[thread.messages.length - 1].id : 0
  const activity = useRef(onActivity)
  activity.current = onActivity
  useEffect(() => {
    if (newestId) activity.current?.()
  }, [newestId])

  const addFiles = useCallback(async (files: ArrayLike<File>) => {
    const r = await collectImages(files, images.length)
    if (r.images.length) setImages(cur => [...cur, ...r.images].slice(0, 4))
    setSendError(r.error)
  }, [images.length])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(e)
    if (!files) return
    if (!Array.from(files).some(f => (f.type || '').startsWith('image/'))) return
    e.preventDefault()
    void addFiles(files)
  }

  const { isDragging, dropProps } = useFileDrop(f => void addFiles(f), true)

  // One draft is sent once (a double Enter carries the very same draft).
  const sentDraft = useRef<{ text: string; images: PendingImage[] } | null>(null)
  useEffect(() => { sentDraft.current = null }, [text, images, key])

  const send = async (raw: string, attached: PendingImage[] = images) => {
    const msg = raw.trim()
    if (!msg && attached.length === 0) return
    if (sentDraft.current && sentDraft.current.text === raw && sentDraft.current.images === attached) return
    sentDraft.current = { text: raw, images: attached }
    const id = newClientMsgId()
    // Send never waits on the bot: while it works the server queues the message.
    const queueIt = working
    const outKey = ++outboxSeq.current
    if (queueIt) setOutbox(cur => [...cur, { key: outKey, id, text: msg, images: attached }])
    else setPending({ id, text: msg, images: attached })
    setText('')
    setImages([])
    setSendError(null)
    input.current?.focus()
    try {
      const r = await api.post<ThreadResponse>(
        `${base}/messages`,
        { text: msg, client_msg_id: id, thread_id: threadId, ...(attached.length ? { images: toWireImages(attached) } : {}) },
        { timeoutMs: 240_000 },
      )
      writeCache<ThreadResponse>(key, t => mergeThread(t ?? null, r))
      onChanged?.()
    } catch (e) {
      // The UI timeout is not "not sent": the server keeps working and the answer lands here.
      if (isRequestTimeout(e)) {
        void load()
        onChanged?.()
        return
      }
      setText(cur => (cur.trim() ? cur : msg))
      setImages(cur => (cur.length ? cur : attached))
      setSendError(actionErrorMessage(e, 'Reply not sent'))
      sentDraft.current = null
    } finally {
      if (queueIt) setOutbox(cur => cur.filter(o => o.key !== outKey))
      else setPending(null)
    }
  }

  const stop = async () => {
    setStopping(true)
    setSendError(null)
    try {
      const r = await api.post<{ stopped: boolean; dropped: number; turn: LaneTurn }>(`${base}/stop`, { thread_id: threadId })
      writeCache<ThreadResponse>(key, t => (t ? { ...t, turn: r.turn } : t as unknown as ThreadResponse))
      if (!pending) void load()
    } catch (e) {
      setSendError(actionErrorMessage(e, 'Could not stop the reply'))
    } finally {
      setStopping(false)
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Same rule as every chat box (obj 901376): Enter sends on desktop, Return is a new line on a phone.
    if (enterSends(e)) {
      e.preventDefault()
      void send(text)
    } else if (e.key === 'Escape' && !text && images.length === 0) {
      e.preventDefault()
      onClose()
    }
  }

  const parentBy = parent.role === 'user' ? 'your message' : `${agent.name}'s message`

  return (
    <aside
      aria-label={`Thread on ${parentBy}`}
      data-testid="reply-thread-panel"
      className={cn('flex min-h-0 min-w-0 flex-col bg-surface-0', className)}
    >
      <header className="flex items-center gap-2 border-b border-line bg-surface-1 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base font-semibold tracking-tight text-fg-0">Thread</h3>
          <p className="truncate text-xs text-fg-2">Replying to {parentBy} · {agent.name} answers here</p>
        </div>
        <IconButton label="Close thread" onClick={onClose}>
          <X aria-hidden="true" className="h-5 w-5" />
        </IconButton>
      </header>

      <div ref={scroller} data-testid="reply-thread-messages" className="relative min-h-0 flex-1 overflow-y-auto overflow-x-clip px-3 py-3" aria-live="polite">
        <div className="flex flex-col gap-3">
          <div data-testid="reply-thread-parent">{renderMessage(parent, null, key)}</div>
          <div className="flex items-center gap-2 text-xs text-fg-2" data-testid="reply-thread-count">
            <span className="shrink-0">{replyCount === 0 ? 'No replies yet' : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}</span>
            <span aria-hidden="true" className="h-px flex-1 bg-line-soft" />
          </div>
          {messages.error && <Alert tone="alarm">{messages.error}</Alert>}
          {delivered.map(m => (
            <div key={m.id} className="flex flex-col gap-1" data-testid="reply-thread-reply">{renderMessage(m, thread, key)}</div>
          ))}
          {pendingBubble && <UserBubble m={{ content: pendingBubble.text, created_at: new Date().toISOString(), images: toBubbleImages(pendingBubble.images) }} />}
          {working && (
            <div className="flex items-center gap-2.5" data-testid="reply-thread-working">
              <AgentAvatar agent={agent} size="sm" />
              <ThinkingIndicator label={`${agent.name} is working…`} tone="fg-2" />
            </div>
          )}
          {queuedRows.map(m => <UserBubble key={m.id} m={m} queued />)}
          {outboxBubbles.map(o => <UserBubble key={`out-${o.key}`} sending m={{ content: o.text, created_at: '', images: toBubbleImages(o.images) }} />)}
        </div>
      </div>

      <form
        className={cn(
          'border-t border-line bg-surface-1 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 transition-colors duration-fast',
          isDragging && 'bg-accent/5 ring-1 ring-inset ring-accent/40',
        )}
        onSubmit={e => { e.preventDefault(); void send(text) }}
        {...dropProps}
      >
        {sendError && <p role="alert" className="mb-2 text-sm text-danger">{sendError}</p>}
        {isDragging && <p className="mb-2 text-sm text-accent">Drop the image to attach it</p>}
        {images.length > 0 && (
          <ul aria-label="Images attached to this reply" className="mb-2 flex flex-wrap gap-2">
            {images.map(i => (
              <li key={i.key} className="relative">
                <img src={i.dataUrl} alt={i.name} title={`${i.name} · ${humanSize(i.size)}`} className="h-14 w-14 rounded-md border border-line object-cover" />
                <button
                  type="button"
                  aria-label={`Remove ${i.name}`}
                  onClick={() => setImages(cur => cur.filter(x => x.key !== i.key))}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-surface-0 text-xs leading-none text-fg-1 transition-colors duration-fast hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-end gap-2">
          <input
            ref={filePicker}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(',')}
            multiple
            className="hidden"
            data-testid="reply-thread-file-input"
            onChange={e => {
              const files = e.target.files
              if (files && files.length) void addFiles(files)
              e.target.value = ''
            }}
          />
          <IconButton type="button" label="Attach an image to this reply" onClick={() => filePicker.current?.click()}>
            <Paperclip aria-hidden="true" className="h-5 w-5" />
          </IconButton>
          <label htmlFor="reply-thread-input" className="sr-only">Reply in this thread</label>
          <textarea
            id="reply-thread-input"
            ref={input}
            rows={1}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKey}
            enterKeyHint={composerEnterKeyHint()}
            onPaste={onPaste}
            placeholder="Reply in thread…"
            className="max-h-40 min-h-[44px] min-w-0 flex-1 resize-none rounded-lg border border-line bg-surface-0 px-3 py-2.5 text-lg text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 sm:text-base"
          />
          {working && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void stop()}
              loading={stopping}
              aria-label={`Stop ${agent.name}'s reply in this thread`}
              leftIcon={<Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />}
              className="min-h-[44px] sm:min-h-[44px]"
            >
              Stop
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!text.trim() && images.length === 0} aria-label="Send reply" className="min-h-[44px] sm:min-h-[44px]">
            Reply
          </Button>
        </div>
        <p className="mt-1.5 hidden text-xs text-fg-2 sm:block">Enter to send · Shift+Enter for a new line · paste, drop or attach a screenshot</p>
      </form>
    </aside>
  )
}
