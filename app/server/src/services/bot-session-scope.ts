/**
 * Per-bot session scope for the Example Operation Kit bots (obj 901330).
 *
 * Problem this closes: in `migration` mode (every existing install, including
 * live OVH) a card session gets EVERY key the Secrets store resolves for its
 * workspace — Stripe, Railway, Twilio and the rest — and, with no
 * `connector_access` row, the card owner's Google and GitHub connections too. A
 * new Example bot starting a card inherited all of that.
 *
 * What this module does: a bot named in `EXAMPLE_BOT_PACKS` is a SCOPED bot. A
 * card session for a scoped bot is filtered to that bot's pack whatever the
 * global `secrets_session_env_mode` says:
 *
 *   keys        only names on the pack (exact names, or a `PREFIX_*` family),
 *               plus explicit `secret_env_allowlist` rows for that bot (agent
 *               subject = the bot slug, or the `*` baseline). Skill rows count
 *               only when the session's skills are an explicit list. A pack's
 *               `denyKeys` win over every allowlist row.
 *   connectors  only connectors on the pack, AND only when the owner's
 *               "Who can use it" rule (`connector_access`) names the bot
 *               explicitly. No row (= "everyone") is NOT a grant for a scoped
 *               bot: it fails closed.
 *   MCP servers workspace MCP servers (Settings → Integrations) only when the
 *               pack lists their slug. None are listed today.
 *   broker      the secrets broker (`{{secret:NAME}}`) applies the same key
 *               filter to a scoped bot's session token, so a withheld key is
 *               not one HTTP call away.
 *
 * A key the pack names but the store does not hold yet (PostHog project key,
 * Meta system-user token) is simply absent: resolveSecrets only emits stored
 * keys. Nothing here creates, copies, rotates or reads a secret value — names
 * only.
 *
 * Which bot a card belongs to: `agent_context` and `cardOwnerBot()` (the one
 * ownership rule). If either names a scoped bot the scope applies, so a bot
 * cannot widen its own session by filing a card under the `general` persona.
 * Two different scoped bots on one card → the INTERSECTION of their packs.
 *
 * Kill switch: `settings.bot_session_scope_enabled = '0'` (or env
 * `CC_BOT_SESSION_SCOPE=0`) turns per-bot scoping off and restores the global
 * policy for these bots. Default ON — this is the behaviour the owner approved.
 * It changes no live setting: the global mode stays whatever it is.
 *
 * Plan from migration → enforce mode for every agent: docs/design/BOT-SECRET-SCOPE.md.
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { ALL_AGENTS, type SessionSubjects } from './secret-env-policy.js'
import { cardOwnerBot } from './bots/card-owner.js'

export const BOT_SCOPE_SETTING = 'bot_session_scope_enabled'
export const BOT_SCOPE_ENV = 'CC_BOT_SESSION_SCOPE'

/** Connector ids, as stored in `connector_access.connector_id`. */
export const GITHUB = 'github'
export const GOOGLE = 'google-workspace'

/** How the bot may use Google. A policy marker in the env, not an OAuth scope. */
export type GoogleUse = 'drafts_only' | 'read_and_drafts'

export interface BotSessionPack {
  slug: string
  name: string
  /** Exact Secrets-store names. May name a key that is not saved yet. */
  keys: readonly string[]
  /** Key families, e.g. `RAILWAY_` for `RAILWAY_*`. */
  keyPrefixes?: readonly string[]
  /** Never injected for this bot, even if an allowlist row names it. */
  denyKeys?: readonly string[]
  denyPrefixes?: readonly string[]
  /** Connector ids this bot may receive (still needs the owner's explicit grant). */
  connectors: readonly string[]
  /** Set when GOOGLE is on the list. */
  google?: GoogleUse
  /** Workspace MCP server slugs this bot may receive. */
  mcpServers?: readonly string[]
  /** Names on the pack that are known NOT to be saved yet (documentation + report). */
  pending?: readonly string[]
}

/**
 * Not-yet-saved names. These are the NAMES the owner should save the new keys
 * under; nothing here supplies a value, and no other bot's key fills the gap.
 */
export const PENDING_KEYS = {
  /** PostHog project API key for Example project 584614. NOT Casey's POSTHOG_OK_TOKEN / POSTHOG_PERSONAL_KEY. */
  POSTHOG_EXAMPLE: 'POSTHOG_EXAMPLE_584614_PROJECT_KEY',
  /** Meta (Facebook) system-user token for paid ads. */
  META: 'META_SYSTEM_USER_TOKEN',
} as const

/** Casey's PostHog keys. Never for the Example marketing bots. */
const AVA_POSTHOG = ['POSTHOG_OK_TOKEN', 'POSTHOG_PERSONAL_KEY'] as const
/** Full-write Stripe material. The CFO gets the read-only key only. */
const STRIPE_WRITE = ['STRIPE_SECRET_KEY', 'STRIPE_RESTRICTED_KEY', 'STRIPE_WEBHOOK_SECRET'] as const

const TWENTY_EXAMPLE = ['TWENTY_API_URL', 'TWENTY_API_KEY_EXAMPLE'] as const
const TWENTY_BD = ['TWENTY_API_URL', 'TWENTY_BD_API_KEY'] as const

/**
 * The eight your-org bots and their packs (owner-approved, obj 901330).
 * Mercury and Ramp are deliberately absent (a separate approved connection).
 * No Instantly key for GTM (its sending stack is the three keys on its pack).
 */
export const EXAMPLE_BOT_PACKS: Readonly<Record<string, BotSessionPack>> = Object.freeze({
  'example-cfo': {
    slug: 'example-cfo',
    name: 'Example CFO',
    keys: ['STRIPE_READONLY_BACKFILL_KEY'],
    denyKeys: [...STRIPE_WRITE],
    denyPrefixes: ['MERCURY_', 'RAMP_'],
    connectors: [GOOGLE],
    google: 'read_and_drafts',
  },
  'example-general-counsel': {
    slug: 'example-general-counsel',
    name: 'Example General Counsel',
    keys: ['DOCUSEAL_API_KEY', 'DOCUSEAL_API_URL'],
    connectors: [GOOGLE],
    google: 'drafts_only',
  },
  'example-seo': {
    slug: 'example-seo',
    name: 'Example SEO',
    keys: [PENDING_KEYS.POSTHOG_EXAMPLE, 'POSTHOG_HOST'],
    denyKeys: [...AVA_POSTHOG],
    connectors: [],
    pending: [PENDING_KEYS.POSTHOG_EXAMPLE],
  },
  'example-paid-ads': {
    slug: 'example-paid-ads',
    name: 'Example Paid Ads',
    keys: [PENDING_KEYS.POSTHOG_EXAMPLE, 'POSTHOG_HOST', PENDING_KEYS.META],
    denyKeys: [...AVA_POSTHOG],
    connectors: [],
    pending: [PENDING_KEYS.POSTHOG_EXAMPLE, PENDING_KEYS.META],
  },
  'example-client-success': {
    slug: 'example-client-success',
    name: 'Example Client Success',
    keys: [...TWENTY_BD, 'GRANOLA_API_KEY'],
    connectors: [GOOGLE],
    google: 'drafts_only',
  },
  'example-business-development': {
    slug: 'example-business-development',
    name: 'Example Business Development',
    keys: [...TWENTY_BD, 'GRANOLA_API_KEY'],
    connectors: [GOOGLE],
    google: 'drafts_only',
  },
  'example-cto': {
    slug: 'example-cto',
    name: 'Example CTO',
    keys: [...TWENTY_EXAMPLE],
    keyPrefixes: ['RAILWAY_'],
    connectors: [GITHUB],
  },
  'example-gtm-engineer': {
    slug: 'example-gtm-engineer',
    name: 'Example GTM Engineer',
    keys: [
      'EMAILBISON_API_KEY',
      'EMAILBISON_BASE_URL',
      'SENDIVO_API_KEY',
      'TELNYX_API_KEY',
      'APIFY_API_TOKEN',
      'GETLEADS_API_KEY',
      'MILLIONVERIFIER_API_KEY',
      'MILLIONVERIFIER_BASE_URL',
      'BOUNCEBAN_API_KEY',
      'BOUNCEBAN_BASE_URL',
      ...TWENTY_EXAMPLE,
    ],
    denyPrefixes: ['INSTANTLY_'],
    connectors: [],
  },
} satisfies Record<string, BotSessionPack>)

export function packFor(slug: string | null | undefined): BotSessionPack | null {
  if (!slug) return null
  return EXAMPLE_BOT_PACKS[slug.trim().toLowerCase()] ?? null
}

/** Is per-bot scoping on? Env wins; a `'0'` row turns it off; default ON. */
export function botSessionScopeEnabled(db?: Database.Database, env: NodeJS.ProcessEnv = process.env): boolean {
  const e = env[BOT_SCOPE_ENV]?.trim()
  if (e === '0' || e === 'off') return false
  if (e === '1' || e === 'on') return true
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(BOT_SCOPE_SETTING) as
      | { value: string }
      | undefined
    return row?.value !== '0'
  } catch {
    // Unreadable settings must not widen a scoped bot.
    return true
  }
}

/** The effective scope for one session. */
export interface BotScope {
  /** Slugs whose packs were combined (sorted). */
  slugs: string[]
  keys: Set<string>
  keyPrefixes: string[]
  denyKeys: Set<string>
  denyPrefixes: string[]
  connectors: Set<string>
  google: GoogleUse | null
  mcpServers: Set<string>
}

function fromPack(p: BotSessionPack): BotScope {
  return {
    slugs: [p.slug],
    keys: new Set(p.keys),
    keyPrefixes: [...(p.keyPrefixes ?? [])],
    denyKeys: new Set(p.denyKeys ?? []),
    denyPrefixes: [...(p.denyPrefixes ?? [])],
    connectors: new Set(p.connectors),
    google: p.connectors.includes(GOOGLE) ? (p.google ?? 'drafts_only') : null,
    mcpServers: new Set(p.mcpServers ?? []),
  }
}

/** Two packs on one card: keep only what BOTH allow; deny what EITHER denies. */
function intersect(a: BotScope, b: BotScope): BotScope {
  const allowsA = (k: string) => a.keys.has(k) || a.keyPrefixes.some(p => k.startsWith(p))
  const allowsB = (k: string) => b.keys.has(k) || b.keyPrefixes.some(p => k.startsWith(p))
  const keys = new Set([...a.keys].filter(allowsB).concat([...b.keys].filter(allowsA)))
  const prefixes = a.keyPrefixes.filter(p => b.keyPrefixes.includes(p))
  const google = a.google && b.google ? (a.google === 'drafts_only' || b.google === 'drafts_only' ? 'drafts_only' : a.google) : null
  return {
    slugs: [...a.slugs, ...b.slugs].sort(),
    keys,
    keyPrefixes: prefixes,
    denyKeys: new Set([...a.denyKeys, ...b.denyKeys]),
    denyPrefixes: [...new Set([...a.denyPrefixes, ...b.denyPrefixes])],
    connectors: new Set([...a.connectors].filter(c => b.connectors.has(c))),
    google,
    mcpServers: new Set([...a.mcpServers].filter(s => b.mcpServers.has(s))),
  }
}

export type ScopedCard = Pick<Objective, 'agent_context'> & { id?: number | null; owner_bot?: string | null }

/**
 * Slugs a card answers to: its `agent_context`, plus every slug of its owning
 * bot by the one ownership rule. `ownerSlugs` is injectable for tests.
 */
export function cardBotSlugs(card: ScopedCard, ownerSlugs?: (card: ScopedCard) => string[]): string[] {
  const out = new Set<string>()
  if (card.agent_context) out.add(String(card.agent_context).trim().toLowerCase())
  try {
    for (const s of (ownerSlugs ?? defaultOwnerSlugs)(card)) out.add(s.trim().toLowerCase())
  } catch {
    /* ownership lookup is best-effort; agent_context still counts */
  }
  return [...out]
}

function defaultOwnerSlugs(card: ScopedCard): string[] {
  if (!card.owner_bot) return []
  return cardOwnerBot({ id: card.id ?? null, owner_bot: card.owner_bot, agent_context: card.agent_context ?? null }, getDb())?.slugs ?? []
}

/**
 * The bot scope for a card session, or null when the card belongs to no scoped
 * bot (or scoping is switched off). Never throws.
 */
export function sessionBotScope(
  card: ScopedCard | null | undefined,
  opts: { db?: Database.Database; env?: NodeJS.ProcessEnv; ownerSlugs?: (card: ScopedCard) => string[] } = {},
): BotScope | null {
  if (!card) return null
  if (!botSessionScopeEnabled(opts.db, opts.env)) return null
  const packs = cardBotSlugs(card, opts.ownerSlugs)
    .map(packFor)
    .filter((p): p is BotSessionPack => !!p)
  const unique = [...new Map(packs.map(p => [p.slug, p])).values()]
  if (unique.length === 0) return null
  return unique.map(fromPack).reduce(intersect)
}

function matches(key: string, exact: Set<string>, prefixes: string[]): boolean {
  return exact.has(key) || prefixes.some(p => key.startsWith(p))
}

/**
 * Allowlist rows that also count for a scoped bot: the bot's own agent rows,
 * the `*` baseline, and skill rows only when the session's skills are an
 * explicit list (an unrestricted session would otherwise pick up every skill's
 * list). Read failure → none.
 */
export function scopedAllowlistRows(scope: BotScope, subjects: SessionSubjects | null, db: Database.Database = getDb()): Set<string> {
  const out = new Set<string>()
  let rows: { subject_type: string; subject: string; key: string }[] = []
  try {
    rows = db.prepare('SELECT subject_type, subject, key FROM secret_env_allowlist').all() as typeof rows
  } catch {
    return out
  }
  const skills = subjects?.skills ? new Set(subjects.skills) : null
  for (const r of rows) {
    if (r.subject_type === 'agent' && (r.subject === ALL_AGENTS || scope.slugs.every(s => s === r.subject))) out.add(r.key)
    else if (r.subject_type === 'skill' && skills?.has(r.subject)) out.add(r.key)
  }
  return out
}

/**
 * The Secrets-store key filter for a scoped bot's session. Deny lists win over
 * everything; then the pack; then explicit allowlist rows for that bot.
 */
export function botKeyFilter(
  scope: BotScope,
  subjects: SessionSubjects | null = null,
  db: Database.Database = getDb(),
): (key: string) => boolean {
  const extra = scopedAllowlistRows(scope, subjects, db)
  return (key: string) => {
    if (matches(key, scope.denyKeys, scope.denyPrefixes)) return false
    return matches(key, scope.keys, scope.keyPrefixes) || extra.has(key)
  }
}

/** Is this connector on the scoped bot's pack at all? (The owner's grant is checked separately.) */
export function packAllowsConnector(scope: BotScope, connectorId: string): boolean {
  return scope.connectors.has(connectorId)
}

/** Env markers a scoped session gets, so the worker can tell what it holds and why. */
export function botScopeEnv(scope: BotScope): Record<string, string> {
  const env: Record<string, string> = { CC_BOT_SESSION_SCOPE: scope.slugs.join(',') }
  if (scope.google) env.CC_GOOGLE_USE = scope.google
  return env
}

/** Names-only view for the review report / design note. */
export function describePack(p: BotSessionPack): {
  slug: string
  keys: string[]
  key_families: string[]
  denied: string[]
  connectors: string[]
  google: GoogleUse | null
  pending: string[]
} {
  return {
    slug: p.slug,
    keys: [...p.keys],
    key_families: (p.keyPrefixes ?? []).map(x => `${x}*`),
    denied: [...(p.denyKeys ?? []), ...(p.denyPrefixes ?? []).map(x => `${x}*`)],
    connectors: [...p.connectors],
    google: p.connectors.includes(GOOGLE) ? (p.google ?? 'drafts_only') : null,
    pending: [...(p.pending ?? [])],
  }
}

/**
 * Broker narrowing for a card session token (routes/secrets-broker.ts). Reads
 * the LIVE card row, so an agent_context change applies at once. A card that
 * cannot be read gets no extra narrowing here (the broker's own workspace scope
 * still applies) — EXCEPT that a read failure never widens a scoped bot,
 * because no row means no bot to scope. Returns undefined for unscoped cards.
 */
export function sessionBrokerKeyFilter(objectiveId: number, db: Database.Database = getDb()): ((key: string) => boolean) | undefined {
  let row: { id: number; agent_context: string | null; owner_bot: string | null } | undefined
  try {
    row = db.prepare('SELECT id, agent_context, owner_bot FROM objectives WHERE id = ?').get(objectiveId) as typeof row
  } catch {
    try {
      row = db.prepare('SELECT id, agent_context, NULL AS owner_bot FROM objectives WHERE id = ?').get(objectiveId) as typeof row
    } catch {
      return undefined
    }
  }
  if (!row) return undefined
  const scope = sessionBotScope(row as ScopedCard, { db })
  return scope ? botKeyFilter(scope, null, db) : undefined
}

/**
 * tmux mode (no jail): the wrapper script inherits the tmux server's env, which
 * on a host that hydrated the Secrets store into process.env at boot carries
 * every store key. For a scoped bot the wrapper therefore `unset`s every store
 * name that its own env does not carry. Names only; '' when not scoped.
 */
export function withheldUnsetLine(env: Record<string, string>, db?: Database.Database): string {
  if (!env.CC_BOT_SESSION_SCOPE) return ''
  let names: string[] = []
  try {
    names = ((db ?? getDb()).prepare('SELECT DISTINCT key FROM secrets').all() as { key: string }[]).map(r => r.key)
  } catch {
    return ''
  }
  const drop = names.filter(k => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !(k in env)).sort()
  return drop.length ? `\nunset ${drop.join(' ')}` : ''
}
