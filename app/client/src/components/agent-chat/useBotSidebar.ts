import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../lib/api'
import { subscribeServerMessages, useWebSocket } from '../../hooks/useWebSocket'
import { isSidebarState, shouldAutoRead } from './sidebar-model'
import { SIDEBAR_KEY, readCache, writeCache } from './chat-cache'
import type { SidebarSection, SidebarState } from './types'

/** How often the sidebar re-reads unread + previews while the page is visible (the backstop for the live push). */
export const SIDEBAR_POLL_MS = 30_000
/** Several replies landing together (a tool turn, a side thread) become one re-read. */
export const SIDEBAR_PUSH_DEBOUNCE_MS = 250

const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

const BASE = '/agent-chat/sidebar'
const bot = (slug: string) => `${BASE}/bots/${encodeURIComponent(slug)}`

/**
 * The person's Bots sidebar (obj 900798): pins, sections, hidden, unread and
 * previews, kept in step with /api/agent-chat/sidebar. Every write answers with
 * the whole new state, so the screen always shows what the server stored.
 *
 * LIVE (obj 900866): the server pings this person's sockets (`agent_chat_unread`,
 * ids only) when a bot reply lands, and the sidebar re-reads at once, so a
 * pending badge appears without waiting for the poll. The bot the person has
 * open, in a tab in front, is read as soon as a new reply shows up there — the
 * badge is for bots that need them, not the one they are looking at.
 *
 * The sidebar is ADDITIVE: a server without the route (or with an odd answer)
 * leaves `state` null and the list falls back to the defaults — talking to a
 * bot must never depend on it.
 */
export function useBotSidebar() {
  // obj 900865: start from the last state this tab saw, so returning to the
  // Bots page paints pins, sections and unread dots at once; refresh() below
  // replaces it with the server's answer.
  const [state, setState] = useState<SidebarState | null>(() => readCache<SidebarState>(SIDEBAR_KEY) ?? null)
  useEffect(() => {
    if (state) writeCache(SIDEBAR_KEY, state)
  }, [state])
  const [error, setError] = useState<string | null>(null)
  const reading = useRef(new Set<string>())
  const activeRef = useRef<string | null>(null)
  const autoRead = useRef<(slug: string) => void>(() => {})

  const take = useCallback((r: unknown) => {
    if (!isSidebarState(r)) return
    setState(r)
    const open = activeRef.current
    if (open && shouldAutoRead(r.bots[open], tabVisible())) autoRead.current(open)
  }, [])

  const refresh = useCallback(async () => {
    try {
      take(await api.get<unknown>(BASE))
    } catch {
      /* leave the sidebar as it is */
    }
  }, [take])

  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh()
    }, SIDEBAR_POLL_MS)
    // Coming back to the tab: catch up now, and read the open bot if it moved.
    const onVisible = () => {
      if (tabVisible()) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // The live push. The chat page has no other socket, so the sidebar opens
  // one; any other socket the app has open delivers here too (page listeners).
  useWebSocket(() => {})
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = subscribeServerMessages(msg => {
      if (msg.type !== 'agent_chat_unread' || timer) return
      timer = setTimeout(() => {
        timer = null
        void refresh()
      }, SIDEBAR_PUSH_DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  /** Run one write; on failure keep the message for the toast and re-read the truth. */
  const run = useCallback(
    async (work: () => Promise<unknown>, failure: string): Promise<boolean> => {
      setError(null)
      try {
        take(await work())
        return true
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : failure)
        void refresh()
        return false
      }
    },
    [take, refresh],
  )

  const patchLocal = useCallback((slug: string, patch: Partial<SidebarState['bots'][string]>) => {
    setState(s => (s && s.bots[slug] ? { ...s, bots: { ...s.bots, [slug]: { ...s.bots[slug], ...patch } } } : s))
  }, [])

  const markRead = useCallback(
    async (slug: string) => {
      // Opening a bot clears its dot at once; the server answer confirms it.
      patchLocal(slug, { unread: false, unread_count: 0, marked_unread: false })
      if (reading.current.has(slug)) return
      reading.current.add(slug)
      try {
        take(await api.post<unknown>(`${bot(slug)}/read`))
      } catch {
        /* the next poll shows the truth */
      } finally {
        reading.current.delete(slug)
      }
    },
    [patchLocal, take],
  )
  autoRead.current = slug => void markRead(slug)

  /** The bot whose conversation is on screen (null = none). Opening one reads it. */
  const setActive = useCallback(
    (slug: string | null) => {
      activeRef.current = slug
      if (slug) void markRead(slug)
    },
    [markRead],
  )

  const markUnread = (slug: string) => run(() => api.post(`${bot(slug)}/unread`), 'Could not mark it unread')
  const setPinned = (slug: string, pinned: boolean) =>
    run(() => api.patch(bot(slug), { pinned }), pinned ? 'Could not pin this bot' : 'Could not unpin this bot')
  const setHidden = (slug: string, hidden: boolean) =>
    run(() => api.patch(bot(slug), { hidden }), hidden ? 'Could not hide this bot' : 'Could not show this bot')
  const moveTo = (slug: string, sectionId: number | null) =>
    run(() => api.patch(bot(slug), { section_id: sectionId }), 'Could not move this bot')

  const createSection = async (name: string): Promise<SidebarSection | null> => {
    setError(null)
    try {
      const r = await api.post<{ section: SidebarSection } & SidebarState>(`${BASE}/sections`, { name })
      take(r)
      return r.section ?? null
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not add the section')
      return null
    }
  }
  const renameSection = (id: number, name: string) => run(() => api.patch(`${BASE}/sections/${id}`, { name }), 'Could not rename the section')
  const setCollapsed = (id: number, collapsed: boolean) => {
    setState(s => (s ? { ...s, sections: s.sections.map(x => (x.id === id ? { ...x, collapsed } : x)) } : s))
    return run(() => api.patch(`${BASE}/sections/${id}`, { collapsed }), 'Could not save that')
  }
  const moveSection = (id: number, by: -1 | 1) => {
    const ids = [...(state?.sections ?? [])].sort((a, b) => a.position - b.position || a.id - b.id).map(s => s.id)
    const i = ids.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= ids.length) return Promise.resolve(false)
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    return run(() => api.put(`${BASE}/sections/order`, { ids }), 'Could not move the section')
  }
  const deleteSection = (id: number) => run(() => api.del(`${BASE}/sections/${id}`), 'Could not delete the section')
  const movePin = (slug: string, by: -1 | 1) => {
    const pinned = Object.entries(state?.bots ?? {})
      .filter(([, b]) => b.pinned && !b.hidden)
      .sort(([sa, a], [sb, b]) => a.pin_position - b.pin_position || sa.localeCompare(sb))
      .map(([s]) => s)
    // The server's order covers every pin, hidden ones included (there are none: hiding unpins).
    const i = pinned.indexOf(slug)
    const j = i + by
    if (i < 0 || j < 0 || j >= pinned.length) return Promise.resolve(false)
    ;[pinned[i], pinned[j]] = [pinned[j], pinned[i]]
    return run(() => api.put(`${BASE}/pins/order`, { slugs: pinned }), 'Could not move the pin')
  }

  return {
    state,
    error,
    setError,
    refresh,
    markRead,
    setActive,
    markUnread,
    setPinned,
    setHidden,
    moveTo,
    movePin,
    createSection,
    renameSection,
    setCollapsed,
    moveSection,
    deleteSection,
  }
}

export type BotSidebarApi = ReturnType<typeof useBotSidebar>
