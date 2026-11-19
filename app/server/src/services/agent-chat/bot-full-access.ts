// ── Bot Full access, per workspace (obj 900972) ──
//
// A per-bot, per-workspace switch ON TOP of the workspace access list
// (bot-workspaces.ts, obj 900797). The list says WHERE a bot may work; Full
// access says that in one of those workspaces it may work on everything:
// every card whatever its owner, the whole workspace knowledge base, workflows
// and scheduled tasks, bot settings and run history, and cards it files and
// owns (full-access-tools.ts holds what each of those means).
//
// What it is built on, and what it never does:
//
//   - A workspace has to be EXPLICITLY granted to the bot first
//     (`botGrantedWorkspace`, the obj 900948 helper). Full access never adds a
//     workspace, and a revoke of the workspace ends it (`dropFullAccessFor
//     RevokedWorkspaces`). That same helper is what passes the workspace agent
//     pool for the cards the bot files and owns, so there is no second bypass.
//   - It counts only while `enabled`, not expired, and the workspace is still
//     granted. Every check reads the row again, so a switch-off or an expiry
//     takes effect on the next tool call, mid-conversation.
//   - Four hard exclusions. Secret values (Shared secrets included), minting
//     or revoking keys, and DNS / Cloudflare Access are PERMANENT: no switch,
//     no column, always refused. Billing is one switch, OFF by default.
//     `exclusionAllowed` is the one question every such path asks; a refusal
//     is written to the audit log (`refuseExclusion`).
//   - A card that carries a protected pull request (FULL_ACCESS_PROTECTED_PRS)
//     is out of reach of every ability (`protectedCardRefusal`), logged.
//   - Merge, prod-migration and deploy approvals are NOT here. They are decided
//     only by services/delegated-approvals.ts and services/bot-approval.ts,
//     which read `delegation_grants` and nothing in this file.
//   - Only an admin's browser session may change a row (the route enforces
//     that). No API key scope is widened: nothing here is reachable with a key.
//
// Every change, every use of a Full access ability and every refusal is an
// append-only row in agent_chat_bot_full_access_audit: who, when, which bot,
// which workspace, on or off, the expiry.
//
// This module only touches the DB, like bot-workspaces.ts.
import {
  FULL_ACCESS_EXCLUSION_LABELS,
  FULL_ACCESS_PROTECTED_PRS,
  FULL_ACCESS_SWITCHES,
  isFullAccessSwitch,
  FULL_ACCESS_MAX_DAYS,
  isFullAccessExclusion,
  noExclusionsAllowed,
  type BotFullAccess,
  type BotFullAccessPatch,
  type FullAccessAuditEntry,
  type FullAccessAuditEvent,
  type FullAccessExclusion,
  type FullAccessSwitch,
} from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import { botGrantedWorkspace, getBotWorkspaceAccess, personaOwnershipBlocked, WORKSPACE_SLUG_RE } from './bot-workspaces.js'

export class FullAccessError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const EXCLUSION_COLUMN: Record<FullAccessSwitch, string> = {
  billing: 'allow_billing',
}

interface Row {
  slug: string
  workspace: string
  enabled: number
  expires_at: string | null
  allow_billing: number
  expiry_logged: number
  updated_by: string | null
  updated_at: string
}

/** SQLite `datetime('now')` format, UTC: `YYYY-MM-DD HH:MM:SS`. */
export function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function isExpired(row: Pick<Row, 'expires_at'>, now: Date): boolean {
  return !!row.expires_at && row.expires_at <= sqliteUtc(now)
}

function toAccess(row: Row | undefined, slug: string, workspace: string, now: Date): BotFullAccess {
  if (!row) {
    return { slug, workspace, enabled: false, expires_at: null, state: 'off', allow: noExclusionsAllowed(), updated_by: null, updated_at: null }
  }
  const allow = noExclusionsAllowed()
  for (const x of FULL_ACCESS_SWITCHES) allow[x] = Number((row as unknown as Record<string, number>)[EXCLUSION_COLUMN[x]]) === 1
  const enabled = Number(row.enabled) === 1
  return {
    slug,
    workspace,
    enabled,
    expires_at: row.expires_at,
    state: !enabled ? 'off' : isExpired(row, now) ? 'expired' : 'on',
    allow,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
  }
}

function readRow(slug: string, workspace: string): Row | undefined {
  return getDb().prepare('SELECT * FROM agent_chat_bot_full_access WHERE slug = ? AND workspace = ?').get(slug, workspace) as Row | undefined
}

// ── audit ──

export interface FullAccessAuditInput {
  event: FullAccessAuditEvent
  slug: string
  workspace?: string | null
  actor?: string | null
  actor_user_id?: number | null
  enabled?: boolean | null
  expires_at?: string | null
  exclusion?: FullAccessExclusion | null
  ability?: string | null
  objective_id?: number | null
  detail?: string | null
}

/** Append one audit row. Never throws: a failed audit write must not turn a refusal into an allow, or the reverse. */
export function writeFullAccessAudit(e: FullAccessAuditInput): void {
  try {
    getDb()
      .prepare(
        `INSERT INTO agent_chat_bot_full_access_audit (event, slug, workspace, actor, actor_user_id, enabled, expires_at, exclusion, ability, objective_id, detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.event,
        e.slug,
        e.workspace ?? null,
        e.actor ?? null,
        e.actor_user_id ?? null,
        e.enabled === undefined || e.enabled === null ? null : e.enabled ? 1 : 0,
        e.expires_at ?? null,
        e.exclusion ?? null,
        e.ability ?? null,
        e.objective_id ?? null,
        e.detail ? e.detail.slice(0, 500) : null,
      )
  } catch (err) {
    console.error('[bot-full-access] audit write failed', err instanceof Error ? err.message : err)
  }
  console.log(
    `[bot-full-access] ${e.event} bot=${e.slug}` +
      (e.workspace ? ` workspace=${e.workspace}` : '') +
      (e.actor ? ` actor=${e.actor}` : '') +
      (e.enabled === undefined || e.enabled === null ? '' : ` enabled=${e.enabled ? 1 : 0}`) +
      (e.expires_at ? ` expires="${e.expires_at}"` : '') +
      (e.exclusion ? ` exclusion=${e.exclusion}` : '') +
      (e.ability ? ` ability=${e.ability}` : '') +
      (e.objective_id ? ` card=#${e.objective_id}` : '') +
      (e.detail ? ` detail="${e.detail.slice(0, 200)}"` : ''),
  )
}

interface AuditRow extends Omit<FullAccessAuditEntry, 'enabled' | 'exclusion' | 'event'> {
  event: string
  enabled: number | null
  exclusion: string | null
}

/** Newest first. `workspaces` narrows to rows a member may see (null = every row). */
export function listFullAccessAudit(slug: string, opts: { limit?: number; workspaces?: string[] | null } = {}): FullAccessAuditEntry[] {
  const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit ?? 50)))
  const rows = getDb()
    .prepare(
      `SELECT id, event, slug, workspace, actor, enabled, expires_at, exclusion, ability, objective_id, detail, created_at
         FROM agent_chat_bot_full_access_audit WHERE slug = ? ORDER BY id DESC LIMIT ?`,
    )
    .all(slug, limit) as AuditRow[]
  return rows
    .filter(r => !opts.workspaces || (r.workspace !== null && opts.workspaces.includes(r.workspace)))
    .map(r => ({
      ...r,
      event: r.event as FullAccessAuditEvent,
      enabled: r.enabled === null ? null : Number(r.enabled) === 1,
      exclusion: isFullAccessExclusion(r.exclusion) ? r.exclusion : null,
    }))
}

// ── reads ──

/** One bot × workspace. No row reads as off with every exclusion off. */
export function getFullAccess(slug: string, workspace: string, now = new Date()): BotFullAccess {
  return toAccess(readRow(slug, workspace), slug, workspace, now)
}

/** One entry per workspace the bot is GRANTED (the only places Full access can be on), in slug order. */
export function listFullAccess(slug: string, now = new Date()): BotFullAccess[] {
  const access = getBotWorkspaceAccess(slug)
  if (access.mode !== 'restricted') return []
  return access.workspaces.map(ws => getFullAccess(slug, ws, now))
}

/**
 * Does Full access count for this bot in this workspace RIGHT NOW? Switched
 * on, not expired, and the workspace is still explicitly granted to the bot.
 * Fails CLOSED: a missing table or a read error is "no".
 *
 * The first check that finds an expiry has passed writes the `expired` audit
 * row (once per expiry), so the log shows when Full access actually ended.
 */
export function fullAccessActive(slug: string | null | undefined, workspace: string | null | undefined, now = new Date()): boolean {
  if (!slug || !workspace) return false
  try {
    const row = readRow(slug, workspace)
    if (!row || Number(row.enabled) !== 1) return false
    if (isExpired(row, now)) {
      noteExpiry(row)
      return false
    }
    return botGrantedWorkspace(slug, workspace)
  } catch {
    return false
  }
}

/** Does this bot have Full access counting in ANY workspace right now? Fails closed to "no". */
export function fullAccessAnywhere(slug: string | null | undefined, now = new Date()): boolean {
  if (!slug) return false
  try {
    const rows = getDb().prepare('SELECT workspace FROM agent_chat_bot_full_access WHERE slug = ? AND enabled = 1').all(slug) as { workspace: string }[]
    return rows.some(r => fullAccessActive(slug, r.workspace, now))
  } catch {
    return false
  }
}

function noteExpiry(row: Row): void {
  if (Number(row.expiry_logged) === 1) return
  const changed = getDb()
    .prepare('UPDATE agent_chat_bot_full_access SET expiry_logged = 1 WHERE slug = ? AND workspace = ? AND expiry_logged = 0')
    .run(row.slug, row.workspace).changes
  if (changed > 0) {
    writeFullAccessAudit({ event: 'expired', slug: row.slug, workspace: row.workspace, actor: 'system', enabled: false, expires_at: row.expires_at, detail: 'Full access reached its expiry' })
  }
}

/** Every bot's ACTIVE Full access in one read (for the bot list badge). */
export function allActiveFullAccess(now = new Date()): Map<string, { workspace: string; expires_at: string | null }[]> {
  const out = new Map<string, { workspace: string; expires_at: string | null }[]>()
  let rows: Row[] = []
  try {
    rows = getDb().prepare('SELECT * FROM agent_chat_bot_full_access WHERE enabled = 1 ORDER BY slug, workspace').all() as Row[]
  } catch {
    return out
  }
  for (const r of rows) {
    if (isExpired(r, now)) {
      noteExpiry(r)
      continue
    }
    if (!botGrantedWorkspace(r.slug, r.workspace)) continue
    const list = out.get(r.slug) ?? []
    list.push({ workspace: r.workspace, expires_at: r.expires_at })
    out.set(r.slug, list)
  }
  return out
}

/**
 * Is one hard exclusion switched ON for this bot in this workspace? Only ever
 * true for a SWITCHABLE kind (billing) while Full access itself counts there.
 * Secret values, keys and DNS / Cloudflare Access are never allowed: there is
 * no switch to read. Fails closed.
 */
export function exclusionAllowed(slug: string, workspace: string, exclusion: FullAccessExclusion, now = new Date()): boolean {
  if (!isFullAccessSwitch(exclusion)) return false
  if (!fullAccessActive(slug, workspace, now)) return false
  try {
    return getFullAccess(slug, workspace, now).allow[exclusion] === true
  } catch {
    return false
  }
}

/**
 * The refusal a hard-exclusion path gives, already written to the audit log.
 * Callers throw the returned message; it names the switch so the person knows
 * exactly what would have to change.
 */
export function refuseExclusion(input: { slug: string; workspace: string; exclusion: FullAccessExclusion; what: string; botName?: string; actorUserId?: number | null }): string {
  writeFullAccessAudit({
    event: 'exclusion_refused',
    slug: input.slug,
    workspace: input.workspace,
    actor: `bot:${input.slug}`,
    actor_user_id: input.actorUserId ?? null,
    exclusion: input.exclusion,
    detail: input.what,
  })
  const label = FULL_ACCESS_EXCLUSION_LABELS[input.exclusion]
  if (!isFullAccessSwitch(input.exclusion)) {
    return `Refused: ${input.what} is "${label}", which a bot with Full access can never do in ${input.workspace}. There is no switch for it. This refusal was logged.`
  }
  return `Refused: ${input.what} is "${label}", which Full access does not include. An admin can switch "${label}" on for ${input.botName ?? input.slug} in ${input.workspace} (bot settings → Full access). This refusal was logged.`
}

// ── changes (admin only — the route enforces who may call these) ──

function parseExpiry(raw: unknown, now: Date): string | null {
  if (raw === null || raw === '') return null
  if (typeof raw !== 'string') throw new FullAccessError(400, 'expiry_invalid', 'expires_at must be a date-time, or null for no expiry.')
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new FullAccessError(400, 'expiry_invalid', `expires_at "${raw}" is not a date.`)
  if (d.getTime() <= now.getTime() + 60_000) throw new FullAccessError(400, 'expiry_invalid', 'The expiry must be in the future.')
  if (d.getTime() > now.getTime() + FULL_ACCESS_MAX_DAYS * 86_400_000) {
    throw new FullAccessError(400, 'expiry_invalid', `Full access can be set to expire at most ${FULL_ACCESS_MAX_DAYS} days ahead. Leave the expiry empty to keep it on until you switch it off.`)
  }
  return sqliteUtc(d)
}

function parseAllow(raw: unknown): Partial<Record<FullAccessSwitch, boolean>> {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new FullAccessError(400, 'allow_invalid', 'allow must be an object of exclusion switches.')
  const out: Partial<Record<FullAccessSwitch, boolean>> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isFullAccessExclusion(k) && !isFullAccessSwitch(k)) {
      throw new FullAccessError(400, 'exclusion_permanent', `"${FULL_ACCESS_EXCLUSION_LABELS[k]}" is never part of Full access and has no switch. Only these can be switched: ${FULL_ACCESS_SWITCHES.join(', ')}.`)
    }
    if (!isFullAccessSwitch(k)) throw new FullAccessError(400, 'allow_invalid', `"${k}" is not a switch. Known: ${FULL_ACCESS_SWITCHES.join(', ')}.`)
    if (typeof v !== 'boolean') throw new FullAccessError(400, 'allow_invalid', `allow.${k} must be true or false.`)
    out[k] = v
  }
  return out
}

export interface FullAccessActor {
  id: number
  username: string
}

/**
 * Apply one settings change. Returns the row after it and what changed.
 *
 * Rules:
 *   - Switching ON needs the workspace on the bot's explicit list. A bot that
 *     predates access lists ("not restricted yet") has no list, so it has to be
 *     restricted first: Full access never rides on implicit access.
 *   - Switching OFF, or back ON after it was off or expired, puts every
 *     exclusion back to off unless the same change sets it. An exclusion is a
 *     fresh decision each time Full access is granted.
 *   - Every distinct change is one audit row.
 */
export function setFullAccess(
  slug: string,
  workspaceRaw: unknown,
  patchRaw: unknown,
  actor: FullAccessActor,
  now = new Date(),
): { access: BotFullAccess; changes: FullAccessAuditEvent[] } {
  if (typeof workspaceRaw !== 'string' || !WORKSPACE_SLUG_RE.test(workspaceRaw)) throw new FullAccessError(400, 'workspace_invalid', 'workspace must be a workspace slug.')
  const workspace = workspaceRaw
  if (!patchRaw || typeof patchRaw !== 'object' || Array.isArray(patchRaw)) throw new FullAccessError(400, 'body_invalid', 'Send the fields to change: enabled, expires_at, allow.')
  const patch = patchRaw as BotFullAccessPatch & Record<string, unknown>
  for (const k of Object.keys(patch)) {
    if (!['enabled', 'expires_at', 'allow'].includes(k)) throw new FullAccessError(400, 'body_invalid', `Unknown field "${k}". Fields: enabled, expires_at, allow.`)
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') throw new FullAccessError(400, 'body_invalid', 'enabled must be true or false.')

  const db = getDb()
  const before = getFullAccess(slug, workspace, now)
  const wasOn = before.state === 'on'
  const wantEnabled = patch.enabled ?? before.enabled
  const turningOn = wantEnabled && !wasOn
  const expiryGiven = Object.prototype.hasOwnProperty.call(patch, 'expires_at')
  // Re-enabling after an expiry without naming a new one clears the stale date:
  // an already-passed expiry would otherwise leave the switch on and dead.
  let expires = expiryGiven ? parseExpiry(patch.expires_at, now) : before.expires_at
  if (!expiryGiven && wantEnabled && before.state === 'expired' && patch.enabled === true) expires = null
  const allowPatch = parseAllow(patch.allow)
  // An expired row is only woken by an explicit "on" or a new expiry: an exclusion
  // edit alone must not quietly bring Full access back.
  if (before.state === 'expired' && patch.enabled === undefined && !expiryGiven) {
    throw new FullAccessError(409, 'full_access_expired', 'Full access has expired here. Switch it on again (with a new expiry, or none) first.')
  }

  if (wantEnabled) {
    const access = getBotWorkspaceAccess(slug)
    if (access.mode !== 'restricted') {
      throw new FullAccessError(409, 'bot_not_restricted', 'This bot is not restricted to a workspace list yet. Grant the workspaces it may use first (Workspace access), then switch Full access on for one of them.')
    }
    if (!botGrantedWorkspace(slug, workspace)) {
      throw new FullAccessError(409, 'workspace_not_granted', `Grant this bot the "${workspace}" workspace first (Workspace access). Full access can only be switched on in a workspace the bot is already granted.`)
    }
  }
  if (!wantEnabled && Object.values(allowPatch).some(v => v === true)) {
    throw new FullAccessError(409, 'full_access_off', 'Switch Full access on first. An exclusion can only be switched on while Full access is on.')
  }

  // Off, or newly on: every exclusion starts from off again.
  const base = !wantEnabled || turningOn ? noExclusionsAllowed() : { ...before.allow }
  const allow = { ...base, ...(wantEnabled ? allowPatch : {}) }

  const changes: FullAccessAuditEvent[] = []
  const actorName = actor.username
  db.transaction(() => {
    db.prepare(
      `INSERT INTO agent_chat_bot_full_access (slug, workspace, enabled, expires_at, allow_billing, expiry_logged, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(slug, workspace) DO UPDATE SET
         enabled = excluded.enabled, expires_at = excluded.expires_at,
         allow_billing = excluded.allow_billing,
         expiry_logged = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).run(
      slug, workspace, wantEnabled ? 1 : 0, wantEnabled ? expires : null,
      allow.billing ? 1 : 0,
      actorName, sqliteUtc(now),
    )
    const audit = (event: FullAccessAuditEvent, extra: Partial<FullAccessAuditInput> = {}) => {
      changes.push(event)
      writeFullAccessAudit({ event, slug, workspace, actor: actorName, actor_user_id: actor.id, enabled: wantEnabled, expires_at: wantEnabled ? expires : null, ...extra })
    }
    if (wantEnabled && !wasOn) {
      audit('enabled', { detail: expires ? `Full access on until ${expires} UTC` : 'Full access on, no expiry' })
    } else if (!wantEnabled && before.enabled) {
      audit('disabled', { detail: before.state === 'expired' ? 'Full access off (it had already expired)' : 'Full access off' })
    } else if (wantEnabled && expires !== before.expires_at) {
      audit('expiry_changed', { detail: expires ? `Expiry set to ${expires} UTC` : 'Expiry removed: on until switched off' })
    }
    for (const x of FULL_ACCESS_SWITCHES) {
      // A reset that comes with switching off is covered by the 'disabled' row.
      if (!wantEnabled) continue
      const was = wasOn ? before.allow[x] : false
      if (allow[x] !== was) audit('exclusion_changed', { exclusion: x, detail: `${FULL_ACCESS_EXCLUSION_LABELS[x]} ${allow[x] ? 'allowed' : 'blocked'}` })
    }
  })()
  return { access: getFullAccess(slug, workspace, now), changes }
}

/**
 * After the bot's workspace list changed: Full access in a workspace that is
 * no longer granted is switched off and logged. Returns the workspaces it
 * ended in. (The read path already ignores such a row; this makes the stored
 * state and the audit log say so too.)
 */
export function dropFullAccessForRevokedWorkspaces(slug: string, actor: string): string[] {
  const db = getDb()
  let rows: Row[] = []
  try {
    rows = db.prepare('SELECT * FROM agent_chat_bot_full_access WHERE slug = ? AND enabled = 1').all(slug) as Row[]
  } catch {
    return []
  }
  const ended: string[] = []
  for (const r of rows) {
    if (botGrantedWorkspace(slug, r.workspace)) continue
    db.prepare(
      `UPDATE agent_chat_bot_full_access SET enabled = 0, expires_at = NULL, allow_billing = 0,
              expiry_logged = 0, updated_by = ?, updated_at = datetime('now') WHERE slug = ? AND workspace = ?`,
    ).run(actor, slug, r.workspace)
    writeFullAccessAudit({ event: 'workspace_revoked', slug, workspace: r.workspace, actor, enabled: false, detail: 'Full access off: the workspace is no longer granted to this bot' })
    ended.push(r.workspace)
  }
  return ended
}

/** The protected pull request a card carries (its pr_number, or the number its PR link ends in), or null. */
export function isProtectedCard(card: { pr_number?: number | null; pr_url?: string | null } | null | undefined): number | null {
  if (!card) return null
  const n = Number(card.pr_number)
  if (card.pr_number != null && Number.isInteger(n) && FULL_ACCESS_PROTECTED_PRS.includes(n)) return n
  const m = /\/pull\/(\d+)(?:[/?#]|$)/.exec(String(card.pr_url ?? ''))
  if (m && FULL_ACCESS_PROTECTED_PRS.includes(Number(m[1]))) return Number(m[1])
  return null
}

/** A protected pull request named in free text (`PR 645`, `#645`, `pull/645`), or null. */
export function protectedPrInText(text: string): number | null {
  for (const n of FULL_ACCESS_PROTECTED_PRS) {
    if (new RegExp(`(?:\\bPR\\s*#?\\s*|\\bpull\\/|\\bpull request\\s*#?\\s*|#)${n}\\b`, 'i').test(text)) return n
  }
  return null
}

/**
 * The plain refusal for card text that names a protected pull request. One
 * sentence on why, one on how to file without it. Shared by both filing tools.
 */
export function protectedPrTextMessage(pr: number): string {
  return (
    `Refused: card text may not name pull request ${pr}, because it is protected, and this applies even to a mention like "do not touch PR ${pr}". ` +
    `To file this card, take the number out of the title and description (write "the protected pull request" if you must refer to it) and send it again. This refusal was logged.`
  )
}

/**
 * The ONE text check for every tool that files a card from chat
 * (`create_objective`, `repo_session_start`). Returns the refusal, ALREADY
 * written to the audit log, or null when the title and description name no
 * protected pull request.
 *
 * A negated mention ("do not touch PR 645") is refused too, on purpose: telling
 * "do not touch 645" from "do touch 645, not 646" reliably is not possible with
 * a pattern, and the wall must not depend on phrasing. Leaving the number out
 * costs the bot nothing — a card that never names it cannot be pointed at it.
 */
export function protectedPrTextRefusal(input: {
  slug: string
  workspace: string | null
  ability: string
  title: string
  description: string
  actorUserId?: number | null
}): string | null {
  const pr = protectedPrInText(`${input.title}\n${input.description}`)
  if (pr === null) return null
  writeFullAccessAudit({
    event: 'protected_refused',
    slug: input.slug,
    workspace: input.workspace,
    actor: `bot:${input.slug}`,
    actor_user_id: input.actorUserId ?? null,
    ability: input.ability,
    detail: `card text names protected PR ${pr}`,
  })
  return protectedPrTextMessage(pr)
}

/**
 * The refusal for a card that carries a protected pull request, ALREADY
 * written to the audit log, or null when the card is not protected. Every Full
 * access path that reads or acts on a card calls this first: the chat tools,
 * the internal take-over route and the Full access branch of /message.
 */
export function protectedCardRefusal(input: {
  slug: string
  workspace: string | null
  ability: string
  card: { id: number; pr_number?: number | null; pr_url?: string | null }
  actorUserId?: number | null
  detail?: string
}): string | null {
  const pr = isProtectedCard(input.card)
  if (pr === null) return null
  writeFullAccessAudit({
    event: 'protected_refused',
    slug: input.slug,
    workspace: input.workspace,
    actor: `bot:${input.slug}`,
    actor_user_id: input.actorUserId ?? null,
    ability: input.ability,
    objective_id: input.card.id,
    detail: input.detail ?? `card #${input.card.id} carries protected PR ${pr}`,
  })
  return `Refused: card #${input.card.id} carries pull request ${pr}, which is protected. Full access never reads or acts on it. This refusal was logged.`
}

/**
 * A CARD SESSION's Full access (the High Agency wake path). A card worked by a
 * bot (`agent_context` = the bot's slug) carries that bot's Full access when
 * the card sits in a workspace where it counts, the target is in the SAME
 * workspace, the card runs for an install admin (its assignee), AND the card
 * provably came from an admin or from the bot's own schedule. One of:
 *
 *   - it is the bot's own High Agency wake: `routine_id` points at the routine
 *     named `high-agency:<slug>` (only the scheduler sets routine_id);
 *   - the bot filed it from an ADMIN's chat: an `agent_chat_cards` row for this
 *     bot whose person is an admin;
 *   - an admin created it directly: `created_by` is an admin and the card has
 *     no parent. A child card inherits `created_by` from a parent its caller
 *     names (lib/objective-ownership.ts), so an inherited value is not proof.
 *
 * Being ASSIGNED to an admin is not enough: anyone who can file or assign a
 * card in the workspace could manufacture that. Returns the bot slug, or null.
 * Callers must have derived `cardId` from the session token, never from a
 * request body.
 */
export function cardSessionFullAccess(cardId: number, targetWorkspace: string | null | undefined, now = new Date()): string | null {
  if (!targetWorkspace) return null
  try {
    const db = getDb()
    const card = db.prepare('SELECT agent_context, workspace, assigned_user_id, created_by, parent_id, routine_id FROM objectives WHERE id = ? AND deleted_at IS NULL').get(cardId) as
      | { agent_context: string | null; workspace: string; assigned_user_id: number | null; created_by: number | null; parent_id: number | null; routine_id: number | null }
      | undefined
    if (!card || !card.agent_context || card.workspace !== targetWorkspace) return null
    // agent_context names a WORKER AGENT when the slug is one (review of PR 797) —
    // UNLESS (obj 901026) the bot is explicitly granted this workspace, which now
    // supersedes a persona sharing its name: the grant is the decision that the
    // two are one identity here. EXCEPT (review fix) the five protected
    // default-roster personas (cto/cmo/coo/cfo/general): an existing
    // admin-assigned CTO/CFO/… card never inherits a same-slugged bot's Full
    // access, grant or not (`personaOwnershipBlocked`).
    if (personaOwnershipBlocked(card.agent_context, card.workspace)) return null
    if (!fullAccessActive(card.agent_context, card.workspace, now)) return null
    const isAdmin = (id: number | null): boolean =>
      id != null && (db.prepare('SELECT role FROM users WHERE id = ?').get(id) as { role?: string } | undefined)?.role === 'admin'
    if (!isAdmin(card.assigned_user_id)) return null
    const slug = card.agent_context
    const ownWake =
      card.routine_id != null &&
      (db.prepare('SELECT name FROM routines WHERE id = ?').get(card.routine_id) as { name?: string } | undefined)?.name === `high-agency:${slug}`
    if (ownWake) return slug
    const filed = db.prepare('SELECT user_id FROM agent_chat_cards WHERE objective_id = ? AND agent_slug = ?').get(cardId, slug) as { user_id: number } | undefined
    if (filed && isAdmin(filed.user_id)) return slug
    if (card.parent_id == null && isAdmin(card.created_by)) return slug
    return null
  } catch {
    return null
  }
}

/** Drop a deleted bot's Full access rows. The audit log is kept: it is history. */
export function forgetFullAccess(slug: string): void {
  try {
    getDb().prepare('DELETE FROM agent_chat_bot_full_access WHERE slug = ?').run(slug)
  } catch { /* no table yet */ }
}
