// ── A card spawn that produced nothing rests its seat (obj 901395) ──
//
// A card session that hits a usage LIMIT already parks its seat and resumes on
// another one (session-death.ts → autoResumeOnLimit, up to 8 moves). A spawn
// that dies with NO output at all (0 tool calls, no answer, no limit line in
// the transcript) was re-spawned up to MAX_NOOP_RESPAWNS times with nothing
// done to the seat, so the respawn could be picked onto the same seat again.
// This gives the seat the same short rest a chat turn's empty exit gets
// (settings.seat_empty_turn_cooldown_minutes; 0 = off), which is what makes
// the respawn rotate. Claude seats only; a seat already cooling down, parked
// or unknown is left as it is.
import type Database from 'better-sqlite3'
import { getAccountById, recordEmptyTurn } from './account-router.js'

/** Returns the seat id that was rested, or null when nothing changed. */
export function restSeatAfterNoOpSpawn(db: Database.Database, sessionId: string | null | undefined): string | null {
  if (!sessionId) return null
  let accountId: string | null = null
  try {
    const row = db.prepare('SELECT account_id FROM session_runtime WHERE session_id = ?').get(sessionId) as { account_id: string | null } | undefined
    accountId = row?.account_id ?? null
  } catch {
    return null // table missing / read error → unknown seat
  }
  if (!accountId) return null
  const seat = getAccountById(accountId)
  if (!seat || (seat.kind && seat.kind !== 'claude')) return null
  return recordEmptyTurn(accountId, `card no-op spawn (session ${sessionId})`) ? accountId : null
}
