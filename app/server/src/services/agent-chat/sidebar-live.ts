// ── Live unread badges for the Bots sidebar (obj 900866) ──
//
// When a bot reply lands in a person's conversation, tell that person's open
// tabs so the sidebar badge appears now instead of on the next 30s poll. The
// message carries ids only. The sidebar re-reads GET /api/agent-chat/sidebar,
// which applies the real unread rule (sidebar.ts), and ws/index.ts delivers it
// to that one person's sockets. A failed push never fails the write that
// caused it: the poll is still the backstop.
import { broadcast } from '../../ws/index.js'

export function notifyBotMessage(userId: number, slug: string): void {
  try {
    broadcast({ type: 'agent_chat_unread', payload: { user_id: userId, agent_slug: slug } })
  } catch {
    /* the sidebar's poll picks it up */
  }
}
