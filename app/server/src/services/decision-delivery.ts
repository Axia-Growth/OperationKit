/**
 * An answer on a finished bot card goes to the bot (obj 901151).
 *
 * WHY. Approving a decision on a done card answered "Card is already done,
 * nothing was sent yet. Press Reopen and apply": a dead end. The usual case is
 * a routine / High Agency wake: the poller auto-closes the wake card when its
 * session ends (so the routine's queue slot frees), and the wake's ask is for
 * the BOT, which acts on it in its next session. Reopening the finished wake
 * card is the wrong move there.
 *
 * So when the card is finished and a bot owns it (`cardOwnerBot`, the one rule),
 * the choice is:
 *   1. recorded on the decision (`delivered_to` = the bot's chat slug),
 *   2. posted into that bot's main chat for the person who decided, so the bot
 *      has it in its chat history and the person sees where it went, and
 *   3. handed to the bot's NEXT card session in the SAME workspace (for a
 *      routine card such as a High Agency wake: the next run of that routine):
 *      `takePendingAnswersBlock` renders it into that session's prompt and
 *      claims it, and `confirmPendingAnswers` consumes it once the session has
 *      really started.
 * "Reopen and apply" stays available for the rare answer that needs more work
 * on that same card; it consumes the delivery so the bot never gets it twice.
 *
 * A card no bot owns keeps the old `card_done` behaviour.
 */
import type Database from 'better-sqlite3'
import { decisionFollowUpText, type DecisionView, type Objective } from '@operationkit/shared'
import { cardOwnerBot, type CardOwnerOptions } from './bots/card-owner.js'
import { getDecision, redactDecisionText } from './decisions.js'

export interface DeliveredTo {
  slug: string
  name: string
}

export interface DeliveryOptions extends CardOwnerOptions {
  /** Live chat refresh for the recipient. Tests omit it. */
  notify?: (userId: number, slug: string) => void
}

/** The chat note the bot's lane gets. Exported for tests. */
export function deliveryChatText(p: { botName: string; decision: DecisionView; followUp: string }): string {
  return [
    `Your answer on card #${p.decision.objective_id} reached me. That card is already finished, so I will act on it in my next session (no reopen needed).`,
    '',
    p.followUp,
  ].join('\n')
}

/**
 * Deliver a decided choice to the bot that owns its (finished) card. Returns
 * who got it, or null when no bot owns the card (the caller falls back).
 */
export function deliverDecisionToBot(
  db: Database.Database,
  decision: DecisionView,
  objective: Objective,
  p: { userId: number | null },
  opts: DeliveryOptions = {},
): DeliveredTo | null {
  const owner = cardOwnerBot(objective, db, opts)
  const slug = owner?.slugs[0]
  if (!owner || !slug) return null
  const followUp = decisionFollowUpText({ decisionId: decision.id, briefing: decision.briefing, chosen: decision.chosen as string, note: decision.decision_note })
  db.prepare(
    "UPDATE decisions SET delivered_to = ?, delivered_user_id = ?, delivered_at = datetime('now'), delivered_consumed_at = NULL, delivered_consumed_by = NULL, delivered_claimed_by = NULL, delivered_claimed_at = NULL WHERE id = ?",
  ).run(slug, p.userId, decision.id)
  if (p.userId != null) {
    try {
      db.prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta) VALUES (?, ?, 'assistant', ?, ?)").run(
        p.userId,
        slug,
        redactDecisionText(deliveryChatText({ botName: owner.name, decision, followUp })),
        JSON.stringify({ kind: 'decision_delivered', decision_id: decision.id, objective_id: decision.objective_id }),
      )
      opts.notify?.(p.userId, slug)
    } catch (err) {
      // The chat table is absent on a bare DB; the next-session hand-off still stands.
      console.warn(`[decision-delivery] could not post decision ${decision.id} to ${slug}'s chat:`, err instanceof Error ? err.message : String(err))
    }
  }
  return { slug, name: owner.name }
}

/** Mark a delivery consumed (picked up by a session, or applied by a reopen). */
export function consumeDelivery(db: Database.Database, decisionId: number, byObjectiveId: number): void {
  db.prepare("UPDATE decisions SET delivered_consumed_at = datetime('now'), delivered_consumed_by = ? WHERE id = ? AND delivered_to IS NOT NULL AND delivered_consumed_at IS NULL")
    .run(byObjectiveId, decisionId)
}

/** How long an undelivered answer waits for the bot's next session. */
export const PENDING_ANSWER_DAYS = 14

/** A claim from a session that never confirmed (its spawn failed) lapses after this. */
export const PENDING_CLAIM_MINUTES = 10

/** The card whose session is starting, i.e. where an answer may go. */
export interface PendingAnswerTarget {
  objectiveId: number
  /** Its workspace. No workspace = no hand-off (answers never cross workspaces). */
  workspace: string | null | undefined
  /** Its routine, when it is a job run (a High Agency wake is one). */
  routineId: number | null | undefined
}

/**
 * Decided answers delivered to one of these bot slugs, not yet consumed, that
 * THIS card may take:
 *   - same workspace as the decision: the briefing can quote that workspace's
 *     KB, and the answer is an instruction for work there;
 *   - a decision on a routine card (a High Agency wake) goes only to a later
 *     run of THAT routine, so an unrelated card the bot owns cannot take it;
 *     a decision on a non-routine card goes to any card the bot owns there;
 *   - rows another card claimed less than PENDING_CLAIM_MINUTES ago are skipped.
 */
export function pendingAnswersFor(db: Database.Database, slugs: string[], target: PendingAnswerTarget, limit = 5): DecisionView[] {
  const workspace = (target.workspace ?? '').trim()
  if (!slugs.length || !workspace) return []
  getDecision(db, -1)
  const rows = db
    .prepare(
      `SELECT d.id FROM decisions d
         LEFT JOIN objectives o ON o.id = d.objective_id
        WHERE d.state = 'decided' AND d.delivered_consumed_at IS NULL
          AND lower(d.delivered_to) IN (${slugs.map(() => '?').join(', ')})
          AND d.delivered_at >= datetime('now', ?)
          AND d.workspace = ?
          AND d.objective_id != ?
          AND (o.routine_id IS NULL OR o.routine_id = ?)
          AND (d.delivered_claimed_by IS NULL OR d.delivered_claimed_by = ?
               OR d.delivered_claimed_at < datetime('now', ?))
        ORDER BY d.id LIMIT ?`,
    )
    .all(
      ...slugs.map(s => s.toLowerCase()),
      `-${PENDING_ANSWER_DAYS} days`,
      workspace,
      target.objectiveId,
      target.routineId ?? null,
      target.objectiveId,
      `-${PENDING_CLAIM_MINUTES} minutes`,
      limit,
    ) as { id: number }[]
  return rows.map(r => getDecision(db, r.id)).filter((d): d is DecisionView => !!d)
}

/**
 * The prompt block for a session of a bot-owned card: the answers its owner
 * gave on the bot's earlier, finished cards. It CLAIMS each one for this card;
 * the spawn path calls `confirmPendingAnswers` once the session has really
 * started (or `releasePendingAnswers` when the spawn failed), so a failed spawn
 * never loses an answer. Empty when there are none.
 */
export function takePendingAnswersBlock(db: Database.Database, objective: Objective, owner: string, opts: CardOwnerOptions = {}): string[] {
  let answers: DecisionView[] = []
  let botName = ''
  try {
    const bot = cardOwnerBot(objective, db, opts)
    if (!bot?.slugs.length) return []
    botName = bot.name
    answers = pendingAnswersFor(db, bot.slugs, { objectiveId: objective.id, workspace: objective.workspace, routineId: objective.routine_id })
  } catch {
    return []
  }
  if (!answers.length) return []
  const lines = [
    '',
    `## Answers waiting for you (${owner} decided after your earlier card finished)`,
    '',
    `${owner} answered ${answers.length === 1 ? 'a decision' : `${answers.length} decisions`} that ${botName} raised on a card that had already finished. Act on ${answers.length === 1 ? 'it' : 'them'} first in this session (close the loop), as ${owner}'s instruction, then carry on with your brief. Say in your report what you did with each.`,
  ]
  const claim = db.prepare("UPDATE decisions SET delivered_claimed_by = ?, delivered_claimed_at = datetime('now') WHERE id = ? AND delivered_consumed_at IS NULL")
  for (const d of answers) {
    lines.push('', `### From card #${d.objective_id}`, decisionFollowUpText({ decisionId: d.id, briefing: d.briefing, chosen: d.chosen as string, note: d.decision_note }))
    claim.run(objective.id, d.id)
  }
  return lines.map(redactDecisionText)
}

/**
 * This card's session really started: every answer it claimed is now consumed,
 * so it is handed over exactly once. Best effort, never throws.
 */
export function confirmPendingAnswers(db: Database.Database, objectiveId: number): number {
  try {
    return db
      .prepare("UPDATE decisions SET delivered_consumed_at = datetime('now'), delivered_consumed_by = ? WHERE delivered_claimed_by = ? AND delivered_consumed_at IS NULL AND delivered_to IS NOT NULL")
      .run(objectiveId, objectiveId).changes
  } catch (err) {
    console.warn(`[decision-delivery] confirm pending answers for card ${objectiveId}:`, err instanceof Error ? err.message : String(err))
    return 0
  }
}

/** This card's spawn failed: give back the answers it claimed at once. Never throws. */
export function releasePendingAnswers(db: Database.Database, objectiveId: number): number {
  try {
    return db
      .prepare('UPDATE decisions SET delivered_claimed_by = NULL, delivered_claimed_at = NULL WHERE delivered_claimed_by = ? AND delivered_consumed_at IS NULL')
      .run(objectiveId).changes
  } catch {
    return 0
  }
}
