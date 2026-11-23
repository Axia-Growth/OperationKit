/**
 * One card per intended card (obj 901498): the shared guard behind the two chat
 * tools that file a card, `create_objective` and `repo_session_start`.
 *
 * Three habits, the same three an outside operator bot follows by hand:
 *
 *  1. **One reusable key per card.** The tool takes an optional
 *     `idempotency_key`; without one the server derives a content fingerprint
 *     of the request. A retry with the same key (or the same content) returns
 *     the card already filed. A key is bound to ONE card: reusing it for a
 *     different title is refused, never silently answered with the old card.
 *  2. **Search first.** Before a card is created, open cards in the same
 *     workspace are compared by title (`findPossibleDuplicate`). A
 *     near-identical one is returned as "possible duplicate #N" and nothing is
 *     filed; the bot comments on / re-owns that card, or calls again with
 *     `file_anyway: true`. Never a silent block, never a silent second card.
 *  3. **Filed is not started.** A card whose start failed is reported as
 *     "exists, not started", so the bot starts it later instead of re-filing.
 *
 * No table of its own. `create_objective` keeps its key on `bot_job_origins`
 * (obj 900323). `repo_session_start` cards have no origin row (that table is
 * the read-only job path), so its key lives in the existing `idempotency_keys`
 * replay store (obj 714091) under a chat-only scope; the server prunes those
 * rows at boot once they are a day old (the Agent API's Idempotency-Key window).
 */
import crypto from 'crypto'
import type { Database } from 'better-sqlite3'
import { normalizeTitle } from '../../lib/title-normalize.js'
import { publicCardUrl } from '../../lib/public-url.js'

/** Printable ASCII, 1-120 characters: safe to store and to match on. */
const KEY_RE = /^[\x21-\x7e]{1,120}$/

/** Thrown for a malformed key; the tools turn it into a ToolUseError. */
export class FilingKeyError extends Error {}

/** The explicit `idempotency_key` argument, or null when none was passed. */
export function parseFilingKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw !== 'string' || !KEY_RE.test(raw.trim())) {
    throw new FilingKeyError('idempotency_key must be 1-120 letters, digits or symbols with no spaces. The card was NOT filed.')
  }
  return raw.trim()
}

/** How an explicit key is stored, so it can never collide with a derived fingerprint (40 hex characters). */
export function explicitKey(key: string): string {
  return `x:${key}`
}

/** Content fingerprint of a filing request: the derived key when the bot passes none. */
export function filingFingerprint(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.map(p => p.trim()).join('\u0000')).digest('hex').slice(0, 40)
}

// ── near-identical titles ────────────────────────────────────────────────────

const STOPWORDS = new Set(['a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'and', 'or', 'with', 'at', 'by', 'from', 'is', 'be', 'it', 'that', 'this'])

/** Two titles are "near-identical" at or above this similarity. */
export const NEAR_DUPLICATE_THRESHOLD = 0.8

function titleTokens(title: string): Set<string> {
  const out = new Set<string>()
  for (const raw of normalizeTitle(title).split(' ')) {
    if (!raw || STOPWORDS.has(raw)) continue
    // Fold a plain plural ("links" → "link") so a one-letter rewording still matches.
    out.add(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw)
  }
  return out
}

/**
 * 0..1: how alike two card titles are. Deterministic, no model call.
 *   - Equal after the board's own normalisation (case, punctuation, "(copy)") → 1.
 *   - Otherwise the share of words in common (Jaccard) after dropping filler
 *     words and folding plain plurals.
 *   - Titles that differ in a NUMBER ("Phase 2" / "Phase 3", "Q3" / "Q4") are
 *     different work by intent → 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a)
  const nb = normalizeTitle(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  const ta = titleTokens(a)
  const tb = titleTokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  const hasDigit = (t: string) => /\p{N}/u.test(t)
  for (const t of ta) if (hasDigit(t) && !tb.has(t)) return 0
  for (const t of tb) if (hasDigit(t) && !ta.has(t)) return 0
  let common = 0
  for (const t of ta) if (tb.has(t)) common++
  const score = common / (ta.size + tb.size - common)
  // Two- and one-word titles only match when every word matches.
  if (Math.min(ta.size, tb.size) < 3 && score < 1) return 0
  return score
}

export interface PossibleDuplicate {
  id: number
  title: string
  status: string
  agent_context: string | null
  owner_bot: string | null
  created_at: string
  similarity: number
}

/**
 * The open card in `workspace` whose title is closest to `title`, when it is
 * near-identical; else null. Open = not done, not cancelled, not deleted. No
 * time window: an open card from last week is still the card to follow up.
 * `visible` keeps the answer to cards the caller may see, so a "possible
 * duplicate" never tells a person about a card that is not on their board.
 * Never throws: a failed lookup must not block a filing.
 */
export function findPossibleDuplicate(
  db: Database,
  opts: { title: string; workspace: string; excludeParentId?: number | null; visible?: (id: number) => boolean },
): PossibleDuplicate | null {
  if (!normalizeTitle(opts.title)) return null
  let rows: Omit<PossibleDuplicate, 'similarity'>[]
  try {
    rows = db
      .prepare(
        `SELECT id, title, status, agent_context, owner_bot, created_at
           FROM objectives
          WHERE workspace = ? AND status NOT IN ('done', 'cancelled') AND deleted_at IS NULL
          ORDER BY id DESC LIMIT 2000`,
      )
      .all(opts.workspace) as Omit<PossibleDuplicate, 'similarity'>[]
  } catch (err) {
    console.warn('[card-filing-guard] lookup failed (allowing the filing):', (err as Error).message)
    return null
  }
  let best: PossibleDuplicate | null = null
  for (const r of rows) {
    if (opts.excludeParentId != null && r.id === opts.excludeParentId) continue
    const similarity = titleSimilarity(opts.title, r.title)
    if (similarity < NEAR_DUPLICATE_THRESHOLD) continue
    if (best && best.similarity >= similarity) continue
    if (opts.visible && !opts.visible(r.id)) continue
    best = { ...r, similarity }
  }
  return best
}

/** What the tool hands the model when it did NOT file because of a possible duplicate. */
export function possibleDuplicateResult(dup: Pick<PossibleDuplicate, 'id' | 'title' | 'status'>, opts: { tool: string; workspace: string; followUp: string }): Record<string, unknown> {
  return {
    filed: false,
    possible_duplicate: { id: dup.id, title: dup.title, status: dup.status, url: publicCardUrl(dup.id) },
    workspace: opts.workspace,
    note:
      `Possible duplicate #${dup.id} ("${dup.title}", ${dup.status}) is already open in ${opts.workspace}. NOTHING was filed. ` +
      `If it is the same work, use that card: ${opts.followUp} ` +
      `Only if it is genuinely different work, call ${opts.tool} again with file_anyway: true (and a title that tells the two apart). Tell the person which you did.`,
  }
}

// ── key store for cards with no bot_job_origins row (repo_session_start) ─────

function sessionScope(agentSlug: string, tool: string, workspace: string): string {
  return `chat-bot:${agentSlug} ${tool} ${workspace}`
}

export interface FiledByKey { cardId: number; title: string; status: string }

/**
 * The live card this person + bot already filed in this workspace under `key`,
 * or null. A key whose card was deleted is forgotten, so the next call files.
 */
export function findFiledByKey(db: Database, who: { userId: number; agentSlug: string; tool: string; workspace: string }, key: string): FiledByKey | null {
  const scope = sessionScope(who.agentSlug, who.tool, who.workspace)
  const row = db
    .prepare('SELECT response_body FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ?')
    .get(who.userId, scope, key) as { response_body: string | null } | undefined
  if (!row?.response_body) return null
  let cardId = 0
  try { cardId = Number((JSON.parse(row.response_body) as { id?: unknown }).id) } catch { /* not ours */ }
  const card = Number.isInteger(cardId) && cardId > 0
    ? (db.prepare('SELECT id, title, status FROM objectives WHERE id = ? AND deleted_at IS NULL').get(cardId) as { id: number; title: string; status: string } | undefined)
    : undefined
  if (!card) {
    db.prepare('DELETE FROM idempotency_keys WHERE user_id = ? AND scope = ? AND idem_key = ?').run(who.userId, scope, key)
    return null
  }
  return { cardId: card.id, title: card.title, status: card.status }
}

/** Bind `keys` to the card just filed. Call inside the transaction that inserted the card. */
export function recordFiledKeys(db: Database, who: { userId: number; agentSlug: string; tool: string; workspace: string }, keys: string[], cardId: number, fingerprint: string): void {
  const scope = sessionScope(who.agentSlug, who.tool, who.workspace)
  const put = db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys (user_id, scope, idem_key, request_hash, status_code, response_body) VALUES (?, ?, ?, ?, 201, ?)`,
  )
  for (const key of new Set(keys)) put.run(who.userId, scope, key, fingerprint, JSON.stringify({ id: cardId }))
}
