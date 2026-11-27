// ── Real Gmail + Google Calendar for chat bots (obj 901331) ──
//
// Backed by the person's own `user_google_connections` row: a bot chatting with
// Operator reads Operator's inbox; a bot chatting with Casey reads Casey's. Nobody else's.
//
// What a bot can do here, and nothing more:
//   - read the inbox, read one message, list calendar events;
//   - save an email DRAFT into the account's own Gmail Drafts folder.
// There is no tool-facing send or insert-event. Sending a draft and adding an
// event live in `googleDelivery()`, which only the person's Send / "Add to
// calendar" click (routes/agent-chat.ts, signed-in browser only) reaches.
//
// Access: the owner's "Who can use it" rules (connector_access) are applied to
// every chat use with the bot's slug and the chat's workspace, exactly as they
// are for card sessions. A bot the owner left out gets no connector at all.
//
// Tokens: `getAccessTokenForUser` refreshes an expired access token with the
// stored refresh token. If Google refuses the refresh (a stale grant), the
// failure is recorded on the row and the tool says to reconnect at Settings →
// Account → Google Workspace. Nothing here revokes, rotates or replaces a
// credential, and no token value is ever returned or logged.
import { canUseConnectorCredential, type ConnectorActor } from '../connector-guard.js'
import {
  CONNECTOR_ID,
  getAccessTokenForUser,
  getForUser,
  googleApiFetch,
} from '../user-google-connections.js'
import type {
  CalendarConnector,
  CalendarEvent,
  EmailDraft,
  EventDraft,
  MailConnector,
  MailMessage,
  MailSummary,
} from './connectors.js'

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars/primary'

export const RECONNECT_HINT = 'Reconnect Google at Settings → Account → Google Workspace.'

export interface GoogleUse {
  userId: number
  /** The bot's slug — matched against the owner's "Who can use it" agent list. */
  agent: string
  /** The chat's workspace — matched against the owner's workspace list. */
  workspace: string | null
  /**
   * Who is using the credential. Chat is the person themself (the default). A
   * card session reaching Google through the host-side connector broker
   * (obj 901743) passes its session actor, so an agent key's connector list
   * still applies on every token use.
   */
  actor?: ConnectorActor
}

function actorOf(use: GoogleUse): ConnectorActor {
  return use.actor ?? { kind: 'user', userId: use.userId }
}

const MAIL_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.readonly',
]
const COMPOSE_SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
]
const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
]

function hasAny(granted: string, wanted: string[]): boolean {
  const set = new Set(granted.split(/\s+/).filter(Boolean))
  return wanted.some(w => set.has(w))
}

/** The draft row's `connector` for a Google account. Send refuses if the account changed since. */
export function googleConnectorId(email: string): string {
  return `google:${email.toLowerCase()}`
}

// ── Authenticated calls ──

interface Authed {
  call(url: string, init?: RequestInit): Promise<Response>
}

function authed(userId: number, actor: ConnectorActor, use?: { agent: string; workspace: string | null }): Authed {
  const token = async (forceRefresh: boolean): Promise<string> => {
    const t = await getAccessTokenForUser(userId, actor, { use, forceRefresh })
    if (t) return t
    const err = getForUser(userId)?.last_error
    throw new Error(
      err
        ? `Google is not answering for this account: ${err.replace(/\s*Reconnect Google Workspace\.?\s*$/i, '')} ${RECONNECT_HINT}`
        : `Google is not available for this bot. ${RECONNECT_HINT}`,
    )
  }
  return {
    async call(url, init = {}) {
      const go = async (t: string) =>
        googleApiFetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${t}` } })
      let res = await go(await token(false))
      // A cached token Google already dropped: refresh once, never more.
      if (res.status === 401) res = await go(await token(true))
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Google refused the request (HTTP ${res.status}). ${RECONNECT_HINT}`)
      }
      return res
    },
  }
}

async function json<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) throw new Error(`Google ${what} failed (HTTP ${res.status}).`)
  return (await res.json()) as T
}

// ── Gmail ──

interface GmailHeader { name: string; value: string }
interface GmailPart { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: GmailHeader[] }
interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

function header(m: GmailMessage, name: string): string {
  const h = m.payload?.headers?.find(x => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

function b64urlDecode(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function findPart(p: GmailPart | undefined, mime: string): string | null {
  if (!p) return null
  if (p.mimeType === mime && p.body?.data) return b64urlDecode(p.body.data)
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime)
    if (hit != null) return hit
  }
  return null
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', rsquo: '\u2019', lsquo: '\u2018',
  rdquo: '\u201d', ldquo: '\u201c', copy: '\u00a9', reg: '\u00ae', trade: '\u2122', bull: '\u2022',
}

/**
 * Decode HTML entities in ONE pass. Each `&...;` is replaced exactly once by a
 * callback, so the output of a replacement is never looked at again:
 * `&amp;lt;` becomes the text `&lt;`, never `<`.
 */
function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (code === 0xa0) return ' '
      return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : m
    }
    return HTML_ENTITIES[e.toLowerCase()] ?? m
  })
}

/** Elements whose content is never text. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'head', 'title', 'noscript', 'template', 'svg', 'iframe', 'object'])
/** Tags that end a line of text. */
const LINE_BREAK_TAGS = new Set(['br', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol', 'hr'])

/**
 * Email HTML → plain text. A single left-to-right scan, not a chain of
 * regex replaces (CodeQL js/incomplete-multi-character-sanitization,
 * js/double-escaping):
 *  - every `<…>` tag is dropped; a tag never becomes text,
 *  - the CONTENT of script/style (and other non-text elements) is skipped up to
 *    its closing tag, so `<scr<script>ipt>…` cannot rebuild a tag,
 *  - any `<` / `>` left in the raw text is dropped, so no markup survives,
 *  - entities are decoded once, at the end, on the text only — a `<` in the
 *    output can only come from an entity the sender wrote, and is plain text.
 */
export function htmlToText(html: string): string {
  const out: string[] = []
  const lower = html.toLowerCase()
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt === -1) { out.push(html.slice(i)); break }
    if (lt > i) out.push(html.slice(i, lt))
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4)
      i = close === -1 ? n : close + 3
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt === -1) break // unterminated tag: drop the rest
    const inner = html.slice(lt + 1, gt)
    const m = /^(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(inner)
    i = gt + 1
    if (!m) continue // `<!doctype>`, `<?xml?>`, `< 3` etc.: dropped
    const closing = m[1] === '/'
    const name = m[2].toLowerCase()
    if (!closing && RAW_TEXT_ELEMENTS.has(name) && !/\/\s*$/.test(inner)) {
      const end = lower.indexOf(`</${name}`, i)
      if (end === -1) { i = n; break }
      const endGt = html.indexOf('>', end)
      i = endGt === -1 ? n : endGt + 1
      continue
    }
    if (name === 'p') out.push(closing ? '\n\n' : '\n')
    else if (LINE_BREAK_TAGS.has(name)) out.push('\n')
    else if (name === 'td' || name === 'th') out.push(' ')
    // inline tags (b, span, a, …) add nothing: `Hel<b>lo</b>` reads `Hello`
  }
  const text = out.join('').replace(/[<>]/g, '')
  return decodeHtmlEntities(text)
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Plain-text body: text/plain, else text/html stripped, else the snippet. Capped so one email cannot flood a turn. */
export function gmailBodyText(m: GmailMessage): string {
  const plain = findPart(m.payload, 'text/plain')
  const text = plain ?? (() => { const h = findPart(m.payload, 'text/html'); return h == null ? null : htmlToText(h) })() ?? m.snippet ?? ''
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(truncated)` : text
}

function summaryOf(m: GmailMessage): MailSummary {
  const ms = Number(m.internalDate)
  return {
    id: m.id,
    from: header(m, 'From'),
    subject: header(m, 'Subject') || '(no subject)',
    received_at: Number.isFinite(ms) ? new Date(ms).toISOString() : '',
    unread: (m.labelIds ?? []).includes('UNREAD'),
    preview: (m.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140),
  }
}

/** A header value must not carry a line break (header injection). */
function oneLine(v: string): string {
  return v.replace(/[\r\n]+/g, ' ').trim()
}

/** RFC 2822 message for Gmail's `raw` field. Subject is RFC 2047-encoded when not ASCII. */
export function buildRawEmail(draft: EmailDraft, threading?: { messageId: string; references: string }): string {
  const subject = oneLine(draft.subject)
  const encSubject = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`
  const lines = [
    `To: ${oneLine(draft.to)}`,
    `Subject: ${encSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
  ]
  if (threading?.messageId) {
    lines.push(`In-Reply-To: ${oneLine(threading.messageId)}`)
    lines.push(`References: ${oneLine([threading.references, threading.messageId].filter(Boolean).join(' '))}`)
  }
  return b64urlEncode(`${lines.join('\r\n')}\r\n\r\n${draft.body.replace(/\r?\n/g, '\r\n')}`)
}

async function threadingFor(api: Authed, inReplyTo: string | null | undefined): Promise<{ threadId?: string; messageId: string; references: string } | undefined> {
  if (!inReplyTo) return undefined
  const res = await api.call(`${GMAIL_API}/messages/${encodeURIComponent(inReplyTo)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`)
  if (res.status === 404) return undefined
  const m = await json<GmailMessage>(res, 'read')
  return { threadId: m.threadId, messageId: header(m, 'Message-ID'), references: header(m, 'References') }
}

async function draftBody(api: Authed, draft: EmailDraft): Promise<{ message: { raw: string; threadId?: string } }> {
  const t = await threadingFor(api, draft.in_reply_to)
  return { message: { raw: buildRawEmail(draft, t), ...(t?.threadId ? { threadId: t.threadId } : {}) } }
}

function gmailConnector(use: GoogleUse, email: string, canCompose: boolean): MailConnector {
  const api = authed(use.userId, actorOf(use), { agent: use.agent, workspace: use.workspace })
  return {
    id: googleConnectorId(email),
    label: `Gmail (${email})`,
    async listInbox(limit, unreadOnly) {
      const q = new URLSearchParams({ maxResults: String(limit), labelIds: 'INBOX' })
      if (unreadOnly) q.set('q', 'is:unread')
      const list = await json<{ messages?: { id: string }[] }>(await api.call(`${GMAIL_API}/messages?${q}`), 'inbox list')
      const meta = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Subject'], ['metadataHeaders', 'Date']])
      const rows = await Promise.all((list.messages ?? []).map(async ({ id }) => {
        const res = await api.call(`${GMAIL_API}/messages/${encodeURIComponent(id)}?${meta}`)
        return res.ok ? summaryOf((await res.json()) as GmailMessage) : null
      }))
      return rows.filter((m): m is MailSummary => m !== null)
    },
    async read(id) {
      const res = await api.call(`${GMAIL_API}/messages/${encodeURIComponent(id)}?format=full`)
      if (res.status === 404 || res.status === 400) return null
      const m = await json<GmailMessage>(res, 'read')
      const full: MailMessage = { ...summaryOf(m), body: gmailBodyText(m) }
      return full
    },
    async saveDraft(draft) {
      if (!canCompose) throw new Error(`This Google connection was not granted Gmail drafts. ${RECONNECT_HINT}`)
      // users.drafts.create — a DRAFT in the account's Drafts folder. Nothing is sent.
      const res = await api.call(`${GMAIL_API}/drafts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(await draftBody(api, draft)),
      })
      const d = await json<{ id?: string }>(res, 'draft save')
      if (!d.id) throw new Error('Google saved no draft id.')
      return { remote_id: d.id }
    },
  }
}

// ── Calendar ──

interface GEvent {
  id: string
  summary?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: { email?: string; displayName?: string; self?: boolean }[]
}

function calendarConnector(use: GoogleUse, email: string): CalendarConnector {
  const api = authed(use.userId, actorOf(use), { agent: use.agent, workspace: use.workspace })
  return {
    id: googleConnectorId(email),
    label: `Google Calendar (${email})`,
    async listEvents(fromIso, toIso) {
      const q = new URLSearchParams({
        timeMin: new Date(fromIso).toISOString(),
        timeMax: new Date(toIso).toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
      })
      const r = await json<{ items?: GEvent[] }>(await api.call(`${CALENDAR_API}/events?${q}`), 'calendar list')
      return (r.items ?? []).map((e): CalendarEvent => ({
        id: e.id,
        title: e.summary || '(no title)',
        start: e.start?.dateTime || e.start?.date || '',
        end: e.end?.dateTime || e.end?.date || '',
        with: (e.attendees ?? []).filter(a => !a.self).map(a => a.displayName || a.email || '').filter(Boolean),
      }))
    },
  }
}

// ── Resolution ──

export interface GoogleConnectors { mail: MailConnector | null; calendar: CalendarConnector | null }

/**
 * The person's Google mailbox and calendar for ONE bot in ONE workspace, or
 * nulls when they have no connection, or their "Who can use it" rules leave
 * this bot / workspace out. The rule is re-checked (and a refusal audited) on
 * every call that would use the token, so a rule tightened mid-chat applies at
 * once.
 */
export function googleConnectorsFor(use: GoogleUse): GoogleConnectors {
  const none = { mail: null, calendar: null }
  if (!(use.userId > 0) || !use.agent) return none
  let summary
  try {
    summary = getForUser(use.userId)
  } catch {
    return none
  }
  if (!summary?.google_email) return none
  const decision = canUseConnectorCredential({
    connectorId: CONNECTOR_ID,
    ownerUserId: use.userId,
    actor: actorOf(use),
    use: { agent: use.agent, workspace: use.workspace },
  })
  if (!decision.allowed) return none
  const scopes = summary.scopes || ''
  return {
    mail: hasAny(scopes, MAIL_SCOPES) ? gmailConnector(use, summary.google_email, hasAny(scopes, COMPOSE_SCOPES)) : null,
    calendar: hasAny(scopes, CALENDAR_SCOPES) ? calendarConnector(use, summary.google_email) : null,
  }
}

// ── The person's click (routes/agent-chat.ts only) ──

export interface GoogleDelivery {
  /** Send an email draft. Updates the saved Gmail draft to the edited text first, then sends that draft. */
  sendEmail(draft: EmailDraft): Promise<void>
  /** Delete the saved Gmail draft when the person discards it in chat. */
  discardEmail(draft: EmailDraft): Promise<void>
  /**
   * Put an event on the person's primary calendar. `sendUpdates=none`: the
   * guests are listed but Google emails nobody; the person can send the invite
   * from Google Calendar.
   */
  addEvent(draft: EventDraft): Promise<void>
}

/**
 * Delivery for a draft made on `connectorId`, acting for the person who
 * clicked. Null when that person's connection is gone or is now a different
 * Google account than the one the draft was made for.
 *
 * NOT for tools: nothing in tools.ts imports this, and a test asserts that.
 */
export function googleDelivery(userId: number, connectorId: string): GoogleDelivery | null {
  const summary = getForUser(userId)
  if (!summary?.google_email || googleConnectorId(summary.google_email) !== connectorId) return null
  const api = authed(userId, { kind: 'user', userId })
  return {
    async sendEmail(draft) {
      if (draft.remote_id) {
        const body = await draftBody(api, draft)
        const up = await api.call(`${GMAIL_API}/drafts/${encodeURIComponent(draft.remote_id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: draft.remote_id, ...body }),
        })
        if (up.ok) {
          await json(await api.call(`${GMAIL_API}/drafts/send`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: draft.remote_id }),
          }), 'send')
          return
        }
        // The person deleted the Gmail draft already: send the chat copy instead.
        if (up.status !== 404) throw new Error(`Google draft update failed (HTTP ${up.status}).`)
      }
      const { message } = await draftBody(api, draft)
      await json(await api.call(`${GMAIL_API}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message),
      }), 'send')
    },
    async discardEmail(draft) {
      if (!draft.remote_id) return
      const res = await api.call(`${GMAIL_API}/drafts/${encodeURIComponent(draft.remote_id)}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404) throw new Error(`Google draft delete failed (HTTP ${res.status}).`)
    },
    async addEvent(draft) {
      const attendees = draft.with.filter(w => /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(w.trim())).map(email => ({ email: email.trim() }))
      const others = draft.with.filter(w => !attendees.some(a => a.email === w.trim()))
      const description = [draft.note, others.length ? `With: ${others.join(', ')}` : ''].filter(Boolean).join('\n\n')
      await json(await api.call(`${CALENDAR_API}/events?sendUpdates=none`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          summary: draft.title,
          ...(description ? { description } : {}),
          start: { dateTime: new Date(draft.start).toISOString() },
          end: { dateTime: new Date(draft.end).toISOString() },
          ...(attendees.length ? { attendees } : {}),
        }),
      }), 'calendar add')
    },
  }
}
