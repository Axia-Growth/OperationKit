/**
 * owner_bot on the internal card-create route (obj 900957, audit finding 3).
 *
 * `POST /api/internal/objectives` used to refuse `owner_bot` as an unknown
 * field, so a card filed by a High Agency wake, or by a card session on a
 * bot's behalf, could never be owned by that bot. The wake brief worked around
 * it by putting the bot's slug in `agent_context`.
 *
 * Two checks, in this order:
 *   1. `validateOwnerBot` (shared): the same shape check the public create
 *      route uses. Is the string safe to store at all?
 *   2. Does a bot here answer to it? The bot registry (id, name or alias),
 *      else a chat bot installed on this board (name or slug). The internal
 *      route has no caller identity, so unlike the public route it does not
 *      store a name nobody answers to: a typo is a 400 that lists the bots.
 *
 * The stored value is the caller's string, trimmed, exactly as the public
 * route stores it.
 */
import type { Database } from 'better-sqlite3'
import { validateOwnerBot } from '@operationkit/shared'
import { builtinsEnabled, loadChatAgents } from '../agent-chat/agent-defs.js'
import { allBotConfigs, applyBotConfig } from '../agent-chat/bot-config.js'
import { listBots, registryKey } from './bot-registry.js'

export type ItemOwnerBot =
  /** `value` null = unowned. `botId` = the registry bot it resolves to, if any.
   *  `slugs` = the chat slugs the owner answers to, lower-cased. */
  | { ok: true; value: string | null; botId: string | null; slugs: string[] }
  | { ok: false; error: string; known: string[] }

/** Chat bots installed on this board, with the admin's display-name overrides. */
function installedChatBots(): Array<{ slug: string; name: string; aliases?: string[] }> {
  try {
    const loaded = loadChatAgents({ env: process.env, includeDemo: false, includeBuiltins: builtinsEnabled(process.env) })
    let configs: ReturnType<typeof allBotConfigs> = new Map()
    try { configs = allBotConfigs() } catch { /* no table yet: every bot is its file */ }
    return loaded.agents.map(a => applyBotConfig(a, configs.get(a.slug))).map(a => ({ slug: a.slug, name: a.name, aliases: a.aliases }))
  } catch {
    return []
  }
}

export function resolveItemOwnerBot(raw: unknown, db: Database): ItemOwnerBot {
  const shape = validateOwnerBot(raw)
  if (!shape.ok) return { ok: false, error: shape.error, known: [] }
  if (shape.value === undefined || shape.value === null) return { ok: true, value: null, botId: null, slugs: [] }

  const key = registryKey(shape.value)
  const bots = listBots(db)
  for (const b of bots) {
    if (registryKey(b.id) === key || registryKey(b.name) === key || b.aliases.some(a => registryKey(a) === key)) {
      return { ok: true, value: shape.value, botId: b.id, slugs: b.agent_slugs.map(s => s.toLowerCase()) }
    }
  }
  const chat = installedChatBots()
  // Two chat bots can share a display name, so every match counts.
  const hits = chat.filter(c =>
    registryKey(c.name) === key || registryKey(c.slug) === key || (c.aliases ?? []).some(a => registryKey(a) === key))
  if (hits.length) return { ok: true, value: shape.value, botId: null, slugs: hits.map(c => c.slug.toLowerCase()) }
  const known = [...new Set([...bots.map(b => b.id), ...chat.map(c => c.name)])]
  return {
    ok: false,
    error: `Unknown owner_bot "${shape.value}". Known bots: ${known.join(', ') || '(none)'}.`,
    known,
  }
}
