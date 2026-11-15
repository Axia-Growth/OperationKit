/**
 * One-click bot registration (obj 900862).
 *
 * A chat bot can only hold an "Approve on my behalf" grant when the bot
 * registry knows it: a grant is keyed by the registry bot's id, because that is
 * the name a bot puts on its approval (`owner_bot`). Before this, a chat bot the
 * registry did not know (e.g. an install's own `<org>-cto` slug, or a new
 * "Operation Kit Dev") showed "add it to settings.bot_registry or
 * settings.bot_agent_slugs" — i.e. hand-edit a settings row on the server.
 *
 * Now the owner clicks "Register this bot" on the bot's settings page. That
 * writes ONE additive entry to `settings.bot_registry_additions`
 * (`bot-registry.ts`), either:
 *  - LINK: this chat slug (and the bot's display name, as an alias) joins an
 *    existing registry bot — the right answer for an install's localized copy
 *    of a shipped bot (`example-cto` → "Grok: CTO", whose shipped slug is the
 *    `your-org-cto` placeholder); or
 *  - NEW: a new registry bot named after the chat bot, owning this slug.
 *
 * Refused, never guessed: a bot that is already registered, an unknown target,
 * a name or slug another bot already answers to. Nothing here grants a tool,
 * a workspace, a secret or an approval — registration is an identity only.
 */
import type { Database } from 'better-sqlite3'
import { validateOwnerBot } from '@operationkit/shared'
import {
  BOT_REGISTRY_ADDITIONS_SETTING,
  botForAgentSlug,
  findBotIndex,
  listBots,
  readRegistryAdditions,
  registryKey,
  resolveBot,
  slugOwnerIndex,
  type BotDefinition,
  type RegistryAddition,
} from './bot-registry.js'
import { TEMPLATE_PLACEHOLDER } from './install-slugs.js'

export interface ChatBotRef {
  slug: string
  name: string
  file_name?: string | null
}

/** The registry bot a chat bot speaks as: its slug first, then its names. Null = unregistered. */
export function registryBotForChat(a: ChatBotRef, db: Database): BotDefinition | null {
  const bySlug = botForAgentSlug(a.slug, db)
  if (bySlug) return bySlug
  for (const name of [a.name, a.file_name]) {
    if (!name) continue
    const r = resolveBot(name, db)
    if (r.ok) return r.bot
  }
  return null
}

export interface RegistrationOptions {
  /** The id a NEW bot would get (the chat bot's name), or null when that name can't be a bot id. */
  new_bot_id: string | null
  /** Existing registry bots this chat bot could be linked to. */
  existing: Array<{ id: string; name: string }>
  /** Pre-selected target: an existing bot id, or null = register as a new bot. */
  suggested: string | null
}

/**
 * The shipped example bots own a `your-org-<role>` placeholder slug. An
 * install's localized copy is `<org>-<role>` — the same role suffix. That is
 * the one pairing we pre-select; the owner still confirms it with the click.
 */
export function suggestedLink(slug: string, bots: BotDefinition[]): string | null {
  const prefix = `${TEMPLATE_PLACEHOLDER}-`
  let best: { id: string; len: number } | null = null
  for (const b of bots) {
    for (const s of b.agent_slugs) {
      if (!s.startsWith(prefix) || s === slug) continue
      const role = s.slice(prefix.length)
      if (role.length < 2 || !slug.endsWith(`-${role}`)) continue
      if (!best || role.length > best.len) best = { id: b.id, len: role.length }
    }
  }
  return best?.id ?? null
}

export function registrationOptions(a: ChatBotRef, db: Database): RegistrationOptions {
  const bots = listBots(db)
  const name = a.name?.trim() ?? ''
  const shape = validateOwnerBot(name)
  const newOk = !!name && shape.ok && findBotIndex(bots, name) < 0
  // De-duplicate by id: a public build can carry two bots that share one.
  const seen = new Set<string>()
  const existing = bots.filter(b => (seen.has(b.id) ? false : (seen.add(b.id), true))).map(b => ({ id: b.id, name: b.name }))
  const suggested = suggestedLink(a.slug, bots)
  return { new_bot_id: newOk ? name : null, existing, suggested }
}

export type RegisterResult =
  | { ok: true; bot: BotDefinition; linked: boolean }
  | { ok: false; status: number; code: string; error: string }

/**
 * Register a chat bot in the registry. `target` = an existing bot (id, name or
 * alias) to link to; null/undefined = a new bot named after the chat bot.
 * Writes only `settings.bot_registry_additions`.
 */
export function registerChatBot(db: Database, a: ChatBotRef, target?: unknown): RegisterResult {
  const current = registryBotForChat(a, db)
  if (current) {
    return { ok: false, status: 409, code: 'already_registered', error: `${a.name} is already registered as "${current.id}".` }
  }
  const bots = listBots(db)
  const slugHeld = slugOwnerIndex(bots, a.slug)
  if (slugHeld >= 0) {
    return { ok: false, status: 409, code: 'slug_taken', error: `"${a.slug}" already belongs to ${bots[slugHeld].id}.` }
  }

  let entry: RegistryAddition
  let linked: boolean
  if (target !== undefined && target !== null && target !== '') {
    const r = resolveBot(target, db)
    if (!r.ok) return { ok: false, status: 400, code: 'unknown_bot', error: r.error }
    entry = { id: r.bot.id, aliases: [a.name, a.slug].filter(Boolean), agent_slugs: [a.slug] }
    linked = true
  } else {
    const name = a.name?.trim() ?? ''
    const shape = validateOwnerBot(name)
    if (!name || !shape.ok) {
      return { ok: false, status: 400, code: 'invalid_name', error: `"${name}" can't be used as a bot name${shape.ok ? '' : `: ${shape.error}`}. Link it to an existing bot instead.` }
    }
    if (findBotIndex(bots, name) >= 0) {
      return { ok: false, status: 409, code: 'name_taken', error: `"${name}" already names another bot. Link it to that bot instead.` }
    }
    entry = { id: name, name, aliases: registryKey(a.slug) === registryKey(name) ? [] : [a.slug], agent_slugs: [a.slug] }
    linked = false
  }

  const before = readRegistryAdditions(db)
  const write = (list: RegistryAddition[]) =>
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(BOT_REGISTRY_ADDITIONS_SETTING, JSON.stringify(list))
  write([...before, entry])

  // Prove the write did what we said: the chat slug now routes to the bot.
  const after = botForAgentSlug(a.slug, db)
  if (!after || after.id !== entry.id) {
    write(before)
    return { ok: false, status: 409, code: 'not_applied', error: `Could not register ${a.name}: the registry did not accept "${a.slug}" for ${entry.id}. Nothing was changed.` }
  }
  return { ok: true, bot: after, linked }
}

/**
 * Automatic registration (obj 900862, acceptance change of 2026-11-14 22:56 ET):
 * every chat bot has a bot identity with NO manual step. A chat bot the
 * registry already knows keeps that identity. Any other chat bot gets one
 * DERIVED from its file on every read — nothing is written to settings, so it
 * follows the file (rename it and the identity follows; delete it and it is
 * gone) and the registry rows stay exactly as the operator left them:
 *  - LINKED to a shipped bot when the chat slug is that bot's install copy
 *    (`<org>-cto` ↔ shipped `your-org-cto`), the same pairing the one-click
 *    register pre-selects;
 *  - otherwise a NEW identity named after the chat bot (its slug when the
 *    name can't be a bot id).
 * Null only when neither the name nor the slug can be an id nobody else uses —
 * then the panel falls back to the one-click register control.
 */
export interface ChatBotIdentity {
  bot: BotDefinition
  /** True = derived automatically (not in the stored registry). */
  auto: boolean
  /** True = an automatic link to an existing registry bot. */
  linked: boolean
}

function derivedBot(a: ChatBotRef, bots: BotDefinition[]): { bot: BotDefinition; linked: boolean } | null {
  const link = suggestedLink(a.slug, bots)
  if (link) {
    const target = bots.find(b => b.id === link)
    if (target) return { bot: target, linked: true }
  }
  for (const candidate of [a.name?.trim() ?? '', a.slug]) {
    if (!candidate || !validateOwnerBot(candidate).ok || findBotIndex(bots, candidate) >= 0) continue
    const name = a.name?.trim() || candidate
    const aliases = [a.name, a.slug, a.file_name].filter((x): x is string => !!x && registryKey(x) !== registryKey(candidate))
    return { bot: { id: candidate, name, aliases: [...new Set(aliases)], agent_slugs: [a.slug] }, linked: false }
  }
  return null
}

/** The identity a chat bot holds grants under: registered, else derived automatically. */
export function chatBotIdentity(a: ChatBotRef, db: Database): ChatBotIdentity | null {
  const registered = registryBotForChat(a, db)
  if (registered) return { bot: registered, auto: false, linked: false }
  const d = derivedBot(a, listBots(db))
  return d ? { bot: d.bot, auto: true, linked: d.linked } : null
}

/**
 * The identity behind a DECLARED bot name (an approval's `owner_bot`, else the
 * agent key label) that the stored registry does not resolve: the installed
 * chat bot whose slug, name or file name it is. Null = no such chat bot.
 */
export function chatBotForDeclared(declared: unknown, chatBots: ChatBotRef[], db: Database): ChatBotIdentity | null {
  if (typeof declared !== 'string' || !declared.trim()) return null
  const key = registryKey(declared)
  const hit = chatBots.find(c => [c.slug, c.name, c.file_name].some(x => !!x && registryKey(x) === key))
  return hit ? chatBotIdentity(hit, db) : null
}
