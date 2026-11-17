import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  FolderInput,
  FolderPlus,
  Mail,
  MailOpen,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Trash2,
  Bot as BotIcon,
  ClipboardPaste,
  LayoutTemplate,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { Button, IconButton, Modal, SearchInput, Toast, cn, useConfirm } from '../ui'
import { copyText } from '../ui/CopyButton'
import { AgentAvatar } from './ChatItems'
import { FullAccessBadge, fullAccessSentence } from './FullAccessBadge'
import { ContextMenu, type MenuAnchor, type MenuItem } from './ContextMenu'
import { botState, buildSidebarView, pendingBadge, pendingTotal, shortTime, type SidebarFilter } from './sidebar-model'
import { DEV_BOT_SLUG, devBotLink } from '../agents/CreateAgentGuide'
import { agentsTabRoute } from '../../lib/routes'
import type { BotSidebarApi } from './useBotSidebar'
import type { AgentsResponse, ChatAgentInfo, SidebarBot, SidebarSection } from './types'
import type { BotStatusEntry, BotStatusResponse } from '@operationkit/shared'
import { BotLiveLine } from './BotLiveStatus'

/* The Bots sidebar (obj 900798).

   Layout, top to bottom:
     header       "Bots" + New section + New bot (admins; obj 900866)
     filter       search box + chips (All · Unread · Pinned · <sections> · Hidden)
     pinned rail  large avatars for the bots you pinned, one click away
     sections     your named groups, in your order, then "Other bots"
     rows         avatar · name · time · last-message preview · pending badge

   PENDING BADGE (obj 900866). A bot "needs you" when it has a reply you have
   not opened or answered (the server's unread rule, sidebar.ts), or you marked
   it unread. The badge is a filled accent pill holding the number of waiting
   replies (no number for a plain "Mark as unread"); it sits on the row, on
   the pinned tile and on a collapsed section, and the header says how many
   replies are waiting in total. It arrives live (a WebSocket ping, see
   useBotSidebar) and clears the moment the bot is opened.

   Every arrangement here (pins, sections, hidden, read state) is the
   person's OWN and is stored server-side per person (useBotSidebar). Only the
   two bot-wide actions in the menu — Rename and Delete — change the bot for
   everyone, so only an admin sees them, behind the same signed-in-admin gate
   as the bot's model and tools; Delete always asks first.

   Styling is token-only (surface-*, fg-*, line, accent), so light/dark and a
   white-label accent come for free; there is no product-specific chrome. */

type MenuState =
  | { kind: 'bot'; agent: ChatAgentInfo; anchor: MenuAnchor; trigger: HTMLElement | null }
  | { kind: 'section'; section: SidebarSection; anchor: MenuAnchor; trigger: HTMLElement | null }

type DialogState =
  | { kind: 'new-bot' }
  | { kind: 'new-section'; thenMove?: string }
  | { kind: 'rename-section'; section: SidebarSection }
  | { kind: 'rename-bot'; agent: ChatAgentInfo }

const LONG_PRESS_MS = 500

/** Anchor a menu at a trigger button's bottom-right corner. */
function anchorFor(el: HTMLElement): MenuAnchor {
  const r = el.getBoundingClientRect()
  return { x: Math.max(0, r.right - 240), y: r.bottom + 4 }
}

/** Long-press on touch opens the menu (iOS Safari fires no contextmenu event). */
function useLongPress(open: (anchor: MenuAnchor, el: HTMLElement) => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  useEffect(() => cancel, [])
  return {
    fired,
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      fired.current = false
      if (e.pointerType !== 'touch') return
      const el = e.currentTarget
      const at = { x: e.clientX, y: e.clientY }
      cancel()
      timer.current = setTimeout(() => {
        fired.current = true
        open(at, el)
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onPointerCancel: cancel,
  }
}

/** The pending badge: a filled accent pill with the waiting-reply count (obj 900866). */
export function PendingBadge({ entry, className }: { entry: SidebarBot; className?: string }) {
  const b = pendingBadge(entry)
  if (!b) return null
  return (
    <span
      role="status"
      aria-label={b.label}
      title={b.label}
      data-pending-badge=""
      className={cn(
        'inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold leading-none tabular-nums text-accent-fg',
        !b.text && 'h-2.5 min-w-0 w-2.5 px-0',
        className,
      )}
    >
      {b.text}
    </span>
  )
}

// ── one bot ──

function previewFor(a: ChatAgentInfo, b: SidebarBot): string {
  const m = b.last_message
  if (!m) return a.description || 'No messages yet'
  const where = m.thread_title ? `${m.thread_title} · ` : ''
  return `${where}${m.role === 'user' ? 'You: ' : ''}${m.preview || '…'}`
}

function BotRow({
  agent,
  entry,
  live,
  active,
  onPick,
  onMenu,
}: {
  agent: ChatAgentInfo
  entry: SidebarBot
  /** obj 900947: what the bot is doing now (dot + live line). Absent = the row reads as before. */
  live?: BotStatusEntry
  active: boolean
  onPick: () => void
  onMenu: (anchor: MenuAnchor, trigger: HTMLElement) => void
}) {
  const press = useLongPress(onMenu)
  const time = entry.last_message ? shortTime(entry.last_message.created_at) : ''
  return (
    <li className="group relative" data-bot={agent.slug}>
      <button
        onClick={() => {
          if (press.fired.current) return
          onPick()
        }}
        onContextMenu={(e: ReactMouseEvent<HTMLButtonElement>) => {
          e.preventDefault()
          const kb = e.clientX === 0 && e.clientY === 0
          onMenu(kb ? anchorFor(e.currentTarget) : { x: e.clientX, y: e.clientY }, e.currentTarget)
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerCancel}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex min-h-[56px] w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          // obj 900865: the picked row lights up in the same frame as the new
          // bot's header (no fade-in); only the row you left, and hover, fade.
          active ? 'bg-surface-3' : 'transition-colors duration-fast hover:bg-surface-2',
        )}
      >
        <AgentAvatar agent={agent} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-base text-fg-0', entry.unread ? 'font-semibold' : 'font-medium')}>{agent.name}</span>
            {time && (
              <span
                className={cn(
                  'shrink-0 text-xs tabular-nums transition-opacity duration-fast group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:opacity-0',
                  entry.unread ? 'text-fg-1' : 'text-fg-3',
                )}
              >
                {time}
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm', entry.unread ? 'text-fg-1' : 'text-fg-2')}>{previewFor(agent, entry)}</span>
            {/* obj 900972: this bot has Full access in a workspace right now. */}
            <FullAccessBadge access={agent.full_access} />
            <PendingBadge entry={entry} />
          </span>
          {live && <BotLiveLine entry={live} className="mt-0.5" />}
        </span>
      </button>
      <button
        type="button"
        aria-label={`Actions for ${agent.name}`}
        aria-haspopup="menu"
        onClick={e => onMenu(anchorFor(e.currentTarget), e.currentTarget)}
        className={cn(
          'absolute right-1.5 top-2 grid h-7 w-7 place-items-center rounded-md text-fg-2 transition-opacity duration-fast',
          'hover:bg-surface-4 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          'opacity-0 focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100',
        )}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
      </button>
    </li>
  )
}

function PinnedTile({
  agent,
  entry,
  active,
  onPick,
  onMenu,
}: {
  agent: ChatAgentInfo
  entry: SidebarBot
  active: boolean
  onPick: () => void
  onMenu: (anchor: MenuAnchor, trigger: HTMLElement) => void
}) {
  const press = useLongPress(onMenu)
  return (
    <li className="min-w-0" data-bot-tile={agent.slug}>
      <button
        onClick={() => {
          if (press.fired.current) return
          onPick()
        }}
        onContextMenu={e => {
          e.preventDefault()
          const kb = e.clientX === 0 && e.clientY === 0
          onMenu(kb ? anchorFor(e.currentTarget) : { x: e.clientX, y: e.clientY }, e.currentTarget)
        }}
        onPointerDown={press.onPointerDown}
        onPointerUp={press.onPointerUp}
        onPointerLeave={press.onPointerLeave}
        onPointerCancel={press.onPointerCancel}
        aria-current={active ? 'page' : undefined}
        aria-label={`${agent.name}${entry.unread ? ` (${pendingBadge(entry)?.label ?? 'unread'})` : ''} — pinned${agent.full_access?.workspaces.length ? ` — ${fullAccessSentence(agent.full_access)}` : ''}`}
        title={agent.name}
        className="group flex w-full flex-col items-center gap-1.5 rounded-xl px-1 pb-1.5 pt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        <span className="relative">
          <AgentAvatar
            agent={agent}
            size="xl"
            className={cn(
              'transition-transform duration-fast group-hover:-translate-y-px',
              active && 'ring-2 ring-accent ring-offset-2 ring-offset-surface-1',
            )}
          />
          <PendingBadge entry={entry} className="absolute -right-1.5 -top-1 ring-2 ring-surface-1" />
          <FullAccessBadge access={agent.full_access} variant="icon" className="absolute -bottom-1 -right-1.5" />
        </span>
        <span className={cn('block w-full truncate text-center text-xs', active || entry.unread ? 'text-fg-0' : 'text-fg-2', entry.unread && 'font-semibold')}>
          {agent.name}
        </span>
      </button>
    </li>
  )
}

// ── a name prompt: new section, rename section, rename bot ──

function NameDialog({
  title,
  label,
  initial,
  hint,
  maxLength,
  confirmLabel,
  onSubmit,
  onClose,
  extra,
}: {
  title: string
  label: string
  initial: string
  hint?: string
  maxLength: number
  confirmLabel: string
  onSubmit: (value: string) => Promise<boolean>
  onClose: () => void
  extra?: { label: string; onClick: () => Promise<boolean> }
}) {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    const ok = await onSubmit(value.trim())
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Modal open onClose={onClose} labelledBy="bot-sidebar-dialog-title" panelClassName="w-full max-w-sm">
      <form className="p-5" onSubmit={e => void submit(e)}>
        <h2 id="bot-sidebar-dialog-title" className="font-display text-lg font-semibold tracking-tight text-fg-0">
          {title}
        </h2>
        <label htmlFor="bot-sidebar-dialog-input" className="mt-4 block text-sm font-medium text-fg-1">
          {label}
        </label>
        <input
          id="bot-sidebar-dialog-input"
          data-autofocus
          autoFocus
          value={value}
          maxLength={maxLength}
          onChange={e => setValue(e.target.value)}
          className="mt-1.5 min-h-[44px] w-full rounded-md border border-line bg-surface-field px-3 text-base text-fg-0 focus:border-accent focus:outline-none focus:ring-1 focus:ring-inset focus:ring-accent sm:min-h-[38px]"
        />
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-fg-2">{hint}</p>}
        <div className="mt-5 flex items-center gap-2">
          {extra && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                const ok = await extra.onClick()
                setBusy(false)
                if (ok) onClose()
              }}
            >
              {extra.label}
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" size="sm" loading={busy} disabled={!value.trim()}>
            {confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

// ── New bot (obj 900866) ──

const choice = cn(
  'flex w-full items-start gap-3 rounded-lg border border-line bg-surface-1 p-3 text-left transition-colors duration-fast',
  'hover:border-line-strong hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
)

/**
 * The New bot button opens the EXISTING create-bot flow (obj 900672's
 * CreateAgentGuide), not a second one: ask the Dev bot (its conversation opens
 * with the request typed, never sent), start from a template, or paste a bot
 * file. The Dev bot path is existence-gated on the live bot list, like the
 * guide; without it the template and paste paths remain.
 */
export function NewBotDialog({ devBotName, onClose }: { devBotName: string | null; onClose: () => void }) {
  const items = [
    ...(devBotName
      ? [
          {
            key: 'dev',
            to: devBotLink('bot'),
            icon: <BotIcon className="h-5 w-5" aria-hidden="true" />,
            title: `Ask ${devBotName}`,
            text: 'It asks what the bot is for, writes the bot file for you, and tells you where it goes. Nothing is sent until you press Send.',
          },
        ]
      : []),
    {
      key: 'template',
      to: agentsTabRoute('templates'),
      icon: <LayoutTemplate className="h-5 w-5" aria-hidden="true" />,
      title: 'Start from a template',
      text: 'Add a ready-made bot, then change its instructions to fit.',
    },
    {
      key: 'paste',
      to: `${agentsTabRoute('templates')}&paste=1`,
      icon: <ClipboardPaste className="h-5 w-5" aria-hidden="true" />,
      title: 'Paste a bot file',
      text: 'Already have one? Paste or upload it. It is checked before it is added.',
    },
  ]
  return (
    <Modal open onClose={onClose} labelledBy="new-bot-dialog-title" panelClassName="w-full max-w-md">
      <div className="p-5">
        <h2 id="new-bot-dialog-title" className="font-display text-lg font-semibold tracking-tight text-fg-0">
          New bot
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-fg-2">A bot is someone you chat with here. Pick how to make one.</p>
        <ul className="mt-4 space-y-2">
          {items.map((it, i) => (
            <li key={it.key}>
              <Link to={it.to} onClick={onClose} className={choice} data-autofocus={i === 0 ? '' : undefined} data-new-bot={it.key}>
                <span className="mt-0.5 shrink-0 text-fg-2">{it.icon}</span>
                <span className="min-w-0">
                  <span className="block text-base font-medium text-fg-0">{it.title}</span>
                  <span className="mt-0.5 block text-sm leading-relaxed text-fg-2">{it.text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  )
}

// ── the sidebar ──

export function BotSidebar({
  data,
  active,
  onPick,
  onPrefetch,
  isAdmin,
  onDemo,
  demoBusy,
  sidebar,
  onAgentChanged,
  onAgentDeleted,
  liveStatus = null,
  onNeedsYou,
}: {
  data: AgentsResponse
  active: string | null
  onPick: (slug: string) => void
  /**
   * The person is about to open this bot (pointer over it, keyboard focus on
   * it, a finger down on it): warm its conversation so the click paints at
   * once (obj 900865). Optional; the list works the same without it.
   */
  onPrefetch?: (slug: string) => void
  isAdmin: boolean
  onDemo: (on: boolean) => void
  demoBusy: boolean
  sidebar: BotSidebarApi
  /** A bot was renamed: merge it into the page's list. */
  onAgentChanged: (a: ChatAgentInfo) => void
  /** A bot was deleted for everyone: reload the list (and leave its page). */
  onAgentDeleted: (slug: string) => void
  /** obj 900947: every bot's live line + the "Needs you" count across bots. Optional. */
  liveStatus?: BotStatusResponse | null
  /** Open the bot whose card needs the person (the header's "Needs you" link). */
  onNeedsYou?: (slug: string) => void
}) {
  const { state } = sidebar
  const [filter, setFilter] = useState<SidebarFilter>('all')
  const [query, setQuery] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [toast, setToast] = useState<{ tone: 'info' | 'alarm'; text: string } | null>(null)
  const { confirm, confirmDialog } = useConfirm()

  const sections = useMemo(() => [...(state?.sections ?? [])].sort((a, b) => a.position - b.position || a.id - b.id), [state?.sections])
  // A filter pointing at a section that was deleted falls back to All.
  useEffect(() => {
    if (filter.startsWith('section:') && !sections.some(s => `section:${s.id}` === filter)) setFilter('all')
  }, [filter, sections])
  // One delegated listener for every row and pinned tile (they carry data-bot).
  const warm = (e: { target: EventTarget | null }) => {
    if (!onPrefetch || !(e.target instanceof Element)) return
    const el = e.target.closest<HTMLElement>('[data-bot],[data-bot-tile]')
    const slug = el?.dataset.bot ?? el?.dataset.botTile
    if (slug && slug !== active) onPrefetch(slug)
  }
  const view = useMemo(() => buildSidebarView(data.agents, state, filter, query), [data.agents, state, filter, query])
  // Replies waiting across every bot the person has not hidden.
  const waiting = useMemo(() => pendingTotal(data.agents.filter(a => !botState(state, a.slug).hidden), state), [data.agents, state])
  const devBot = data.agents.find(a => a.slug === DEV_BOT_SLUG) ?? null
  // obj 900947: cards across every bot that need the person (each card once, server-counted).
  const needsYou = liveStatus?.needs_you_total ?? 0
  const firstNeeding = useMemo(
    () => data.agents.find(a => (liveStatus?.bots[a.slug]?.counts.needs_you ?? 0) > 0)?.slug ?? null,
    [data.agents, liveStatus],
  )

  // Hook errors surface as the same toast as the menu's own messages.
  useEffect(() => {
    if (sidebar.error) setToast({ tone: 'alarm', text: sidebar.error })
  }, [sidebar.error])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => {
      setToast(null)
      sidebar.setError(null)
    }, 3500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast])

  const closeMenu = useCallback(
    (restore: boolean) => {
      setMenu(m => {
        if (restore && m?.trigger?.isConnected) setTimeout(() => m.trigger?.focus(), 0)
        return null
      })
    },
    [],
  )

  const renameBot = async (a: ChatAgentInfo, name: string | null): Promise<boolean> => {
    try {
      const r = await api.put<{ agent: ChatAgentInfo }>(`/agent-chat/agents/${encodeURIComponent(a.slug)}/config`, { name })
      onAgentChanged(r.agent)
      setToast({ tone: 'info', text: name ? `Renamed to ${r.agent.name}` : `Back to ${r.agent.name}` })
      return true
    } catch (e) {
      setToast({ tone: 'alarm', text: e instanceof Error && e.message ? e.message : 'Could not rename this bot' })
      return false
    }
  }

  const deleteBot = async (a: ChatAgentInfo) => {
    const ok = await confirm({
      title: `Delete ${a.name} for everyone?`,
      message: `${a.name} leaves every person's Bots list and its scheduled wakes stop. Its agent folder is moved to .deleted/ on the server, so an admin can bring it back. Everyone's chat history with it is kept.`,
      confirmLabel: 'Delete bot',
      danger: true,
    })
    if (!ok) return
    try {
      await api.del(`/agent-chat/agents/${encodeURIComponent(a.slug)}`)
      setToast({ tone: 'info', text: `${a.name} was deleted` })
      onAgentDeleted(a.slug)
      void sidebar.refresh()
    } catch (e) {
      setToast({ tone: 'alarm', text: e instanceof Error && e.message ? e.message : 'Could not delete this bot' })
    }
  }

  const botMenuItems = (a: ChatAgentInfo): MenuItem[] => {
    const b = botState(state, a.slug)
    const pinnedCount = Object.values(state?.bots ?? {}).filter(x => x.pinned).length
    const atPinCap = !b.pinned && !!state && pinnedCount >= state.max_pins
    const pinnedOrder = view.rail.map(x => x.slug)
    const pinIndex = pinnedOrder.indexOf(a.slug)
    const moveItems: MenuItem[] = [
      ...sections.map(s => ({
        key: `to-${s.id}`,
        label: s.name,
        checked: b.section_id === s.id,
        onSelect: () => void sidebar.moveTo(a.slug, s.id),
      })),
      { key: 'to-none', label: 'Other bots (no section)', checked: b.section_id === null, onSelect: () => void sidebar.moveTo(a.slug, null), separator: sections.length > 0 },
      { key: 'to-new', label: 'New section…', icon: <Plus className="h-4 w-4" />, onSelect: () => setDialog({ kind: 'new-section', thenMove: a.slug }) },
    ]
    const builtinOrDemo = a.source === 'builtin' || a.source === 'demo'
    return [
      b.pinned
        ? { key: 'unpin', label: 'Unpin', icon: <PinOff className="h-4 w-4" />, onSelect: () => void sidebar.setPinned(a.slug, false) }
        : {
            key: 'pin',
            label: 'Pin to top',
            icon: <Pin className="h-4 w-4" />,
            disabled: atPinCap,
            hint: atPinCap ? `Up to ${state?.max_pins} pins — unpin one first` : undefined,
            onSelect: () => void sidebar.setPinned(a.slug, true),
          },
      ...(b.pinned && pinIndex > 0
        ? [{ key: 'pin-left', label: 'Move pin left', icon: <ArrowLeft className="h-4 w-4" />, onSelect: () => void sidebar.movePin(a.slug, -1) }]
        : []),
      ...(b.pinned && pinIndex >= 0 && pinIndex < pinnedOrder.length - 1
        ? [{ key: 'pin-right', label: 'Move pin right', icon: <ArrowRight className="h-4 w-4" />, onSelect: () => void sidebar.movePin(a.slug, 1) }]
        : []),
      { key: 'move', label: 'Move to section', icon: <FolderInput className="h-4 w-4" />, submenu: moveItems },
      b.unread
        ? { key: 'read', label: 'Mark as read', icon: <MailOpen className="h-4 w-4" />, onSelect: () => void sidebar.markRead(a.slug) }
        : { key: 'unread', label: 'Mark as unread', icon: <Mail className="h-4 w-4" />, onSelect: () => void sidebar.markUnread(a.slug) },
      ...(isAdmin
        ? [{ key: 'rename', label: 'Rename…', icon: <Pencil className="h-4 w-4" />, onSelect: () => setDialog({ kind: 'rename-bot', agent: a }) }]
        : []),
      {
        key: 'copy',
        label: 'Copy ID',
        icon: <Copy className="h-4 w-4" />,
        detail: a.slug,
        onSelect: () =>
          void copyText(a.slug).then(ok => setToast(ok ? { tone: 'info', text: `Copied ${a.slug}` } : { tone: 'alarm', text: 'Could not copy — your browser blocked it' })),
      },
      b.hidden
        ? { key: 'show', label: 'Show in sidebar', icon: <Eye className="h-4 w-4" />, onSelect: () => void sidebar.setHidden(a.slug, false) }
        : {
            key: 'hide',
            label: 'Hide from sidebar',
            icon: <EyeOff className="h-4 w-4" />,
            onSelect: () =>
              void sidebar.setHidden(a.slug, true).then(ok => ok && setToast({ tone: 'info', text: `${a.name} is hidden — find it under the Hidden filter` })),
          },
      ...(isAdmin
        ? [
            {
              key: 'delete',
              label: 'Delete…',
              icon: <Trash2 className="h-4 w-4" />,
              danger: true,
              separator: true,
              disabled: builtinOrDemo,
              hint: builtinOrDemo ? (a.source === 'demo' ? 'Turn the demo off instead' : 'Ships with the app — hide it instead') : undefined,
              onSelect: () => void deleteBot(a),
            },
          ]
        : []),
    ]
  }

  const sectionMenuItems = (s: SidebarSection): MenuItem[] => {
    const i = sections.findIndex(x => x.id === s.id)
    return [
      { key: 'rename', label: 'Rename section…', icon: <Pencil className="h-4 w-4" />, onSelect: () => setDialog({ kind: 'rename-section', section: s }) },
      { key: 'up', label: 'Move up', icon: <ArrowUp className="h-4 w-4" />, disabled: i <= 0, onSelect: () => void sidebar.moveSection(s.id, -1) },
      {
        key: 'down',
        label: 'Move down',
        icon: <ArrowDown className="h-4 w-4" />,
        disabled: i < 0 || i >= sections.length - 1,
        onSelect: () => void sidebar.moveSection(s.id, 1),
      },
      {
        key: 'delete',
        label: 'Delete section…',
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        separator: true,
        hint: 'Its bots move to Other bots',
        onSelect: () =>
          void (async () => {
            const ok = await confirm({
              title: `Delete the section "${s.name}"?`,
              message: 'Only the section goes. Its bots move to Other bots — none are deleted or hidden.',
              confirmLabel: 'Delete section',
              danger: true,
            })
            if (ok) await sidebar.deleteSection(s.id)
          })(),
      },
    ]
  }

  const openBotMenu = (a: ChatAgentInfo) => (anchor: MenuAnchor, trigger: HTMLElement) => setMenu({ kind: 'bot', agent: a, anchor, trigger })

  const chips: { key: SidebarFilter; label: string; count?: number }[] = [
    { key: 'all', label: 'All' },
    { key: 'unread', label: 'Unread', count: view.counts.unread },
    { key: 'pinned', label: 'Pinned', count: view.counts.pinned },
    ...sections.map(s => ({ key: `section:${s.id}` as SidebarFilter, label: s.name })),
    ...(view.counts.hidden > 0 || filter === 'hidden' ? [{ key: 'hidden' as SidebarFilter, label: 'Hidden', count: view.counts.hidden }] : []),
  ]

  const emptyText =
    query.trim() !== ''
      ? `No bots match "${query.trim()}"`
      : filter === 'unread'
        ? "You're all caught up"
        : filter === 'pinned'
          ? 'Nothing pinned yet — open a bot\'s menu and pick Pin to top'
          : filter === 'hidden'
            ? 'No hidden bots'
            : filter.startsWith('section:')
              ? 'No bots in this section yet — move one here from its menu'
              : 'Every bot is hidden — see the Hidden filter'

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-1.5 px-4 pb-1 pt-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold tracking-tight text-fg-0">Bots</h1>
          <p className="mt-0.5 text-sm text-fg-2" aria-live="polite">
            {waiting > 0 ? (
              <button
                type="button"
                onClick={() => setFilter('unread')}
                className="rounded text-left font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                {waiting === 1 ? '1 reply waiting on you' : `${waiting > 99 ? '99+' : waiting} replies waiting on you`}
              </button>
            ) : (
              'One ongoing conversation with each bot.'
            )}
          </p>
          {needsYou > 0 && (
            <p className="mt-1">
              <button
                type="button"
                data-testid="bots-needs-you"
                onClick={() => firstNeeding && onNeedsYou?.(firstNeeding)}
                aria-label={`${needsYou} card${needsYou === 1 ? '' : 's'} across your bots need${needsYou === 1 ? 's' : ''} you`}
                className="inline-flex items-center gap-1.5 rounded-full border border-status-human/30 bg-status-human/10 px-2 py-0.5 text-xs font-medium text-status-human hover:bg-status-human/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-status-human" aria-hidden="true" />
                <span className="font-mono font-semibold tabular-nums">{needsYou > 99 ? '99+' : needsYou}</span>
                Needs you
              </button>
            </p>
          )}
        </div>
        <IconButton label="New section" onClick={() => setDialog({ kind: 'new-section' })} className="h-8 w-8">
          <FolderPlus className="h-[18px] w-[18px]" aria-hidden="true" />
        </IconButton>
        {isAdmin && (
          <Button variant="primary" size="sm" leftIcon={<Plus className="h-4 w-4" aria-hidden="true" />} onClick={() => setDialog({ kind: 'new-bot' })}>
            New bot
          </Button>
        )}
      </div>

      <div role="search" aria-label="Filter bots" className="space-y-2 px-3 pb-2 pt-1">
        <SearchInput
          aria-label="Filter bots by name or message"
          placeholder="Filter bots"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              setQuery('')
            }
          }}
          className="bg-surface-2"
        />
        <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]" aria-label="Show">
          {chips.map(c => {
            const on = filter === c.key
            return (
              <button
                key={c.key}
                type="button"
                aria-pressed={on}
                onClick={() => setFilter(c.key)}
                className={cn(
                  'flex min-h-[32px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-sm transition-colors duration-fast sm:min-h-[28px]',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
                  on ? 'border-transparent bg-fg-0 text-surface-0' : 'border-line text-fg-2 hover:border-line-strong hover:text-fg-0',
                )}
              >
                {c.label}
                {!!c.count && c.count > 0 && <span className={cn('tabular-nums', on ? 'opacity-70' : 'text-fg-3')}>{c.count}</span>}
              </button>
            )
          })}
        </div>
      </div>

      <nav
        aria-label="Bots"
        className="relative min-h-0 flex-1 overflow-y-auto px-2 pb-3"
        onPointerOver={warm}
        onPointerDown={warm}
        onFocus={warm}
      >
        {view.rail.length > 0 && (
          <section aria-label="Pinned bots" className="px-1 pb-2 pt-1">
            <ul className="grid grid-cols-4 gap-x-1 gap-y-2">
              {view.rail.map(a => (
                <PinnedTile
                  key={a.slug}
                  agent={a}
                  entry={botState(state, a.slug)}
                  active={a.slug === active}
                  onPick={() => onPick(a.slug)}
                  onMenu={openBotMenu(a)}
                />
              ))}
            </ul>
          </section>
        )}

        {view.groups.map(g => {
          const collapsed = !!g.section?.collapsed && filter === 'all' && !query.trim()
          const unreadIn = pendingTotal(g.agents, state)
          return (
            <section key={g.key} aria-label={g.title ?? 'Bots'} className={cn(g.title && 'mt-2 first:mt-0')}>
              {g.title && (
                <div className="group/section flex items-center gap-1 px-1.5 pb-1 pt-2">
                  {g.section ? (
                    <button
                      type="button"
                      aria-expanded={!collapsed}
                      onClick={() => void sidebar.setCollapsed(g.section!.id, !g.section!.collapsed)}
                      onContextMenu={e => {
                        e.preventDefault()
                        setMenu({ kind: 'section', section: g.section!, anchor: { x: e.clientX, y: e.clientY }, trigger: e.currentTarget })
                      }}
                      className="flex min-h-[28px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
                    >
                      <ChevronDown
                        className={cn('h-3.5 w-3.5 shrink-0 text-fg-3 transition-transform duration-fast', collapsed && '-rotate-90')}
                        aria-hidden="true"
                      />
                      <span className="truncate text-xs font-semibold uppercase tracking-eyebrow text-fg-2">{g.title}</span>
                      {collapsed && unreadIn > 0 && (
                        <span
                          role="status"
                          aria-label={`${unreadIn} unread in this section`}
                          className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold leading-none tabular-nums text-accent-fg"
                        >
                          {unreadIn > 99 ? '99+' : unreadIn}
                        </span>
                      )}
                    </button>
                  ) : (
                    <h2 className="flex min-h-[28px] min-w-0 flex-1 items-center px-1 text-xs font-semibold uppercase tracking-eyebrow text-fg-2">
                      {g.title}
                    </h2>
                  )}
                  {g.section && (
                    <button
                      type="button"
                      aria-label={`Actions for the section ${g.title}`}
                      aria-haspopup="menu"
                      onClick={e => setMenu({ kind: 'section', section: g.section!, anchor: anchorFor(e.currentTarget), trigger: e.currentTarget })}
                      className="grid h-7 w-7 place-items-center rounded-md text-fg-3 opacity-0 transition-opacity duration-fast hover:bg-surface-3 hover:text-fg-0 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 group-hover/section:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                    </button>
                  )}
                </div>
              )}
              {!collapsed &&
                (g.agents.length > 0 ? (
                  <ul className="space-y-px">
                    {g.agents.map(a => (
                      <BotRow
                        key={a.slug}
                        agent={a}
                        entry={botState(state, a.slug)}
                        live={liveStatus?.bots[a.slug]}
                        active={a.slug === active}
                        onPick={() => onPick(a.slug)}
                        onMenu={openBotMenu(a)}
                      />
                    ))}
                  </ul>
                ) : (
                  g.section && <p className="px-3 pb-1 text-xs text-fg-3">Empty — move a bot here from its menu.</p>
                ))}
            </section>
          )
        })}

        {view.empty && <p className="px-3 py-6 text-center text-sm text-fg-2">{emptyText}</p>}
      </nav>

      {isAdmin && (data.problems?.length ?? 0) > 0 && (
        <section aria-label="Bots that need fixing" className="relative max-h-[40%] shrink-0 overflow-y-auto border-t border-line-soft px-3 py-3">
          <h3 className="px-1 text-xs font-medium text-fg-2">Needs fixing</h3>
          <ul className="mt-1.5 space-y-1.5">
            {data.problems!.map(p => (
              <li key={p.file} data-bot-problem={p.slug} className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                  <span className="min-w-0 truncate font-medium text-fg-0">{p.slug}</span>
                </div>
                <p className="mt-1 text-xs text-fg-1">
                  {p.withheld
                    ? 'This bot is off until its file is fixed. The built-in version was not loaded in its place.'
                    : 'This bot is off until its file is fixed.'}
                </p>
                {p.errors.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-fg-2">
                    {p.errors.map((e, i) => (
                      <li key={i} className="break-words">{e}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-1 break-all font-mono text-xs text-fg-2">{p.file}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {isAdmin && (
        <div className="border-t border-line-soft px-4 py-3">
          <button
            onClick={() => onDemo(!data.demo)}
            disabled={demoBusy}
            className="min-h-[44px] w-full rounded-md px-2 text-left text-sm text-fg-2 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-45"
          >
            {data.demo ? 'Demo bot is on — turn it off' : 'Turn on the demo bot (sample inbox + calendar)'}
          </button>
        </div>
      )}

      {menu?.kind === 'bot' && (
        <ContextMenu label={`Actions for ${menu.agent.name}`} items={botMenuItems(menu.agent)} anchor={menu.anchor} onClose={closeMenu} />
      )}
      {menu?.kind === 'section' && (
        <ContextMenu label={`Actions for the section ${menu.section.name}`} items={sectionMenuItems(menu.section)} anchor={menu.anchor} onClose={closeMenu} />
      )}

      {dialog?.kind === 'new-bot' && <NewBotDialog devBotName={devBot?.name ?? null} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'new-section' && (
        <NameDialog
          title="New section"
          label="Section name"
          initial=""
          hint="Group bots the way you work, e.g. Development or Marketing. Only you see your sections."
          maxLength={40}
          confirmLabel="Add section"
          onClose={() => setDialog(null)}
          onSubmit={async name => {
            const s = await sidebar.createSection(name)
            if (s && dialog.thenMove) await sidebar.moveTo(dialog.thenMove, s.id)
            return !!s
          }}
        />
      )}
      {dialog?.kind === 'rename-section' && (
        <NameDialog
          title="Rename section"
          label="Section name"
          initial={dialog.section.name}
          maxLength={40}
          confirmLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={name => sidebar.renameSection(dialog.section.id, name)}
        />
      )}
      {dialog?.kind === 'rename-bot' && (
        <NameDialog
          title={`Rename ${dialog.agent.name}`}
          label="Bot name"
          initial={dialog.agent.name}
          hint={`Renames the bot for everyone on this install. Its ID (${dialog.agent.slug}) and link stay the same.`}
          maxLength={60}
          confirmLabel="Rename"
          onClose={() => setDialog(null)}
          onSubmit={name => renameBot(dialog.agent, name)}
          extra={
            dialog.agent.file_name && dialog.agent.file_name !== dialog.agent.name
              ? { label: `Reset to "${dialog.agent.file_name}"`, onClick: () => renameBot(dialog.agent, null) }
              : undefined
          }
        />
      )}

      {toast && (
        <div className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-4 z-[70] sm:bottom-4">
          <Toast tone={toast.tone} onDismiss={() => setToast(null)}>
            {toast.text}
          </Toast>
        </div>
      )}
      {confirmDialog}
    </div>
  )
}
