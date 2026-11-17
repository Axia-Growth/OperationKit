/**
 * The Cloudflare Access sync token an admin enters in Settings → Users (obj 900023).
 *
 * Settings → Users can keep this install's Cloudflare Access "Allowed people"
 * policy in step with the people an admin adds, re-emails or removes. That needs
 * a Cloudflare API token with ONE permission (Account → Access: Apps and
 * Policies → Edit). This file is where that token lives once an admin pastes it.
 *
 * The rules, each enforced here rather than by convention:
 *
 *   * **Encrypted at rest.** It goes into the native secrets store (AES-256-GCM,
 *     global scope) under `CF_ACCESS_SYNC_TOKEN_KEY`, so it has the store's
 *     audit trail and version history.
 *   * **Write-only.** Nothing in this module returns the value to a caller
 *     outside the server: `cfAccessTokenStatus()` reports only whether one is
 *     set and where it came from. No API route has a path that reads it back.
 *   * **Server-only.** The key is listed in `isServerOnlySecretKey`, so the boot
 *     hydration, session spawn env, `resolveSecretNames` and the secrets broker
 *     all skip it. A session never receives it, by name or by value.
 *   * **No restart.** `resolveCfAccessToken()` is called on every sync. It reads
 *     the row's version (no decrypt) and only decrypts when that changed, so a
 *     token saved a second ago is used on the very next save in Settings → Users.
 *   * **Env fallback.** With nothing stored, `OK_CF_ACCESS_API_TOKEN` (the
 *     installer's hand-over path) is used, exactly as before.
 *
 * A store problem (no master key on a compose-only setup, a corrupt row) is not
 * an error for the caller: it falls through to the env fallback.
 */
import {
  deleteSecret,
  getSecret,
  getSecretValue,
  setSecret,
} from './secrets-store.js'

/** Name in the secrets store. Listed in isServerOnlySecretKey (secrets-store.ts). */
export const CF_ACCESS_SYNC_TOKEN_KEY = 'CC_SERVER_CF_ACCESS_SYNC_TOKEN'

const GLOBAL = { scopeType: 'global' as const }

/** A Cloudflare API token is ~40 url-safe characters. Be generous, not exact. */
const TOKEN_SHAPE = /^[A-Za-z0-9_\-.]{20,200}$/

export type CfAccessTokenSource = 'settings' | 'env'

export interface CfAccessTokenStatus {
  configured: boolean
  source: CfAccessTokenSource | null
  /** When the stored token was last saved (settings source only). */
  updated_at: string | null
}

let cache: { stamp: string; token: string } | null = null
/** Bumped on every save / clear so the policy client is rebuilt. */
let generation = 0

function storedStamp(): { stamp: string; updatedAt: string } | null {
  try {
    const s = getSecret(GLOBAL, CF_ACCESS_SYNC_TOKEN_KEY)
    return s ? { stamp: `${s.id}:${s.version}`, updatedAt: s.updatedAt } : null
  } catch {
    return null
  }
}

/**
 * SERVER-ONLY. The token to use for a Cloudflare call right now, or null.
 * Never pass the result to a response body, a log line or an error message.
 */
export function resolveCfAccessToken(
  env: NodeJS.ProcessEnv = process.env,
): { token: string; source: CfAccessTokenSource } | null {
  const stamp = storedStamp()
  if (stamp) {
    if (cache && cache.stamp === stamp.stamp) return { token: cache.token, source: 'settings' }
    try {
      const value = getSecretValue(GLOBAL, CF_ACCESS_SYNC_TOKEN_KEY, null, 'server')
      if (value && value.trim()) {
        cache = { stamp: stamp.stamp, token: value.trim() }
        return { token: cache.token, source: 'settings' }
      }
    } catch {
      // fall through to the env fallback
    }
  } else {
    cache = null
  }
  const fromEnv = (env.OK_CF_ACCESS_API_TOKEN || '').trim()
  return fromEnv ? { token: fromEnv, source: 'env' } : null
}

/** Whether a token is set and where from. Never the value. */
export function cfAccessTokenStatus(env: NodeJS.ProcessEnv = process.env): CfAccessTokenStatus {
  const stamp = storedStamp()
  if (stamp) return { configured: true, source: 'settings', updated_at: stamp.updatedAt }
  if ((env.OK_CF_ACCESS_API_TOKEN || '').trim()) return { configured: true, source: 'env', updated_at: null }
  return { configured: false, source: null, updated_at: null }
}

/** Is this plausibly a Cloudflare API token? Used to reject a pasted URL or a typo. */
export function looksLikeCfToken(raw: unknown): raw is string {
  return typeof raw === 'string' && TOKEN_SHAPE.test(raw.trim())
}

/** Store (or replace) the token. Takes effect on the next sync — no restart. */
export function saveCfAccessToken(token: string, actorUserId: number | null): void {
  setSecret({
    scope: GLOBAL,
    key: CF_ACCESS_SYNC_TOKEN_KEY,
    value: token.trim(),
    serviceOnly: true,
    actorUserId,
    source: 'ui',
    description: 'Cloudflare Access sync token (Settings → Users). Access: Apps and Policies Edit only.',
  })
  cache = null
  generation++
}

/** Remove the stored token. The env fallback, if any, applies again. */
export function clearCfAccessToken(actorUserId: number | null): boolean {
  let removed = false
  try { removed = deleteSecret(GLOBAL, CF_ACCESS_SYNC_TOKEN_KEY, actorUserId, 'ui') } catch { removed = false }
  cache = null
  generation++
  return removed
}

/** Changes whenever the stored token is saved or cleared. Not derived from the value. */
export function cfAccessTokenGeneration(): number {
  return generation
}

/** Test hook. */
export function resetCfAccessTokenCacheForTests(): void {
  cache = null
  generation++
}
