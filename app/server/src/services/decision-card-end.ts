/**
 * Wiring (obj 901151): when ANY card ends, its Needs you asks are settled at
 * once, not on the next 15 s sweep.
 *
 *   1. stale asks are withdrawn (decision-queue.ts `onCardEnded`): a card that
 *      was cancelled, closed by a person, or finished without asking.
 *   2. an ask with no briefing is briefed from the now-written session summary,
 *      or withdrawn as an FYI (decision-autobrief.ts). This is async (one model
 *      call); the stack hides the ask until it is done.
 *
 * The poller also runs both on a timer (`maybeRunDecisionUpkeep`) as the
 * backstop for a missed event or a restart.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import { onObjectiveEnded } from '../ws/index.js'
import { onCardEnded, sweepStaleDecisions } from './decision-queue.js'
import { briefDueDecisions, type FyiSink } from './decision-autobrief.js'
import { fyiSink } from './decision-fyi-sink.js'

/** What runs for one ended card. Exported for tests. */
export async function handleCardEnded(db: Database.Database, objectiveId: number, sink: FyiSink = fyiSink): Promise<void> {
  try {
    onCardEnded(db, objectiveId)
  } catch (err) {
    console.warn(`[decision-card-end] clearing card ${objectiveId}:`, err instanceof Error ? err.message : String(err))
  }
  await briefDueDecisions(db, sink, { objectiveId })
}

let stop: (() => void) | null = null
/** Register the card-ended hook once (index.ts at boot). */
export function startDecisionCardEndHook(): void {
  if (stop) return
  stop = onObjectiveEnded(id => {
    void handleCardEnded(getDb(), id)
  })
}

export const UPKEEP_INTERVAL_MS = 15_000
let lastUpkeep = 0
let upkeepRunning = false
/**
 * Poller backstop: withdraw stale asks everywhere, then brief every due
 * no-briefing ask. Throttled; never overlaps itself.
 */
export function maybeRunDecisionUpkeep(db: Database.Database, nowMs = Date.now(), sink: FyiSink = fyiSink): boolean {
  if (upkeepRunning || nowMs - lastUpkeep < UPKEEP_INTERVAL_MS) return false
  lastUpkeep = nowMs
  upkeepRunning = true
  try {
    sweepStaleDecisions(db)
  } catch (err) {
    console.warn('[decision-card-end] sweep failed:', err instanceof Error ? err.message : String(err))
  }
  void briefDueDecisions(db, sink, { nowMs }).finally(() => { upkeepRunning = false })
  return true
}
