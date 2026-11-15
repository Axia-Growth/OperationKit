// ── Bot-to-bot messaging: the store, the addressing and the access rule (obj 900859) ──
//
// One bot sends another bot a message; the recipient is WOKEN with it (the
// delivery worker in bot-wake.ts runs one turn of the recipient), and its final
// answer is stored as the REPLY on the same thread. Both bots, and the people of
// the workspace, can read that thread later. Design: docs/design/BOT-TO-BOT-MESSAGING.md.
//
// This module is DB-only: send / list / read and the access rule. It never calls
// a model, so the chat tools (tools.ts) can import it without pulling the engine.
//
// ── the access rule (one sentence) ──
//
// A bot conversation lives in exactly ONE workspace W, and a bot may send into or
// read it only when W is in (the acting person's workspaces) ∩ (the bot's own
// workspace list, obj 900797) — the same intersection every other chat tool
// uses — and the RECIPIENT bot must also be granted W. Concretely:
//
//   send    sender ∈ W (person ∩ bot), recipient bot granted W, sender is a
//           participant when replying on an existing conversation.
//   read    the bot is a participant AND W ∈ (person ∩ bot). In a wake the scope
//           is narrowed further to the ONE workspace of the conversation that
//           woke it.
//   deliver every check above is re-run at delivery time, so a revoke between
//           send and wake stops the wake.
//
// A conversation outside the caller's scope is answered exactly like one that
// does not exist ("not found"), so the tool is not an existence oracle for
// another workspace's threads.
import { getDb } from '../../db/index.js'
import { getUserWorkspaces } from '../../middleware/workspace.js'
import { logActivity } from '../../routes/feed.js'
import { rateLimit } from '../file-access.js'
import { botMayUseWorkspace, botWorkspaceAllowlist } from './bot-workspaces.js'

// ── settings (read at the point of use, no restart) ──

function setting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

function intSetting(key: string, fallback: number, min: number, max: number): number {
  const raw = setting(key)
  if (raw === null || raw.trim() === '') return fallback
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
}

/** Kill switch: settings.bot_messaging_enabled = '0' refuses every send and parks delivery. */
export function botMessagingEnabled(): boolean {
  return setting('bot_messaging_enabled') !== '0'
}

/**
 * How many wakes deep a chain of bot messages may go. A message a person's chat
 * sends is depth 0; a message a bot sends while it is itself answering a wake is
 * one deeper. Default 2 (A → B → C, no further).
 */
export function maxBotMessageDepth(): number {
  return intSetting('bot_messaging_max_depth', 2, 0, 5)
}

/** Messages (kind 'message') one conversation may carry before it is full. */
export function maxMessagesPerConversation(): number {
  return intSetting('bot_messaging_max_per_conversation', 40, 1, 1000)
}

/** Sends per sending bot per minute (in-process window). */
export function botMessageRatePerMinute(): number {
  return intSetting('bot_messaging_rate_per_minute', 20, 1, 600)
}

export const MAX_BOT_MESSAGE_CHARS = 8000
export const MAX_SUBJECT_CHARS = 120

// ── types ──

export interface BotConversation {
  id: number
  workspace: string
  initiator_slug: string
  recipient_slug: string
  subject: string
  started_by_user_id: number | null
  message_count: number
  last_message_at: string | null
  created_at: string
  updated_at: string
}

export type BotMessageKind = 'message' | 'reply' | 'tool' | 'error' | 'notice'
export type BotMessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'none'

export interface BotMessage {
  id: number
  conversation_id: number
  workspace: string
  kind: BotMessageKind
  from_slug: string
  to_slug: string | null
  body: string
  tool_name: string | null
  depth: number
  in_reply_to: number | null
  sent_by_user_id: number | null
  origin_user_id: number | null
  origin_agent_slug: string | null
  origin_thread_id: number | null
  status: BotMessageStatus
  attempts: number
  next_attempt_at: string | null
  lease_until: string | null
  last_error: string | null
  provider: string | null
  model: string | null
  meta: Record<string, unknown> | null
  created_at: string
  delivered_at: string | null
}

/** A refused send / read. `status` is what an HTTP route would answer. */
export class BotMessageRefused extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'refused') {
    super(message)
  }
}

/** A bot as addressing needs it. */
export interface BotRef {
  slug: string
  name: string
}

function mapConversation(r: Record<string, unknown>): BotConversation {
  return {
    id: Number(r.id),
    workspace: String(r.workspace),
    initiator_slug: String(r.initiator_slug),
    recipient_slug: String(r.recipient_slug),
    subject: String(r.subject ?? ''),
    started_by_user_id: r.started_by_user_id == null ? null : Number(r.started_by_user_id),
    message_count: Number(r.message_count ?? 0),
    last_message_at: (r.last_message_at as string) ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  }
}

export function mapBotMessage(r: Record<string, unknown>): BotMessage {
  let meta: Record<string, unknown> | null = null
  if (typeof r.meta === 'string' && r.meta) {
    try { meta = JSON.parse(r.meta) } catch { meta = null }
  }
  const num = (v: unknown) => (v == null ? null : Number(v))
  return {
    id: Number(r.id),
    conversation_id: Number(r.conversation_id),
    workspace: String(r.workspace),
    kind: r.kind as BotMessageKind,
    from_slug: String(r.from_slug),
    to_slug: (r.to_slug as string) ?? null,
    body: String(r.body ?? ''),
    tool_name: (r.tool_name as string) ?? null,
    depth: Number(r.depth ?? 0),
    in_reply_to: num(r.in_reply_to),
    sent_by_user_id: num(r.sent_by_user_id),
    origin_user_id: num(r.origin_user_id),
    origin_agent_slug: (r.origin_agent_slug as string) ?? null,
    origin_thread_id: num(r.origin_thread_id),
    status: r.status as BotMessageStatus,
    attempts: Number(r.attempts ?? 0),
    next_attempt_at: (r.next_attempt_at as string) ?? null,
    lease_until: (r.lease_until as string) ?? null,
    last_error: (r.last_error as string) ?? null,
    provider: (r.provider as string) ?? null,
    model: (r.model as string) ?? null,
    meta,
    created_at: String(r.created_at),
    delivered_at: (r.delivered_at as string) ?? null,
  }
}

/** SQLite's datetime('now') format, from a JS clock (so tests can move time). */
export function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

// ── who may use which workspace ──

function userRole(userId: number): string | null {
  const row = getDb().prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role?: string } | undefined
  return row?.role ?? null
}

/** The person's own workspaces (an admin: every workspace on the install). [] = no such user. */
export function personWorkspaces(userId: number): string[] {
  const role = userRole(userId)
  if (role === null) return []
  if (role === 'admin') {
    return (getDb().prepare('SELECT slug FROM workspaces ORDER BY slug').all() as { slug: string }[]).map(r => r.slug)
  }
  return getUserWorkspaces(userId).map(w => w.workspace)
}

/**
 * Where this bot may send and read bot messages while acting for this person:
 * (the person's workspaces) ∩ (the bot's list). An unrestricted bot (predates
 * access lists) is bounded by the person alone — the same rule as the board tools.
 */
export function botMessageWorkspaces(userId: number, slug: string): string[] {
  const mine = personWorkspaces(userId)
  const allow = botWorkspaceAllowlist(slug)
  return allow === null ? mine : mine.filter(w => allow.includes(w))
}

// ── audit ──

/**
 * One activity-feed line per send / delivery / failure / refusal. The thread
 * itself (bot_messages, with status, attempts and errors on every row) is the
 * durable record; this is the operator-visible trail. Best-effort by design: a
 * feed write never decides whether a message goes.
 */
export function auditBotMessage(kind: string, title: string, meta: Record<string, unknown> & { workspace?: string | null }): void {
  try {
    logActivity({
      project: 'operationkit',
      workspace: meta.workspace ?? undefined,
      event_type: kind === 'bot_message_failed' || kind === 'bot_message_refused' ? 'error' : 'progress',
      title: title.slice(0, 200),
      metadata: { kind, ...meta },
    })
  } catch { /* the activity feed is best-effort */ }
}

// ── delivery kick (bot-wake.ts registers; nothing registered = the timer picks it up) ──

let kick: (() => void) | null = null
export function onBotMessageQueued(fn: (() => void) | null): void {
  kick = fn
}

// ── reads ──

export function getConversationRow(id: number): BotConversation | null {
  if (!Number.isInteger(id) || id <= 0) return null
  const r = getDb().prepare('SELECT * FROM bot_conversations WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapConversation(r) : null
}

export function getBotMessage(id: number): BotMessage | null {
  const r = getDb().prepare('SELECT * FROM bot_messages WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapBotMessage(r) : null
}

/** In-clause helper. An empty scope matches nothing (never "everything"). */
function inList(values: string[]): { sql: string; params: string[] } {
  if (values.length === 0) return { sql: '(NULL)', params: [] }
  return { sql: `(${values.map(() => '?').join(', ')})`, params: values }
}

/**
 * A conversation, but ONLY when its workspace is in `workspaces` and (when
 * `participant` is given) that bot is one of its two ends. Anything else → null,
 * the same answer as "no such conversation".
 */
export function conversationInScope(id: number, workspaces: string[] | null, participant?: string): BotConversation | null {
  const c = getConversationRow(id)
  if (!c) return null
  if (workspaces !== null && !workspaces.includes(c.workspace)) return null
  if (participant && c.initiator_slug !== participant && c.recipient_slug !== participant) return null
  return c
}

export interface ConversationSummary extends BotConversation {
  last_preview: string | null
  last_kind: BotMessageKind | null
  /** Messages still waiting to be delivered (pending / delivering). */
  pending: number
  /** Messages that gave up. */
  failed: number
}

/**
 * Conversations in `workspaces` (null = every workspace, the admin view),
 * optionally only those `bot` takes part in. Newest activity first.
 */
export function listConversations(opts: { workspaces: string[] | null; bot?: string; withBot?: string; limit?: number }): ConversationSummary[] {
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(opts.limit) || 50)))
  const where: string[] = []
  const params: (string | number)[] = []
  if (opts.workspaces !== null) {
    const ws = inList(opts.workspaces)
    where.push(`c.workspace IN ${ws.sql}`)
    params.push(...ws.params)
  }
  if (opts.bot) {
    where.push('(c.initiator_slug = ? OR c.recipient_slug = ?)')
    params.push(opts.bot, opts.bot)
  }
  if (opts.withBot) {
    where.push('(c.initiator_slug = ? OR c.recipient_slug = ?)')
    params.push(opts.withBot, opts.withBot)
  }
  const rows = getDb()
    .prepare(
      `SELECT c.*,
              (SELECT m.body FROM bot_messages m WHERE m.conversation_id = c.id AND m.kind IN ('message', 'reply', 'notice') ORDER BY m.id DESC LIMIT 1) AS last_preview,
              (SELECT m.kind FROM bot_messages m WHERE m.conversation_id = c.id AND m.kind IN ('message', 'reply', 'notice') ORDER BY m.id DESC LIMIT 1) AS last_kind,
              (SELECT COUNT(*) FROM bot_messages m WHERE m.conversation_id = c.id AND m.status IN ('pending', 'delivering')) AS pending,
              (SELECT COUNT(*) FROM bot_messages m WHERE m.conversation_id = c.id AND m.status = 'failed') AS failed
         FROM bot_conversations c
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC
        LIMIT ?`,
    )
    .all(...params, limit) as Record<string, unknown>[]
  return rows.map(r => ({
    ...mapConversation(r),
    last_preview: r.last_preview == null ? null : String(r.last_preview).slice(0, 200),
    last_kind: (r.last_kind as BotMessageKind) ?? null,
    pending: Number(r.pending ?? 0),
    failed: Number(r.failed ?? 0),
  }))
}

/**
 * Every entry on one conversation, oldest first. The workspace predicate is on
 * the MESSAGE row itself (denormalised), so even a corrupted conversation_id
 * could not pull another workspace's text into this answer.
 */
export function conversationMessages(c: BotConversation, opts: { limit?: number } = {}): BotMessage[] {
  const limit = Math.min(500, Math.max(1, Math.trunc(Number(opts.limit) || 200)))
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
         SELECT * FROM bot_messages WHERE conversation_id = ? AND workspace = ? ORDER BY id DESC LIMIT ?
       ) ORDER BY id`,
    )
    .all(c.id, c.workspace, limit) as Record<string, unknown>[]
  return rows.map(mapBotMessage)
}

// ── writes ──

export interface InsertEntry {
  conversation: BotConversation
  kind: BotMessageKind
  from_slug: string
  to_slug: string | null
  body: string
  tool_name?: string | null
  depth?: number
  in_reply_to?: number | null
  sent_by_user_id?: number | null
  status?: BotMessageStatus
  provider?: string | null
  model?: string | null
  meta?: Record<string, unknown> | null
  origin?: { userId: number; agentSlug: string; threadId: number | null } | null
  nextAttemptAt?: string | null
}

/** Append one entry to a conversation (and bump its activity). */
export function insertEntry(e: InsertEntry): BotMessage {
  const db = getDb()
  const id = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO bot_messages (conversation_id, workspace, kind, from_slug, to_slug, body, tool_name, depth, in_reply_to,
                                   sent_by_user_id, origin_user_id, origin_agent_slug, origin_thread_id, status,
                                   next_attempt_at, provider, model, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.conversation.id,
        e.conversation.workspace,
        e.kind,
        e.from_slug,
        e.to_slug,
        e.body,
        e.tool_name ?? null,
        e.depth ?? 0,
        e.in_reply_to ?? null,
        e.sent_by_user_id ?? null,
        e.origin?.userId ?? null,
        e.origin?.agentSlug ?? null,
        e.origin?.threadId ?? null,
        e.status ?? 'none',
        e.nextAttemptAt ?? null,
        e.provider ?? null,
        e.model ?? null,
        e.meta ? JSON.stringify(e.meta) : null,
      )
    db.prepare(
      `UPDATE bot_conversations
          SET message_count = message_count + ?, last_message_at = datetime('now'), updated_at = datetime('now')
        WHERE id = ?`,
    ).run(e.kind === 'message' ? 1 : 0, e.conversation.id)
    return Number(info.lastInsertRowid)
  })()
  return getBotMessage(id) as BotMessage
}

export interface SendInput {
  /** The sending bot. */
  from: BotRef
  /** The person the sending bot is acting for (chat: the person typing; wake: the person the wake acts for). */
  userId: number
  /** Recipient bot slug or display name. Optional when replying on `conversationId`. */
  to?: unknown
  conversationId?: unknown
  /** A workspace to start the conversation in. Defaults to `defaultWorkspace`. */
  workspace?: unknown
  /** The chat's own workspace — where a new conversation starts unless `workspace` says otherwise. */
  defaultWorkspace: string
  text: unknown
  subject?: unknown
  /** Every bot on the install (the caller resolves it; this module never loads agent files). */
  bots: BotRef[]
  /** The chat lane the message is sent from — the reply is posted back there. Null inside a wake. */
  origin: { userId: number; agentSlug: string; threadId: number | null } | null
  /** Set when the SENDER is itself answering a bot message (bot-wake.ts). */
  wake?: { conversationId: number; depth: number } | null
}

export interface SendResult {
  conversation: BotConversation
  message: BotMessage
  recipient: BotRef
  created: boolean
}

function refuse(input: Pick<SendInput, 'from' | 'userId'>, workspace: string | null, reason: string, status = 400, code = 'refused'): never {
  auditBotMessage('bot_message_refused', `${input.from.name} could not message a bot: ${reason}`, {
    workspace,
    from: input.from.slug,
    user_id: input.userId,
    reason,
  })
  throw new BotMessageRefused(reason, status, code)
}

/** Resolve "to" by slug first, then by display name (case/space-insensitive). */
export function resolveBot(bots: BotRef[], raw: unknown): BotRef | null {
  if (typeof raw !== 'string') return null
  const want = raw.trim().replace(/^@/, '')
  if (!want) return null
  const bySlug = bots.find(b => b.slug === want)
  if (bySlug) return bySlug
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
  const byName = bots.filter(b => norm(b.name) === norm(want) || b.slug.toLowerCase() === want.toLowerCase())
  return byName.length === 1 ? byName[0] : null
}

/**
 * Queue a message from one bot to another. Never calls a model: the message is
 * an outbox row (status 'pending') that the delivery worker turns into a wake.
 * Every refusal is a BotMessageRefused with a sentence the model can repeat.
 */
export function sendBotMessage(input: SendInput): SendResult {
  if (!botMessagingEnabled()) refuse(input, null, 'Bot-to-bot messaging is switched off on this install.', 503, 'disabled')
  const text = typeof input.text === 'string' ? input.text.trim() : ''
  if (!text) refuse(input, null, 'text is required: what do you want to tell the other bot?')
  if (text.length > MAX_BOT_MESSAGE_CHARS) refuse(input, null, `The message is too long (${MAX_BOT_MESSAGE_CHARS.toLocaleString('en-US')} characters max).`)

  const scope = botMessageWorkspaces(input.userId, input.from.slug)
  const depth = input.wake ? input.wake.depth + 1 : 0
  if (depth > maxBotMessageDepth()) {
    refuse(input, null, `This chain of bot messages is already ${input.wake?.depth ?? 0} hops deep, the most this install allows. Answer with what you have instead.`, 409, 'depth')
  }

  let conversation: BotConversation | null = null
  let recipient: BotRef | null = null
  let created = false
  const db = getDb()

  if (input.conversationId !== undefined && input.conversationId !== null && input.conversationId !== '') {
    const id = Math.trunc(Number(input.conversationId))
    // In a wake the bot may only see the conversation that woke it (+ its own workspace scope).
    const wakeScope = input.wake ? scope.filter(w => w === conversationWorkspace(input.wake!.conversationId)) : scope
    conversation = conversationInScope(id, wakeScope, input.from.slug)
    if (!conversation) refuse(input, null, `Bot conversation #${input.conversationId} not found.`, 404, 'not_found')
    if (input.wake && input.wake.conversationId === conversation.id) {
      refuse(input, conversation.workspace, 'You are answering this conversation right now: your final answer IS your reply. Do not use message_bot for it.', 409, 'self_reply')
    }
    const otherSlug = conversation.initiator_slug === input.from.slug ? conversation.recipient_slug : conversation.initiator_slug
    recipient = input.bots.find(b => b.slug === otherSlug) ?? null
    if (!recipient) refuse(input, conversation.workspace, `The other bot on conversation #${conversation.id} (${otherSlug}) is no longer on this install.`, 404, 'no_recipient')
    if (input.to !== undefined && input.to !== null && input.to !== '') {
      const named = resolveBot(input.bots, input.to)
      if (!named || named.slug !== recipient.slug) {
        refuse(input, conversation.workspace, `Conversation #${conversation.id} is with ${recipient.name} (${recipient.slug}). Leave "to" out, or start a new conversation for another bot.`)
      }
    }
  } else {
    recipient = resolveBot(input.bots, input.to)
    if (!recipient) {
      const names = input.bots.filter(b => b.slug !== input.from.slug).map(b => `${b.name} (${b.slug})`)
      refuse(input, null, `No bot "${String(input.to ?? '')}" on this install.${names.length ? ` Bots: ${names.slice(0, 20).join(', ')}.` : ''}`, 404, 'no_recipient')
    }
    if (recipient.slug === input.from.slug) refuse(input, null, 'A bot cannot message itself.')
    const rawWs = typeof input.workspace === 'string' && input.workspace.trim() ? input.workspace.trim() : input.defaultWorkspace
    const ws = input.wake ? conversationWorkspace(input.wake.conversationId) : rawWs
    if (input.wake && rawWs && rawWs !== ws) {
      refuse(input, ws, `While answering a bot message you can only message bots in that conversation's workspace (${ws}).`, 403, 'workspace')
    }
    // Same answer whether or not the workspace exists: no existence oracle.
    if (!ws || !scope.includes(ws)) {
      refuse(input, null, `You can't message bots in "${ws || '(no workspace)'}" from here. Workspaces you may use: ${scope.join(', ') || '(none)'}.`, 403, 'workspace')
    }
    if (!botMayUseWorkspace(recipient.slug, ws)) {
      refuse(input, ws, `${recipient.name} is not granted the ${ws} workspace, so it cannot receive messages there. An admin grants it on ${recipient.name}'s settings panel (Workspace access).`, 403, 'recipient_workspace')
    }
    const subject = (typeof input.subject === 'string' && input.subject.trim() ? input.subject : text)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_SUBJECT_CHARS)
    const info = db
      .prepare('INSERT INTO bot_conversations (workspace, initiator_slug, recipient_slug, subject, started_by_user_id) VALUES (?, ?, ?, ?, ?)')
      .run(ws, input.from.slug, recipient.slug, subject, input.userId)
    conversation = getConversationRow(Number(info.lastInsertRowid)) as BotConversation
    created = true
  }

  // Re-checked on an existing conversation too: a revoke since the last message must stop this one.
  if (!botMayUseWorkspace(recipient.slug, conversation.workspace)) {
    refuse(input, conversation.workspace, `${recipient.name} is no longer granted the ${conversation.workspace} workspace.`, 403, 'recipient_workspace')
  }
  if (conversation.message_count >= maxMessagesPerConversation()) {
    refuse(input, conversation.workspace, `Conversation #${conversation.id} is full (${maxMessagesPerConversation()} messages). Start a new one.`, 409, 'full')
  }
  if (rateLimit(`bot-message:${input.from.slug}`, botMessageRatePerMinute()) !== null) {
    refuse(input, conversation.workspace, 'Too many bot messages in the last minute. Wait a moment and try again.', 429, 'rate')
  }

  const message = insertEntry({
    conversation,
    kind: 'message',
    from_slug: input.from.slug,
    to_slug: recipient.slug,
    body: text,
    depth,
    sent_by_user_id: input.userId,
    status: 'pending',
    origin: input.origin,
    nextAttemptAt: sqlTime(new Date()),
  })
  auditBotMessage('bot_message_sent', `${input.from.name} messaged ${recipient.name} (bot conversation #${conversation.id})`, {
    workspace: conversation.workspace,
    conversation_id: conversation.id,
    message_id: message.id,
    from: input.from.slug,
    to: recipient.slug,
    user_id: input.userId,
    depth,
  })
  try { kick?.() } catch { /* the timer delivers it anyway */ }
  return { conversation: getConversationRow(conversation.id) as BotConversation, message, recipient, created }
}

function conversationWorkspace(id: number): string {
  return getConversationRow(id)?.workspace ?? ''
}
