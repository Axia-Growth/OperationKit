/**
 * Keep the Cloudflare Access allow policy in step with Settings → Users (obj 900023).
 *
 * Settings → Users already creates the person, their sign-in email and their
 * workspace roles. Cloudflare Access is a second, separate door: unless the
 * email is in the Access application's "Allowed people" policy, the teammate
 * never reaches the app at all — they get Cloudflare's "That account does not
 * have access" page, and an admin has to go and edit the policy by hand.
 *
 * This service closes that gap for installs that hold a Cloudflare API token
 * with Access edit rights. `lib/cf-access-policy.ts` does the talking; this
 * file decides WHEN to talk and guarantees the two properties the admin routes
 * need:
 *
 *   1. **User administration never fails because of Cloudflare.** Every entry
 *      point swallows its own errors. Creating, editing or deleting a user
 *      succeeds exactly as it did before whether the token is absent, wrong,
 *      under-scoped or the API is down; the only consequence is the per-user
 *      status badge reading "blocked at Cloudflare".
 *   2. **No token ever escapes.** Nothing here logs, returns or embeds the
 *      token — the failures that reach a caller are the typed reasons from
 *      `CfPolicyFailure`, which are fixed strings.
 *
 * The status read is cached briefly so that listing a page of users is one
 * Cloudflare call, not one per user.
 */
import {
  CfAccessPolicyClient,
  allowListCovers,
  cfAccessPolicyConfig,
  normaliseEmail,
  type CfAllowList,
  type CfPolicyFailure,
} from '../lib/cf-access-policy.js'
import { cfAccessConfig } from '../lib/cf-access.js'
import { createHash } from 'node:crypto'
import { resolveCfAccessToken } from './cf-access-token.js'
import type { CfAccessStatus, CfAccessUserStatus } from '@operationkit/shared'

export type { CfAccessStatus, CfAccessUserStatus }

const STATUS_CACHE_MS = 15_000

let client: CfAccessPolicyClient | null = null
let clientKey = ''
/** Set by the test hook; when true, `injected` wins over whatever the env says. */
let injectedSet = false
let injected: CfAccessPolicyClient | null = null
let cached: { at: number; value: { ok: true; list: CfAllowList } | { ok: false; reason: CfPolicyFailure } } | null = null

/**
 * Process-wide client, or null when sync is not configured. The token is
 * resolved on EVERY call (Settings first, then OK_CF_ACCESS_API_TOKEN), so a
 * token an admin saves in Settings → Users is used on the next save — no restart.
 */
export function getCfAccessPolicyClient(env: NodeJS.ProcessEnv = process.env): CfAccessPolicyClient | null {
  if (injectedSet) return injected
  const resolved = resolveCfAccessToken(env)
  const cfg = resolved ? cfAccessPolicyConfig(env, resolved.token) : null
  if (!cfg) { client = null; clientKey = ''; return null }
  // A one-way fingerprint of the token, so saving a new token rebuilds the
  // client. Only the hash is kept in the key and the key is never logged.
  const fp = createHash('sha256').update(cfg.apiToken).digest('hex').slice(0, 16)
  const key = `${cfg.accountId ?? '?'}|${cfg.aud}|${cfg.policyName}|${cfg.appId ?? ''}|${fp}`
  if (!client || clientKey !== key) { client = new CfAccessPolicyClient(cfg); clientKey = key }
  return client
}

/** Test hook: inject a client (or clear with null) and drop any cached read. */
export function setCfAccessPolicyClientForTests(c: CfAccessPolicyClient | null | undefined): void {
  injectedSet = c !== undefined
  injected = c ?? null
  client = null
  clientKey = ''
  cached = null
}

/**
 * Is there a Cloudflare door in front of this install at all?
 *
 * False means there is no second door, so no user can be "blocked at
 * Cloudflare" and the UI must show no badge — including for a user who has no
 * sign-in email, who would otherwise fall through to a misleading "blocked".
 */
export function cfAccessApplies(env: NodeJS.ProcessEnv = process.env): boolean {
  return cfAccessConfig(env) !== null
}

/**
 * What the INSTALLER put in the "Allowed people" policy, as recorded in the
 * env by install/cloudflare.sh: the exact addresses (ACCESS_ALLOWED_EMAILS
 * -> OK_CF_ACCESS_PROTECTED_EMAILS) and, only on an install whose client.conf
 * set the optional ACCESS_ALLOWED_EMAIL_DOMAIN, that domain
 * (-> OK_CF_ACCESS_ALLOWED_DOMAIN). Neither is a secret.
 *
 * Reading them lets Settings -> Users show "can sign in" for those people with
 * no Cloudflare token on the server. This is read-only: the app never writes
 * an email_domain rule (see lib/cf-access-policy.ts).
 */
export function installerAllowList(env: NodeJS.ProcessEnv = process.env): CfAllowList {
  const split = (v: string | undefined) => (v || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  return {
    emails: split(env.OK_CF_ACCESS_PROTECTED_EMAILS).filter(e => e.includes('@')),
    domains: split(env.OK_CF_ACCESS_ALLOWED_DOMAIN).map(d => d.replace(/^@/, '')).filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)),
  }
}

/** Test hook: forget the cached allow-list read. */
export function clearCfAccessStatusCache(): void { cached = null }

async function readAllowList(
  env: NodeJS.ProcessEnv,
  now: () => number,
): Promise<{ ok: true; list: CfAllowList } | { ok: false; reason: CfPolicyFailure }> {
  if (cached && now() - cached.at < STATUS_CACHE_MS) return cached.value
  const c = getCfAccessPolicyClient(env)
  if (!c) return { ok: false, reason: 'not_configured' }
  c.invalidate()
  const res = await c.allowList()
  cached = { at: now(), value: res }
  return res
}

/**
 * Per-email sign-in status for a list of users, in one Cloudflare read.
 *
 * Returns a map keyed by the normalised email. A user with no email is not in
 * the map; callers render those as `no_email` (they cannot be matched at the
 * Cloudflare door either way).
 */
export async function cfAccessStatuses(
  emails: Array<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<Map<string, CfAccessStatus>> {
  const out = new Map<string, CfAccessStatus>()
  const wanted = emails.map(normaliseEmail).filter((e): e is string => !!e)
  if (wanted.length === 0) return out

  // Not behind Access at all: there is no second door, so no badge.
  if (!cfAccessConfig(env)) {
    for (const e of wanted) out.set(e, { status: 'not_applicable', detail: 'access_not_configured' })
    return out
  }

  // Anyone the installer's own config already lets through (an address
  // listed in client.conf, or the optional domain if one was set) can sign in — no token and
  // no Cloudflare read needed. Only the rest go to the API.
  const installer = installerAllowList(env)
  const rest: string[] = []
  for (const e of wanted) {
    const covered = allowListCovers(installer, e)
    if (covered === 'domain') out.set(e, { status: 'can_sign_in', detail: 'allowed_by_domain' })
    else if (covered === 'email') out.set(e, { status: 'can_sign_in', detail: 'allowed_directly' })
    else rest.push(e)
  }
  if (rest.length === 0) return out

  const read = await readAllowList(env, now)
  if (!read.ok) {
    // We cannot confirm anyone is allowed. Per spec that shows as "blocked at
    // Cloudflare" with the reason attached, and never as an error dialog.
    const detail: CfAccessStatus['detail'] = read.reason === 'not_configured' ? 'sync_not_configured' : read.reason
    for (const e of rest) out.set(e, { status: 'blocked', detail })
    return out
  }

  for (const e of rest) {
    const covered = allowListCovers(read.list, e)
    out.set(e, covered === 'email'
      ? { status: 'can_sign_in', detail: 'allowed_directly' }
      : covered === 'domain'
        ? { status: 'can_sign_in', detail: 'allowed_by_domain' }
        : { status: 'blocked', detail: 'not_allowed' })
  }
  return out
}

/**
 * Can the server use its Cloudflare token right now? One read of the allow
 * policy (cached like the status read). Reasons only — never the token.
 */
export async function cfAccessSyncHealth(
  env: NodeJS.ProcessEnv = process.env,
  now: () => number = Date.now,
): Promise<{ ok: true } | { ok: false; reason: CfPolicyFailure }> {
  try {
    const read = await readAllowList(env, now)
    return read.ok ? { ok: true } : { ok: false, reason: read.reason }
  } catch {
    return { ok: false, reason: 'cloudflare_error' }
  }
}

export interface CfSyncReport {
  added?: string
  removed?: string
  failure?: CfPolicyFailure
}

/**
 * Reconcile one user's sign-in email with the Access policy.
 *
 * `previous` and `next` are the email before and after the change; pass null
 * for "none". A create is `(null, email)`, a delete is `(email, null)`, an edit
 * is `(old, new)` and removes the old address as well as adding the new one.
 *
 * Never throws and never rejects: the caller's write has already happened and
 * must not be undone by a Cloudflare problem.
 */
export async function syncUserAccessEmail(
  previous: string | null | undefined,
  next: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CfSyncReport> {
  const before = normaliseEmail(previous)
  const after = normaliseEmail(next)
  if (before === after) return {}
  const report: CfSyncReport = {}
  try {
    const c = getCfAccessPolicyClient(env)
    if (!c) return {}
    if (after) {
      const res = await c.addEmail(after)
      if (res.ok) { if (res.changed) report.added = after } else report.failure = res.reason
    }
    if (before) {
      const res = await c.removeEmail(before)
      if (res.ok) { if (res.changed) report.removed = before } else report.failure ??= res.reason
    }
  } catch {
    // Defensive: lib/cf-access-policy.ts is written not to throw, but a bug
    // there must still not break user administration.
    report.failure = 'cloudflare_error'
  } finally {
    cached = null
  }
  if (report.added || report.removed || report.failure) {
    // Reasons only — no token, no policy body, no Cloudflare ids.
    console.log(
      `[cf-access-sync] ${report.added ? `allowed ${report.added} ` : ''}` +
      `${report.removed ? `revoked ${report.removed} ` : ''}` +
      `${report.failure ? `(cloudflare: ${report.failure})` : ''}`.trim(),
    )
  }
  return report
}
