import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ChevronLeft, Info, MessageSquareReply, Paperclip, Pin, Square, X } from 'lucide-react'
import { api, isRequestTimeout } from '../../lib/api'
import { actionErrorMessage } from '../../lib/format'
import { useAuth } from '../../context/AuthContext'
import { useFileDrop, filesFromClipboard } from '../../hooks/useFileDrop'
import { useMediaQuery } from '../../hooks/useMediaQuery'
import { Alert, Button, EmptyState, IconButton, Skeleton, SkeletonText, cn, useConfirm } from '../ui'
import { ThinkingIndicator } from '../design/primitives'
import { Tabs } from '../ui/Tabs'
import { AgentAvatar, AssistantBubble, BotThreadLink, CardChip, DraftCard, ErrorLine, ToolLine, UserBubble, time } from './ChatItems'
import { ReplyThreadPanel } from './ReplyThreadPanel'
import { mergeThread, newClientMsgId } from './thread-merge'
import { FullAccessBadge } from './FullAccessBadge'
import { BotMessagesPanel } from './BotMessagesPanel'
import { AgentInfoPanel } from './AgentInfoPanel'
import { collectImages, humanSize, toWireImages, type PendingImage } from './attachments'
import { BotSettingsPanel } from './BotSettingsPanel'
import { BotSidebar, NewBotDialog } from './BotSidebar'
import { useBotSidebar } from './useBotSidebar'
import { useBotStatus } from './useBotStatus'
import { BotWorkTab } from './BotWorkTab'
import { BotActivityFeed } from './BotActivityFeed'
import { NeedsYouMessage, isNeedsYouMessage } from './NeedsYouMessage'
import { foldFeedMessages } from './chat-feed-model'
import { BotLiveLine } from './BotLiveStatus'
import type { BotStatusEntry } from '@operationkit/shared'
import {
  AGENTS_KEY,
  fetchAgents,
  fetchMessages,
  fetchThreads,
  messagesKey,
  prefetchBot,
  readCache,
  setChatCacheScope,
  threadsKey,
  useCached,
  writeCache,
} from './chat-cache'
import {
  ACCEPTED_IMAGE_TYPES,
  COLOUR_CLASSES,
  PROVIDER_LABELS,
  type AgentsResponse,
  type ChatAgentInfo,
  type ChatCard,
  type ChatDraft,
  type ChatMessage,
  type ChatThread,
  type LaneTurn,
  type ReplyThreadOpenResponse,
  type ReplyThreadSummary,
  type ThreadResponse,
  type ThreadsResponse,
} from './types'

/* Built-in bot chat (obj 719987; user-facing terminology renamed to "bot" in
   obj 900327).
   Pick a bot on the left (a list on its own screen on mobile), then talk to it
   in ONE ongoing conversation. Every reply says which AI answered. Email and
   calendar actions arrive as drafts with your own Send button; bigger jobs
   arrive as board-card chips that update while the card runs.

   TERMINOLOGY (obj 900327, extended by obj 900370) — the nouns are NOT
   interchangeable:
     - a BOT is the durable identity defined by one agent file. It is created by
       adding that file on the server, never from this page.
     - the MAIN CONVERSATION is the ongoing message history between you and one
       bot. There is exactly one per bot, it starts implicitly with your first
       message, and "Clear conversation" empties it WITHOUT deleting the bot.
     - a SIDE THREAD is an extra, named conversation beside the main one: its own
       history, its own context, and it runs CONCURRENTLY — you can set one off
       and keep talking in the main conversation while it works. Closing a side
       thread archives that lane and leaves the main conversation untouched.
     - a THREAD (obj 901373, "Reply in thread") hangs off ONE message of the
       main conversation or of a side thread. It opens in a panel beside the
       conversation; the bot answers a reply there, with that message and the
       thread's earlier replies as its context, and nothing is posted to the
       conversation the message sits in.
   The Bots sidebar's "New bot" button (obj 900866) does not create a bot here
   either: it opens the existing create flow (ask the Dev bot, a template, or
   paste a bot file), which writes the agent file on the server. The
   identifiers below (agent*, ChatAgentInfo, /agent-chat, the agent_chat_*
   tables, the agents/ folder) are the UNCHANGED technical names - only what a
   person reads was renamed. */

const OPEN_CARD = new Set(['planning', 'queue', 'working', 'ai_review'])

export function suggestionsFor(a: ChatAgentInfo): string[] {
  // The server's resolved About (obj 900747): the file's own prompts, else ones
  // generated from the bot's instructions and tools.
  if (a.about?.example_prompts?.length) return a.about.example_prompts
  // A bot file that lists its own example prompts (obj 900672) knows best.
  if (a.example_prompts?.length) return a.example_prompts
  const has = (t: string) => a.tools.includes(t)
  // The demo knows its made-up people; a real agent gets generic openers.
  if (a.source === 'demo') {
    return [
      ...(has('email') ? ["What's in my inbox?", 'Reply to Priya'] : []),
      ...(has('calendar') ? ['Move the meeting with Priya to Friday'] : []),
      ...(has('create_objective') ? ['Prepare a website quote for Elena'] : []),
    ].slice(0, 4)
  }
  return [
    ...(has('email') ? ['What needs a reply today?'] : []),
    ...(has('calendar') ? ["What's on my calendar this week?"] : []),
    ...(has('search') ? ['What do my notes say about this week?'] : []),
    ...(has('create_objective') ? ['Put a task on the board for the team'] : []),
  ].slice(0, 3)
}

// ── bot list: see BotSidebar.tsx (obj 900798) ──

// ── the lane strip: main conversation + side threads (obj 900370) ──

/**
 * The Bots page fills the viewport; only its inner lists scroll (obj 901252).
 * An absolutely positioned descendant (an sr-only label, e.g. the Pro/Con text
 * of a decision briefing in the thread) is laid out against its nearest
 * POSITIONED ancestor. With none, it escaped every overflow box, sat at its
 * static spot thousands of pixels down the thread and stretched the document:
 * the window scrolled past the composer into a blank area. So the root and every
 * scroller below it are `relative` (each scroller clips its own content), and the
 * root clips as a backstop with `overflow-clip`, which unlike `overflow-hidden`
 * is not a scroll container that focus() or scrollIntoView() could move.
 */
export const CHAT_PAGE_ROOT_CLASS = 'relative flex h-full min-h-0 overflow-clip bg-surface-0'

const MAIN_LANE = 'main'

const MODEL_WORDS: Record<string, string> = { gpt: 'GPT', ai: 'AI', llama: 'Llama', o1: 'o1', o3: 'o3', o4: 'o4' }

/**
 * A friendly model name for display: "claude-opus-5-5" → "Claude Opus 5.5",
 * "claude-sonnet-4-20250514" → "Claude Sonnet 4". The raw id stays in a tooltip.
 */
export function friendlyModelName(id: string): string {
  const parts = id.replace(/[-_]\d{8}$/, '').split(/[-_/\s]+/).filter(Boolean)
  const out: string[] = []
  for (const p of parts) {
    const prev = out[out.length - 1]
    if (/^\d+$/.test(p) && prev && /^\d+(\.\d+)*$/.test(prev)) {
      out[out.length - 1] = `${prev}.${p}`
    } else {
      const lower = p.toLowerCase()
      out.push(MODEL_WORDS[lower] ?? (/^[a-z]/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p))
    }
  }
  return out.join(' ') || id
}

function LaneStrip({
  threads,
  lane,
  maxOpen,
  busy,
  onPick,
  onOpen,
}: {
  threads: ChatThread[]
  lane: number | null
  maxOpen: number
  busy: boolean
  onPick: (id: number | null) => void
  onOpen: () => void
}) {
  const atCap = maxOpen > 0 && threads.length >= maxOpen
  // One tab per lane on the UI SDK tabs (obj 900819): one tab stop, arrow keys
  // move between lanes. "+ Side thread" is an action, so it sits beside the
  // tablist rather than inside it.
  const items = [
    { key: MAIN_LANE, label: 'Main' },
    ...threads.map(t => ({
      key: String(t.id),
      label: t.title,
      ...(t.pinned ? { icon: <Pin aria-label="Pinned" className="h-3 w-3 shrink-0" /> } : {}),
      ...(t.message_count > 0 ? { count: t.message_count } : {}),
    })),
  ]
  return (
    <div className="flex items-center gap-2 border-b border-line-soft bg-surface-1 px-2 py-1.5 sm:px-4">
      <Tabs
        items={items}
        value={lane === null ? MAIN_LANE : String(lane)}
        onChange={k => onPick(k === MAIN_LANE ? null : Number(k))}
        label="Conversations with this bot"
        className="min-w-0"
      />
      <button
        type="button"
        onClick={onOpen}
        disabled={busy || atCap}
        title={atCap ? `${maxOpen} open side threads is the limit for one bot — close one first` : 'Open a side thread that runs beside this conversation'}
        className={cn(
          'min-h-[32px] shrink-0 whitespace-nowrap rounded-md border border-line bg-surface-1 px-3 text-sm text-fg-2 transition-colors duration-fast',
          'hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-45',
        )}
      >
        + Side thread
      </button>
    </div>
  )
}

// ── one lane of one bot: the main conversation, or one side thread ──

function Conversation({
  agent,
  onBack,
  initialText = '',
  meta,
  isAdmin = false,
  onAgentChanged,
  onActivity,
  initialBotThread = null,
  view = 'chat',
  onView,
  live,
}: {
  agent: ChatAgentInfo
  /** obj 900947: which of the bot's views is open — its chat, its Work, or its High Agency Activity. */
  view?: BotView
  onView?: (v: BotView) => void
  /** obj 900947: the bot's live status line for the header. */
  live?: BotStatusEntry
  onBack: () => void
  initialText?: string
  /** ?bot_thread=<id> opens that bot-to-bot thread in the Bot messages panel (obj 900859). */
  initialBotThread?: number | null
  /** The bot list's install-wide data: tool catalog, model suggestions, web status (obj 900671). */
  meta?: AgentsResponse
  isAdmin?: boolean
  onAgentChanged?: (a: ChatAgentInfo) => void
  /** A message landed or loaded in the lane on screen — the sidebar marks the bot read (obj 900798). */
  onActivity?: () => void
}) {
  // obj 900671: the bot's settings panel (model, provider, tools) on its own page.
  const [settingsOpen, setSettingsOpen] = useState(false)
  // The "i" panel (obj 900672): how to use this bot + example prompts.
  const [infoOpen, setInfoOpen] = useState(false)
  // obj 900859: the Bot messages panel — this bot's threads with other bots.
  // null = closed; 'list' = its conversations; a number = one thread.
  const [botPanel, setBotPanel] = useState<'list' | number | null>(initialBotThread ?? null)
  const openBotThread = useCallback((id: number) => {
    setBotPanel(id)
    setInfoOpen(false)
    setSettingsOpen(false)
  }, [])
  // A deep link (/chat/<slug>?prompt=…) pre-fills the box once; it never sends.
  // Captured at mount and applied by a mount-only effect declared AFTER the
  // reset effect below, so it survives StrictMode's double effect run and a
  // later lane switch still starts with an empty box.
  const prefill = useRef(initialText)
  const [text, setText] = useState('')
  // The long placeholder wrapped and was clipped in the one-line box at phone width (QA obj 900621).
  const narrow = useMediaQuery('(max-width: 639px)')
  // obj 901203: on a phone, open Bot settings take the whole conversation pane.
  // Sharing 844px with the view tabs, thread tabs and composer left ~450px of
  // settings, so High Agency sat behind a small inner scroll. The chat stays
  // mounted (draft, scroll position) and comes back when settings close.
  const settingsFull = narrow && settingsOpen && !!meta?.tool_catalog
  const [images, setImages] = useState<PendingImage[]>([])
  // The message whose turn this tab is waiting on (its POST runs the turn).
  // `id` is the message's client_msg_id (obj 900977): once the server's own row
  // for it is in the thread, that row is the message and this bubble is hidden.
  const [pending, setPending] = useState<{ id: string; text: string; images: PendingImage[] } | null>(null)
  // obj 900949: messages sent while the bot is working, until the server has
  // stored them as queued. Each shows as a "Sending…" bubble below the turn.
  const [outbox, setOutbox] = useState<{ key: number; id: string; text: string; images: PendingImage[] }[]>([])
  const outboxSeq = useRef(0)
  const [stopping, setStopping] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  // null = the main conversation; a number = that side thread (obj 900370).
  const [lane, setLane] = useState<number | null>(null)
  const [laneBusy, setLaneBusy] = useState(false)
  // null = not renaming; a string = the name being edited in the header.
  const [renameTo, setRenameTo] = useState<string | null>(null)
  // obj 901373: the reply thread open in the panel — its lane id and the message it hangs off.
  const [replyThread, setReplyThread] = useState<{ threadId: number; parent: ChatMessage } | null>(null)
  // Phones have no hover: the action sits under each message there (and on long-press).
  const noHover = useMediaQuery('(hover: none)')
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  // Autosize the composer: grow with its content (typed, pasted or prefilled)
  // up to COMPOSER_MAX_PX, then scroll inside. Runs before paint so the box
  // never flashes at the old height; clearing the text shrinks it back.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_PX)}px`
    el.style.overflowY = el.scrollHeight > COMPOSER_MAX_PX ? 'auto' : 'hidden'
  }, [text])
  const filePicker = useRef<HTMLInputElement>(null)
  const { confirm, confirmDialog } = useConfirm()
  const slug = agent.slug
  const base = `/agent-chat/agents/${encodeURIComponent(slug)}`
  // Omitting thread_id is what asks for the main conversation, server-side.
  const laneQuery = lane === null ? '' : `?thread_id=${lane}`

  // obj 900865: both reads go through the Bots page cache, so a bot (or lane)
  // that was opened or prefetched before paints at once from memory and is
  // refreshed behind it. Only a never-seen lane shows the skeleton below.
  const msgKey = messagesKey(slug, lane)
  const messages = useCached<ThreadResponse>(msgKey, () => fetchMessages(slug, lane), 'Could not load this conversation')
  const thread = messages.data ?? null
  const loadError = messages.error
  const load = messages.reload
  /** Update the cached copy of ONE lane (captured by the caller, so a reply that lands after a lane switch goes to its own lane). */
  const updateThread = (key: string, fn: (t: ThreadResponse) => ThreadResponse) => {
    const cur = readCache<ThreadResponse>(key)
    if (cur) writeCache<ThreadResponse>(key, fn(cur))
  }

  // The strip is ADDITIVE: a server that does not answer it (or answers it with
  // something unexpected) must leave the conversation working, not blank the
  // page. So both the failure and the shape are handled here.
  const strip = useCached<ThreadsResponse>(threadsKey(slug), () => fetchThreads(slug))
  const threads = useMemo(() => (Array.isArray(strip.data?.threads) ? strip.data.threads : []), [strip.data])
  const maxOpen = typeof strip.data?.max_open === 'number' ? strip.data.max_open : 0
  const loadThreads = strip.reload
  const setThreads = (fn: (cur: ChatThread[]) => ChatThread[]) =>
    writeCache<ThreadsResponse>(threadsKey(slug), d => ({ max_open: maxOpen, ...d, threads: fn(Array.isArray(d?.threads) ? d.threads : []) }))
  const activeThread = threads.find(t => t.id === lane) ?? null

  // obj 900949: the bot is working when this tab is waiting on a turn OR the
  // server says one is running in this lane (a queue being delivered, another tab).
  const working = !!pending || !!thread?.turn?.running
  // Queued messages render at the bottom, after the turn they wait behind.
  const delivered = useMemo(() => (thread?.messages ?? []).filter(m => !m.meta?.queued), [thread?.messages])
  const queuedRows = useMemo(() => (thread?.messages ?? []).filter(m => m.meta?.queued), [thread?.messages])
  // obj 900977: the server stores a message's row when its turn starts (or when
  // it is queued), so any re-read of the lane mid-turn already returns it. A
  // message is shown ONCE: the local bubble steps aside as soon as the row with
  // the same client_msg_id is in the thread.
  const storedIds = useMemo(() => {
    const ids = new Set<string>()
    for (const m of thread?.messages ?? []) if (m.meta?.client_msg_id) ids.add(m.meta.client_msg_id)
    return ids
  }, [thread?.messages])
  const pendingBubble = pending && !storedIds.has(pending.id) ? pending : null
  const outboxBubbles = useMemo(() => outbox.filter(o => !storedIds.has(o.id)), [outbox, storedIds])
  const queuedCount = queuedRows.length + outboxBubbles.length
  // While the server works through this lane with no request of ours open,
  // re-read it so replies and picked-up queued messages appear.
  const serverBusy = !pending && (!!thread?.turn?.running || queuedRows.length > 0)
  useEffect(() => {
    if (!serverBusy) return
    const t = setInterval(() => void load(), TURN_POLL_MS)
    return () => clearInterval(t)
  }, [serverBusy, load])

  useEffect(() => {
    setText('')
    setImages([])
    setSendError(null)
  }, [msgKey])

  useEffect(() => {
    if (prefill.current) setText(prefill.current)
  }, [])

  const openLane = async () => {
    setLaneBusy(true)
    setSendError(null)
    try {
      const r = await api.post<{ thread: ChatThread }>(`${base}/threads`, { title: `Side thread ${threads.length + 1}` })
      setThreads(cur => [r.thread, ...cur])
      setLane(r.thread.id)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not open a side thread')
    } finally {
      setLaneBusy(false)
    }
  }

  const renameLane = async (t: ChatThread, next: string) => {
    setRenameTo(null)
    if (next.trim() === '' || next === t.title) return
    try {
      const r = await api.patch<{ thread: ChatThread }>(`${base}/threads/${t.id}`, { title: next })
      setThreads(cur => cur.map(x => (x.id === r.thread.id ? r.thread : x)))
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not rename this side thread')
    }
  }

  // "Close" is archive, not delete: the lane's own messages are kept, and the
  // main conversation is not read or written at all.
  const closeLane = async (t: ChatThread) => {
    if (
      !(await confirm({
        title: `Close the side thread "${t.title}"?`,
        message: 'It stops showing here and its messages are kept. Your main conversation with this bot is not changed.',
        confirmLabel: 'Close side thread',
      }))
    )
      return
    try {
      await api.patch(`${base}/threads/${t.id}`, { archived: true })
      setThreads(cur => cur.filter(x => x.id !== t.id))
      setLane(null)
    } catch (e) {
      setSendError(e instanceof Error ? e.message : 'Could not close this side thread')
    }
  }

  // Leaving a lane abandons a half-typed rename rather than carrying it over,
  // and closes the thread panel: its parent message is no longer on screen.
  useEffect(() => { setRenameTo(null); setReplyThread(null) }, [lane])

  /**
   * obj 901373: open the thread on one message. The server finds the message's
   * thread or creates it (one per message); a message that already shows
   * "N replies" opens straight from its known thread id while that is confirmed.
   */
  const openReplyThread = async (m: ChatMessage, known?: ReplyThreadSummary) => {
    setSendError(null)
    setBotPanel(null)
    setInfoOpen(false)
    setSettingsOpen(false)
    if (known) setReplyThread({ threadId: known.thread_id, parent: m })
    try {
      const r = await api.post<ReplyThreadOpenResponse>(`${base}/messages/${m.id}/thread`, {})
      setReplyThread({ threadId: r.thread.id, parent: m })
    } catch (e) {
      setReplyThread(null)
      setSendError(actionErrorMessage(e, 'Could not open the thread'))
    }
  }

  // Paste / drop / attach all end up here (obj 900157).
  const addFiles = useCallback(async (files: ArrayLike<File>) => {
    const r = await collectImages(files, images.length)
    if (r.images.length) setImages(cur => [...cur, ...r.images].slice(0, 4))
    setSendError(r.error)
  }, [images.length])

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = filesFromClipboard(e)
    if (!files) return
    // Only swallow the paste when it really is an image, so pasting text (which
    // can also carry a file on some platforms) still types into the box.
    if (!Array.from(files).some(f => (f.type || '').startsWith('image/'))) return
    e.preventDefault()
    void addFiles(files)
  }

  const { isDragging, dropProps } = useFileDrop(f => void addFiles(f), true)

  // Board cards keep moving after the chat ends: refresh while any is still open.
  // Board cards keep moving after the conversation ends: refresh while any is still open.
  const openCards = thread?.cards.some(c => OPEN_CARD.has(c.status)) ?? false
  useEffect(() => {
    if (!openCards) return
    const t = setInterval(() => void load(), 15_000)
    return () => clearInterval(t)
  }, [openCards, load])

  // obj 900859: a message to another bot whose reply has not landed in this lane
  // yet — re-read the lane every few seconds until it does (bounded).
  const awaitingBotReply = useMemo(() => {
    const msgs = thread?.messages ?? []
    const relayed = (x: ChatMessage, id: number) =>
      x.role === 'assistant' && x.meta?.bot_conversation_id === id && (x.meta?.kind === 'bot_reply' || x.meta?.kind === 'bot_message_failed')
    return msgs.some((m, i) => {
      const id = m.meta?.bot_conversation_id
      if (m.role !== 'tool' || m.tool_name !== 'message_bot' || m.meta?.ok === false || !id) return false
      // Only a recent send: an old one whose reply went elsewhere must not poll forever.
      if (Date.now() - sentAt(m.created_at) > BOT_REPLY_WINDOW_MS) return false
      return !msgs.slice(i + 1).some(x => relayed(x, id))
    })
  }, [thread?.messages])
  useEffect(() => {
    if (!awaitingBotReply) return
    let polls = 0
    const t = setInterval(() => {
      if (++polls > BOT_REPLY_MAX_POLLS) clearInterval(t)
      else void load()
    }, BOT_REPLY_POLL_MS)
    return () => clearInterval(t)
  }, [awaitingBotReply, load])

  // A lane that just came on screen (a bot switch, a lane switch) opens AT the
  // newest message before paint; only a message arriving while you watch
  // scrolls smoothly. Smooth-scrolling a whole cached history on every switch
  // read as a slow page.
  const scrolledFor = useRef<string | null>(null)
  const hasThread = !!thread
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (scrolledFor.current !== msgKey) {
      if (!hasThread) return
      scrolledFor.current = msgKey
      el.scrollTop = el.scrollHeight
      return
    }
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [msgKey, hasThread, thread?.messages.length, pendingBubble, outboxBubbles.length])

  // A list that was display:none while settings filled a phone screen lost its
  // scroll offset; it comes back at the newest message, as it was (obj 901203).
  useLayoutEffect(() => {
    const el = scroller.current
    if (!settingsFull && el) el.scrollTop = el.scrollHeight
  }, [settingsFull])

  // obj 900798: what is on screen has been read. Fires when the newest message
  // in view changes (a lane loaded, a reply landed), not on every 15s refresh,
  // so a bot the person just marked unread stays unread until something new.
  const newestId = thread?.messages.length ? thread.messages[thread.messages.length - 1].id : 0
  const activity = useRef(onActivity)
  activity.current = onActivity
  useEffect(() => {
    if (newestId) activity.current?.()
  }, [newestId])

  // obj 900977: one draft is sent once. Two submits fired before the box has
  // re-rendered empty (a double Enter, Enter + click) carry the very same draft;
  // the second is dropped here. Any change to the draft clears the mark.
  const sentDraft = useRef<{ text: string; images: PendingImage[] } | null>(null)
  useEffect(() => { sentDraft.current = null }, [text, images, msgKey])

  const send = async (raw: string, attached: PendingImage[] = images) => {
    const msg = raw.trim()
    // A screenshot on its own is a message: send when there is text OR an image.
    if (!msg && attached.length === 0) return
    if (sentDraft.current && sentDraft.current.text === raw && sentDraft.current.images === attached) return
    sentDraft.current = { text: raw, images: attached }
    const key = msgKey
    // obj 900977: the id this message is known by on both sides. The server
    // stores it on the row and answers a repeat with that row, not a second one.
    const id = newClientMsgId()
    // obj 900949: Send never waits on the bot. While a turn runs, the message
    // goes straight to the server, which queues it (202) and delivers it next.
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
        { text: msg, client_msg_id: id, ...(lane === null ? {} : { thread_id: lane }), ...(attached.length ? { images: toWireImages(attached) } : {}) },
        { timeoutMs: 240_000 },
      )
      writeCache<ThreadResponse>(key, t => mergeThread(t ?? null, r))
      // The strip shows per-lane message counts and ordering by last activity.
      void loadThreads()
    } catch (e) {
      // obj 901329: the 240s timeout is UI-only. The server already holds the
      // message and keeps working on it (a dropped request is not Stop), so
      // this is not "not sent": re-read the thread, where the answer lands.
      if (isRequestTimeout(e)) {
        void load()
        void loadThreads()
        return
      }
      // Nothing typed is lost: put it back unless the person is already typing the next one.
      setText(cur => (cur.trim() ? cur : msg))
      setImages(cur => (cur.length ? cur : attached))
      setSendError(actionErrorMessage(e, 'Message not sent'))
      // Sending the restored draft again is a deliberate retry, not a double submit.
      sentDraft.current = null
    } finally {
      if (queueIt) setOutbox(cur => cur.filter(o => o.key !== outKey))
      else setPending(null)
    }
  }

  /**
   * obj 900949: cancel the reply in progress. Queued messages are kept (they go
   * to the bot next); `dropQueued` discards them too and is only sent after the
   * person confirmed.
   */
  const stop = async (dropQueued = false) => {
    const key = msgKey
    setStopping(true)
    setSendError(null)
    try {
      const r = await api.post<{ stopped: boolean; dropped: number; turn: LaneTurn }>(`${base}/stop`, {
        ...(lane === null ? {} : { thread_id: lane }),
        ...(dropQueued ? { drop_queued: true } : {}),
      })
      updateThread(key, t => ({
        ...t,
        turn: r.turn,
        messages: dropQueued ? t.messages.filter(m => !m.meta?.queued) : t.messages,
      }))
      if (!pending) void load()
    } catch (e) {
      setSendError(actionErrorMessage(e, 'Could not stop the reply'))
    } finally {
      setStopping(false)
    }
  }

  const discardQueued = async (n: number) => {
    if (
      !(await confirm({
        title: `Stop and discard ${n === 1 ? 'your queued message' : `${n} queued messages`}?`,
        message: `${n === 1 ? 'It has' : 'They have'} not reached ${agent.name} yet and will be deleted. The reply in progress is stopped too.`,
        confirmLabel: 'Stop and discard',
        danger: true,
      }))
    )
      return
    await stop(true)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send(text)
    }
  }

  const draftAction = async (path: string, body?: unknown, method: 'post' | 'put' = 'post', key: string = msgKey) => {
    setSendError(null)
    try {
      const r = method === 'put' ? await api.put<{ draft: ChatDraft }>(path, body) : await api.post<{ draft: ChatDraft }>(path, body)
      const d = r.draft
      updateThread(key, t => ({ ...t, drafts: t.drafts.map(x => (x.id === d.id ? d : x)) }))
    } catch (e) {
      setSendError(actionErrorMessage(e, 'That did not work'))
    }
  }

  const clear = async () => {
    if (
      !(await confirm({
        title: activeThread ? `Clear the side thread "${activeThread.title}"?` : `Clear your conversation with ${agent.name}?`,
        // Clearing empties ONE lane. It does NOT delete the bot - the bot is its
        // agent file on the server and stays exactly as it is - and clearing a
        // side thread never touches the main conversation.
        message: activeThread
          ? `Only this side thread's messages are deleted. Your main conversation with ${agent.name} is not changed.`
          : `The messages are deleted from this server, with the threads replied under them. ${agent.name} itself is not deleted — only this conversation is emptied. Side threads, board cards and saved notes stay.`,
        confirmLabel: activeThread ? 'Clear side thread' : 'Clear conversation',
        danger: true,
      }))
    )
      return
    const key = msgKey
    await api.del(`${base}/messages${laneQuery}`)
    // The threads replied under these messages are cleared with them (obj 901373).
    setReplyThread(null)
    updateThread(key, t => ({ ...t, messages: [], reply_threads: {} }))
    await load()
    void loadThreads()
  }

  const drafts = useMemo(() => new Map((thread?.drafts ?? []).map(d => [d.id, d])), [thread?.drafts])
  const cards = useMemo(() => new Map((thread?.cards ?? []).map(c => [c.id, c])), [thread?.cards])
  /** One stored message, drawn the same way in the conversation and in the thread panel. */
  const renderMessage = (m: ChatMessage, t: ThreadResponse | null, key: string): ReactNode => {
    if (isNeedsYouMessage(m)) return <NeedsYouMessage m={m} agent={agent} />
    const own = t === thread
    const draft = m.meta?.draft_id ? (own ? drafts.get(m.meta.draft_id) : t?.drafts.find(d => d.id === m.meta?.draft_id)) : undefined
    const card = m.tool_name === 'create_objective' && m.meta?.objective_id ? (own ? cards.get(m.meta.objective_id) : t?.cards.find(c => c.id === m.meta?.objective_id)) : undefined
    return (
      <MessageRow
        m={m}
        agent={agent}
        draft={draft}
        card={card}
        onSend={d => draftAction(`/agent-chat/drafts/${d.id}/send`, undefined, 'post', key)}
        onDiscard={d => draftAction(`/agent-chat/drafts/${d.id}/discard`, undefined, 'post', key)}
        onSave={(d, patch) => draftAction(`/agent-chat/drafts/${d.id}`, patch, 'put', key)}
        onOpenBotThread={openBotThread}
      />
    )
  }
  const answeredBy = `${PROVIDER_LABELS[agent.answered_by.id]}${agent.answered_by.model ? ` · ${friendlyModelName(agent.answered_by.model)}` : ''}`

  return (
    <section aria-label={`Conversation with ${agent.name}`} className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-1 px-2 py-2 sm:flex-nowrap sm:px-4">
        <IconButton label="All bots" onClick={onBack} className="md:hidden">
          <ChevronLeft aria-hidden="true" className="h-5 w-5" />
        </IconButton>
        <AgentAvatar agent={agent} />
        <div className="min-w-[9rem] flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate font-display text-lg font-semibold tracking-tight text-fg-0">{agent.name}</h2>
            {/* obj 900972: Full access, with the workspace and the expiry when one is set. */}
            <FullAccessBadge access={agent.full_access} variant="full" />
          </div>
          <p className="truncate text-xs text-fg-2">
            Answers with <span className="text-fg-1" title={agent.answered_by.model ?? undefined}>{answeredBy}</span>
            {agent.version && <span> · v{agent.version}</span>}
            {/* Named only in a side thread: the main conversation is the unlabelled default. */}
            {activeThread && <span> · side thread <span className="text-fg-1">{activeThread.title}</span></span>}
          </p>
          {live && <BotLiveLine entry={live} className="mt-0.5" />}
        </div>
        {/* Actions travel as one group: on a phone they wrap under the bot name
            instead of squeezing it to a single letter (obj 900750). */}
        <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
        {activeThread && renameTo !== null && (
          <form
            className="flex items-center gap-1"
            onSubmit={e => { e.preventDefault(); void renameLane(activeThread, renameTo) }}
          >
            <label htmlFor="side-thread-name" className="sr-only">Name of this side thread</label>
            <input
              id="side-thread-name"
              autoFocus
              value={renameTo}
              onChange={e => setRenameTo(e.target.value)}
              onKeyDown={e => { if (e.key === 'Escape') setRenameTo(null) }}
              className="min-h-[36px] w-40 rounded-md border border-line bg-surface-0 px-2 text-sm text-fg-0 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30"
            />
            <Button type="submit" variant="ghost" size="sm">Save</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRenameTo(null)}>Cancel</Button>
          </form>
        )}
        {activeThread && renameTo === null && (
          <>
            <Button variant="ghost" size="sm" onClick={() => setRenameTo(activeThread.title)} className="min-h-[44px] sm:min-h-0">
              Rename
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Close the side thread "${activeThread.title}" (your main conversation is kept)`}
              onClick={() => void closeLane(activeThread)}
              className="min-h-[44px] sm:min-h-0"
            >
              Close
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={botPanel !== null}
          aria-controls="bot-messages-panel"
          aria-label={`${botPanel !== null ? 'Hide' : 'Show'} ${agent.name}'s messages with other bots`}
          onClick={() => setBotPanel(p => (p === null ? 'list' : null))}
          className={cn('min-h-[44px] sm:min-h-0', botPanel !== null && 'bg-surface-3 text-fg-0')}
        >
          Bot messages
        </Button>
        {meta?.tool_catalog && (
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={settingsOpen}
            aria-label={`${settingsOpen ? 'Hide' : 'Show'} settings for ${agent.name} (model and tools)`}
            onClick={() => setSettingsOpen(o => !o)}
            className="min-h-[44px] sm:min-h-0"
          >
            Settings
          </Button>
        )}
        <IconButton
          label={infoOpen ? `Hide how to use ${agent.name}` : `How to use ${agent.name}: info and example prompts`}
          aria-expanded={infoOpen}
          aria-controls="agent-info-panel"
          onClick={() => setInfoOpen(o => !o)}
          className={cn(infoOpen && 'bg-surface-3 text-fg-0')}
        >
          <Info aria-hidden="true" className="h-5 w-5" />
        </IconButton>
        <Button
          variant="ghost"
          size="sm"
          aria-label={
            activeThread
              ? `Clear this side thread (your main conversation with ${agent.name} is kept)`
              : `Clear this conversation with ${agent.name} (the bot is kept)`
          }
          onClick={() => void clear()}
          disabled={!thread?.messages.length || working}
          className="min-h-[44px] sm:min-h-0"
        >
          {activeThread ? 'Clear side thread' : 'Clear conversation'}
        </Button>
        </div>
      </header>

      {settingsOpen && meta?.tool_catalog && (
        <BotSettingsPanel
          agent={agent}
          meta={meta}
          isAdmin={isAdmin}
          onSaved={a => onAgentChanged?.(a)}
          onClose={() => setSettingsOpen(false)}
          fill={settingsFull}
        />
      )}

      {botPanel !== null && (
        <BotMessagesPanel
          id="bot-messages-panel"
          agent={agent}
          agents={meta?.agents ?? [agent]}
          conversationId={botPanel === 'list' ? null : botPanel}
          onPick={id => setBotPanel(id === null ? 'list' : id)}
          onClose={() => setBotPanel(null)}
        />
      )}

      {infoOpen && (
        <AgentInfoPanel
          id="agent-info-panel"
          agent={agent}
          prompts={suggestionsFor(agent)}
          onLoaded={a => onAgentChanged?.(a)}
          onClose={() => setInfoOpen(false)}
          onUsePrompt={p => {
            setText(p)
            setInfoOpen(false)
            input.current?.focus()
          }}
        />
      )}

      {/* `contents` keeps this wrapper out of the flex layout; `hidden` steps the
          whole chat aside while settings fill a phone screen (obj 901203). */}
      <div className={settingsFull ? 'hidden' : 'contents'}>
      <div className="flex items-center gap-2 border-b border-line bg-surface-1 px-2 py-1.5 sm:px-4" data-testid="bot-view-tabs">
        <Tabs
          label={`${agent.name} views`}
          value={view}
          onChange={k => onView?.(k as BotView)}
          items={[
            { key: 'chat', label: 'Chat' },
            { key: 'work', label: 'Work', count: live ? live.counts.running + live.counts.review + live.counts.queued : undefined },
            { key: 'activity', label: 'Activity' },
          ]}
        />
        {live && live.counts.needs_you > 0 && view !== 'work' && (
          <button
            type="button"
            onClick={() => onView?.('work')}
            className="ml-auto rounded-full border border-status-human/30 bg-status-human/10 px-2 py-0.5 text-xs font-medium text-status-human hover:bg-status-human/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          >
            {live.counts.needs_you} need{live.counts.needs_you === 1 ? 's' : ''} you
          </button>
        )}
      </div>

      {view === 'work' && <div className="relative min-h-0 flex-1 overflow-y-auto"><BotWorkTab agent={agent} /></div>}
      {view === 'activity' && <div className="relative min-h-0 flex-1 overflow-y-auto"><BotActivityFeed agent={agent} /></div>}

      {view === 'chat' && (<>
      <LaneStrip threads={threads} lane={lane} maxOpen={maxOpen} busy={laneBusy} onPick={setLane} onOpen={() => void openLane()} />

      {/* obj 901373: the conversation, with the thread panel beside it on a wide
          screen and over it on a narrow one (the conversation stays mounted
          underneath: its draft and scroll position are there when the panel closes). */}
      <div className="relative flex min-h-0 flex-1" data-testid="chat-with-thread">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">

      {/* While Bot settings is open the panel takes the pane and scrolls itself
          (obj 900864); the message list keeps its place but drops its padding so
          no 32px sliver of half-cut chat shows between the lanes and the composer.
          Closing settings brings it back at the same (bottom) scroll position. */}
      <div
        ref={scroller}
        data-testid="chat-message-list"
        className={cn('relative min-h-0 flex-1 overflow-y-auto overflow-x-clip px-3 sm:px-6', settingsOpen && meta?.tool_catalog ? 'py-0' : 'py-4')}
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-[760px] flex-col gap-3">
          {loadError && <Alert tone="alarm">{loadError}</Alert>}
          {!thread && !loadError && <MessagesSkeleton />}
          {thread && thread.messages.length === 0 && !pending && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <AgentAvatar agent={agent} size="lg" />
              <div className="space-y-1">
                <p className="font-display text-lg font-semibold text-fg-0">
                  {activeThread ? `"${activeThread.title}" is empty` : `Start a conversation with ${agent.name}`}
                </p>
                <p className="mx-auto max-w-[46ch] text-sm leading-relaxed text-fg-2">
                  {activeThread
                    ? `A side thread has its own history and its own context — ${agent.name} sees only what you say here, and it keeps working while you use the main conversation.`
                    : agent.about?.description || agent.description}
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {suggestionsFor(agent).map(s => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="min-h-[44px] rounded-full border border-line bg-surface-1 px-4 text-sm text-fg-1 transition-all duration-fast hover:-translate-y-px hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                  >
                    {s}
                  </button>
                ))}
              </div>
              {!activeThread && (
                <button
                  type="button"
                  onClick={() => setInfoOpen(true)}
                  className="text-sm text-accent underline-offset-2 hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                >
                  How to use {agent.name}
                </button>
              )}
              {agent.source === 'demo' && <p className="text-xs text-fg-2">Demo bot: the inbox, calendar and notes are made-up sample data.</p>}
            </div>
          )}
          {foldFeedMessages(delivered).map(item => {
            if (item.kind === 'feed') {
              return <FoldedActivity key={item.key} messages={item.messages} agent={agent} onOpenActivity={() => onView?.('activity')} />
            }
            const m = item.m
            // obj 901373: the person's and the bot's messages can be replied to in a thread.
            if (m.role !== 'user' && m.role !== 'assistant') return <div key={m.id} className="contents">{renderMessage(m, thread, msgKey)}</div>
            const summary = thread?.reply_threads?.[String(m.id)]
            return (
              <ThreadableMessage
                key={m.id}
                m={m}
                summary={summary}
                open={replyThread?.parent.id === m.id}
                alwaysShowAction={noHover}
                onReply={() => void openReplyThread(m, summary)}
              >
                {renderMessage(m, thread, msgKey)}
              </ThreadableMessage>
            )
          })}
          {pendingBubble && (
            <UserBubble
              m={{ content: pendingBubble.text, created_at: new Date().toISOString(), images: pendingBubble.images.map((i, n) => ({ id: -1 - n, name: i.name, media_type: i.media_type, size: i.size, url: i.dataUrl })) }}
            />
          )}
          {working && (
            <div className="flex items-center gap-2.5" data-testid="bot-working">
              <AgentAvatar agent={agent} size="sm" />
              <ThinkingIndicator label={`${agent.name} is working…`} tone="fg-2" />
            </div>
          )}
          {/* obj 900949: messages sent while the bot works wait here, in the
              order they were sent, until the bot picks them up. */}
          {queuedRows.map(m => <UserBubble key={m.id} m={m} queued />)}
          {outboxBubbles.map(o => (
            <UserBubble
              key={`out-${o.key}`}
              sending
              m={{ content: o.text, created_at: '', images: o.images.map((i, n) => ({ id: -1 - n, name: i.name, media_type: i.media_type, size: i.size, url: i.dataUrl })) }}
            />
          ))}
          {queuedCount > 0 && (
            <p className="self-end text-right text-xs text-fg-2" data-testid="queue-note">
              {working
                ? `${agent.name} is mid-task. ${queuedCount === 1 ? 'Your message goes' : `Your ${queuedCount} messages go`} to it next, in order.`
                : `Sending ${queuedCount === 1 ? 'your queued message' : `your ${queuedCount} queued messages`}…`}
            </p>
          )}
        </div>
      </div>

      <form
        className={cn(
          'border-t border-line bg-surface-1 px-3 pb-[max(env(safe-area-inset-bottom),12px)] pt-3 transition-colors duration-fast sm:px-6',
          isDragging && 'bg-accent/5 ring-1 ring-inset ring-accent/40',
        )}
        onSubmit={e => { e.preventDefault(); void send(text) }}
        {...dropProps}
      >
        <div className="mx-auto max-w-[760px]">
          {sendError && <p role="alert" className="mb-2 text-sm text-danger">{sendError}</p>}
          {isDragging && <p className="mb-2 text-sm text-accent">Drop the image to attach it</p>}
          {images.length > 0 && (
            <ul aria-label="Attached images" className="mb-2 flex flex-wrap gap-2">
              {images.map(i => (
                <li key={i.key} className="relative">
                  <img src={i.dataUrl} alt={i.name} title={`${i.name} · ${humanSize(i.size)}`} className="h-16 w-16 rounded-md border border-line object-cover" />
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
              data-testid="agent-chat-file-input"
              onChange={e => {
                const files = e.target.files
                if (files && files.length) void addFiles(files)
                e.target.value = ''
              }}
            />
            <IconButton type="button" label="Attach an image" onClick={() => filePicker.current?.click()}>
              <Paperclip aria-hidden="true" className="h-5 w-5" />
            </IconButton>
            <label htmlFor="agent-chat-input" className="sr-only">Message {agent.name}</label>
            <textarea
              id="agent-chat-input"
              ref={input}
              rows={1}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={onKey}
              onPaste={onPaste}
              placeholder={narrow ? 'Write a message…' : activeThread ? `Write a message in "${activeThread.title}"` : 'Write a message, or paste a screenshot'}
              className="max-h-60 min-h-[44px] flex-1 resize-none rounded-lg border border-line bg-surface-0 px-3.5 py-2.5 text-lg text-fg-0 placeholder:text-fg-3 transition-colors duration-fast hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30 disabled:opacity-60 sm:text-base"
            />
            {/* obj 900949: Stop is its own small control, shown only while the
                bot works. Send below never turns into a spinner or locks. */}
            {working && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void stop()}
                loading={stopping}
                aria-label={queuedCount > 0 ? `Stop ${agent.name}'s reply (your queued messages are kept)` : `Stop ${agent.name}'s reply`}
                leftIcon={<Square aria-hidden="true" className="h-3.5 w-3.5 fill-current" />}
                className="min-h-[44px] sm:min-h-[44px]"
              >
                Stop
              </Button>
            )}
            <Button type="submit" variant="primary" disabled={!text.trim() && images.length === 0} className="min-h-[44px] sm:min-h-[44px]">
              Send
            </Button>
          </div>
          {working && queuedCount > 0 && queuedRows.length > 0 && (
            <p className="mt-1.5 text-xs text-fg-2">
              Stop keeps your queued {queuedRows.length === 1 ? 'message' : 'messages'}.{' '}
              <button
                type="button"
                onClick={() => void discardQueued(queuedRows.length)}
                className="text-accent underline-offset-2 hover:text-accent-hover hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                Stop and discard queued
              </button>
            </p>
          )}
          <p className="mt-1.5 hidden text-xs text-fg-2 sm:block">Enter to send · Shift+Enter for a new line · paste, drop or attach a screenshot · Email and calendar are always drafts until you press Send.</p>
        </div>
      </form>
      </div>
      {replyThread && (
        <ReplyThreadPanel
          key={replyThread.threadId}
          agent={agent}
          threadId={replyThread.threadId}
          parent={replyThread.parent}
          renderMessage={renderMessage}
          onClose={() => setReplyThread(null)}
          onChanged={() => void load()}
          onActivity={onActivity}
          className="absolute inset-0 z-10 xl:static xl:z-auto xl:w-[400px] xl:shrink-0 xl:border-l xl:border-line"
        />
      )}
      </div>
      </>)}
      </div>
      {confirmDialog}
    </section>
  )
}

/** How many bots the page warms at idle once the list is on screen (obj 900865). */
const IDLE_PREFETCH_BOTS = 6

/** The message-list placeholder, on the shared Skeleton primitives. */
function MessagesSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading conversation" data-testid="messages-skeleton">
      <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={2} className="flex-1" /></div>
      <div className="flex justify-end"><Skeleton className="h-10 w-1/2 rounded-lg" /></div>
      <div className="flex items-start gap-2.5"><Skeleton className="h-7 w-7 rounded-lg" /><SkeletonText lines={3} className="flex-1" /></div>
    </div>
  )
}

/** The whole conversation pane (header, messages, composer) before the bot list has arrived. */
function ConversationSkeleton() {
  return (
    <div className="flex h-full min-w-0 flex-col" aria-label="Loading conversation" data-testid="conversation-skeleton">
      <div className="flex items-center gap-2 border-b border-line bg-surface-1 px-2 py-2 sm:px-4">
        <Skeleton className="h-9 w-9 rounded-lg" />
        <div className="flex-1 space-y-1.5"><Skeleton className="h-4 w-40" /><Skeleton className="h-3 w-56" /></div>
      </div>
      <div className="flex-1 overflow-hidden px-3 py-4 sm:px-6">
        <div className="mx-auto max-w-[760px]"><MessagesSkeleton /></div>
      </div>
      <div className="border-t border-line bg-surface-1 px-3 pb-3 pt-3 sm:px-6">
        <Skeleton className="mx-auto h-11 max-w-[760px] rounded-lg" />
      </div>
    </div>
  )
}

/** Tallest the chat composer grows before it scrolls inside (matches `max-h-60`). */
const COMPOSER_MAX_PX = 240
/** While a bot-to-bot reply is awaited: re-read the lane this often, at most this many times (~5 min). */
const BOT_REPLY_POLL_MS = 5000
/** obj 900949: while the bot works through a lane on its own (a queue), re-read the lane this often. */
const TURN_POLL_MS = 2000
const BOT_REPLY_MAX_POLLS = 60
const BOT_REPLY_WINDOW_MS = 15 * 60_000

/** A server timestamp (SQLite 'YYYY-MM-DD HH:MM:SS' UTC or ISO) as epoch ms; 0 if unreadable. */
function sentAt(iso: string): number {
  const t = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime()
  return Number.isNaN(t) ? 0 : t
}

export { mergeThread }

/**
 * obj 901373: one message of the conversation plus its thread affordances — the
 * "Reply in thread" action (on hover or keyboard focus; always shown, and on
 * long-press, where there is no hover) and, once the message has replies, the
 * "N replies" link with the last reply's time.
 */
export function ThreadableMessage({
  m,
  summary,
  open,
  alwaysShowAction,
  onReply,
  children,
}: {
  m: ChatMessage
  summary?: ReplyThreadSummary
  /** This message's thread is the one open in the panel. */
  open: boolean
  alwaysShowAction: boolean
  onReply: () => void
  children: ReactNode
}) {
  const mine = m.role === 'user'
  const press = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current)
    press.current = null
  }
  useEffect(() => cancelPress, [])
  const n = summary?.reply_count ?? 0
  const last = summary?.last_reply_at ? time(summary.last_reply_at) : ''
  return (
    <div
      data-testid="threadable-message"
      data-message-id={m.id}
      className={cn('group/msg relative flex flex-col gap-1 rounded-lg', open && 'bg-accent/5 outline outline-1 outline-offset-4 outline-accent/40')}
      onTouchStart={() => { cancelPress(); press.current = setTimeout(onReply, LONG_PRESS_MS) }}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
    >
      {children}
      {(n > 0 || alwaysShowAction) && (
        <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs', mine ? 'justify-end' : 'ml-9')}>
          {n > 0 && (
            <button
              type="button"
              data-testid="thread-replies-link"
              onClick={onReply}
              aria-label={`${n} ${n === 1 ? 'reply' : 'replies'} in thread${last ? `, last reply ${last}` : ''}. Open thread`}
              className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md px-1.5 font-medium text-accent-hover underline-offset-2 hover:bg-surface-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <MessageSquareReply aria-hidden="true" className="h-3.5 w-3.5" />
              <span>{n} {n === 1 ? 'reply' : 'replies'}</span>
              {last && <span className="font-normal text-fg-2">· last reply {last}</span>}
            </button>
          )}
          {alwaysShowAction && n === 0 && (
            <button
              type="button"
              onClick={onReply}
              className="inline-flex min-h-[28px] items-center gap-1.5 rounded-md px-1.5 text-fg-2 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <MessageSquareReply aria-hidden="true" className="h-3.5 w-3.5" />
              Reply in thread
            </button>
          )}
        </div>
      )}
      {!alwaysShowAction && (
        <button
          type="button"
          onClick={onReply}
          title="Reply in thread"
          className={cn(
            'absolute -top-3 z-[1] inline-flex min-h-[28px] items-center gap-1.5 rounded-md border border-line bg-surface-1 px-2 text-xs text-fg-1 opacity-0 shadow-sm transition-opacity duration-fast',
            'hover:border-line-strong hover:text-fg-0 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/msg:opacity-100',
            'right-2',
          )}
        >
          <MessageSquareReply aria-hidden="true" className="h-3.5 w-3.5" />
          Reply in thread
        </button>
      )}
    </div>
  )
}

/** How long a touch is held on a message before its thread opens. */
const LONG_PRESS_MS = 550

function MessageRow({
  m,
  agent,
  draft,
  card,
  onSend,
  onDiscard,
  onSave,
  onOpenBotThread,
}: {
  m: ChatMessage
  agent: ChatAgentInfo
  draft?: ChatDraft
  card?: ChatCard
  onSend: (d: ChatDraft) => Promise<void>
  onDiscard: (d: ChatDraft) => Promise<void>
  onSave: (d: ChatDraft, patch: Record<string, string>) => Promise<void>
  onOpenBotThread?: (id: number) => void
}) {
  if (m.role === 'user') return <UserBubble m={m} />
  if (m.role === 'assistant') return <AssistantBubble m={m} agent={agent} onOpenBotThread={onOpenBotThread} />
  if (m.role === 'error') return <ErrorLine m={m} />
  const botThread = m.meta?.ok !== false ? m.meta?.bot_conversation_id : undefined
  return (
    <>
      <ToolLine m={m} />
      {botThread && onOpenBotThread && <BotThreadLink id={botThread} onOpen={onOpenBotThread} className="ml-9 self-start" />}
      {draft && <DraftCard draft={draft} onSend={onSend} onDiscard={onDiscard} onSave={onSave} />}
      {card && <CardChip card={card} />}
    </>
  )
}

/** obj 900947: the three views on a bot's page. */
export type BotView = 'chat' | 'work' | 'activity'
const BOT_VIEWS: BotView[] = ['chat', 'work', 'activity']

/**
 * Older High Agency updates in this chat, folded into one row (obj 900947).
 * Nothing is deleted: "Show" expands them in place, and the Activity tab is
 * where new ones go.
 */
export function FoldedActivity({ messages, agent, onOpenActivity }: { messages: ChatMessage[]; agent: ChatAgentInfo; onOpenActivity: () => void }) {
  const [open, setOpen] = useState(false)
  const n = messages.length
  return (
    <div className="rounded-lg border border-dashed border-line bg-surface-1/60 px-3 py-2" data-testid="folded-activity">
      <div className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
        <span>{n} High Agency update{n === 1 ? '' : 's'} — now in Activity</span>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
          className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {open ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          onClick={onOpenActivity}
          className="text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Open Activity
        </button>
      </div>
      {open && (
        <div className="mt-2 flex flex-col gap-3">
          {messages.map(m => <AssistantBubble key={m.id} m={m} agent={agent} />)}
        </div>
      )}
    </div>
  )
}

// ── page ──

export function AgentChatPage() {
  const { slug } = useParams<{ slug?: string }>()
  const navigate = useNavigate()
  // ?prompt= pre-fills the message box (obj 900672) — e.g. the Agents page's
  // "Ask the Dev bot" links. Read once, then dropped from the URL
  // so a reload does not put it back.
  const [params, setParams] = useSearchParams()
  const pendingPrompt = useRef<{ slug: string; text: string } | null>(null)
  const promptParam = params.get('prompt')
  // obj 900859: /chat/<slug>?bot_thread=<id> opens that bot-to-bot thread.
  const botThreadParam = Math.trunc(Number(params.get('bot_thread'))) || null
  if (promptParam && slug) pendingPrompt.current = { slug, text: promptParam.slice(0, 2000) }
  useEffect(() => {
    if (!params.has('prompt')) return
    setParams(p => {
      const next = new URLSearchParams(p)
      next.delete('prompt')
      return next
    }, { replace: true })
  }, [params, setParams])
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  // obj 900865: everything below is read through the Bots page cache, bound to
  // the signed-in person. Switching bots no longer remounts this page (App.tsx
  // gives every /chat URL one transition key), and coming back to /chat paints
  // the last bot list at once while it refreshes.
  setChatCacheScope(user ? String(user.id) : null)
  const bots = useCached<AgentsResponse>(AGENTS_KEY, fetchAgents, 'Could not load bots')
  const data = bots.data ?? null
  const load = bots.reload
  const [actionError, setError] = useState<string | null>(null)
  const error = actionError ?? bots.error
  const [demoBusy, setDemoBusy] = useState(false)
  const [newBotOpen, setNewBotOpen] = useState(false)
  // obj 900798: the person's pins, sections, hidden bots and unread state.
  const sidebar = useBotSidebar()
  // obj 900947: every bot's live line + "Needs you" across bots, and which view of the open bot is showing.
  const { status: liveStatus } = useBotStatus()
  const viewParam = params.get('view')
  const view: BotView = BOT_VIEWS.includes(viewParam as BotView) ? (viewParam as BotView) : 'chat'
  const setView = useCallback((v: BotView) => {
    setParams(p => {
      const next = new URLSearchParams(p)
      if (v === 'chat') next.delete('view')
      else next.set('view', v)
      return next
    }, { replace: true })
  }, [setParams])

  const setDemo = async (on: boolean) => {
    setDemoBusy(true)
    try {
      await api.put('/agent-chat/settings', { demo: on })
      await load()
      if (on) navigate('/chat/demo-assistant')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the demo setting')
    } finally {
      setDemoBusy(false)
    }
  }

  const active = data?.agents.find(a => a.slug === slug) ?? null
  // The conversation read the prompt when it mounted; forget it so coming back
  // to this bot later does not type it in again.
  useEffect(() => {
    if (active && pendingPrompt.current?.slug === active.slug) pendingPrompt.current = null
  }, [active])
  const pick = (s: string) => navigate(`/chat/${s}`)
  // Opening a bot reads it (and clears a "Mark as unread"). The sidebar also
  // keeps the open bot read while new replies land in it (obj 900866).
  const { markRead, setActive } = sidebar
  const activeSlug = active?.slug ?? null
  useEffect(() => {
    setActive(activeSlug)
    return () => setActive(null)
  }, [activeSlug, setActive])
  const mergeAgent = (a: ChatAgentInfo) => {
    const d = readCache<AgentsResponse>(AGENTS_KEY)
    if (d) writeCache<AgentsResponse>(AGENTS_KEY, { ...d, agents: d.agents.map(x => (x.slug === a.slug ? { ...x, ...a } : x)) })
  }

  // obj 900865: warm the first few bots once the list is on screen (pinned
  // first, then list order), at idle, so even a first click usually paints
  // from memory. Hover / focus / touch in the sidebar warms any other bot.
  const sidebarBots = sidebar.state?.bots
  const warmOrder = useMemo(() => {
    const entries = sidebarBots ?? {}
    const pinned = Object.entries(entries)
      .filter(([, b]) => b.pinned && !b.hidden)
      .sort(([sa, a], [sb, b]) => a.pin_position - b.pin_position || sa.localeCompare(sb))
      .map(([s]) => s)
    const listed = (data?.agents ?? []).map(a => a.slug)
    const known = new Set(listed)
    return [...new Set([...pinned, ...listed])]
      .filter(s => known.has(s) && !entries[s]?.hidden)
      .slice(0, IDLE_PREFETCH_BOTS)
      .join('\n')
  }, [sidebarBots, data?.agents])
  useEffect(() => {
    if (!warmOrder) return
    const run = () => warmOrder.split('\n').forEach(prefetchBot)
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run, { timeout: 2000 })
      return () => w.cancelIdleCallback?.(id)
    }
    const t = setTimeout(run, 300)
    return () => clearTimeout(t)
  }, [warmOrder])

  if (error && !data) {
    return <div className="p-6"><Alert tone="alarm">{error}</Alert></div>
  }
  if (!data) {
    return (
      <div className={CHAT_PAGE_ROOT_CLASS} aria-busy="true" aria-label="Loading bots">
        <div className={cn('h-full w-full shrink-0 space-y-2 border-line bg-surface-1 p-4 md:block md:w-[300px] md:border-r', slug ? 'hidden' : 'block')}>
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
        </div>
        {/* obj 900865: the conversation pane is never left empty while the list loads. */}
        <div className={cn('h-full min-w-0 flex-1', slug ? 'block' : 'hidden md:block')}>
          <ConversationSkeleton />
        </div>
      </div>
    )
  }

  if (data.agents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <EmptyState
          icon={<span className={cn('grid h-full w-full place-items-center rounded-lg border font-display text-sm font-semibold', COLOUR_CLASSES.green.tile)}>AI</span>}
          title="No bots yet"
          description={
            isAdmin
              ? 'A bot is one file in the agents folder on the server. New bot walks you through making one, or try the demo: a personal assistant bot with a made-up inbox and calendar.'
              : 'Your administrator has not added any bots yet.'
          }
          action={
            isAdmin ? (
              <div className="flex flex-wrap justify-center gap-2">
                <Button variant="primary" loading={demoBusy} onClick={() => void setDemo(true)}>Turn on the demo bot</Button>
                <Button variant="secondary" onClick={() => setNewBotOpen(true)}>New bot</Button>
              </div>
            ) : undefined
          }
        />
        {newBotOpen && <NewBotDialog devBotName={null} onClose={() => setNewBotOpen(false)} />}
      </div>
    )
  }

  return (
    <div className={CHAT_PAGE_ROOT_CLASS} data-testid="chat-page">
      <aside className={cn('relative h-full w-full shrink-0 border-line bg-surface-1 md:block md:w-[300px] md:border-r', active ? 'hidden' : 'block')}>
        <BotSidebar
          data={data}
          active={active?.slug ?? null}
          onPick={pick}
          onPrefetch={prefetchBot}
          isAdmin={isAdmin}
          onDemo={on => void setDemo(on)}
          demoBusy={demoBusy}
          sidebar={sidebar}
          liveStatus={liveStatus}
          onNeedsYou={s => navigate(`/chat/${s}?view=work`)}
          onAgentChanged={mergeAgent}
          onAgentDeleted={gone => {
            if (gone === active?.slug) navigate('/chat')
            void load()
          }}
        />
      </aside>
      <main className={cn('relative h-full min-w-0 flex-1', active ? 'block' : 'hidden md:block')}>
        {active ? (
          <Conversation
            key={active.slug}
            agent={active}
            onBack={() => navigate('/chat')}
            initialText={pendingPrompt.current?.slug === active.slug ? pendingPrompt.current.text : ''}
            meta={data}
            isAdmin={isAdmin}
            onAgentChanged={mergeAgent}
            onActivity={() => void markRead(active.slug)}
            initialBotThread={botThreadParam}
            view={view}
            onView={setView}
            live={liveStatus?.bots[active.slug]}
          />
        ) : (
          <div className="flex h-full items-center justify-center px-6">
            <EmptyState
              title={slug ? `No bot called "${slug}"` : 'Pick a bot'}
              description="Each bot keeps one ongoing conversation with you — opening a bot reopens that conversation, it does not create a new bot. History is stored on this server only."
              compact
            />
          </div>
        )}
      </main>
    </div>
  )
}
