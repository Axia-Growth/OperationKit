// Bot avatars for the board (obj 900947). The board knows a card's bot by its
// registry id / display name (`bot_owner`, `bot_owner_name`, shared/ownership.ts)
// and its `agent_context`; the avatar and colour live on the chat bot
// (GET /api/agent-chat/agents). One shared read per page load, matched by
// spelling, so the board stays usable — falling back to the plain bot icon —
// when the bot list is slow or unavailable.
import { useEffect, useState } from 'react'
import { api } from './api'

export type BotColour = 'blue' | 'pink' | 'green' | 'amber' | 'grey'

export interface BotAvatarInfo {
  slug: string
  name: string
  avatar: string
  colour: BotColour
}

interface AgentLike {
  slug: string
  name: string
  file_name?: string
  avatar: string
  colour: BotColour
}

/** Same idea as the server's registryKey: case, spaces and punctuation never matter. */
export function avatarKey(raw: string | null | undefined): string {
  return (raw ?? '').toLowerCase().replace(/^grok:\s*/, '').replace(/[^a-z0-9]/g, '')
}

export function buildAvatarIndex(agents: AgentLike[]): Map<string, BotAvatarInfo> {
  const out = new Map<string, BotAvatarInfo>()
  for (const a of agents) {
    const info: BotAvatarInfo = { slug: a.slug, name: a.name, avatar: a.avatar, colour: a.colour }
    for (const k of [a.slug, a.name, a.file_name]) {
      const key = avatarKey(k)
      if (key && !out.has(key)) out.set(key, info)
    }
  }
  return out
}

export interface CardBotFields {
  bot_owner?: string | null
  bot_owner_name?: string | null
  agent_context?: string | null
}

/** The chat bot behind a card, or null. Name first (what a person reads), then id, then the chat slug. */
export function avatarFor(index: Map<string, BotAvatarInfo>, c: CardBotFields): BotAvatarInfo | null {
  for (const raw of [c.bot_owner_name, c.bot_owner, c.agent_context === 'general' ? null : c.agent_context]) {
    const hit = index.get(avatarKey(raw))
    if (hit) return hit
  }
  return null
}

let shared: Promise<Map<string, BotAvatarInfo>> | null = null

function load(): Promise<Map<string, BotAvatarInfo>> {
  if (!shared) {
    // Promise.resolve first: a test double that answers undefined must not throw here.
    shared = Promise.resolve()
      .then(() => api.get<{ agents?: AgentLike[] }>('/agent-chat/agents'))
      .then(r => buildAvatarIndex(Array.isArray(r?.agents) ? r.agents : []))
      .catch(() => {
        shared = null // try again on the next mount
        return new Map<string, BotAvatarInfo>()
      })
  }
  return shared
}

/** Test seam: forget the shared read. */
export function resetBotAvatars(): void {
  shared = null
}

/** The bot-avatar index; empty until the bot list arrives (or if it never does). */
export function useBotAvatars(): Map<string, BotAvatarInfo> {
  const [index, setIndex] = useState<Map<string, BotAvatarInfo>>(() => new Map())
  useEffect(() => {
    let live = true
    void load().then(i => {
      if (live && i.size) setIndex(i)
    })
    return () => { live = false }
  }, [])
  return index
}
