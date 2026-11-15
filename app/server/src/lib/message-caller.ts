/**
 * Who is calling `POST /api/internal/objectives/:id/message` (obj 900910,
 * closing the obj-707038 follow-up "real enforcement needs a per-session token
 * minted at spawn").
 *
 * Every card session already holds an objective-scoped HMAC token
 * (`CC_SESSION_TOKEN`, lib/session-trust.ts, minted in session-spawn-env.ts).
 * When the caller presents it, the sender is DERIVED from the token:
 *
 *   token valid, no body id              → fromId = token's card   (session_token)
 *   token valid, body id == token's card → same                    (session_token)
 *   token valid, body id != token's card → 403 + mismatch          (refused, logged)
 *   token present but invalid / expired  → 401                     (never falls back to the body)
 *   no token, body id                    → fromId = body id        (self_declared — recorded as such)
 *   no token, no body id                 → fromId = null           (none — unattributed)
 *
 * `settings.message_require_session_token = '1'` refuses the two tokenless rows
 * with a 401 once every caller sends the header. It is OFF by default because
 * the delegator wake, ci-feedback-bridge and strategy-governance omit both.
 */
import type Database from 'better-sqlite3'
import { SESSION_TOKEN_HEADER, sessionTokenFromHeaders, verifySessionToken } from './session-trust.js'

export const MESSAGE_REQUIRE_SESSION_TOKEN = 'message_require_session_token'

export type MessageCallerIdentity = 'session_token' | 'self_declared' | 'none'

export type MessageCaller =
  | { ok: true; fromId: number | null; identity: MessageCallerIdentity }
  | { ok: false; status: 400 | 401 | 403; error: string; mismatch?: { declared: number; token: number } }

function requireToken(db: Database.Database): boolean {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MESSAGE_REQUIRE_SESSION_TOKEN) as { value?: string } | undefined
    return row?.value === '1'
  } catch {
    return false
  }
}

export function resolveMessageCaller(
  db: Database.Database,
  headers: Record<string, string | string[] | undefined>,
  declared: unknown,
  now = Date.now(),
): MessageCaller {
  let declaredId: number | null = null
  if (declared !== undefined && declared !== null && declared !== '') {
    const n = Number(declared)
    if (!Number.isInteger(n) || n <= 0) return { ok: false, status: 400, error: 'from_objective_id must be a positive integer objective id' }
    declaredId = n
  }

  // A header that is present but not a session token is a broken caller, not an
  // anonymous one — refuse it rather than quietly using the body id.
  const rawHeader = headers[SESSION_TOKEN_HEADER]
  const token = sessionTokenFromHeaders(headers)
  if (token || (typeof rawHeader === 'string' && rawHeader.trim() !== '')) {
    let claims = null
    try {
      claims = token ? verifySessionToken(token, now) : null
    } catch {
      claims = null // no signing key configured → cannot verify
    }
    if (!claims) return { ok: false, status: 401, error: 'X-CC-Session-Token is invalid or expired, so the sender cannot be verified.' }
    if (declaredId !== null && declaredId !== claims.objectiveId) {
      return {
        ok: false,
        status: 403,
        error: `from_objective_id ${declaredId} does not match the calling session (card #${claims.objectiveId}). The sender is taken from the session token.`,
        mismatch: { declared: declaredId, token: claims.objectiveId },
      }
    }
    return { ok: true, fromId: claims.objectiveId, identity: 'session_token' }
  }

  if (requireToken(db)) {
    return { ok: false, status: 401, error: `A session token is required to message a card (${MESSAGE_REQUIRE_SESSION_TOKEN}=1). Send -H "X-CC-Session-Token: $CC_SESSION_TOKEN".` }
  }
  return { ok: true, fromId: declaredId, identity: declaredId === null ? 'none' : 'self_declared' }
}
