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
 *   delivered  the card is done and a BOT owns it (obj 901151): the choice goes to
 *              that bot (its chat now, its next session's prompt) without
 *              reopening anything (services/decision-delivery.ts)
 *   card_done  the card is done/cancelled, no bot owns it, and the person did not
 *              ask to reopen: nothing is sent, the record says so, and the UI
 *              offers "Reopen and apply"
 *   reopened   "Reopen and apply": an EXPLICIT human reopen (terminal_by_human
 *              cleared, audited), then the same restart as `sent`
 *   to_chat    obj 901453: a bot raised it from chat and the chosen option needs a
 *              chat-only operator tool (deploy / merge). A card session has no such
 *              tool, so the card is NOT restarted: the bot's chat gets "You chose
 *              Deploy. Type deploy here to run it." The click itself runs nothing
 *              and no gate is widened (deliverDecisionToChat in decision-delivery.ts)
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
  chosenLabel,
  optionChatActions,
  optionFor,
  type ChatOnlyAction,
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
  /**
   * obj 901151: hand a choice on a finished card to the bot that owns it.
   * Returns the bot's display name, or null when no bot owns the card.
   */
  deliverToBot?: (db: Database.Database, decision: DecisionView, objective: Objective) => { name: string } | null
  /**
   * obj 901453: hand a choice that needs a chat-only operator tool (deploy /
   * merge) to the chat of the bot that raised it. Returns the bot's display
   * name, or null when it could not be posted (the caller falls back to the card).
   */
  deliverToChat?: (db: Database.Database, decision: DecisionView, action: ChatOnlyAction) => { name: string } | null
  /** obj 901151: a reopen applies a delivered answer itself, so the bot's copy is consumed. */
  consumeDelivery?: (db: Database.Database, decisionId: number, objectiveId: number) => void
}

export interface ApplyResult {
  outcome: DecisionOutcome
  outcome_text: string
  decision: DecisionView
  objective: Objective | null
}

/**
 * obj 901453: the chat-only operator action (deploy / merge) the chosen option
 * names, when the decision was raised by a bot from chat. Null otherwise: a
 * worker's decision, a deny, an own answer, or an option that only waits.
 */
export function chatOnlyActionFor(decision: DecisionView): ChatOnlyAction | null {
  if (decision.source !== 'bot' || !decision.agent_slug?.trim()) return null
  const acts = optionChatActions(optionFor(decision.briefing, decision.chosen))
  // "Merge and deploy" asks for the merge first: it is the step that must run first.
  return acts[0] ?? null
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
  const finish = (outcome: DecisionOutcome, error?: string | null, bot?: string | null, action?: string | null): ApplyResult => {
    const text = decisionOutcomeText({ objectiveId: decision.objective_id, briefing: decision.briefing, chosen, outcome, error, note: decision.decision_note, bot, action })
    const updated = setOutcome(db, decision.id, outcome, text)
    return { outcome, outcome_text: text, decision: updated, objective: objective ? loadObjective(db, objective.id) : null }
  }
  if (!objective) return finish('recorded')

  // obj 901453: a deploy / merge option on a decision a bot raised from chat goes
  // back to that chat. Only that chat can run it, and only when the person types it.
  const action = chatOnlyActionFor(decision)
  if (action && deps.deliverToChat && !p.reopen) {
    let to: { name: string } | null = null
    try {
      to = deps.deliverToChat(db, decision, action)
    } catch (err) {
      console.warn(`[decisions] could not post decision ${decision.id} to its bot's chat:`, err instanceof Error ? err.message : String(err))
    }
    if (to) return finish('to_chat', null, to.name, action)
  }

  const text = decisionFollowUpText({ decisionId: decision.id, briefing: decision.briefing, chosen, note: decision.decision_note })
  let reopened = false
  if (isLockedStatus(objective.status)) {
    // A "no" on a finished card changes nothing — never reopen a card to tell it not to act.
    if (chosen === DENY_CHOICE) return finish('recorded')
    if (!p.reopen) {
      // obj 901151: a finished card a bot owns is not a dead end: the bot gets it.
      if (objective.status === 'done' && deps.deliverToBot) {
        let to: { name: string } | null = null
        try {
          to = deps.deliverToBot(db, decision, objective)
        } catch (err) {
          console.warn(`[decisions] could not deliver decision ${decision.id} to its bot:`, err instanceof Error ? err.message : String(err))
        }
        if (to) return finish('delivered', null, to.name)
      }
      return finish('card_done')
    }
    // Explicit human reopen: the person pressed "Reopen and apply".
    try { deps.consumeDelivery?.(db, decision.id, objective.id) } catch { /* best effort */ }
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
      try { liftDecisionHold(db, fresh.id, decision, chosen) } catch { /* best effort */ }
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
  // obj 901277: the card was waiting for THIS answer; it has it now and is starting.
  try { liftDecisionHold(db, fresh.id, decision, chosen) } catch { /* best effort: never block the restart */ }
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
      const failText = decisionOutcomeText({ objectiveId: decision.objective_id, briefing: decision.briefing, chosen, outcome: 'failed', error: msg, note: decision.decision_note })
      try { setOutcome(db, decision.id, 'failed', failText) } catch { /* best effort */ }
    }
  })
  return result
}

// ── the hold that waited for this answer (obj 901277) ──
//
// Card #901231 was filed "queued and held, do not start until Operator approves",
// with queue_hold = "Waiting for Operator's decision. Do not start until Operator
// approves …". Operator answered, the card started, and both lines stayed: the
// owning bot then read a WORKING card that still said "held, do not start" and
// told Operator it could not confirm anything. Answering the decision is the
// approval those lines waited for, so here they stop reading as live:
//   - queue_hold is cleared when it is a wait-for-the-decision / owner-approval
//     hold; any other hold (a vendor key, another card, a date) is left alone;
//   - a description that still says "queued and held" / "do not start until"
//     gets ONE dated line on top saying the hold was lifted by this answer.
// Both are recorded in activity_log so nothing disappears silently.

/** Does this hold text wait on an owner decision / approval (and nothing else we can tell)? */
export function isDecisionWaitHold(hold: string | null | undefined): boolean {
  const h = (hold ?? '').trim()
  if (!h) return false
  return (
    /\bdecision\b/i.test(h) ||
    /\b(until|till|before)\b[^.\n]{0,60}\b(approv\w*|answer\w*|decid\w*|sign(s|ed)?[- ]off|go[- ]ahead|says? (yes|go))/i.test(h) ||
    /\bwait(s|ing)?\s+(for|on)\s+(the\s+)?(owner|operator|operator|your?|human)('s)?\b[^.\n]{0,40}\b(approv\w*|answer|decision|ok|go[- ]ahead|sign[- ]off|choice)/i.test(h) ||
    /\b(needs?|awaiting|pending)\s+(owner|operator|human|operator)('s)?\s+(approval|decision|answer|sign[- ]off)/i.test(h)
  )
}

/** A brief that still tells the reader the card is held. */
export function descriptionSaysHeld(description: string | null | undefined): boolean {
  return /\b(queued\s+and\s+held|held\s+until|do\s+not\s+start\s+until|don'?t\s+start\s+until|on\s+hold\s+until)\b/i.test(description ?? '')
}

export const HOLD_LIFTED_MARK = '[hold lifted]'

function liftDecisionHold(db: Database.Database, objectiveId: number, decision: DecisionView, chosen: string): void {
  const row = db.prepare('SELECT id, workspace, project, description, queue_hold FROM objectives WHERE id = ?').get(objectiveId) as
    | { id: number; workspace: string; project: string | null; description: string | null; queue_hold: string | null }
    | undefined
  if (!row) return
  const answer = chosenLabel(decision.briefing, chosen, decision.decision_note) ?? chosen
  const who = decision.decided_by ?? 'the owner'
  const when = decision.decided_at ?? new Date().toISOString().slice(0, 19).replace('T', ' ')
  const changes: string[] = []
  if (isDecisionWaitHold(row.queue_hold)) {
    db.prepare("UPDATE objectives SET queue_hold = NULL, updated_at = datetime('now') WHERE id = ? AND queue_hold = ?").run(row.id, row.queue_hold)
    changes.push(`cleared queue_hold "${(row.queue_hold ?? '').slice(0, 200)}"`)
  }
  if (descriptionSaysHeld(row.description) && !(row.description ?? '').startsWith(HOLD_LIFTED_MARK)) {
    const line = `${HOLD_LIFTED_MARK} ${when} UTC: ${who} answered decision #${decision.id} (${answer}) and the card was started with that answer. Any "queued and held / do not start until approved" line below no longer applies.`
    db.prepare("UPDATE objectives SET description = ?, updated_at = datetime('now') WHERE id = ?").run(`${line}\n\n${row.description ?? ''}`, row.id)
    changes.push('marked the "held" line in the description as lifted')
  }
  if (!changes.length) return
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, event_type, title, detail, metadata)
       VALUES (?, ?, ?, 'decision', ?, ?, ?)`,
    ).run(
      row.project ?? '',
      row.workspace,
      row.id,
      `Hold lifted by decision #${decision.id}`,
      changes.join('; '),
      JSON.stringify({ kind: 'decision_hold_lifted', decision_id: decision.id, previous_queue_hold: row.queue_hold }),
    )
  } catch { /* activity_log is a record, not a gate */ }
}
