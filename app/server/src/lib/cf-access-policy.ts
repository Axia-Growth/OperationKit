/**
 * Cloudflare Access "Allowed people" policy sync (obj 900023).
 *
 * The problem this solves: an admin adds a teammate in Settings → Users, the
 * app knows who they are — and Cloudflare Access still turns them away at the
 * door with "That account does not have access", because their email is not in
 * the Access application's allow policy. Someone then has to open the
 * Cloudflare dashboard. This module removes that step: when the install holds a
 * Cloudflare API token with Access edit rights, the server adds exactly that
 * one email to the install's OWN Access application's "Allowed people" policy,
 * and takes it out again when the user is deleted or their email changes.
 *
 * Deliberately narrow — every one of these is a hard rule, not a default:
 *   * ONE application: the one whose AUD tag equals OK_CF_ACCESS_AUD, i.e. the
 *     app this very install already verifies its sign-in JWTs against. Other
 *     apps on the same Cloudflare account are never written to.
 *   * ONE policy on that app: the one named "Allowed people"
 *     (OK_CF_ACCESS_POLICY_NAME to override), and only when its decision is
 *     `allow`. The "Install verify robot" service-token policy is refused by
 *     name AND by decision, so it cannot be edited even if misconfigured.
 *   * ONE include entry per call: a single `{email:{email}}` rule is appended
 *     or dropped. Existing entries — including any `email_domain` rule the
 *     installer wrote from ACCESS_ALLOWED_EMAIL_DOMAIN — are carried through
 *     untouched. This module never adds, edits or removes a domain rule.
 *   * Idempotent: adding an email that is already allowed (directly, or via a
 *     domain rule that already covers it) performs NO write at all. Removing
 *     one that is not there is likewise a no-op.
 *   * Fail soft: every failure is a typed reason, never a thrown error, so a
 *     missing or under-scoped token degrades to a per-user status badge instead
 *     of breaking user administration.
 *
 * The token comes from Settings → Users → "Cloudflare sign-in sync" (stored
 * encrypted, server-only; services/cf-access-token.ts) or, as a fallback, the
 * OK_CF_ACCESS_API_TOKEN env var. It is never logged, never returned by an API
 * route, and never interpolated into an error message.
 *
 * The account id is optional: an install that predates OK_CF_ACCOUNT_ID being
 * recorded resolves it from the token (the accounts the token can see, then the
 * one whose Access apps include this install's AUD).
 *
 * Minimum token permission: Account → Access: Apps and Policies → Edit, scoped
 * to the single Cloudflare account that hosts this install. Nothing else.
 */

export const CF_API_BASE = 'https://api.cloudflare.com/client/v4'
export const DEFAULT_POLICY_NAME = 'Allowed people'
/** Never editable by this module, whatever OK_CF_ACCESS_POLICY_NAME says. */
export const VERIFY_ROBOT_POLICY_NAME = 'Install verify robot'

const FETCH_TIMEOUT_MS = 8000

export interface CfAccessPolicyConfig {
  /** Null = resolve from the token on first use (see CfAccessPolicyClient.account). */
  accountId: string | null
  /** Secret. Never logged, never serialised into a response. */
  apiToken: string
  /** The AUD tag of this install's Access app — the only app we may touch. */
  aud: string
  /** Optional short-circuit for app discovery. */
  appId: string | null
  policyName: string
  /** Emails the installer put in the policy; this module never removes them. */
  protectedEmails: string[]
}

export type CfPolicyFailure =
  | 'not_configured'
  | 'forbidden'
  | 'app_not_found'
  | 'policy_not_found'
  | 'policy_refused'
  | 'unreachable'
  | 'cloudflare_error'

export type CfAddReason = 'added' | 'already_allowed' | 'covered_by_domain'
export type CfRemoveReason = 'removed' | 'not_present' | 'protected' | 'would_empty_policy'

export type CfPolicyResult<T> =
  | { ok: true; changed: boolean; reason: T }
  | { ok: false; reason: CfPolicyFailure }

export interface CfAllowList {
  emails: string[]
  domains: string[]
}

/**
 * Config from the environment, or null when email sync is not switched on.
 * Needs the account id, a token, and the AUD of the app we are allowed to edit;
 * any one missing means "not configured", which is a supported, quiet state.
 */
export function cfAccessPolicyConfig(
  env: NodeJS.ProcessEnv = process.env,
  /** The token from Settings, when one is stored. Wins over the env fallback. */
  token?: string | null,
): CfAccessPolicyConfig | null {
  const rawAccount = (env.OK_CF_ACCOUNT_ID || '').trim()
  const apiToken = (token || env.OK_CF_ACCESS_API_TOKEN || '').trim()
  const aud = (env.OK_CF_ACCESS_AUD || '').trim()
  if (!apiToken || !aud) return null
  // A malformed account id is ignored (resolved from the token instead) rather
  // than switching the whole sync off.
  const accountId = /^[a-f0-9]{8,64}$/i.test(rawAccount) ? rawAccount : null
  const policyName = (env.OK_CF_ACCESS_POLICY_NAME || '').trim() || DEFAULT_POLICY_NAME
  if (policyName === VERIFY_ROBOT_POLICY_NAME) return null
  return {
    accountId,
    apiToken,
    aud,
    appId: (env.OK_CF_ACCESS_APP_ID || '').trim() || null,
    policyName,
    protectedEmails: (env.OK_CF_ACCESS_PROTECTED_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(s => s.includes('@')),
  }
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  const email = (raw || '').trim().toLowerCase()
  return email.includes('@') ? email : null
}

function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1)
}

/** A single `include` entry as Cloudflare returns it. Unknown shapes pass through verbatim. */
type IncludeRule = Record<string, unknown>

interface AccessPolicy {
  id: string
  name?: string
  decision?: string
  precedence?: number
  session_duration?: string
  include?: IncludeRule[]
  exclude?: IncludeRule[]
  require?: IncludeRule[]
}

type FetchLike = (url: string, init?: {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

function ruleEmail(rule: IncludeRule): string | null {
  const e = (rule as { email?: { email?: unknown } }).email
  return e && typeof e.email === 'string' ? e.email.trim().toLowerCase() : null
}

function ruleDomain(rule: IncludeRule): string | null {
  const d = (rule as { email_domain?: { domain?: unknown } }).email_domain
  return d && typeof d.domain === 'string' ? d.domain.trim().toLowerCase() : null
}

function listOf(include: IncludeRule[]): CfAllowList {
  return {
    emails: include.map(ruleEmail).filter((e): e is string => !!e),
    domains: include.map(ruleDomain).filter((d): d is string => !!d),
  }
}

/** Does this include list already let `email` through, and how? */
export function allowListCovers(list: CfAllowList, email: string): 'email' | 'domain' | null {
  const target = (email || '').trim().toLowerCase()
  if (!target.includes('@')) return null
  if (list.emails.includes(target)) return 'email'
  if (list.domains.includes(domainOf(target))) return 'domain'
  return null
}

/** Cap on accounts probed when resolving the account from the token. */
const MAX_ACCOUNTS_PROBED = 20

export class CfAccessPolicyClient {
  private appIdCache: string | null
  private accountCache: string | null
  private policyCache: AccessPolicy | null = null

  constructor(
    readonly config: CfAccessPolicyConfig,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.appIdCache = config.appId
    this.accountCache = config.accountId
  }

  /** Drop memoised app/policy state — used after every write. */
  invalidate(): void {
    this.policyCache = null
    if (!this.config.appId) this.appIdCache = null
  }

  private async call(method: string, path: string, body?: unknown): Promise<
    { ok: true; result: unknown } | { ok: false; reason: CfPolicyFailure }
  > {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    try {
      const res = await this.fetchImpl(`${CF_API_BASE}${path}`, {
        method,
        headers: {
          // The only place the token is ever used. Not logged anywhere.
          Authorization: `Bearer ${this.config.apiToken}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ctrl.signal,
      })
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'forbidden' }
      let parsed: unknown = null
      try { parsed = await res.json() } catch { parsed = null }
      const envelope = parsed as { success?: boolean; result?: unknown; errors?: Array<{ code?: number }> } | null
      if (!res.ok || !envelope || envelope.success !== true) {
        // Cloudflare answers an under-scoped token with 200 + success:false +
        // code 10000 as often as it answers 403. Treat the two the same way.
        const codes = (envelope?.errors || []).map(e => e?.code)
        if (codes.includes(10000) || codes.includes(9109)) return { ok: false, reason: 'forbidden' }
        if (res.status === 404) return { ok: false, reason: 'app_not_found' }
        return { ok: false, reason: 'cloudflare_error' }
      }
      return { ok: true, result: envelope.result }
    } catch {
      return { ok: false, reason: 'unreachable' }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * The Cloudflare account that hosts this install. Configured, or found from
   * the token: the accounts it can see, narrowed to the one whose Access apps
   * include this install's AUD. Read-only calls; nothing is written here.
   */
  private async account(): Promise<{ ok: true; id: string } | { ok: false; reason: CfPolicyFailure }> {
    if (this.accountCache) return { ok: true, id: this.accountCache }
    const res = await this.call('GET', '/accounts?per_page=50')
    if (!res.ok) return res
    const ids = (Array.isArray(res.result) ? (res.result as Array<{ id?: unknown }>) : [])
      .map(a => a.id).filter((id): id is string => typeof id === 'string' && /^[a-f0-9]{8,64}$/i.test(id))
    if (ids.length === 0) return { ok: false, reason: 'forbidden' }
    let lastFailure: CfPolicyFailure = 'app_not_found'
    for (const id of ids.slice(0, MAX_ACCOUNTS_PROBED)) {
      const found = await this.findApp(id)
      if (found.ok) { this.accountCache = id; this.appIdCache ??= found.id; return { ok: true, id } }
      if (found.reason !== 'app_not_found') lastFailure = found.reason
    }
    return { ok: false, reason: lastFailure }
  }

  private async findApp(accountId: string): Promise<{ ok: true; id: string } | { ok: false; reason: CfPolicyFailure }> {
    const res = await this.call('GET', `/accounts/${accountId}/access/apps`)
    if (!res.ok) return res
    const apps = Array.isArray(res.result) ? (res.result as Array<{ id?: unknown; aud?: unknown }>) : []
    const match = apps.find(a => typeof a.aud === 'string' && a.aud === this.config.aud)
    if (!match || typeof match.id !== 'string') return { ok: false, reason: 'app_not_found' }
    return { ok: true, id: match.id }
  }

  /** The app id whose AUD matches this install. Never any other app. */
  private async appId(): Promise<{ ok: true; accountId: string; id: string } | { ok: false; reason: CfPolicyFailure }> {
    const acct = await this.account()
    if (!acct.ok) return acct
    if (this.appIdCache) return { ok: true, accountId: acct.id, id: this.appIdCache }
    const found = await this.findApp(acct.id)
    if (!found.ok) return found
    this.appIdCache = found.id
    return { ok: true, accountId: acct.id, id: found.id }
  }

  /** The one allow policy we are permitted to edit. */
  private async policy(): Promise<
    { ok: true; accountId: string; appId: string; policy: AccessPolicy } | { ok: false; reason: CfPolicyFailure }
  > {
    const app = await this.appId()
    if (!app.ok) return app
    if (this.policyCache) return { ok: true, accountId: app.accountId, appId: app.id, policy: this.policyCache }
    const res = await this.call('GET', `/accounts/${app.accountId}/access/apps/${app.id}/policies`)
    if (!res.ok) return res
    const policies = Array.isArray(res.result) ? (res.result as AccessPolicy[]) : []
    const found = policies.find(p => p && p.name === this.config.policyName)
    if (!found || typeof found.id !== 'string') return { ok: false, reason: 'policy_not_found' }
    // Belt and braces: the verify-robot policy (decision `non_identity`) and any
    // other non-allow policy are refused even if they carry the configured name.
    if (found.name === VERIFY_ROBOT_POLICY_NAME || found.decision !== 'allow') {
      return { ok: false, reason: 'policy_refused' }
    }
    this.policyCache = found
    return { ok: true, accountId: app.accountId, appId: app.id, policy: found }
  }

  /** Emails and domains the policy currently lets through. */
  async allowList(): Promise<{ ok: true; list: CfAllowList } | { ok: false; reason: CfPolicyFailure }> {
    const p = await this.policy()
    if (!p.ok) return p
    return { ok: true, list: listOf(Array.isArray(p.policy.include) ? p.policy.include : []) }
  }

  private async writeInclude(accountId: string, appId: string, policy: AccessPolicy, include: IncludeRule[]): Promise<
    { ok: true } | { ok: false; reason: CfPolicyFailure }
  > {
    const body: Record<string, unknown> = {
      name: policy.name,
      decision: policy.decision,
      include,
    }
    if (Array.isArray(policy.exclude)) body.exclude = policy.exclude
    if (Array.isArray(policy.require)) body.require = policy.require
    if (typeof policy.precedence === 'number') body.precedence = policy.precedence
    if (typeof policy.session_duration === 'string') body.session_duration = policy.session_duration
    const res = await this.call(
      'PUT',
      `/accounts/${accountId}/access/apps/${appId}/policies/${policy.id}`,
      body,
    )
    this.invalidate()
    return res.ok ? { ok: true } : { ok: false, reason: res.reason }
  }

  /** Let `email` through. No write at all when it is already allowed. */
  async addEmail(rawEmail: string): Promise<CfPolicyResult<CfAddReason>> {
    const email = normaliseEmail(rawEmail)
    if (!email) return { ok: false, reason: 'not_configured' }
    const p = await this.policy()
    if (!p.ok) return p
    const include = Array.isArray(p.policy.include) ? [...p.policy.include] : []
    const covered = allowListCovers(listOf(include), email)
    if (covered === 'email') return { ok: true, changed: false, reason: 'already_allowed' }
    if (covered === 'domain') return { ok: true, changed: false, reason: 'covered_by_domain' }
    const written = await this.writeInclude(p.accountId, p.appId, p.policy, [...include, { email: { email } }])
    return written.ok ? { ok: true, changed: true, reason: 'added' } : { ok: false, reason: written.reason }
  }

  /**
   * Stop letting `email` through. Only ever drops exact `{email:{email}}`
   * entries — a domain rule that happens to cover the address is left alone,
   * because it was not this module that put it there.
   */
  async removeEmail(rawEmail: string): Promise<CfPolicyResult<CfRemoveReason>> {
    const email = normaliseEmail(rawEmail)
    if (!email) return { ok: false, reason: 'not_configured' }
    if (this.config.protectedEmails.includes(email)) return { ok: true, changed: false, reason: 'protected' }
    const p = await this.policy()
    if (!p.ok) return p
    const include = Array.isArray(p.policy.include) ? p.policy.include : []
    const next = include.filter(rule => ruleEmail(rule) !== email)
    if (next.length === include.length) return { ok: true, changed: false, reason: 'not_present' }
    // An empty include list is a policy nobody matches — that locks the install
    // out of its own front door. Refuse rather than write it.
    if (next.length === 0) return { ok: true, changed: false, reason: 'would_empty_policy' }
    const written = await this.writeInclude(p.accountId, p.appId, p.policy, next)
    return written.ok ? { ok: true, changed: true, reason: 'removed' } : { ok: false, reason: written.reason }
  }
}
