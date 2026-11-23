/**
 * Delegated approvals (obj 900839) — the shared vocabulary.
 *
 * A worker card only treats a chat message as the owner's approval for a gated
 * action when the server stamps it so. Until now that meant the owner typing in
 * the web UI. A DELEGATION GRANT lets the owner say, ahead of time and in
 * writing: "this bot may approve THIS action in THIS workspace on my behalf,
 * until THIS date". The server checks the grant on every bot message that
 * claims to be an approval; the worker sees a `DELEGATED:` stamp that names the
 * one action it covers.
 *
 * The action list is deliberately closed. Adding a kind is a code change, so a
 * grant can never silently cover something its owner did not tick.
 */

export const DELEGATION_ACTIONS = ['merge', 'prod_migration', 'deploy'] as const
export type DelegationAction = (typeof DELEGATION_ACTIONS)[number]

/** What a person reads (UI, stamps, audit lines). */
export const DELEGATION_ACTION_LABELS: Record<DelegationAction, string> = {
  merge: 'merge',
  prod_migration: 'prod migration',
  deploy: 'deploy',
}

export function isDelegationAction(raw: unknown): raw is DelegationAction {
  return typeof raw === 'string' && (DELEGATION_ACTIONS as readonly string[]).includes(raw)
}

/** Longest a grant may run. A grant is a standing approval; it must end. */
export const DELEGATION_MAX_DAYS = 365

/** Carried on a MessageSender whose kind is 'delegated'. */
export interface DelegationStamp {
  grant_id: number
  action: DelegationAction
  /** Canonical bot-registry id of the bot that sent the message. */
  bot: string
  /** Display name of the owner who issued the grant. */
  on_behalf_of: string
}

/** One grant as the settings panel sees it. */
export interface DelegationGrant {
  id: number
  granting_user_id: number
  granted_by: string
  bot_name: string
  agent_slug: string | null
  workspace: string
  actions: DelegationAction[]
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoked_by: string | null
  created_by: string
  /** active = not revoked and not expired. */
  state: 'active' | 'expired' | 'revoked'
  /**
   * "Merge without asking me each time" (obj 901388). Only ever true on a grant
   * that ticks merge. While the grant is active, the server itself merges the
   * bot's OWN cards whose AI review passed (same guards as a chat merge).
   * Set when the grant is issued; off for every grant issued before it existed.
   */
  standing_merge: boolean
}

export interface DelegationGrantsResponse {
  /** The registry bot this chat bot speaks as; null = it cannot hold a grant. */
  bot: { id: string; name: string } | null
  /**
   * Set when `bot` was derived automatically from the chat bot's file rather
   * than read from the stored registry (obj 900862). `linked` = it is the
   * shipped bot this chat bot is the install copy of.
   */
  bot_auto?: { linked: boolean }
  /** Why `bot` is null, in plain words. */
  bot_unavailable_reason?: string
  /** Workspaces a new grant may name for this bot. */
  workspace_options: { slug: string; name: string }[]
  grants: DelegationGrant[]
  /** True when the caller may create or revoke (a signed-in admin in the browser). */
  can_manage: boolean
  /**
   * Present when `bot` is null (obj 900862): how the owner can register this
   * chat bot in one click — as a new bot, or linked to an existing one.
   */
  registration?: DelegationRegistrationOptions
  /** Set on the response to a successful registration. */
  registered?: { id: string; name: string; linked: boolean }
}

export interface DelegationRegistrationOptions {
  /** The id a NEW bot would get (the chat bot's name); null = it can only be linked. */
  new_bot_id: string | null
  /** Existing registry bots it could be linked to. */
  existing: { id: string; name: string }[]
  /** Pre-selected existing bot id; null = register as a new bot. */
  suggested: string | null
}
