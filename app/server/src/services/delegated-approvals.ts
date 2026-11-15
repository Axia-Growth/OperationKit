/**
 * Delegated approvals (obj 900839): scoped "approve on my behalf" grants.
 *
 * ## The problem
 *
 * A worker card refuses a merge, a prod migration or a deploy unless the
 * approving chat message carries the server stamp `VERIFIED: … (owner, typed in
 * UI)`. A bot relaying the owner's decision through an agent key is stamped
 * `AGENT: …` — correctly — so the owner had to type every approval on every
 * card himself.
 *
 * ## The fix: an explicit, narrow, expiring grant
 *
 * The owner issues a grant in Settings → Bots → <bot>: "this bot may approve
 * <these actions> in <this workspace> on my behalf until <date>". A bot message
 * that names an approval action is then checked here, and only when EVERY one
 * of these holds does it reach the worker stamped `DELEGATED: …`:
 *
 *   1. it came in on a named agent key (`cc_live_…`) — never a cookie, a legacy
 *      key or a Bearer JWT;
 *   2. it names exactly one action from the closed list (merge, prod_migration,
 *      deploy);
 *   3. the bot it speaks as (`owner_bot` on the message, else the key label)
 *      resolves in the bot registry — or names an installed chat bot, whose
 *      automatic identity is the one its settings page grants to (obj 900862);
 *   4. there is a grant for THAT bot, in the CARD's workspace, with THAT
 *      action ticked, not revoked, not expired;
 *   5. the grant was issued by the person who owns the agent key, and that
 *      person is still an admin (the owner);
 *   6. the key itself may reach the card's workspace.
 *
 * Anything else is a refusal (default deny) that names what was missing, and it
 * is written to the audit log. A refused approval is NOT delivered as a plain
 * bot message: a bot that thinks it approved something must learn that it did
 * not.
 *
 * ## What a grant can never do
 *
 *  - reach another workspace or another action (exact match on both);
 *  - outlive `expires_at` or `revoked_at` (checked on every message);
 *  - be created, extended or widened by a bot: the grant routes accept only a
 *    signed-in admin's browser session, and there is no update route at all —
 *    a grant is immutable apart from revocation;
 *  - count as the owner for anything else. The `DELEGATED:` stamp approves ONE
 *    action; it does not override card text, capture pasted secrets, or count
 *    as a verified-owner instruction.
 *
 * ## Trust note
 *
 * Which bot a message speaks as is DECLARED by the caller (a shared agent key
 * serves several bots). That is the same trust level as `owner_bot` on a card.
 * The grant does not make the declaration stronger; it bounds what a correct
 * declaration can do, ties it to the key OWNER's own grant, and records every
 * use with the key id and label so a misuse is attributable.
 */
import type { Database } from 'better-sqlite3'
import {
  DELEGATION_ACTION_LABELS,
  DELEGATION_MAX_DAYS,
  isDelegationAction,
  type DelegationAction,
  type DelegationGrant,
  type MessageSender,
  type Objective,
} from '@operationkit/shared'
import type { AuthRequest } from '../middleware/auth.js'
import { resolveBot } from './bots/bot-registry.js'

export class DelegationError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message)
  }
}

const ACTION_COLUMN: Record<DelegationAction, string> = {
  merge: 'allow_merge',
  prod_migration: 'allow_prod_migration',
  deploy: 'allow_deploy',
}

interface GrantRow {
  id: number
  granting_user_id: number
  bot_name: string
  agent_slug: string | null
  workspace: string
  allow_merge: number
  allow_prod_migration: number
  allow_deploy: number
  created_at: string
  expires_at: string
  revoked_at: string | null
  revoked_by: string | null
  created_by: string
}

/** SQLite `datetime('now')` format, UTC: `YYYY-MM-DD HH:MM:SS`. */
export function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

function displayName(username: string): string {
  const u = username.trim()
  return u ? u.charAt(0).toUpperCase() + u.slice(1) : 'Unknown user'
}

function rowActions(r: GrantRow): DelegationAction[] {
  return (Object.keys(ACTION_COLUMN) as DelegationAction[]).filter(a => Number((r as unknown as Record<string, number>)[ACTION_COLUMN[a]]) === 1)
}

function toGrant(db: Database, r: GrantRow, now: Date): DelegationGrant {
  const u = db.prepare('SELECT username FROM users WHERE id = ?').get(r.granting_user_id) as { username: string } | undefined
  const state: DelegationGrant['state'] = r.revoked_at ? 'revoked' : r.expires_at <= sqliteUtc(now) ? 'expired' : 'active'
  return {
    id: r.id,
    granting_user_id: r.granting_user_id,
    granted_by: u?.username ?? `user #${r.granting_user_id}`,
    bot_name: r.bot_name,
    agent_slug: r.agent_slug,
    workspace: r.workspace,
    actions: rowActions(r),
    created_at: r.created_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    revoked_by: r.revoked_by,
    created_by: r.created_by,
    state,
  }
}

export function listGrantsForBot(db: Database, botName: string, now = new Date()): DelegationGrant[] {
  const rows = db.prepare('SELECT * FROM delegation_grants WHERE bot_name = ? ORDER BY id DESC').all(botName) as GrantRow[]
  return rows.map(r => toGrant(db, r, now))
}

export function getGrant(db: Database, id: number, now = new Date()): DelegationGrant | null {
  const r = db.prepare('SELECT * FROM delegation_grants WHERE id = ?').get(id) as GrantRow | undefined
  return r ? toGrant(db, r, now) : null
}

// ── audit ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  event: 'grant_created' | 'grant_revoked' | 'approval_used' | 'approval_denied'
  grant_id?: number | null
  objective_id?: number | null
  workspace?: string | null
  bot_name?: string | null
  action?: string | null
  actor?: string | null
  agent_key_id?: number | null
  agent_key_label?: string | null
  reason?: string | null
  message?: string | null
}

const EXCERPT_MAX = 500

export function excerpt(message: string | null | undefined): string | null {
  if (!message) return null
  const t = message.trim()
  return t.length > EXCERPT_MAX ? `${t.slice(0, EXCERPT_MAX)}…` : t
}

export function writeDelegationAudit(db: Database, e: AuditEntry): void {
  db.prepare(
    `INSERT INTO delegation_audit (event, grant_id, objective_id, workspace, bot_name, action, actor, agent_key_id, agent_key_label, reason, message_excerpt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    e.event,
    e.grant_id ?? null,
    e.objective_id ?? null,
    e.workspace ?? null,
    e.bot_name ?? null,
    e.action ?? null,
    e.actor ?? null,
    e.agent_key_id ?? null,
    e.agent_key_label ?? null,
    e.reason ?? null,
    excerpt(e.message),
  )
  console.log(
    `[delegated-approval] ${e.event}` +
      (e.grant_id ? ` grant=#${e.grant_id}` : '') +
      (e.objective_id ? ` card=#${e.objective_id}` : '') +
      (e.bot_name ? ` bot="${e.bot_name}"` : '') +
      (e.workspace ? ` workspace=${e.workspace}` : '') +
      (e.action ? ` action=${e.action}` : '') +
      (e.actor ? ` actor=${e.actor}` : '') +
      (e.agent_key_id ? ` key=#${e.agent_key_id}` : '') +
      (e.reason ? ` reason="${e.reason}"` : ''),
  )
}

// ── grant lifecycle (owner only — the route enforces who may call these) ─────

export interface CreateGrantInput {
  grantor: { id: number; username: string }
  botName: string
  agentSlug: string | null
  workspace: unknown
  actions: unknown
  expiresAt: unknown
  /** Workspaces this bot may be granted in (existence + bot access already applied). */
  allowedWorkspaces: string[]
  now?: Date
}

export function parseActions(raw: unknown): DelegationAction[] {
  if (!Array.isArray(raw)) throw new DelegationError(400, 'actions_invalid', 'actions must be a list: merge, prod_migration and/or deploy')
  const out: DelegationAction[] = []
  for (const a of raw) {
    if (!isDelegationAction(a)) throw new DelegationError(400, 'actions_invalid', `Unknown action "${String(a)}". Allowed: merge, prod_migration, deploy.`)
    if (!out.includes(a)) out.push(a)
  }
  if (out.length === 0) throw new DelegationError(400, 'actions_invalid', 'Tick at least one action (merge, prod migration or deploy).')
  return out
}

export function parseExpiry(raw: unknown, now: Date): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new DelegationError(400, 'expiry_required', 'expires_at is required: every grant must end.')
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) throw new DelegationError(400, 'expiry_invalid', `expires_at "${raw}" is not a date.`)
  if (d.getTime() <= now.getTime() + 60_000) throw new DelegationError(400, 'expiry_invalid', 'expires_at must be in the future.')
  if (d.getTime() > now.getTime() + DELEGATION_MAX_DAYS * 86_400_000) {
    throw new DelegationError(400, 'expiry_invalid', `A grant can run for at most ${DELEGATION_MAX_DAYS} days.`)
  }
  return sqliteUtc(d)
}

export function createGrant(db: Database, input: CreateGrantInput): DelegationGrant {
  const now = input.now ?? new Date()
  const workspace = typeof input.workspace === 'string' ? input.workspace.trim() : ''
  if (!workspace) throw new DelegationError(400, 'workspace_required', 'Pick the one workspace this grant covers.')
  if (!input.allowedWorkspaces.includes(workspace)) {
    throw new DelegationError(400, 'workspace_forbidden', `"${workspace}" is not a workspace this bot may be granted in (it must exist and be in the bot's workspace access).`)
  }
  const actions = parseActions(input.actions)
  const expires = parseExpiry(input.expiresAt, now)
  const has = (a: DelegationAction) => (actions.includes(a) ? 1 : 0)
  const info = db
    .prepare(
      `INSERT INTO delegation_grants (granting_user_id, bot_name, agent_slug, workspace, allow_merge, allow_prod_migration, allow_deploy, created_at, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.grantor.id, input.botName, input.agentSlug, workspace, has('merge'), has('prod_migration'), has('deploy'), sqliteUtc(now), expires, input.grantor.username)
  const id = Number(info.lastInsertRowid)
  writeDelegationAudit(db, {
    event: 'grant_created',
    grant_id: id,
    workspace,
    bot_name: input.botName,
    action: actions.join(','),
    actor: input.grantor.username,
    reason: `expires ${expires} UTC`,
  })
  return getGrant(db, id, now)!
}

/** Revoke a grant. Idempotent: revoking a revoked grant changes nothing. */
export function revokeGrant(db: Database, id: number, botName: string, actor: string, now = new Date()): { grant: DelegationGrant; changed: boolean } {
  const row = db.prepare('SELECT * FROM delegation_grants WHERE id = ? AND bot_name = ?').get(id, botName) as GrantRow | undefined
  if (!row) throw new DelegationError(404, 'grant_not_found', `No grant #${id} for this bot.`)
  if (row.revoked_at) return { grant: toGrant(db, row, now), changed: false }
  db.prepare('UPDATE delegation_grants SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL').run(sqliteUtc(now), actor, id)
  writeDelegationAudit(db, { event: 'grant_revoked', grant_id: id, workspace: row.workspace, bot_name: row.bot_name, actor })
  return { grant: getGrant(db, id, now)!, changed: true }
}

// ── the approval gate ─────────────────────────────────────────────────────────

export interface ActiveGrantQuery {
  botName: string
  workspace: string
  action: DelegationAction
  grantorUserId: number
  now?: Date
}

/**
 * The newest grant that covers exactly this bot × workspace × action for this
 * grantor right now, or null. Expired and revoked grants never match.
 */
export function findActiveGrant(db: Database, q: ActiveGrantQuery): GrantRow | null {
  const column = ACTION_COLUMN[q.action]
  if (!column) return null
  const row = db
    .prepare(
      `SELECT g.* FROM delegation_grants g
         JOIN users u ON u.id = g.granting_user_id
        WHERE g.bot_name = ? AND g.workspace = ? AND g.${column} = 1
          AND g.granting_user_id = ?
          AND g.revoked_at IS NULL AND g.expires_at > ?
          AND u.role = 'admin'
        ORDER BY g.id DESC LIMIT 1`,
    )
    .get(q.botName, q.workspace, q.grantorUserId, sqliteUtc(q.now ?? new Date())) as GrantRow | undefined
  return row ?? null
}

export type DelegationDecision =
  /** The message does not claim to be an approval: handle it exactly as before. */
  | { kind: 'none' }
  | { kind: 'allowed'; sender: MessageSender; grantId: number; action: DelegationAction; bot: string; onBehalfOf: string }
  | { kind: 'denied'; status: number; code: string; error: string }

/**
 * Resolves a declared bot name the stored registry does not know to the
 * automatic identity of an installed chat bot (obj 900862). The route passes
 * one built on the live chat-bot list; omitted = registry only.
 */
export type DeclaredChatBotResolver = (declared: unknown) => { id: string } | null

export interface DelegationRequestBody {
  approval?: unknown
  owner_bot?: unknown
}

/**
 * Decide whether a card chat message is a delegated approval. Pure apart from
 * reads (and the denial audit row) — the caller records an allowed approval
 * with `recordDelegatedApproval` once the message is actually stored.
 */
export function decideDelegatedApproval(
  db: Database,
  req: Pick<AuthRequest, 'agentKey' | 'user' | 'authVia'>,
  objective: Pick<Objective, 'id' | 'workspace'>,
  body: DelegationRequestBody,
  message: string,
  now = new Date(),
  chatBotFor?: DeclaredChatBotResolver,
): DelegationDecision {
  const raw = body.approval
  if (raw === undefined || raw === null || raw === '') return { kind: 'none' }

  const deny = (status: number, code: string, error: string, extra: Partial<AuditEntry> = {}): DelegationDecision => {
    try {
      writeDelegationAudit(db, {
        event: 'approval_denied',
        objective_id: objective.id,
        workspace: objective.workspace ?? null,
        action: typeof raw === 'string' ? raw : null,
        actor: req.user?.username ?? null,
        agent_key_id: req.agentKey?.id ?? null,
        agent_key_label: req.agentKey?.label ?? null,
        reason: code,
        message,
        ...extra,
      })
    } catch (err) {
      console.warn('[delegated-approval] audit write failed:', (err as Error).message)
    }
    return { kind: 'denied', status, code, error }
  }

  if (!isDelegationAction(raw)) {
    return deny(400, 'approval_invalid', `approval must be one of: merge, prod_migration, deploy (got "${String(raw)}").`)
  }
  const action = raw
  if (!req.agentKey || req.authVia !== 'agent_api_key' || !req.user) {
    return deny(403, 'approval_requires_bot_key', 'A delegated approval must come from a bot on a named agent key. The owner approves by typing in the card instead.')
  }
  const workspace = objective.workspace?.trim()
  if (!workspace) return deny(403, 'no_workspace', 'This card has no workspace, so no grant can cover it.')
  if (req.agentKey.workspaces && !req.agentKey.workspaces.includes(workspace)) {
    return deny(403, 'key_workspace_forbidden', `This agent key may not reach workspace "${workspace}".`)
  }

  const declared = body.owner_bot ?? req.agentKey.label
  const bot = resolveBot(declared, db)
  let botName: string
  if (bot.ok) {
    botName = bot.bot.id
  } else {
    let auto: { id: string } | null = null
    try { auto = chatBotFor?.(declared) ?? null } catch { auto = null }
    if (!auto) return deny(403, 'unknown_bot', `No delegation: ${bot.error} Pass owner_bot = the bot that is approving.`)
    botName = auto.id
  }
  const grant = findActiveGrant(db, { botName, workspace, action, grantorUserId: req.user.id, now })
  if (!grant) {
    return deny(
      403,
      'no_active_grant',
      `No delegation: there is no active grant for "${botName}" to approve ${DELEGATION_ACTION_LABELS[action]} in workspace "${workspace}" ` +
        `on behalf of ${req.user.username}. Grants are issued by the owner in Settings → Bots → the bot → Approve on my behalf; expired or revoked grants never count.`,
      { bot_name: botName },
    )
  }
  const owner = db.prepare('SELECT username FROM users WHERE id = ?').get(grant.granting_user_id) as { username: string }
  const onBehalfOf = displayName(owner.username)
  const sender: MessageSender = {
    kind: 'delegated',
    verified: false,
    label: botName,
    username: req.user.username,
    delegation: { grant_id: grant.id, action, bot: botName, on_behalf_of: onBehalfOf },
  }
  return { kind: 'allowed', sender, grantId: grant.id, action, bot: botName, onBehalfOf }
}

/** The one-line card/audit sentence for a delegated approval. */
export function delegatedApprovalLine(d: { bot: string; onBehalfOf: string; grantId: number; action: DelegationAction }): string {
  return `Approved by ${d.bot} on behalf of ${d.onBehalfOf} under grant #${d.grantId} (${DELEGATION_ACTION_LABELS[d.action]})`
}

/** Quote a message as a markdown blockquote (the audit line's source). */
export function quoteMessage(message: string): string {
  const body = excerpt(message) ?? ''
  return body.split('\n').map(l => `> ${l}`).join('\n')
}

/**
 * Record an allowed delegated approval: the server audit row, and the line on
 * the card (activity log, with the quoted source message). `logLine` is
 * injected so this module does not import the routes layer.
 */
export function recordDelegatedApproval(
  db: Database,
  d: Extract<DelegationDecision, { kind: 'allowed' }>,
  ctx: {
    objective: Pick<Objective, 'id' | 'workspace' | 'project'>
    message: string
    agentKey: { id: number; label: string }
    actor: string
    sessionId?: string | null
    logLine?: (e: { project: string; workspace?: string; objective_id: number; session_id?: string | null; event_type: string; title: string; detail: string; metadata: Record<string, unknown> }) => void
  },
): string {
  const line = delegatedApprovalLine(d)
  writeDelegationAudit(db, {
    event: 'approval_used',
    grant_id: d.grantId,
    objective_id: ctx.objective.id,
    workspace: ctx.objective.workspace ?? null,
    bot_name: d.bot,
    action: d.action,
    actor: ctx.actor,
    agent_key_id: ctx.agentKey.id,
    agent_key_label: ctx.agentKey.label,
    message: ctx.message,
  })
  try {
    ctx.logLine?.({
      project: ctx.objective.project || 'operationkit',
      workspace: ctx.objective.workspace ?? undefined,
      objective_id: ctx.objective.id,
      session_id: ctx.sessionId ?? null,
      event_type: 'decision',
      title: line,
      detail: quoteMessage(ctx.message),
      metadata: {
        kind: 'delegated_approval',
        grant_id: d.grantId,
        action: d.action,
        bot: d.bot,
        on_behalf_of: d.onBehalfOf,
        agent_key_id: ctx.agentKey.id,
        agent_key_label: ctx.agentKey.label,
      },
    })
  } catch (err) {
    console.warn('[delegated-approval] card line failed:', (err as Error).message)
  }
  return line
}
