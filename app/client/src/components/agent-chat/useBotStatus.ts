import { useCallback, useEffect, useState } from 'react'
import type { BotStatusResponse } from '@operationkit/shared'
import { api } from '../../lib/api'
import { subscribeServerMessages } from '../../hooks/useWebSocket'

/** How often the sidebar live lines re-read while the page is visible. */
export const BOT_STATUS_POLL_MS = 30_000

const tabVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden'

/** A runtime check, so an older server (no route, or an odd answer) leaves the sidebar as it was. */
export function isBotStatusResponse(v: unknown): v is BotStatusResponse {
  const r = v as BotStatusResponse | null
  return !!r && typeof r === 'object' && !!r.bots && typeof r.bots === 'object' && typeof r.needs_you_total === 'number'
}

/**
 * Every bot's live line + status dot and the "Needs you" count across bots
 * (obj 900947), from GET /api/agent-chat/bot-status. ADDITIVE like the rest of
 * the sidebar: if the read fails the rows render exactly as before.
 *
 * Re-reads on a poll while the tab is visible, when the tab comes back, and
 * when a bot posts to a chat (the same live ping the unread badge uses — a
 * "needs you" post is one of those).
 */
export function useBotStatus(): { status: BotStatusResponse | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<BotStatusResponse | null>(null)
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<unknown>('/agent-chat/bot-status')
      if (isBotStatusResponse(r)) setStatus(r)
    } catch {
      /* leave it as it is */
    }
  }, [])
  useEffect(() => {
    void refresh()
    const t = setInterval(() => {
      if (tabVisible()) void refresh()
    }, BOT_STATUS_POLL_MS)
    const onVisible = () => {
      if (tabVisible()) void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    const off = subscribeServerMessages(msg => {
      if ((msg as { type?: string }).type === 'agent_chat_unread') void refresh()
    })
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      off()
    }
  }, [refresh])
  return { status, refresh }
}
