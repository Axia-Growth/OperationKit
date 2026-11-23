// ── Per-bot secret access: one screen on the bot's settings page (obj 901484) ──
//
// Before this, letting ONE chat bot read FIVE keys took about 13 admin clicks
// on two pages: tick "Use secrets by name" on the bot, then for each key open
// it in Settings → Secrets, tick the workspace, type the host, pick methods,
// save. And that Bot access entry is per WORKSPACE, so every other bot there
// that had the tool got the key too.
//
// A grant here is (bot, workspace, secret name) → exact hosts + methods. It is
// its own table and only ADDS to the workspace-wide policy:
//   - the broker treats a name as usable when the workspace-wide entry OR this
//     bot's grant allows the host and method (secrets-broker.ts, `botGrants`);
//   - existing Bot access entries are never read-modified-written from here;
//   - no `secrets` row is touched, and no value is returned, stored or logged.
//
// Walls: only an admin signed in to the browser saves (routes/agent-chat.ts);
// a grant with no host is refused, never filled in from a suggestion; hosts are
// exact (no wildcard, no IP); methods default to GET + HEAD; every add, change
// and removal is a `secret_access_log` row (action `bot_access`).
import { getDb } from '../../db/index.js'
import { decryptSecret } from '../secrets-crypto.js'
import { MIN_SECRET_LEN } from '../secret-redaction.js'
import { logAccess } from '../secrets-store.js'
import { BrokerPolicyError, getBrokerPolicy, isBrokerableSecretKey, validatePolicyEntry, type BotSecretGrant } from '../secrets-broker.js'
import { companionEndpointName, credentialVendorPrefix } from '../session-trust-prompt.js'
import type { ChatAgent } from './agent-defs.js'
import { setBotConfig } from './bot-config.js'
import { fullAccessActive, fullAccessAnywhere } from './bot-full-access.js'
import { botMayUseWorkspace, getBotWorkspaceAccess } from './bot-workspaces.js'
import { KNOWN_TOOL_NAMES, listsAllTools } from './tool-names.js'

export const READ_METHODS = ['GET', 'HEAD'] as const
export const ALL_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
/** One Save may carry this many secrets for one bot in one workspace. */
export const MAX_BOT_SECRET_GRANTS = 50
const MAX_GRANT_HOSTS = 5
const MAX_CONFIRMED_HOSTS_PER_SAVE = 500
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WS_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const EXACT_HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

export class BotSecretAccessError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

interface GrantRow { slug: string; workspace: string; secret_name: string; hosts: string; methods: string; granted_by: number | null; updated_at: string }

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

function grantRows(slug: string, workspace: string): GrantRow[] {
  return getDb()
    .prepare('SELECT * FROM agent_chat_bot_secret_grants WHERE slug = ? AND workspace = ? ORDER BY secret_name')
    .all(slug, workspace) as GrantRow[]
}

export type AllSecretsMode = 'read' | 'write'
export interface AllSecretsSwitch { enabled: boolean; mode: AllSecretsMode }
/** A grant plus where it came from: the bot's own per-key tick, or its All secrets switch. */
export type EffectiveGrant = BotSecretGrant & { source: 'grant' | 'all_secrets' }

const cleanHosts = (json: string): string[] => parseList(json).filter(h => EXACT_HOST_RE.test(h) && !IPV4_RE.test(h))

/** This bot's All secrets switch in one workspace. Off when there is no row or the table cannot be read. */
export function allSecretsSwitch(slug: string, workspace: string): AllSecretsSwitch {
  try {
    const r = getDb().prepare('SELECT mode FROM agent_chat_bot_secret_all WHERE slug = ? AND workspace = ?').get(slug, workspace) as { mode: string } | undefined
    return r ? { enabled: true, mode: r.mode === 'write' ? 'write' : 'read' } : { enabled: false, mode: 'read' }
  } catch { return { enabled: false, mode: 'read' } }
}

/** Hosts an admin confirmed per secret for this workspace (once per key). */
export function confirmedSecretHosts(workspace: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  try {
    const rows = getDb().prepare('SELECT secret_name, hosts FROM agent_chat_secret_hosts WHERE workspace = ?').all(workspace) as { secret_name: string; hosts: string }[]
    for (const r of rows) {
      const hosts = cleanHosts(r.hosts)
      if (hosts.length) out.set(r.secret_name, hosts)
    }
  } catch { /* no table → none confirmed */ }
  return out
}

/**
 * What the broker reads on every chat secret call: this bot's grants in this
 * workspace. Empty when the bot may no longer use the workspace, so a workspace
 * revoke ends every grant there without touching the rows.
 *
 * Two sources. (1) The bot's own per-key rows. (2) With its All secrets switch
 * on: every Workspace-scope secret of this workspace that has a confirmed host,
 * with the switch's methods. Read live, so a secret added later is covered and
 * switching off ends it on the next call. Shared secrets are never covered by
 * the switch. A per-key row wins over the switch for that one key.
 */
export function botSecretGrants(slug: string | null | undefined, workspace: string | null | undefined): Record<string, EffectiveGrant> {
  if (!slug || !workspace || !botMayUseWorkspace(slug, workspace)) return {}
  const out: Record<string, EffectiveGrant> = {}
  try {
    const all = allSecretsSwitch(slug, workspace)
    if (all.enabled) {
      const hostsByName = confirmedSecretHosts(workspace)
      const methods = all.mode === 'write' ? [...ALL_METHODS] : [...READ_METHODS]
      const names = getDb().prepare("SELECT key FROM secrets WHERE scope_type = 'workspace' AND workspace = ?").all(workspace) as { key: string }[]
      for (const { key } of names) {
        const hosts = hostsByName.get(key)
        if (hosts && isBrokerableSecretKey(key)) out[key] = { hosts, methods: [...methods], source: 'all_secrets' }
      }
    }
    for (const r of grantRows(slug, workspace)) {
      if (!isBrokerableSecretKey(r.secret_name)) continue
      const hosts = cleanHosts(r.hosts)
      const methods = parseList(r.methods).filter(m => (ALL_METHODS as readonly string[]).includes(m))
      if (hosts.length) out[r.secret_name] = { hosts, methods, source: 'grant' }
    }
  } catch { return {} } // an unreadable table never widens access
  return out
}

/** A deleted bot's grants go with it, so a later bot with the same slug starts with none. */
export function forgetBotSecretGrants(slug: string): void {
  try { getDb().prepare('DELETE FROM agent_chat_bot_secret_grants WHERE slug = ?').run(slug) } catch { /* table absent on a very old DB */ }
  try { getDb().prepare('DELETE FROM agent_chat_bot_secret_all WHERE slug = ?').run(slug) } catch { /* same */ }
}

// ── Host suggestions (shown, never saved by the server) ─────────────────────

/** Where a suggested host came from. The admin sees this next to the host. */
export type HostSuggestionSource = 'confirmed' | 'bot_access' | 'other_bot' | 'url_secret' | 'known_vendor'
export interface HostSuggestion { host: string; source: HostSuggestionSource; from?: string }

/**
 * Vendor API hosts by credential name prefix (`APIFY_API_TOKEN` → APIFY). Kept
 * short on purpose: only hosts that are the vendor's documented API host. A
 * suggestion is a starting point the admin checks; it is never applied for them.
 */
export const KNOWN_VENDOR_HOSTS: Readonly<Record<string, string>> = {
  AIRTABLE: 'api.airtable.com',
  ANTHROPIC: 'api.anthropic.com',
  APIFY: 'api.apify.com',
  CALENDLY: 'api.calendly.com',
  CLICKUP: 'api.clickup.com',
  CLICK_UP: 'api.clickup.com',
  DEEPGRAM: 'api.deepgram.com',
  EXA: 'api.exa.ai',
  FIRECRAWL: 'api.firecrawl.dev',
  GITHUB: 'api.github.com',
  GODADDY: 'api.godaddy.com',
  HUBSPOT: 'api.hubapi.com',
  HUNTER: 'api.hunter.io',
  INSTANTLY: 'api.instantly.ai',
  LEADMAGIC: 'api.leadmagic.io',
  MILLIONVERIFIER: 'api.millionverifier.com',
  NOTION: 'api.notion.com',
  OPENAI: 'api.openai.com',
  POSTMARK: 'api.postmarkapp.com',
  RESEND: 'api.resend.com',
  SENDGRID: 'api.sendgrid.com',
  STRIPE: 'api.stripe.com',
  TELNYX: 'api.telnyx.com',
  TWILIO: 'api.twilio.com',
}

function exactHost(h: string): string | null {
  const host = h.trim().toLowerCase().replace(/\.$/, '')
  return EXACT_HOST_RE.test(host) && !IPV4_RE.test(host) ? host : null
}

/**
 * The host of a companion endpoint secret (`FOO_BASE_URL` beside `FOO_API_KEY`).
 * Only the host name leaves this function: never the path, query or port, and
 * nothing at all when the stored URL carries a user name or password.
 */
function hostOfEndpointSecret(name: string, workspace: string): string | null {
  try {
    const rows = getDb()
      .prepare("SELECT scope_type, value_encrypted FROM secrets WHERE key = ? AND ((scope_type = 'workspace' AND workspace = ?) OR scope_type = 'global') ORDER BY scope_type = 'workspace' DESC")
      .all(name, workspace) as { scope_type: string; value_encrypted: string }[]
    if (!rows[0]) return null
    const raw = decryptSecret(rows[0].value_encrypted).trim()
    if (!raw || /\s/.test(raw)) return null
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`)
    if (u.protocol !== 'https:' || u.username || u.password) return null
    return exactHost(u.hostname)
  } catch { return null }
}

interface WorkspaceSecrets {
  /** name → where it lives for this workspace (workspace row wins). */
  byName: Map<string, 'workspace' | 'shared'>
}

function secretsFor(workspace: string): WorkspaceSecrets {
  const rows = getDb()
    .prepare("SELECT key, scope_type FROM secrets WHERE (scope_type = 'workspace' AND workspace = ?) OR scope_type = 'global' ORDER BY key")
    .all(workspace) as { key: string; scope_type: string }[]
  const byName = new Map<string, 'workspace' | 'shared'>()
  for (const r of rows) {
    if (!isBrokerableSecretKey(r.key)) continue
    if (r.scope_type === 'workspace' || !byName.has(r.key)) byName.set(r.key, r.scope_type === 'workspace' ? 'workspace' : 'shared')
  }
  return { byName }
}

function suggestionsFor(name: string, slug: string, workspace: string, names: Set<string>, confirmed: string[] = []): HostSuggestion[] {
  const out: HostSuggestion[] = []
  const add = (host: string | null, source: HostSuggestionSource, from?: string) => {
    if (host && !out.some(s => s.host === host)) out.push({ host, source, ...(from ? { from } : {}) })
  }
  // 0. Hosts an admin already confirmed for this key in this workspace.
  for (const h of confirmed) add(exactHost(h), 'confirmed')
  // 1. Hosts an admin already typed for this secret (wildcards are not suggested).
  for (const h of getBrokerPolicy()[name]?.hosts ?? []) add(exactHost(h), 'bot_access')
  // 2. Hosts another bot in this workspace was already given for it.
  try {
    const others = getDb()
      .prepare('SELECT slug, hosts FROM agent_chat_bot_secret_grants WHERE workspace = ? AND secret_name = ? AND slug != ?')
      .all(workspace, name, slug) as { slug: string; hosts: string }[]
    for (const o of others) for (const h of parseList(o.hosts)) add(exactHost(h), 'other_bot', o.slug)
  } catch { /* no table → no suggestion */ }
  // 3. A matching *_BASE_URL / *_API_URL / *_URL secret.
  const companion = companionEndpointName(name, names)
  if (companion && isBrokerableSecretKey(companion)) add(hostOfEndpointSecret(companion, workspace), 'url_secret', companion)
  // 4. The small built-in vendor map.
  const prefix = credentialVendorPrefix(name)
  if (prefix) {
    const hit = Object.keys(KNOWN_VENDOR_HOSTS).find(k => prefix === k || prefix.startsWith(`${k}_`))
    if (hit) add(KNOWN_VENDOR_HOSTS[hit]!, 'known_vendor')
  }
  return out.slice(0, 4)
}

// ── Test access: usable yes/no and why, per secret ──────────────────────────

export type SecretAccessReason =
  | 'ok'
  | 'bot_not_in_workspace'
  | 'full_access_blocks_secrets'
  | 'tool_off'
  | 'secret_missing'
  | 'never_for_bots'
  | 'shared_blocked_by_full_access'
  | 'workspace_not_ticked'
  | 'no_host'
  | 'value_too_short'

export interface SecretAccessStatus {
  name: string
  usable: boolean
  reason: SecretAccessReason
  /** One plain sentence for the admin. Names, hosts and methods only. */
  detail: string
  /** How the bot gets it when usable: its own grant, the workspace-wide Bot access entry, or both. */
  via: Array<'bot_grant' | 'all_secrets' | 'workspace_bot_access'>
  hosts: string[]
  /** null = any method (only a workspace-wide entry can say that). */
  methods: string[] | null
}

function agentHasSecretsTool(agent: Pick<ChatAgent, 'tools'>): boolean {
  return agent.tools.includes('secrets')
}

function valueTooShort(name: string, workspace: string): boolean {
  try {
    const rows = getDb()
      .prepare("SELECT value_encrypted FROM secrets WHERE key = ? AND ((scope_type = 'workspace' AND workspace = ?) OR scope_type = 'global') ORDER BY scope_type = 'workspace' DESC")
      .all(name, workspace) as { value_encrypted: string }[]
    return !!rows[0] && decryptSecret(rows[0].value_encrypted).length < MIN_SECRET_LEN
  } catch { return false }
}

/**
 * Would a chat call with this secret get past every gate short of the vendor?
 * Mirrors runSecretTool + executeHttp in order. It sends nothing anywhere and
 * its output holds no value: the one value read is a length comparison.
 */
export function secretAccessStatus(agent: ChatAgent, workspace: string, name: string, ctx?: { secrets?: WorkspaceSecrets; grants?: Record<string, EffectiveGrant>; all?: AllSecretsSwitch; now?: Date }): SecretAccessStatus {
  const base = { name, usable: false, via: [] as SecretAccessStatus['via'], hosts: [] as string[], methods: [] as string[] | null }
  const no = (reason: SecretAccessReason, detail: string): SecretAccessStatus => ({ ...base, reason, detail })
  if (!botMayUseWorkspace(agent.slug, workspace)) return no('bot_not_in_workspace', `${agent.name} has no access to the ${workspace} workspace. Add it under Workspace access first.`)
  if (fullAccessActive(agent.slug, workspace, ctx?.now)) return no('full_access_blocks_secrets', `${agent.name} has Full access in ${workspace}. A bot with Full access can never use a secret there.`)
  if (!agentHasSecretsTool(agent)) return no('tool_off', `The "Use secrets by name" tool is off for ${agent.name}. Saving this panel switches it on.`)
  if (!isBrokerableSecretKey(name)) return no('never_for_bots', `${name} is a sign-in or server-only secret. No bot can use it.`)
  const where = (ctx?.secrets ?? secretsFor(workspace)).byName.get(name)
  if (!where) return no('secret_missing', `No secret named ${name} is saved for ${workspace} or as Shared.`)
  if (where === 'shared' && fullAccessAnywhere(agent.slug, ctx?.now)) return no('shared_blocked_by_full_access', `${agent.name} has Full access in another workspace, so it can never use a Shared secret. Save ${name} at Workspace scope instead.`)
  const grant = (ctx?.grants ?? botSecretGrants(agent.slug, workspace))[name]
  const policy = getBrokerPolicy()[name]
  const policyVisible = where === 'workspace' || (policy?.workspaces ?? []).includes(workspace)
  if (!grant && !policyVisible) return no('workspace_not_ticked', `${name} is a Shared secret, and neither this bot nor the ${workspace} workspace has been given it. All secrets does not cover Shared secrets.`)
  const policyHosts = policyVisible ? policy?.hosts ?? [] : []
  const hosts = [...new Set([...(grant?.hosts ?? []), ...policyHosts])]
  if (hosts.length === 0) {
    const all = ctx?.all ?? allSecretsSwitch(agent.slug, workspace)
    return no('no_host', all.enabled && where === 'workspace'
      ? `${name} has no confirmed host yet, so it cannot be sent anywhere, even with All secrets on. Confirm its host once and every bot with All secrets can use it.`
      : `${name} has no destination host yet, so it cannot be sent anywhere.`)
  }
  if (valueTooShort(name, workspace)) return no('value_too_short', `${name} is shorter than ${MIN_SECRET_LEN} characters, too short to hide reliably, so bots cannot use it.`)
  const via: SecretAccessStatus['via'] = [...(grant ? [grant.source === 'all_secrets' ? 'all_secrets' as const : 'bot_grant' as const] : []), ...(policyHosts.length ? ['workspace_bot_access' as const] : [])]
  const policyAny = policyHosts.length > 0 && !(policy!.methods && policy!.methods.length)
  const methods = policyAny ? null : [...new Set([...(grant?.methods ?? []), ...(policyHosts.length ? policy!.methods ?? [] : [])])]
  return {
    name, usable: true, reason: 'ok', via, hosts, methods,
    detail: `${agent.name} can send ${name} to ${hosts.join(', ')} (${methods ? methods.join(', ') : 'any method'}).`,
  }
}

// ── The panel ───────────────────────────────────────────────────────────────

export interface SecretAccessRow {
  name: string
  scope: 'workspace' | 'shared'
  /** This bot's own per-key grant, or null. */
  grant: (BotSecretGrant & { mode: 'read' | 'write' | 'custom' }) | null
  /** Hosts confirmed for this key in this workspace (once per key; used by the All secrets switch). */
  confirmed_hosts: string[]
  /** True when the All secrets switch is what covers this key for this bot (Workspace scope, no per-key grant). */
  covered_by_all: boolean
  /** The workspace-wide Bot access entry that already reaches this workspace (any bot with the tool), or null. */
  workspace_wide: { hosts: string[]; methods: string[] | null } | null
  suggestions: HostSuggestion[]
  status: SecretAccessStatus
}

export interface SecretAccessPanel {
  slug: string
  workspace: string | null
  /** Workspaces the panel can be opened for (the bot's own list; every workspace for a bot not restricted yet). */
  workspaces: string[]
  tool_on: boolean
  full_access_here: boolean
  /** This bot's All secrets switch here. Covers Workspace-scope secrets only, never Shared ones. */
  all_secrets: AllSecretsSwitch
  /** Workspace-scope secrets with no confirmed host: not usable through All secrets until confirmed. */
  needs_host: string[]
  secrets: SecretAccessRow[]
}

function modeOf(methods: string[]): 'read' | 'write' | 'custom' {
  const s = [...methods].sort().join(',')
  if (s === [...READ_METHODS].sort().join(',')) return 'read'
  if (s === [...ALL_METHODS].sort().join(',')) return 'write'
  return 'custom'
}

export function panelWorkspaces(slug: string): string[] {
  const access = getBotWorkspaceAccess(slug)
  if (access.mode === 'restricted') return [...access.workspaces].sort()
  return (getDb().prepare('SELECT slug FROM workspaces WHERE archived = 0 ORDER BY slug').all() as { slug: string }[]).map(w => w.slug)
}

/** Everything the screen shows for one bot in one workspace. Names, hosts and methods only. */
export function secretAccessPanel(agent: ChatAgent, workspaceRaw: unknown): SecretAccessPanel {
  const workspaces = panelWorkspaces(agent.slug)
  const workspace = typeof workspaceRaw === 'string' && workspaceRaw.trim() ? workspaceRaw.trim() : workspaces[0] ?? null
  const empty: SecretAccessPanel = { slug: agent.slug, workspace, workspaces, tool_on: agentHasSecretsTool(agent), full_access_here: false, all_secrets: { enabled: false, mode: 'read' }, needs_host: [], secrets: [] }
  if (!workspace) return empty
  if (!WS_SLUG_RE.test(workspace) || !workspaces.includes(workspace)) throw new BotSecretAccessError(`${agent.name} has no access to the workspace '${workspace}'.`, 404)
  const secrets = secretsFor(workspace)
  const grants = botSecretGrants(agent.slug, workspace)
  const policy = getBrokerPolicy()
  const names = new Set(secrets.byName.keys())
  const all = allSecretsSwitch(agent.slug, workspace)
  const confirmed = confirmedSecretHosts(workspace)
  const rows: SecretAccessRow[] = []
  for (const [name, scope] of secrets.byName) {
    const g = grants[name]
    const p = policy[name]
    const wide = p && p.hosts.length > 0 && (scope === 'workspace' || (p.workspaces ?? []).includes(workspace))
      ? { hosts: p.hosts, methods: p.methods && p.methods.length ? p.methods : null }
      : null
    rows.push({
      name,
      scope,
      grant: g && g.source === 'grant' ? { hosts: g.hosts, methods: g.methods, mode: modeOf(g.methods) } : null,
      confirmed_hosts: scope === 'workspace' ? confirmed.get(name) ?? [] : [],
      covered_by_all: all.enabled && scope === 'workspace' && g?.source !== 'grant',
      workspace_wide: wide,
      suggestions: suggestionsFor(name, agent.slug, workspace, names, scope === 'workspace' ? confirmed.get(name) : []),
      status: secretAccessStatus(agent, workspace, name, { secrets, grants, all }),
    })
  }
  return {
    ...empty,
    full_access_here: fullAccessActive(agent.slug, workspace),
    all_secrets: all,
    // An address (FOO_BASE_URL) is not a key a bot sends, so it is not asked about.
    needs_host: rows.filter(r => r.scope === 'workspace' && r.confirmed_hosts.length === 0 && !/_(URL|URI|HOST|DOMAIN)$/.test(r.name)).map(r => r.name),
    secrets: rows,
  }
}

/** "Test access": a fresh read of every secret this bot was granted, is covered for by All secrets, or already reaches. Calls no vendor. */
export function testBotSecretAccess(agent: ChatAgent, workspaceRaw: unknown): { slug: string; workspace: string; tool_on: boolean; checked_at: string; results: SecretAccessStatus[] } {
  const panel = secretAccessPanel(agent, workspaceRaw)
  if (!panel.workspace) throw new BotSecretAccessError(`${agent.name} has no workspace yet. Add one under Workspace access first.`)
  return {
    slug: agent.slug,
    workspace: panel.workspace,
    tool_on: panel.tool_on,
    checked_at: new Date().toISOString(),
    results: panel.secrets.filter(s => s.grant || s.workspace_wide || s.covered_by_all).map(s => s.status),
  }
}

// ── Save ────────────────────────────────────────────────────────────────────

interface CleanGrant { name: string; hosts: string[]; methods: string[] }

/** The admin's own host list for one secret: exact names only. Empty or missing is refused, never filled in. */
function cleanHostList(name: string, hostsRaw: unknown, methodsRaw?: unknown): { hosts: string[]; methods: string[] } {
  let entry
  try {
    entry = validatePolicyEntry({ hosts: hostsRaw, methods: methodsRaw ?? [...READ_METHODS] })
  } catch (err) {
    if (err instanceof BrokerPolicyError) {
      throw new BotSecretAccessError(/at least one destination host/.test(err.message) ? `${name}: confirm a destination host. A suggested host is not saved until you do.` : `${name}: ${err.message}`)
    }
    throw err
  }
  if (entry.hosts.length > MAX_GRANT_HOSTS) throw new BotSecretAccessError(`${name}: at most ${MAX_GRANT_HOSTS} hosts`)
  for (const h of entry.hosts) {
    if (h.startsWith('*.')) throw new BotSecretAccessError(`${name}: '${h}' is a wildcard. Name the exact host, for example api.example.com.`)
    if (IPV4_RE.test(h) || !EXACT_HOST_RE.test(h)) throw new BotSecretAccessError(`${name}: '${h}' is not a host name. Use one like api.example.com.`)
  }
  const methods = entry.methods && entry.methods.length ? entry.methods : [...READ_METHODS]
  return { hosts: [...entry.hosts].sort(), methods: (ALL_METHODS as readonly string[]).filter(m => methods.includes(m)) }
}

function cleanName(raw: unknown, available: Map<string, 'workspace' | 'shared'>, workspace: string): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (!NAME_RE.test(name)) throw new BotSecretAccessError(`'${String(raw)}' is not a secret name`)
  if (!isBrokerableSecretKey(name)) throw new BotSecretAccessError(`${name} is a sign-in or server-only secret. No bot can use it.`)
  if (!available.has(name)) throw new BotSecretAccessError(`No secret named ${name} is saved for ${workspace} or as Shared.`)
  return name
}

function cleanGrant(raw: unknown, available: Map<string, 'workspace' | 'shared'>, workspace: string): CleanGrant {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BotSecretAccessError('each grant must be an object with name and hosts')
  const g = raw as Record<string, unknown>
  const name = cleanName(g.name, available, workspace)
  return { name, ...cleanHostList(name, g.hosts, g.methods) }
}

/** `hosts: [{name, hosts}]` — hosts confirmed once per key. An empty list for a name removes its confirmation. */
function cleanConfirmedHosts(raw: unknown, available: Map<string, 'workspace' | 'shared'>, workspace: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (raw === undefined || raw === null) return out
  if (!Array.isArray(raw)) throw new BotSecretAccessError('hosts must be a list')
  if (raw.length > MAX_CONFIRMED_HOSTS_PER_SAVE) throw new BotSecretAccessError(`at most ${MAX_CONFIRMED_HOSTS_PER_SAVE} secrets per save`)
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new BotSecretAccessError('each hosts entry must be an object with name and hosts')
    const h = item as Record<string, unknown>
    const name = cleanName(h.name, available, workspace)
    if (available.get(name) !== 'workspace') throw new BotSecretAccessError(`${name} is a Shared secret. All secrets covers Workspace secrets only; give a Shared secret per key instead.`)
    if (out.has(name)) throw new BotSecretAccessError(`${name} is listed twice`)
    const empty = h.hosts === undefined || h.hosts === null || (Array.isArray(h.hosts) && h.hosts.length === 0) || (typeof h.hosts === 'string' && !h.hosts.trim())
    out.set(name, empty ? [] : cleanHostList(name, h.hosts).hosts)
  }
  return out
}

function cleanAllSwitch(raw: unknown): AllSecretsSwitch | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BotSecretAccessError('all_secrets must be {enabled, mode}')
  const a = raw as Record<string, unknown>
  if (typeof a.enabled !== 'boolean') throw new BotSecretAccessError('all_secrets.enabled must be true or false')
  // Write is an explicit choice: a missing mode is Read only.
  if (a.mode !== undefined && a.mode !== 'read' && a.mode !== 'write') throw new BotSecretAccessError("all_secrets.mode must be 'read' or 'write'")
  return { enabled: a.enabled, mode: a.mode === 'write' ? 'write' : 'read' }
}

export interface SaveResult {
  added: string[]
  changed: string[]
  removed: string[]
  /** What happened to the All secrets switch, or null when this save did not touch it. */
  all_secrets: 'on_read' | 'on_write' | 'off' | null
  /** Secret names whose confirmed host list was set or cleared by this save. */
  hosts_confirmed: string[]
  hosts_cleared: string[]
  /** True when this save switched the bot's "Use secrets by name" tool on. */
  tool_switched_on: boolean
}

/**
 * Replace this bot's grants in one workspace with `grantsRaw` (the whole panel,
 * one Save). The CALLER has already checked: admin, signed-in browser. One
 * transaction; every add / change / removal is audited by name.
 */
export function saveBotSecretAccess(
  agent: ChatAgent,
  workspaceRaw: unknown,
  grantsRaw: unknown,
  actor: { id: number; username: string },
  extra: { all_secrets?: unknown; hosts?: unknown } = {},
): SaveResult {
  const workspace = typeof workspaceRaw === 'string' ? workspaceRaw.trim() : ''
  if (!WS_SLUG_RE.test(workspace)) throw new BotSecretAccessError('workspace is required')
  if (!panelWorkspaces(agent.slug).includes(workspace) || !botMayUseWorkspace(agent.slug, workspace)) {
    throw new BotSecretAccessError(`${agent.name} has no access to the workspace '${workspace}'. Add it under Workspace access first.`)
  }
  if (!Array.isArray(grantsRaw)) throw new BotSecretAccessError('grants must be a list')
  if (grantsRaw.length > MAX_BOT_SECRET_GRANTS) throw new BotSecretAccessError(`at most ${MAX_BOT_SECRET_GRANTS} secrets per bot per workspace`)
  const available = secretsFor(workspace).byName
  const next = new Map<string, CleanGrant>()
  for (const raw of grantsRaw) {
    const g = cleanGrant(raw, available, workspace)
    if (next.has(g.name)) throw new BotSecretAccessError(`${g.name} is listed twice`)
    next.set(g.name, g)
  }
  const allNext = cleanAllSwitch(extra.all_secrets)
  const hostsNext = cleanConfirmedHosts(extra.hosts, available, workspace)
  if ((next.size > 0 || allNext?.enabled) && fullAccessActive(agent.slug, workspace)) {
    throw new BotSecretAccessError(`${agent.name} has Full access in ${workspace}. A bot with Full access can never use a secret there, so there is nothing to grant.`, 409)
  }

  const db = getDb()
  const before = new Map(grantRows(agent.slug, workspace).map(r => [r.secret_name, { hosts: parseList(r.hosts), methods: parseList(r.methods) }]))
  const result: SaveResult = { added: [], changed: [], removed: [], all_secrets: null, hosts_confirmed: [], hosts_cleared: [], tool_switched_on: false }
  const allBefore = allSecretsSwitch(agent.slug, workspace)
  const hostsBefore = confirmedSecretHosts(workspace)
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',')
  db.transaction(() => {
    for (const [name] of before) {
      if (next.has(name)) continue
      db.prepare('DELETE FROM agent_chat_bot_secret_grants WHERE slug = ? AND workspace = ? AND secret_name = ?').run(agent.slug, workspace, name)
      result.removed.push(name)
    }
    for (const g of next.values()) {
      const old = before.get(g.name)
      if (old && same(old.hosts, g.hosts) && same(old.methods, g.methods)) continue
      db.prepare(
        `INSERT INTO agent_chat_bot_secret_grants (slug, workspace, secret_name, hosts, methods, granted_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug, workspace, secret_name) DO UPDATE SET hosts = excluded.hosts, methods = excluded.methods,
           granted_by = excluded.granted_by, updated_at = datetime('now')`,
      ).run(agent.slug, workspace, g.name, JSON.stringify(g.hosts), JSON.stringify(g.methods), actor.id)
      ;(old ? result.changed : result.added).push(g.name)
    }
    for (const [name, hosts] of hostsNext) {
      const old = hostsBefore.get(name) ?? []
      if (same(old, hosts)) continue
      if (hosts.length === 0) {
        db.prepare('DELETE FROM agent_chat_secret_hosts WHERE workspace = ? AND secret_name = ?').run(workspace, name)
        result.hosts_cleared.push(name)
      } else {
        db.prepare(
          `INSERT INTO agent_chat_secret_hosts (workspace, secret_name, hosts, confirmed_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace, secret_name) DO UPDATE SET hosts = excluded.hosts, confirmed_by = excluded.confirmed_by, updated_at = datetime('now')`,
        ).run(workspace, name, JSON.stringify(hosts), actor.id)
        result.hosts_confirmed.push(name)
      }
    }
    if (allNext && (allNext.enabled !== allBefore.enabled || (allNext.enabled && allNext.mode !== allBefore.mode))) {
      if (allNext.enabled) {
        db.prepare(
          `INSERT INTO agent_chat_bot_secret_all (slug, workspace, mode, granted_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(slug, workspace) DO UPDATE SET mode = excluded.mode, granted_by = excluded.granted_by, updated_at = datetime('now')`,
        ).run(agent.slug, workspace, allNext.mode, actor.id)
        result.all_secrets = allNext.mode === 'write' ? 'on_write' : 'on_read'
      } else {
        db.prepare('DELETE FROM agent_chat_bot_secret_all WHERE slug = ? AND workspace = ?').run(agent.slug, workspace)
        result.all_secrets = 'off'
      }
    }
  })()

  const scope = `bot:${agent.slug}@${workspace}`
  for (const name of result.removed) logAccess(actor.id, 'bot_access', scope, name, { source: 'ui', detail: `bot=${agent.slug} workspace=${workspace} removed` })
  for (const name of [...result.added, ...result.changed]) {
    const g = next.get(name)!
    logAccess(actor.id, 'bot_access', scope, name, {
      source: 'ui',
      detail: `bot=${agent.slug} workspace=${workspace} ${result.added.includes(name) ? 'granted' : 'changed'} hosts=${g.hosts.join(',')} methods=${g.methods.join(',')}`,
    })
  }

  for (const name of result.hosts_cleared) logAccess(actor.id, 'bot_access', `workspace:${workspace}`, name, { source: 'ui', detail: `workspace=${workspace} confirmed host removed` })
  for (const name of result.hosts_confirmed) {
    logAccess(actor.id, 'bot_access', `workspace:${workspace}`, name, { source: 'ui', detail: `workspace=${workspace} host confirmed hosts=${hostsNext.get(name)!.join(',')} (used by bots with All secrets)` })
  }
  if (result.all_secrets) {
    logAccess(actor.id, 'bot_access', scope, '*', {
      source: 'ui',
      detail: result.all_secrets === 'off'
        ? `bot=${agent.slug} workspace=${workspace} All secrets switched off`
        : `bot=${agent.slug} workspace=${workspace} All secrets switched on mode=${allNext!.mode} methods=${(allNext!.mode === 'write' ? ALL_METHODS : READ_METHODS).join(',')}${allBefore.enabled ? ` (was ${allBefore.mode})` : ''}`,
    })
  }

  // One screen: a bot that now holds a grant gets the tool that uses it. Removing
  // every grant leaves the tool alone (a workspace-wide entry may still need it).
  if ((next.size > 0 || allNext?.enabled) && !agentHasSecretsTool(agent)) {
    const src = agent.config?.tools ?? agent.file_defaults?.tools ?? agent.tools
    // A file that says "all" keeps every tool: carry that over as the All tools switch.
    const all = !agent.config?.all_tools && listsAllTools(src)
    const tools = [...new Set([...src.filter(t => KNOWN_TOOL_NAMES.has(t)), 'secrets'])]
    setBotConfig(agent.slug, all ? { tools, all_tools: true } : { tools }, actor.username)
    logAccess(actor.id, 'bot_access', scope, '*', { source: 'ui', detail: `bot=${agent.slug} tool "Use secrets by name" switched on` })
    result.tool_switched_on = true
  }
  return result
}
