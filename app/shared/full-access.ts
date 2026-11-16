/**
 * Bot Full access (obj 900972) — the shared vocabulary.
 *
 * Full access is a per-bot, per-workspace switch an admin flips in the bot's
 * settings. It sits ON TOP of the bot's workspace access list (obj 900797): a
 * workspace has to be granted to the bot before Full access can be switched on
 * there, and revoking the workspace takes Full access with it.
 *
 * While it is on, in that ONE workspace the bot may read and act on every card
 * whatever its owner, read and write the whole workspace knowledge base, read
 * and edit workflows and scheduled tasks, read bot settings and run history,
 * and file and own cards (including a card that gives it a repo checkout).
 *
 * Four kinds of action are NOT part of Full access:
 *
 *   secret_values — using secrets (the secrets broker), Shared secrets included
 *   keys          — minting or revoking keys and tokens
 *   dns_access    — DNS records and Cloudflare Access
 *   billing       — billing, payments and subscriptions
 *
 * The first three are PERMANENT: there is no switch. For a bot with Full
 * access in a workspace every such path is refused and the refusal is logged,
 * whatever the bot's own file lists. Billing is the one kind an admin may
 * switch on, off by default.
 *
 * Cards that carry a protected pull request (FULL_ACCESS_PROTECTED_PRS) are
 * out of reach of every Full access ability, also refused and logged.
 *
 * Merge, prod-migration and deploy approvals are not a switch here at all:
 * they stay with the "approve on my behalf" grants (delegation.ts).
 *
 * Both lists are deliberately closed. Adding a kind is a code change.
 */

export const FULL_ACCESS_EXCLUSIONS = ['secret_values', 'keys', 'dns_access', 'billing'] as const
export type FullAccessExclusion = (typeof FULL_ACCESS_EXCLUSIONS)[number]

/** Never part of Full access, with no switch: always refused and logged. */
export const FULL_ACCESS_PERMANENT_EXCLUSIONS = ['secret_values', 'keys', 'dns_access'] as const
export type FullAccessPermanentExclusion = (typeof FULL_ACCESS_PERMANENT_EXCLUSIONS)[number]

/** The exclusions an admin may switch on (each off by default). */
export const FULL_ACCESS_SWITCHES = ['billing'] as const
export type FullAccessSwitch = (typeof FULL_ACCESS_SWITCHES)[number]

export function isFullAccessSwitch(raw: unknown): raw is FullAccessSwitch {
  return typeof raw === 'string' && (FULL_ACCESS_SWITCHES as readonly string[]).includes(raw)
}

/**
 * Pull requests no Full access ability may touch: a card whose pr_number is
 * here (or whose PR link ends in that number) is refused and logged.
 */
export const FULL_ACCESS_PROTECTED_PRS: readonly number[] = [645]

export function isFullAccessExclusion(raw: unknown): raw is FullAccessExclusion {
  return typeof raw === 'string' && (FULL_ACCESS_EXCLUSIONS as readonly string[]).includes(raw)
}

/** What a person reads (settings toggles, refusal lines, audit rows). */
export const FULL_ACCESS_EXCLUSION_LABELS: Record<FullAccessExclusion, string> = {
  secret_values: 'Secret values',
  keys: 'Minting or revoking keys',
  dns_access: 'DNS and Cloudflare Access',
  billing: 'Billing',
}

export const FULL_ACCESS_EXCLUSION_HELP: Record<FullAccessExclusion, string> = {
  secret_values: 'Using secrets through the secrets broker, Shared secrets included.',
  keys: 'Creating, rotating or revoking API keys and tokens.',
  dns_access: 'Changing DNS records or Cloudflare Access rules.',
  billing: 'Reach billing, payment or subscription systems.',
}

/** Every switch off: the state a new Full access row starts in. */
export function noExclusionsAllowed(): Record<FullAccessSwitch, boolean> {
  return { billing: false }
}

/** Longest a Full access expiry may be set ahead. Leaving the expiry empty means "until switched off". */
export const FULL_ACCESS_MAX_DAYS = 365

export type FullAccessState = 'on' | 'off' | 'expired'

/** One bot × workspace row, as the settings panel sees it. */
export interface BotFullAccess {
  slug: string
  workspace: string
  /** The stored switch. `state` says whether it counts right now. */
  enabled: boolean
  /** UTC, SQLite `YYYY-MM-DD HH:MM:SS`; null = no expiry. */
  expires_at: string | null
  state: FullAccessState
  /** The switchable exclusions (billing). False until an admin turns it on. Secrets, keys and DNS have no switch. */
  allow: Record<FullAccessSwitch, boolean>
  updated_by: string | null
  updated_at: string | null
}

export const FULL_ACCESS_AUDIT_EVENTS = [
  'enabled',
  'disabled',
  'expiry_changed',
  'exclusion_changed',
  'expired',
  'workspace_revoked',
  'ability_used',
  'ability_refused',
  'exclusion_refused',
  'protected_refused',
] as const
export type FullAccessAuditEvent = (typeof FULL_ACCESS_AUDIT_EVENTS)[number]

/** One audit row: who, when, which bot and workspace, what changed. */
export interface FullAccessAuditEntry {
  id: number
  event: FullAccessAuditEvent
  slug: string
  workspace: string | null
  /** Username of the admin (a settings change) or `bot:<slug>` (a use or a refusal). */
  actor: string | null
  /** The switch after the change (settings events only). */
  enabled: boolean | null
  expires_at: string | null
  exclusion: FullAccessExclusion | null
  /** Which ability was used or refused, e.g. `card_take_over`. */
  ability: string | null
  objective_id: number | null
  detail: string | null
  created_at: string
}

export interface BotFullAccessResponse {
  slug: string
  /** One entry per workspace the bot is granted (the only places Full access can be on). */
  workspaces: BotFullAccess[]
  workspace_options: { slug: string; name: string }[]
  /** True for a signed-in admin in the browser: the only caller that may change it. */
  can_manage: boolean
  /** Newest first. */
  audit: FullAccessAuditEntry[]
}

/** What the bot list carries per bot, for the sidebar and bot-page badge. */
export interface BotFullAccessSummary {
  /** Workspaces where Full access counts right now (and the caller may see). */
  workspaces: { workspace: string; expires_at: string | null }[]
}

/** What `PUT /api/agent-chat/agents/:slug/full-access/:workspace` accepts. Omitted fields are left as they are. */
export interface BotFullAccessPatch {
  enabled?: boolean
  /** ISO date-time, or null to clear the expiry. */
  expires_at?: string | null
  allow?: Partial<Record<FullAccessSwitch, boolean>>
}
