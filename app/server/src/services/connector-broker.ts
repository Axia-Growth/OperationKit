/**
 * Host-side connector broker for card sessions (obj 901743, public issue #136).
 *
 * A spawned session (Claude Code, Codex or Grok, tmux or jail) no longer holds
 * the card owner's GitHub PAT or Google refresh token / OAuth client in its
 * process env. It holds only its card-scoped `CC_SESSION_TOKEN`, and every
 * connector use is a request to this broker, decided on the LIVE card row:
 *
 *   GitHub — `brokerGithubCredential`: a git credential helper and a `gh` shim
 *     inside the session ask for a credential for ONE repo. The repo must be
 *     linked to the card's workspace (or be the card's own project repo). The
 *     owner's connector rules (agent-key list, Who can use it, delegated-card
 *     opt-in, scoped-bot pack) are re-checked and audited on every request, so
 *     a tightened rule or a revoked key applies at once rather than at the next
 *     spawn. The credential is handed to the git / gh child process for that one
 *     call; it is never exported into the agent's env.
 *
 *   Google — `brokerGoogle` + `callGoogleTool`: the session's MCP client talks to
 *     the broker's MCP endpoint. The refresh token and client secret stay on the
 *     host; the broker refreshes the access token and calls Gmail / Calendar
 *     itself, after enforcing the card's connector mode (`drafts_only` or
 *     `read_and_drafts`). There is no send, no event insert and no raw API path.
 *
 *   Workspace MCP servers — `resolveRelayServer`: their access tokens were
 *     `CC_MCP_TOKEN_<id>` env vars; the broker now relays the session's JSON-RPC
 *     to the server with the token added on the host.
 *
 * No function here returns a credential to a caller other than the route that
 * hands it to the credential helper / gh shim, and nothing logs one.
 *
 * Residual risk (documented in the PR): without a GitHub App there is no way to
 * mint a short-lived, repo-scoped installation token, so the git/gh credential
 * is still the owner's PAT — scoped per request to the card's repos, audited,
 * and never resident in the env. A GitHub App installation token is the follow-up.
 */
import type Database from 'better-sqlite3'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import {
  sessionTokenFromHeaders,
  verifySessionToken,
  type SessionTokenClaims,
} from '../lib/session-trust.js'
import { checkConnectorCredential, type ConnectorDenyReason } from './connector-guard.js'
import { CONNECTOR_ID as GITHUB_CONNECTOR, getDecryptedForUser } from './user-github-tokens.js'
import { CONNECTOR_ID as GOOGLE_CONNECTOR, getForUser as getGoogleSummary } from './user-google-connections.js'
import { resolveSecrets } from './secrets-store.js'
import { resolveWriteWorkspace } from './workspaces.js'
import {
  isDelegatedCard,
  resolveActingUserId,
  safeBotScope,
  sessionSecretKeyFilter,
  spawnActor,
} from './session-spawn-env.js'
import type { GoogleUse as GoogleMode } from './bot-session-scope.js'
import { googleConnectorsFor, type GoogleConnectors } from './agent-chat/google-connectors.js'
import { listServerRows, type McpServerRow } from './workspace-mcp-servers.js'
import { frameAndScan } from './injection-telemetry.js'

// ── The card behind a request ───────────────────────────────────────────────

export interface BrokerCard {
  objective: Objective
  claims: SessionTokenClaims
  /** The owner whose connections this session acts with (assignee, else creator). */
  ownerUserId: number | null
  workspace: string
}

export type BrokerRefusal = { ok: false; status: number; code: string; error: string }

function refuse(status: number, code: string, error: string): BrokerRefusal {
  return { ok: false, status, code, error }
}

/**
 * Resolve the session token on a request to its LIVE card. Refused when the
 * token is missing / forged / expired, the card is gone or ended, the card moved
 * workspace, or the card changed owner since the token was minted (a session
 * minted for one person never reaches another person's connection).
 */
export function resolveBrokerCard(
  headers: Record<string, string | string[] | undefined>,
  db: Database.Database = getDb(),
): { ok: true; card: BrokerCard } | BrokerRefusal {
  let claims: SessionTokenClaims | null = null
  try {
    claims = verifySessionToken(sessionTokenFromHeaders(headers))
  } catch {
    claims = null
  }
  if (!claims) return refuse(401, 'session_token_invalid', 'A valid X-CC-Session-Token is required.')
  let row: (Objective & { deleted_at?: string | null }) | undefined
  try {
    row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(claims.objectiveId) as typeof row
  } catch {
    row = undefined
  }
  if (!row || row.deleted_at) return refuse(403, 'card_gone', 'This card no longer exists.')
  if (row.status === 'done' || row.status === 'cancelled') return refuse(403, 'card_ended', 'This card has ended; its session token no longer works.')
  const workspace = resolveWriteWorkspace(row.workspace)
  if (workspace !== claims.workspace) return refuse(403, 'workspace_changed', 'This card moved workspace since the session started.')
  const ownerUserId = resolveActingUserId(row)
  if ((claims.actingUserId ?? null) !== (ownerUserId ?? null)) {
    return refuse(403, 'owner_changed', 'This card changed owner since the session started; restart the session.')
  }
  return { ok: true, card: { objective: row, claims, ownerUserId, workspace } }
}

// ── GitHub ──────────────────────────────────────────────────────────────────

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/

/**
 * `owner/repo` (lower-case) from anything a caller may hand over: `owner/repo`,
 * `owner/repo.git`, a git credential `path` (`Owner/Repo.git/info/lfs`), an
 * https or ssh GitHub URL. Null for anything else, including `..` segments.
 */
export function normalizeGithubRepo(input: string | null | undefined): string | null {
  let s = String(input ?? '').trim()
  if (!s) return null
  s = s.replace(/^git@github\.com:/i, '')
  s = s.replace(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?github\.com(?::\d+)?\//i, '')
  s = s.replace(/^github\.com\//i, '')
  s = s.replace(/^\/+/, '')
  const parts = s.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/i, '')
  if (!SEGMENT.test(owner) || !SEGMENT.test(repo)) return null
  if (owner === '.' || owner === '..' || repo === '.' || repo === '..' || !repo) return null
  return `${owner}/${repo}`.toLowerCase()
}

/**
 * The repos a card's session may get a GitHub credential for: every repo linked
 * to the card's OWN workspace (Settings → Workspaces → repos). Deliberately not
 * widened by the card's free-text `project`, which would let a card name a repo
 * linked only to another workspace.
 */
export function allowedGithubRepos(
  objective: Pick<Objective, 'project' | 'workspace'>,
  db: Database.Database = getDb(),
): Set<string> {
  const out = new Set<string>()
  const add = (g: string | null | undefined) => {
    const n = normalizeGithubRepo(g)
    if (n) out.add(n)
  }
  try {
    const ws = resolveWriteWorkspace(objective.workspace)
    const rows = db
      .prepare(`SELECT github FROM workspace_repos WHERE workspace = ? AND github IS NOT NULL AND github != ''`)
      .all(ws) as { github: string }[]
    for (const r of rows) add(r.github)
  } catch {
    /* no table / no rows: nothing linked */
  }
  return out
}

export type GithubCredential =
  | { ok: true; token: string; repo: string; source: 'secret' | 'connection' }
  | BrokerRefusal

/**
 * The GitHub credential for one repo, for one live card. Precedence matches the
 * old spawn env: a `GH_TOKEN` / `GITHUB_TOKEN` row in Settings → Secrets that this
 * card may hold overrides the owner's connection. SERVER-ONLY result.
 */
export function brokerGithubCredential(
  card: BrokerCard,
  repoInput: string | null | undefined,
  db: Database.Database = getDb(),
): GithubCredential {
  const repo = normalizeGithubRepo(repoInput)
  if (!repo) return refuse(400, 'repo_required', 'Name the GitHub repository as owner/repo.')
  if (!allowedGithubRepos(card.objective, db).has(repo)) {
    return refuse(
      403,
      'repo_out_of_scope',
      `${repo} is not linked to this card's workspace (${card.workspace}). Link it in Settings → Workspaces → repos.`,
    )
  }
  const { objective, ownerUserId } = card

  // Settings → Secrets override, filtered exactly as the spawn env would be.
  try {
    const filter = sessionSecretKeyFilter(objective, ownerUserId)
    const store = resolveSecrets({
      workspace: objective.workspace,
      userId: ownerUserId,
      audit: true,
      actorUserId: null,
      keyFilter: k => (k === 'GH_TOKEN' || k === 'GITHUB_TOKEN') && (filter ? filter(k) : true),
    })
    const t = store.GH_TOKEN || store.GITHUB_TOKEN
    if (t) return { ok: true, token: t, repo, source: 'secret' }
  } catch {
    /* fall through to the connection */
  }

  const actor = spawnActor(objective, ownerUserId)
  const decision = checkConnectorCredential({
    connectorId: GITHUB_CONNECTOR,
    ownerUserId,
    actor,
    use: { agent: objective.agent_context, workspace: objective.workspace },
    delegated: isDelegatedCard(objective),
    botScope: safeBotScope(objective),
  })
  if (!decision.allowed) return refuse(403, `github_${decision.reason}`, githubRefusalText(decision.reason))
  let token: string | null = null
  try {
    token = ownerUserId != null ? getDecryptedForUser(ownerUserId, actor) : null
  } catch {
    token = null
  }
  if (!token) return refuse(404, 'github_not_connected', "The card owner's GitHub connection is not set up or could not be read (Settings → Connectors → GitHub).")
  return { ok: true, token, repo, source: 'connection' }
}

function githubRefusalText(reason: ConnectorDenyReason): string {
  return `GitHub is not available to this card (${reason}). The card owner controls this in Settings → Connectors → GitHub.`
}

/** Parse a git credential-helper request (`key=value` lines). */
export function parseGitCredentialRequest(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

// ── Google Workspace ────────────────────────────────────────────────────────

export type GoogleAccess =
  | { ok: true; mode: GoogleMode; email: string; connectors: GoogleConnectors }
  | BrokerRefusal

/** The card's Google connector mode. A scoped bot keeps its pack's mode; every other card is read_and_drafts. */
export function googleModeFor(objective: Objective): GoogleMode {
  return safeBotScope(objective)?.google ?? 'read_and_drafts'
}

/**
 * Google for one live card: the owner's connection, gated by the same connector
 * rules as the spawn env (re-checked and audited now), with the card's mode.
 */
export function brokerGoogle(card: BrokerCard): GoogleAccess {
  // A read-only session token (the AI reviewer, obj 901525) writes nothing,
  // Gmail drafts included: it gets no Google tools at all.
  const { objective, ownerUserId } = card
  if (card.claims.readOnly) return refuse(403, 'google_read_only_session', 'This is a read-only (reviewer) session; it gets no Google tools.')
  if (ownerUserId == null) return refuse(403, 'google_no_owner', 'This card has no owner, so no Google account applies.')
  const actor = spawnActor(objective, ownerUserId)
  const decision = checkConnectorCredential({
    connectorId: GOOGLE_CONNECTOR,
    ownerUserId,
    actor,
    use: { agent: objective.agent_context, workspace: objective.workspace },
    delegated: isDelegatedCard(objective),
    botScope: safeBotScope(objective),
  })
  if (!decision.allowed) {
    return refuse(403, `google_${decision.reason}`, `Google Workspace is not available to this card (${decision.reason}).`)
  }
  let email = ''
  try {
    email = getGoogleSummary(ownerUserId)?.google_email ?? ''
  } catch {
    email = ''
  }
  if (!email) return refuse(404, 'google_not_connected', 'The card owner has not connected Google (Settings → Account → Google Workspace).')
  const connectors = googleConnectorsFor({
    userId: ownerUserId,
    agent: objective.agent_context || 'general',
    workspace: objective.workspace,
    actor,
  })
  return { ok: true, mode: googleModeFor(objective), email, connectors }
}

export interface GoogleToolDef {
  name: string
  description: string
  /** `read` needs read_and_drafts; `draft` is allowed in both modes. */
  needs: 'read' | 'draft'
  inputSchema: Record<string, unknown>
}

export const GOOGLE_TOOLS: readonly GoogleToolDef[] = [
  {
    name: 'gmail_list_inbox',
    needs: 'read',
    description: "List recent messages in the card owner's Gmail inbox (sender, subject, date, preview).",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many messages (1-50, default 20).' },
        unread_only: { type: 'boolean', description: 'Only unread messages.' },
      },
    },
  },
  {
    name: 'gmail_read_message',
    needs: 'read',
    description: 'Read one Gmail message by id (from gmail_list_inbox).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'gmail_create_draft',
    needs: 'draft',
    description: "Save an email DRAFT in the card owner's Gmail Drafts folder. Nothing is sent; the owner sends it.",
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
        in_reply_to: { type: 'string', description: 'Gmail message id this replies to (optional).' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'calendar_list_events',
    needs: 'read',
    description: "List events on the card owner's primary Google Calendar between two ISO times.",
    inputSchema: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
    },
  },
]

/** True when the mode permits the tool. Enforced before ANY upstream request. */
export function googleModeAllows(mode: GoogleMode, tool: GoogleToolDef): boolean {
  return tool.needs === 'draft' || mode === 'read_and_drafts'
}

export function googleToolsForMode(mode: GoogleMode): GoogleToolDef[] {
  return GOOGLE_TOOLS.filter(t => googleModeAllows(mode, t))
}

export class GoogleToolRefusal extends Error {}

/**
 * Run one Google tool for a card. Mode and connector availability are checked
 * first; only then does the connector refresh a token and call Google.
 */
export async function callGoogleTool(
  access: Extract<GoogleAccess, { ok: true }>,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const tool = GOOGLE_TOOLS.find(t => t.name === name)
  if (!tool) throw new GoogleToolRefusal(`Unknown tool: ${name}`)
  if (!googleModeAllows(access.mode, tool)) {
    throw new GoogleToolRefusal(`${name} is not allowed: this card's Google mode is ${access.mode} (drafts only, no reading).`)
  }
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string).trim() : '')
  const { mail, calendar } = access.connectors
  switch (name) {
    case 'gmail_list_inbox': {
      if (!mail) throw new GoogleToolRefusal('This Google connection was not granted Gmail read access.')
      const n = Number(args.limit)
      const limit = Number.isFinite(n) ? Math.min(50, Math.max(1, Math.floor(n))) : 20
      return { messages: await mail.listInbox(limit, args.unread_only === true) }
    }
    case 'gmail_read_message': {
      if (!mail) throw new GoogleToolRefusal('This Google connection was not granted Gmail read access.')
      const id = str('id')
      if (!id) throw new GoogleToolRefusal('id is required.')
      const m = await mail.read(id)
      if (!m) throw new GoogleToolRefusal('No such message.')
      return m
    }
    case 'gmail_create_draft': {
      if (!mail?.saveDraft) throw new GoogleToolRefusal('This Google connection was not granted Gmail drafts.')
      const to = str('to')
      const subject = str('subject')
      const body = typeof args.body === 'string' ? args.body : ''
      if (!to || !subject || !body) throw new GoogleToolRefusal('to, subject and body are required.')
      const saved = await mail.saveDraft({ to, subject, body, in_reply_to: str('in_reply_to') || null })
      return { saved: true, draft_id: saved.remote_id, note: 'Saved to Gmail Drafts. Nothing was sent.' }
    }
    case 'calendar_list_events': {
      if (!calendar) throw new GoogleToolRefusal('This Google connection was not granted Calendar access.')
      const from = str('from')
      const to = str('to')
      if (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        throw new GoogleToolRefusal('from and to must be ISO date-times.')
      }
      return { events: await calendar.listEvents(from, to) }
    }
  }
  throw new GoogleToolRefusal(`Unknown tool: ${name}`)
}

/**
 * The text a Google tool result reaches the session's model as. Mail and
 * calendar content is written by outsiders, so a read result is sealed in an
 * untrusted frame (and scanned) — boundary 19 in docs/security/untrusted-content.md.
 * A draft confirmation is server-written and stays plain.
 */
export function googleToolResultForSession(card: BrokerCard, toolName: string, out: unknown): string {
  const text = JSON.stringify(out, null, 2)
  const tool = GOOGLE_TOOLS.find(t => t.name === toolName)
  if (!tool || tool.needs !== 'read') return text
  return frameAndScan(
    {
      source: toolName.startsWith('calendar') ? 'calendar' : 'email',
      scope: card.workspace,
      label: toolName,
      text,
    },
    { objectiveId: card.objective.id, workspace: card.workspace, reader: `card:${card.objective.id}` },
  )
}

// ── Workspace MCP relay ─────────────────────────────────────────────────────

/**
 * The workspace MCP server a card may reach under `slug`: connected, enabled,
 * in the card's workspace, and on a scoped bot's list. Null otherwise — the
 * caller answers 404 so a slug in another workspace is not confirmed to exist.
 */
export function resolveRelayServer(card: BrokerCard, slug: string): McpServerRow | null {
  if (!/^[a-z0-9-]{1,48}$/.test(slug)) return null
  let rows: McpServerRow[] = []
  try {
    rows = listServerRows(card.objective.workspace)
  } catch {
    return null
  }
  const row = rows.find(r => r.slug === slug)
  if (!row || Number(row.enabled) === 0 || row.status !== 'connected') return null
  const scope = safeBotScope(card.objective)
  if (scope && !scope.mcpServers.has(row.slug)) return null
  return row
}
