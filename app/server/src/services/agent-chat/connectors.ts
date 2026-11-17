// ── Email + calendar connectors for chat agents (obj 719987, obj 901331) ──
//
// Agents only ever DRAFT. There is deliberately no "send" tool and no
// tool-facing send/insert method: a draft is a row in agent_chat_drafts that
// the person sees in the chat with a Send (or "Add to calendar") button, and
// only that click — a separate, cookie-authed HTTP call — acts on it, through
// `resolveDelivery()` below. The connectors handed to tools (`Connectors`)
// can read and save drafts; they cannot deliver.
//
// Backends:
//   - the person's own Google account (`user_google_connections`), for every
//     real bot, gated by the owner's "Who can use it" rules (./google-connectors.ts);
//   - the built-in sample inbox + calendar (./demo), for the demo assistant
//     (DEMO_AGENT_SLUG) ONLY. The install-wide demo switch
//     (settings.agent_chat_demo / AGENT_CHAT_DEMO) only lists that assistant;
//     it no longer gives other bots the sample inbox.
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { DEMO_AGENT_SLUG, DEMO_DIR } from './agent-defs.js'
import { googleConnectorsFor, googleDelivery } from './google-connectors.js'

export interface MailSummary { id: string; from: string; subject: string; received_at: string; unread: boolean; preview: string }
export interface MailMessage extends MailSummary { body: string }
export interface CalendarEvent { id: string; title: string; start: string; end: string; with: string[] }

export interface EmailDraft {
  to: string
  subject: string
  body: string
  in_reply_to?: string | null
  /** The matching draft in the account's own Drafts folder (Gmail draft id), when there is one. */
  remote_id?: string | null
}
export interface EventDraft { title: string; start: string; end: string; with: string[]; note?: string | null }

type MaybeAsync<T> = T | Promise<T>

/** What a TOOL may do with a mailbox: read, and save drafts. No send. */
export interface MailConnector {
  id: string
  label: string
  listInbox(limit: number, unreadOnly: boolean): MaybeAsync<MailSummary[]>
  read(id: string): MaybeAsync<MailMessage | null>
  /** Save the draft in the account's own Drafts folder too (Gmail). Never sends. */
  saveDraft?(draft: EmailDraft): Promise<{ remote_id: string }>
}
/** What a TOOL may do with a calendar: read. Events are drafted as rows, never inserted. */
export interface CalendarConnector {
  id: string
  label: string
  listEvents(fromIso: string, toIso: string): MaybeAsync<CalendarEvent[]>
}

interface DemoInbox { messages: { id: string; hours_ago: number; from: string; subject: string; unread: boolean; body: string }[] }
interface DemoCalendar { events: { id: string; day_offset: number; start: string; minutes: number; title: string; with: string[] }[] }

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(DEMO_DIR, file), 'utf8')) as T
}

/** Sample data is stored with relative times so the demo always looks current. */
export function demoMail(now: () => Date = () => new Date()): MailConnector {
  const all = (): MailMessage[] =>
    readJson<DemoInbox>('inbox.json').messages.map(m => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      unread: m.unread,
      received_at: new Date(now().getTime() - m.hours_ago * 3600_000).toISOString(),
      preview: m.body.replace(/\s+/g, ' ').slice(0, 140),
      body: m.body,
    }))
  return {
    id: 'demo',
    label: 'Demo inbox (sample data)',
    listInbox: (limit, unreadOnly) =>
      all()
        .filter(m => !unreadOnly || m.unread)
        .slice(0, limit)
        .map(({ body: _b, ...s }) => s),
    read: id => all().find(m => m.id === id) ?? null,
  }
}

export function demoCalendar(now: () => Date = () => new Date()): CalendarConnector {
  const all = (): CalendarEvent[] => {
    const base = now()
    return readJson<DemoCalendar>('calendar.json').events.map(e => {
      const [h, m] = e.start.split(':').map(Number)
      const start = new Date(base.getFullYear(), base.getMonth(), base.getDate() + e.day_offset, h, m)
      return { id: e.id, title: e.title, with: e.with, start: start.toISOString(), end: new Date(start.getTime() + e.minutes * 60_000).toISOString() }
    })
  }
  return {
    id: 'demo',
    label: 'Demo calendar (sample data)',
    listEvents: (fromIso, toIso) => {
      const from = Date.parse(fromIso)
      const to = Date.parse(toIso)
      return all().filter(e => Date.parse(e.end) >= from && Date.parse(e.start) <= to)
    },
  }
}

export interface Connectors { mail: MailConnector | null; calendar: CalendarConnector | null }

export interface ResolveConnectorsOpts {
  /** Force the sample inbox. Only the demo assistant should pass this. */
  demo?: boolean
  /** The bot. The demo assistant always gets the sample inbox and needs no Google account. */
  agentSlug?: string | null
  /** The person the bot is acting for. Their own Google connection is the only one used. */
  userId?: number | null
  /** The chat's workspace, for the owner's "Who can use it" workspace list. */
  workspace?: string | null
  now?: () => Date
}

/**
 * The mailbox + calendar a bot's TOOLS get for this turn.
 *
 *  - demo assistant (or `demo: true`) → sample data, no Google needed;
 *  - any other bot → the person's own Google account, if connected AND their
 *    connector_access rules allow this bot in this workspace;
 *  - otherwise nothing ("No email account is connected").
 *
 * The install-wide demo switch is deliberately NOT an input here: it used to
 * put every bot on the sample inbox (obj 901331).
 */
export function resolveConnectors(opts: ResolveConnectorsOpts): Connectors {
  if (opts.demo || opts.agentSlug === DEMO_AGENT_SLUG) return { mail: demoMail(opts.now), calendar: demoCalendar(opts.now) }
  if (opts.agentSlug && typeof opts.userId === 'number' && opts.userId > 0) {
    return googleConnectorsFor({ userId: opts.userId, agent: opts.agentSlug, workspace: opts.workspace ?? null })
  }
  return { mail: null, calendar: null }
}

/** What the person's click does with a draft. Never handed to a tool. */
export interface DraftDelivery {
  sendEmail(draft: EmailDraft): Promise<void>
  discardEmail(draft: EmailDraft): Promise<void>
  addEvent(draft: EventDraft): Promise<void>
}

const demoDelivery: DraftDelivery = {
  // Demo: the draft row flips to "sent"/"added"; nothing leaves the server.
  sendEmail: async () => {},
  discardEmail: async () => {},
  addEvent: async () => {},
}

/**
 * Delivery for a draft's connector, acting for the person who clicked
 * (routes/agent-chat.ts, signed-in browser only). Null when that account is no
 * longer connected (or is now a different Google account).
 */
export function resolveDelivery(userId: number, connectorId: string): DraftDelivery | null {
  if (connectorId === 'demo') return demoDelivery
  if (connectorId.startsWith('google:')) return googleDelivery(userId, connectorId)
  return null
}

// ── Drafts ──

export type DraftKind = 'email' | 'event'
export type DraftStatus = 'draft' | 'sent' | 'added' | 'discarded'
export interface DraftRow {
  id: number
  user_id: number
  agent_slug: string
  kind: DraftKind
  connector: string
  payload: EmailDraft | EventDraft
  status: DraftStatus
  created_at: string
  updated_at: string
}

function mapDraft(r: Record<string, unknown>): DraftRow {
  return { ...(r as unknown as DraftRow), payload: JSON.parse(String(r.payload)) }
}

export function createDraft(userId: number, agentSlug: string, kind: DraftKind, connector: string, payload: EmailDraft | EventDraft): DraftRow {
  const db = getDb()
  const info = db
    .prepare('INSERT INTO agent_chat_drafts (user_id, agent_slug, kind, connector, payload) VALUES (?, ?, ?, ?, ?)')
    .run(userId, agentSlug, kind, connector, JSON.stringify(payload))
  return getDraft(Number(info.lastInsertRowid))!
}

export function getDraft(id: number): DraftRow | null {
  const r = getDb().prepare('SELECT * FROM agent_chat_drafts WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapDraft(r) : null
}

export function listDrafts(userId: number, agentSlug: string): DraftRow[] {
  return (getDb()
    .prepare('SELECT * FROM agent_chat_drafts WHERE user_id = ? AND agent_slug = ? ORDER BY id')
    .all(userId, agentSlug) as Record<string, unknown>[]).map(mapDraft)
}

export function setDraftStatus(id: number, status: DraftStatus): void {
  getDb().prepare("UPDATE agent_chat_drafts SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, id)
}
