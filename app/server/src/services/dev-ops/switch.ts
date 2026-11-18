/**
 * The ONE admin switch for the Operation Kit Dev operator tools (obj 901424).
 *
 * The owner approved (2026-11-18) a set of operator powers for exactly one bot,
 * Operation Kit Dev: merge its own PRs once CI is green, run the standard
 * update.sh deploy with automatic rollback, close cards he merged by hand, and
 * Cloudflare Access / DNS changes. This file decides whether those tools exist
 * for a chat turn at all. Every tool re-checks it on every call.
 *
 *  - Only the bot whose chat slug is `operation-kit-dev` is ever eligible. No
 *    setting, row or grant can add a second bot.
 *  - For that bot, no row = ON (the owner's approval is the default). An admin
 *    turns it off (or back on) on the bot's settings panel, cookie-admin only.
 *  - Only an ordinary chat turn by an ADMIN typing in the browser (cookie
 *    session): never a card wake, a bot-to-bot wake, a queued drain, an API key
 *    or a bearer token, never a member's chat. The role is re-read every call.
 *
 * Full access and delegation grants are not consulted: neither adds these
 * tools and neither stands in for this switch.
 */
import { getDb } from '../../db/index.js'

export const DEV_OPS_BOT_SLUG = 'operation-kit-dev'

export interface DevOpsSwitch {
  slug: string
  eligible: boolean
  enabled: boolean
  is_default: boolean
  updated_at: string | null
}

export function isDevOpsBot(slug: string | null | undefined): boolean {
  return String(slug ?? '').trim().toLowerCase() === DEV_OPS_BOT_SLUG
}

export function getDevOpsSwitch(slug: string): DevOpsSwitch {
  const eligible = isDevOpsBot(slug)
  if (!eligible) return { slug, eligible: false, enabled: false, is_default: true, updated_at: null }
  let row: { enabled: number; updated_at: string } | undefined
  try {
    row = getDb().prepare('SELECT enabled, updated_at FROM agent_chat_dev_ops WHERE slug = ?').get(DEV_OPS_BOT_SLUG) as typeof row
  } catch {
    row = undefined
  }
  if (!row) return { slug, eligible: true, enabled: true, is_default: true, updated_at: null }
  return { slug, eligible: true, enabled: row.enabled === 1, is_default: false, updated_at: row.updated_at }
}

/** Set the switch. Refuses (returns false) for any bot other than Operation Kit Dev. */
export function setDevOpsSwitch(slug: string, enabled: boolean, userId: number | null): boolean {
  if (!isDevOpsBot(slug)) return false
  getDb().prepare(
    `INSERT INTO agent_chat_dev_ops (slug, enabled, updated_by, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(slug) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(DEV_OPS_BOT_SLUG, enabled ? 1 : 0, userId)
  return true
}

export type DevOpsGateCode = 'wake_turn' | 'bot_not_eligible' | 'switch_off' | 'not_admin' | 'not_browser'

export interface DevOpsGateInput {
  agentSlug: string
  userId: number
  wake: boolean
  /** The message came from the admin's signed-in browser (cookie), not a key or token. */
  browserSession: boolean
}

/** Null when the dev-ops tools may run for this turn, else the reason they may not. */
export function devOpsGate(input: DevOpsGateInput): { code: DevOpsGateCode; error: string } | null {
  if (input.wake) return { code: 'wake_turn', error: 'Operator tools are not available in a wake turn; only in a live chat with an admin.' }
  if (!isDevOpsBot(input.agentSlug)) return { code: 'bot_not_eligible', error: 'Only the built-in Dev bot has operator tools.' }
  if (!getDevOpsSwitch(input.agentSlug).enabled) {
    return { code: 'switch_off', error: "Operator tools are switched off for this bot (bot settings → Operator tools)." }
  }
  const role = (getDb().prepare('SELECT role FROM users WHERE id = ?').get(input.userId) as { role?: string } | undefined)?.role
  if (role !== 'admin') return { code: 'not_admin', error: 'Operator tools act only for an admin.' }
  if (!input.browserSession) {
    return { code: 'not_browser', error: 'Operator tools work only when an admin types in the app in the browser (not through an API key, a token or a queued message).' }
  }
  return null
}
