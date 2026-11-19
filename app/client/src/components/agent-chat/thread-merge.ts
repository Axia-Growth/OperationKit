// Shared by the conversation and the reply-thread panel (obj 901373): both send
// into a lane and fold the server's answer into that lane's cached copy.
import type { ThreadResponse } from './types'

/** A fresh client_msg_id: 8-64 of [A-Za-z0-9_-], the shape the server accepts. */
export function newClientMsgId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/**
 * obj 901488: a failed send that may still have REACHED the server. A proxy
 * that gave up waiting (Cloudflare 524, a 502/504) or a dropped connection
 * answers with no JSON `error` of ours, while the turn keeps running behind it.
 * A refusal from our own server (400, 409, 503 "AI unavailable", …) always
 * carries one and is a real "not sent".
 */
export function sendMayHaveLanded(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status
  if (typeof status !== 'number' || status === 0) return true
  const body = (e as { body?: unknown }).body
  return status >= 500 && !(body && typeof body === 'object' && 'error' in body)
}

/** obj 901488: what the page asks when the same words were sent again as a NEW message. */
export const SEND_AGAIN_QUESTION = 'This already went through. Send again?'

/**
 * obj 901488: the server matched this send to a message it already had BY ITS
 * TEXT (a new send of the same words) and ran nothing. The person is asked
 * before it is sent a second time.
 */
export function shouldAskSendAgain(r: Pick<ThreadResponse, 'duplicate' | 'duplicate_by'>): boolean {
  return !!r.duplicate && r.duplicate_by === 'text'
}

/**
 * obj 901488: the small quiet line for a retry of the SAME send (same id) or a
 * second Continue press. Nothing to ask: it is one message. A same-text repeat
 * gets the question instead (shouldAskSendAgain).
 */
export function duplicateNote(r: Pick<ThreadResponse, 'duplicate' | 'duplicate_state' | 'duplicate_by'>): string | null {
  if (!r.duplicate || shouldAskSendAgain(r)) return null
  return r.duplicate_state === 'answered' ? 'Already answered above.' : 'Already sent, still working.'
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
  // obj 901373: and the lane's reply-thread counts;
  // obj 901491: and the running reply's job (null once the lane is idle).
  return {
    messages: byId(prev.messages, r.messages),
    drafts: byId(prev.drafts ?? [], r.drafts ?? []),
    cards: byId(prev.cards ?? [], r.cards ?? []),
    // obj 901392: the newer answer's state of a follow-up replaces the older one.
    followups: byId(prev.followups ?? [], r.followups ?? []),
    turn: r.turn ?? prev.turn,
    turn_job: r.turn_job !== undefined ? r.turn_job : prev.turn_job,
    reply_threads: r.reply_threads ?? prev.reply_threads,
  }
}

