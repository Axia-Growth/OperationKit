/**
 * Board ownership (obj 900869) — who a card belongs to RIGHT NOW.
 *
 * The model, from the owner's walkthrough:
 *
 *  - Every card shows one owner: a bot or a human.
 *  - While a bot is doing the work, the owner is that bot.
 *  - When the card actually needs a human, ownership shifts to the human and the
 *    card sits in Needs You. The human queue IS Needs You.
 *
 * Ownership is DERIVED, never stored as its own column. It is a pure function of
 * fields the board already keeps current (status, session_id, owner_bot,
 * agent_context, the assignees, the creator), so it cannot drift from the column
 * a card sits in: the moment the poller parks a card in `review` with no agent on
 * it, the owner reads as the human, and the moment a bot is put back on it, it
 * reads as the bot again. The server computes it once in `mapObjective` and ships
 * it as `current_owner`; the client uses the same function as a fallback.
 *
 * "Needs a human" is the same rule the board uses for the Needs You column
 * (`boardColumnOf` in the client, obj 900669): status `review` with no live agent
 * session. A review card with an agent still running a turn is the bot's.
 */

/**
 * objectives.agent_context's column default (db/schema/core.ts). Every card
 * filed without a persona carries it, and the built-in "General" bot also lists
 * it as its chat slug — so this slug alone never says a bot owns a card.
 */
export const DEFAULT_AGENT_CONTEXT = 'general'

/** Filter token for a card with nobody on it (shared with the owner filter). */
export const OWNER_UNASSIGNED_TOKEN = '__unassigned__'

/** Prefix that turns a bot id into an owner-filter token (`bot:Operation Kit`). */
export const OWNER_BOT_PREFIX = 'bot:'

export function botOwnerToken(botId: string): string {
  return `${OWNER_BOT_PREFIX}${botId}`
}

export function isBotOwnerToken(token: string): boolean {
  return token.startsWith(OWNER_BOT_PREFIX)
}

export function botIdFromToken(token: string): string | null {
  return isBotOwnerToken(token) ? token.slice(OWNER_BOT_PREFIX.length) : null
}

/**
 * 'external' (obj 901030): the card's bot is named by `owner_bot` but is NOT a
 * bot installed on this board (no chat agent here answers to that name/slug) —
 * e.g. a card filed through a shared API key by an outside assistant that
 * names itself as a product-level identity this install never configured.
 * Styled distinctly from 'bot' so it never reads as "this install's Operation
 * Kit did this" or, worse, as an unowned/mystery card.
 */
export type CardOwnerKind = 'bot' | 'human' | 'unassigned' | 'external'

export interface CardOwner {
  kind: CardOwnerKind
  /** What a person reads on the tag: a bot name, a username (or "a, b"), or "Unassigned". */
  label: string
  /** The owner-filter token(s) this owner answers to. */
  tokens: string[]
  /** Bot id when kind = 'bot' or 'external'. */
  bot: string | null
  /** Usernames when kind = 'human' (primary first). */
  humans: string[]
  /** True when the card is waiting on a human (it sits in Needs You). */
  needs_human: boolean
  /** The bot that was working the card before it shifted to the human, if any. */
  handed_off_from_bot: string | null
  /** kind = 'external' only: the tooltip explaining who filed it, e.g.
   *  "Filed by an outside assistant via API key OpKit." */
  external_detail: string | null
}

/** The fields ownership reads. Every one already exists on an Objective. */
export interface OwnershipInput {
  status: string
  session_id?: string | null
  /** Canonical registry bot id written by a bot filer / a claim. */
  owner_bot?: string | null
  /** Bot resolved server-side from owner_bot, else from agent_context's chat slug. */
  bot_owner?: string | null
  /** Display name for the bot (registry `name`); falls back to the id. */
  bot_owner_name?: string | null
  /** obj 901030: true when `bot_owner` names a bot no chat agent on THIS
   *  install answers to (a card filed by an outside assistant via a shared
   *  API key). Server-resolved alongside `bot_owner`. */
  bot_owner_is_external?: boolean
  /** obj 901030: tooltip text for an external bot owner, e.g. "Filed by an
   *  outside assistant via API key OpKit." Only meaningful when
   *  `bot_owner_is_external` is true. */
  bot_owner_detail?: string | null
  assigned_usernames?: string[] | null
  created_by_username?: string | null
}

/** Same rule as the Needs You column: review with no agent session running. */
export function cardNeedsHuman(o: Pick<OwnershipInput, 'status' | 'session_id'>): boolean {
  return o.status === 'review' && (o.session_id == null || o.session_id === '')
}

/** The bot behind a card, or null. `bot_owner` (server-resolved) wins over raw `owner_bot`. */
export function cardBot(o: Pick<OwnershipInput, 'owner_bot' | 'bot_owner'>): string | null {
  const b = (o.bot_owner ?? o.owner_bot ?? '').trim()
  return b ? b : null
}

/**
 * Who owns the card right now. Rules, in order:
 *
 *  1. Needs a human → the assigned humans; else the person who filed it; else
 *     Unassigned. The bot that was working it is kept as `handed_off_from_bot`.
 *  2. A bot is on it → that bot.
 *  3. Assigned humans → them.
 *  4. Nobody → Unassigned.
 *
 * Terminal cards (done / cancelled) follow rules 2-4: the record of who did it.
 */
export function cardOwner(o: OwnershipInput): CardOwner {
  const bot = cardBot(o)
  const botLabel = (o.bot_owner_name ?? '').trim() || bot
  const assigned = (o.assigned_usernames ?? []).filter(Boolean)
  const needsHuman = cardNeedsHuman(o)

  if (needsHuman) {
    const humans = assigned.length > 0 ? assigned : o.created_by_username ? [o.created_by_username] : []
    if (humans.length > 0) {
      return { kind: 'human', label: humans.join(', '), tokens: [...humans], bot: null, humans, needs_human: true, handed_off_from_bot: botLabel, external_detail: null }
    }
    return { kind: 'unassigned', label: 'Unassigned', tokens: [OWNER_UNASSIGNED_TOKEN], bot: null, humans: [], needs_human: true, handed_off_from_bot: botLabel, external_detail: null }
  }
  if (bot) {
    const external = !!o.bot_owner_is_external
    return {
      kind: external ? 'external' : 'bot',
      label: botLabel ?? bot,
      tokens: [botOwnerToken(bot)],
      bot,
      humans: [],
      needs_human: false,
      handed_off_from_bot: null,
      external_detail: external ? (o.bot_owner_detail ?? `Filed by an outside assistant — ${botLabel ?? bot} is not a bot on this install.`) : null,
    }
  }
  if (assigned.length > 0) {
    return { kind: 'human', label: assigned.join(', '), tokens: [...assigned], bot: null, humans: assigned, needs_human: false, handed_off_from_bot: null, external_detail: null }
  }
  return { kind: 'unassigned', label: 'Unassigned', tokens: [OWNER_UNASSIGNED_TOKEN], bot: null, humans: [], needs_human: false, handed_off_from_bot: null, external_detail: null }
}

/**
 * Every owner-filter token a card answers to — the people AND the bot involved,
 * regardless of who holds it this minute. The filter matches on these (not only
 * on the current owner) so that "Me" still shows a card of mine while a bot is
 * working it, and "Operation Kit" still shows a card it handed to me.
 *
 * A card with no human assignee also answers to Unassigned, exactly as before
 * this change, so a saved "Unassigned + me" selection loses nothing.
 */
export function ownerFilterTokens(o: OwnershipInput): string[] {
  const out: string[] = []
  const assigned = (o.assigned_usernames ?? []).filter(Boolean)
  if (assigned.length > 0) out.push(...assigned)
  else out.push(OWNER_UNASSIGNED_TOKEN)
  const bot = cardBot(o)
  if (bot) out.push(botOwnerToken(bot))
  return out
}
