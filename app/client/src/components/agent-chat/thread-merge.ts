// Shared by the conversation and the reply-thread panel (obj 901373): both send
// into a lane and fold the server's answer into that lane's cached copy.
import type { ThreadResponse } from './types'

/** A fresh client_msg_id: 8-64 of [A-Za-z0-9_-], the shape the server accepts. */
export function newClientMsgId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

export function mergeThread(t: ThreadResponse | null, r: ThreadResponse): ThreadResponse {
  const prev = t ?? { messages: [], drafts: [], cards: [] }
  const byId = <T extends { id: number }>(a: T[], b: T[]) => [...new Map([...a, ...b].map(x => [x.id, x])).values()]
  // obj 900977: a queued message is re-filed under a NEW row id when the bot
  // picks it up. A POST answer that lands after a re-read already showed the
  // delivered row must not add the old queued row back beside it.
  const delivered = new Set(prev.messages.filter(m => m.meta?.client_msg_id && !m.meta.queued).map(m => m.meta!.client_msg_id!))
  const incoming = r.messages.filter(m => !(m.meta?.queued && m.meta.client_msg_id && delivered.has(m.meta.client_msg_id)))
  r = { ...r, messages: incoming }
  // obj 900949: the newest answer carries the lane's turn state (running, queued count);
  // obj 901373: and the lane's reply-thread counts.
  return { messages: byId(prev.messages, r.messages), drafts: byId(prev.drafts ?? [], r.drafts ?? []), cards: byId(prev.cards ?? [], r.cards ?? []), turn: r.turn ?? prev.turn, reply_threads: r.reply_threads ?? prev.reply_threads }
}

