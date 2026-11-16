/**
 * Apply a person's decision to its card (obj 901059).
 *
 * The old Approve button posted "Approved: go ahead…" through the card message
 * route, which refuses a done card with a 409 — so approving a decision on a
 * finished job card did nothing visible, and the bot then said "the card is
 * done, reopen it before sending". Here every path ends in a named OUTCOME the
 * person sees in one line (shared `decisionOutcomeText`):
 *
 *   sent       the card was parked (review / queue / dead worker): it is moved to
 *              working and restarted with the choice as a follow-up
 *   queued     the worker is alive mid-turn: the choice is queued and handed to
 *              the same session when the turn ends (services/followup-queue.ts)
 *   card_done  the card is done/cancelled and the person did not ask to reopen:
 *              nothing is sent, the record says so, and the UI offers
 *              "Reopen and apply"
 *   reopened   "Reopen and apply": an EXPLICIT human reopen (terminal_by_human
 *              cleared, audited), then the same restart as `sent`
 *   recorded   a deny on a finished card, or a card that no longer exists
 *   failed     the restart threw (spend ceiling, disk…): the choice is kept and
 *              the error is stated
 *
 * The follow-up is delivered under the deciding person's OWN server-stamped
 * sender (from how their request authenticated), so a cookie owner is VERIFIED
 * and nothing here mints an approval on anyone's behalf.
 */
import type Database from 'better-sqlite3'
import {
  DENY_CHOICE,
  decisionFollowUpText,
  decisionOutcomeText,
  type DecisionOutcome,
  type DecisionView,
  type Objective,
} from '@operationkit/shared'
import type { MessageSender } from '../lib/message-provenance.js'
import { isLockedStatus, runMachineStatusUpdate } from '../lib/status-lock.js'
import { setOutcome } from './decisions.js'

export interface ApplyDeps {
  getSessionState: (sessionId: string) => 'working' | 'review' | 'dead'
  resolveSessionId: (db: Database.Database, objective: Objective) => string
  recordInJsonl: (sessionId: string, text: string, sender: MessageSender, queued: boolean) => void
  enqueue: (db: Database.Database, objectiveId: number, sessionId: string, text: string, sender: MessageSender) => void
  /** The respawn. Called on the next tick; a throw marks the outcome `failed`. */
  sendFollowUp: (sessionId: string, text: string, objective: Objective, sender: MessageSender) => void
  audit: (db: Database.Database, objective: Objective, actor: string) => void
  broadcast: (objective: Objective) => void
  noteStart: (objectiveId: number, actor: string) => void
  /** Deferred-work scheduler. Tests pass a synchronous one. */
  defer: (fn: () => void) => void
}

export interface ApplyResult {
  outcome: DecisionOutcome
  outcome_text: string
  decision: DecisionView
  objective: Objective | null
}

function loadObjective(db: Database.Database, id: number): Objective | null {
  return (db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined) ?? null
}

/**
 * Deliver a decided choice to its card and record the outcome.
 * `reopen` = the person pressed "Reopen and apply" (an explicit human reopen).
 */
export function applyDecision(
  db: Database.Database,
  decision: DecisionView,
  p: { sender: MessageSender; actor: string; reopen: boolean },
  deps: ApplyDeps,
): ApplyResult {
  const chosen = decision.chosen as string
  const objective = loadObjective(db, decision.objective_id)
  const finish = (outcome: DecisionOutcome, error?: string | null): ApplyResult => {
    const text = decisionOutcomeText({ objectiveId: decision.objective_id, briefing: decision.briefing, chosen, outcome, error })
    const updated = setOutcome(db, decision.id, outcome, text)
    return { outcome, outcome_text: text, decision: updated, objective: objective ? loadObjective(db, objective.id) : null }
  }
  if (!objective) return finish('recorded')

  const text = decisionFollowUpText({ decisionId: decision.id, briefing: decision.briefing, chosen, note: decision.decision_note })
  let reopened = false
  if (isLockedStatus(objective.status)) {
    // A "no" on a finished card changes nothing — never reopen a card to tell it not to act.
    if (chosen === DENY_CHOICE) return finish('recorded')
    if (!p.reopen) return finish('card_done')
    // Explicit human reopen: the person pressed "Reopen and apply".
    db.prepare("UPDATE objectives SET status = 'review', terminal_by_human = 0, updated_at = datetime('now') WHERE id = ? AND status IN ('done', 'cancelled')")
      .run(objective.id)
    deps.audit(db, objective, p.actor)
    reopened = true
  }

  const fresh = loadObjective(db, objective.id) as Objective
  const sessionId = deps.resolveSessionId(db, fresh)

  // Worker alive and mid-turn: queue it for the same session, never kill the run.
  if (!reopened && fresh.status === 'working' && fresh.session_id === sessionId && deps.getSessionState(sessionId) === 'working') {
    try {
      deps.recordInJsonl(sessionId, text, p.sender, true)
      deps.enqueue(db, fresh.id, sessionId, text, p.sender)
      return finish('queued')
    } catch (err) {
      return finish('failed', err instanceof Error ? err.message : String(err))
    }
  }

  const prior = fresh.status
  try {
    runMachineStatusUpdate(db, "UPDATE objectives SET status = 'working', session_id = ?, updated_at = datetime('now') WHERE id = ?", sessionId, fresh.id)
    deps.recordInJsonl(sessionId, text, p.sender, false)
  } catch (err) {
    return finish('failed', err instanceof Error ? err.message : String(err))
  }
  const working = loadObjective(db, fresh.id) as Objective
  deps.broadcast(working)
  const result = finish(reopened ? 'reopened' : 'sent')
  deps.defer(() => {
    try {
      deps.noteStart(fresh.id, p.actor)
      deps.sendFollowUp(sessionId, text, working, p.sender)
    } catch (err) {
      const msg = ((err as Error)?.message || String(err)).split('\n')[0].slice(0, 300)
      console.error(`[decisions] restart failed for card ${fresh.id} (decision ${decision.id}):`, msg)
      try {
        db.prepare("UPDATE objectives SET status = ?, updated_at = datetime('now') WHERE id = ?").run(prior, fresh.id)
        const reverted = loadObjective(db, fresh.id)
        if (reverted) deps.broadcast(reverted)
      } catch { /* best effort */ }
      const failText = decisionOutcomeText({ objectiveId: decision.objective_id, briefing: decision.briefing, chosen, outcome: 'failed', error: msg })
      try { setOutcome(db, decision.id, 'failed', failText) } catch { /* best effort */ }
    }
  })
  return result
}
