// High Agency activity in an existing chat (obj 900947). Messages are never
// rewritten or deleted: the server flags old High Agency updates with
// `meta.activity_feed` when the chat is read, and the UI folds each run of them
// into one collapsed row ("3 High Agency updates — now in Activity"). Pure, so
// the folding rule is tested without rendering.
import type { ChatMessage } from './types'

export type ChatItem =
  | { kind: 'message'; m: ChatMessage }
  | { kind: 'feed'; key: string; messages: ChatMessage[] }

export function isFeedMessage(m: Pick<ChatMessage, 'role' | 'meta'>): boolean {
  return m.role === 'assistant' && m.meta?.activity_feed === true
}

/** Fold consecutive flagged messages into one collapsed item; everything else passes through. */
export function foldFeedMessages(messages: ChatMessage[]): ChatItem[] {
  const out: ChatItem[] = []
  for (const m of messages) {
    if (isFeedMessage(m)) {
      const last = out[out.length - 1]
      if (last?.kind === 'feed') last.messages.push(m)
      else out.push({ kind: 'feed', key: `feed-${m.id}`, messages: [m] })
    } else {
      out.push({ kind: 'message', m })
    }
  }
  return out
}
