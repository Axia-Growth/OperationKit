/**
 * The ONE rule for which bot owns a card (obj 900956, audit finding 3).
 *
 * Before this, three places answered "whose card is this?" three ways: the High
 * Agency supervisor and the wake brief read only `agent_context`, and bot
 * approval read `owner_bot` first and `agent_context` second. A card a bot
 * filed from chat carries `owner_bot` and may be worked by a different
 * `agent_context`, so the bot's own wake and the daily supervisor did not see
 * it as the bot's card.
 *
 * The rule, in order:
 *
 *  1. `owner_bot`, when set. It is resolved through the bot registry (id, name,
 *     alias or chat slug); a name the registry does not know is matched against
 *     the chat bots installed here (name or slug). A value nothing here answers
 *     to is still an owner: an outside bot with no chat slug. `agent_context` is
 *     NOT consulted once `owner_bot` is set, so the two can disagree and
 *     `owner_bot` wins.
 *  2. Else `agent_context`, when it is a bot's chat slug and not the default
 *     agent (`general` sits on every persona-less card and proves nothing). A
 *     chat slug is one the registry lists (matched as a slug only: a worker
 *     persona `cfo` is not the bot NAMED "CFO"), an installed chat bot's slug,
 *     or a slug that was given High Agency.
 *  3. Else no bot owns the card.
 *
 * One guard, carried over from bot approval (review of PR 797): when a chat bot
 * filed the card and works it under its own slug (`agent_chat_cards`), an
 * `owner_bot` that resolves to a bot which does NOT answer to that slug is a
 * display-name collision, not ownership. Such a card has no single owner here
 * (null), so no bot may close it as its own work.
 */
import type { Database } from 'better-sqlite3'
import { DEFAULT_AGENT_CONTEXT } from '@operationkit/shared'
import { loadChatAgents, builtinsEnabled } from '../agent-chat/agent-defs.js'
import { allBotConfigs, applyBotConfig } from '../agent-chat/bot-config.js'
import { listBots, registryKey, type BotDefinition } from './bot-registry.js'

/** An installed chat bot: its slug and display name. */
export interface ChatBotRef {
  slug: string
  name: string
  /** Other names it answers to, e.g. a built-in bot's default-brand name (obj 901033). */
  aliases?: string[]
}

export interface CardOwnerBot {
  /** Registry id (the canonical `owner_bot` value) when the owner is a registered bot, else null. */
  botId: string | null
  /** What a person reads. */
  name: string
  /** Chat slugs the owner answers to, lower-cased. Empty for a bot with no chat agent here. */
  slugs: string[]
  /** Which card field named the owner. */
  via: 'owner_bot' | 'agent_context'
}

/** The card fields the rule reads. */
export interface OwnedCard {
  id?: number | null
  owner_bot?: string | null
  agent_context?: string | null
}

export interface CardOwnerOptions {
  /** Installed chat bots. Default: the agent files loaded on this install. */
  chatBots?: ChatBotRef[]
}

const CHAT_BOT_CACHE_MS = 30_000
let chatBotCache: { at: number; bots: ChatBotRef[] } | null = null

/** Chat bots installed on this board (slug + display name), cached for 30s. */
export function installedChatBots(): ChatBotRef[] {
  const now = Date.now()
  if (!chatBotCache || now - chatBotCache.at > CHAT_BOT_CACHE_MS) {
    let bots: ChatBotRef[] = []
    try {
      const loaded = loadChatAgents({ env: process.env, includeDemo: false, includeBuiltins: builtinsEnabled(process.env) })
      let configs: ReturnType<typeof allBotConfigs> = new Map()
      try { configs = allBotConfigs() } catch { /* no table yet → every bot is its file */ }
      bots = loaded.agents.map(a => applyBotConfig(a, configs.get(a.slug))).map(a => ({ slug: a.slug, name: a.name, aliases: a.aliases }))
    } catch {
      bots = []
    }
    chatBotCache = { at: now, bots }
  }
  return chatBotCache.bots
}

/** Test seam: forget the cached chat bot list. */
export function clearInstalledChatBotCache(): void {
  chatBotCache = null
}

const lower = (v: unknown): string => String(v ?? '').trim().toLowerCase()

/**
 * Build the rule once (registry, chat bots and High Agency slugs are read a
 * single time) and apply it to many cards. `cardOwnerBot` is the one-card form.
 */
export function cardOwnerResolver(db: Database, opts: CardOwnerOptions = {}): (card: OwnedCard) => CardOwnerBot | null {
  let bots: BotDefinition[]
  try { bots = listBots(db) } catch { bots = listBots() }
  const chatBots = opts.chatBots ?? installedChatBots()

  const highAgency = new Set<string>()
  try {
    for (const r of db.prepare('SELECT slug FROM agent_chat_high_agency').all() as { slug: string }[]) highAgency.add(lower(r.slug))
  } catch { /* no High Agency table */ }

  let filedBy: { get(id: number): unknown } | null = null
  try { filedBy = db.prepare('SELECT agent_slug FROM agent_chat_cards WHERE objective_id = ?') } catch { filedBy = null }

  const fromRegistry = (b: BotDefinition, via: CardOwnerBot['via']): CardOwnerBot =>
    ({ botId: b.id, name: b.name, slugs: b.agent_slugs.map(lower), via })
  /** The registry bot a chat slug belongs to. Slug match only: never by id or name. */
  const bySlug = (slug: string): BotDefinition | undefined => {
    const k = registryKey(slug)
    return bots.find(b => b.agent_slugs.some(s => registryKey(s) === k))
  }
  const fromChat = (c: ChatBotRef, via: CardOwnerBot['via']): CardOwnerBot => {
    const reg = bySlug(c.slug)
    return reg ? fromRegistry(reg, via) : { botId: null, name: c.name, slugs: [lower(c.slug)], via }
  }

  /** The chat slug that filed this card AND works it, or null. */
  const chatFiledSlug = (card: OwnedCard, ctx: string): string | null => {
    if (!filedBy || card.id == null || !ctx || ctx === DEFAULT_AGENT_CONTEXT) return null
    try {
      const row = filedBy.get(Number(card.id)) as { agent_slug: string } | undefined
      return row && lower(row.agent_slug) === ctx ? ctx : null
    } catch {
      return null
    }
  }

  return (card) => {
    const explicit = String(card.owner_bot ?? '').trim()
    const ctx = lower(card.agent_context)

    if (explicit) {
      const key = registryKey(explicit)
      const reg = bots.find(b =>
        registryKey(b.id) === key || registryKey(b.name) === key || b.aliases.some(a => registryKey(a) === key),
      ) ?? bySlug(explicit)
      const chat = reg ? undefined : chatBots.find(c =>
        registryKey(c.name) === key || registryKey(c.slug) === key || (c.aliases ?? []).some(a => registryKey(a) === key))
      const owner: CardOwnerBot = reg
        ? fromRegistry(reg, 'owner_bot')
        : chat
          ? fromChat(chat, 'owner_bot')
          : { botId: null, name: explicit, slugs: [], via: 'owner_bot' }
      const filed = chatFiledSlug(card, ctx)
      if (filed && !owner.slugs.includes(filed)) return null
      return owner
    }

    if (!ctx || ctx === DEFAULT_AGENT_CONTEXT) return null
    const reg = bySlug(ctx)
    if (reg) return fromRegistry(reg, 'agent_context')
    const chat = chatBots.find(c => lower(c.slug) === ctx)
    if (chat) return fromChat(chat, 'agent_context')
    if (highAgency.has(ctx)) return { botId: null, name: ctx, slugs: [ctx], via: 'agent_context' }
    return null
  }
}

/** The bot that owns this card, or null when no bot does. See the rule at the top of this file. */
export function cardOwnerBot(card: OwnedCard, db: Database, opts: CardOwnerOptions = {}): CardOwnerBot | null {
  return cardOwnerResolver(db, opts)(card)
}

/** Does the bot with this chat slug own the card? */
export function ownerHasSlug(owner: CardOwnerBot | null, slug: string): boolean {
  return !!owner && owner.slugs.includes(lower(slug))
}

/** Of these cards, the ids the bot with this chat slug owns ("your cards"). */
export function cardIdsOwnedByBot(db: Database, slug: string, cards: OwnedCard[], opts: CardOwnerOptions = {}): number[] {
  const owner = cardOwnerResolver(db, opts)
  return cards.filter(c => c.id != null && ownerHasSlug(owner(c), slug)).map(c => Number(c.id))
}
