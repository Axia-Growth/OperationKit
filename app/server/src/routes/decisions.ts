/**
 * Decision briefings (obj 901059) — mounted at /api/decisions.
 *
 *   POST /api/decisions                      raise {objective_id, context, question, options, recommended, recommended_why, agent_slug?}
 *                                            (the card's own worker via CC_SESSION_TOKEN, or a caller who may see the card —
 *                                             a bot's agent key included). No question or < 2 options → 400 with `errors`.
 *   GET  /api/decisions?objective_id=N       the card's decisions, newest first (worker token or card access)
 *   GET  /api/decisions/log                  the learning log (?workspace= &objective_id= &since= &limit=)
 *   GET  /api/decisions/feedback?workspace=  recent questions the person had to ask (fed back into briefings)
 *   GET  /api/decisions/queue                the "Needs you" stack: every open decision the person may answer,
 *                                            ordered by urgency then age (obj 901084). Stale asks are cleared first.
 *   GET  /api/decisions/queue/count          {count} for the top-nav badge
 *   GET  /api/decisions/:id                  one decision with its thread
 *   POST /api/decisions/:id/questions        {body} ask the raising bot a question; ?wait=1 waits for the answer
 *   GET  /api/decisions/queue/history        the person's own recently decided items, newest first (obj 901139)
 *   POST /api/decisions/:id/decide           {choice: <option key>|'deny'|'own', note?, answer?, reopen?}
 *                                            'own' = the person's own words instead of an option (obj 901139);
 *                                            needs `answer` (or `note`) and is delivered, logged and cleared like any choice.
 *
 * Questions and decisions come ONLY from a person signed in to the web UI (the
 * httpOnly cookie) who owns the card or is an admin — never an agent key, a
 * Bearer JWT or a session token, so a bot cannot answer its own decision. The
 * choice is delivered to the card under that person's server-stamped sender.
 */
import { Router, type NextFunction, type Response } from 'express'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { requireOwnership, mapObjective, userOwnsObjective } from './objectives-helpers.js'
import { logActivity } from './feed.js'
import { authenticatedViaCookie, senderFromRequest } from '../lib/message-provenance.js'
import { sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'
import {
  DecisionError,
  decisionLog,
  getDecision,
  listDecisionsForCard,
  raiseDecision,
  recentOwnerQuestions,
  recordChoice,
  resolveChoice,
  writeDecisionLogToKb,
} from '../services/decisions.js'
import { OWN_ANSWER_CHOICE } from '@operationkit/shared'
import { decisionQueueCount, listDecidedHistory, listDecisionQueue, staleReasonForCard, sweepStaleDecisions, withReopenFlag, deliveryConsumed } from '../services/decision-queue.js'
import { listAgents as listChatAgents } from '../services/agent-chat/engine.js'
import { askAndAnswer } from '../services/decision-answerer.js'
import { applyDecision, type ApplyDeps } from '../services/decision-apply.js'
import { consumeDelivery, deliverDecisionToBot, deliverDecisionToChat } from '../services/decision-delivery.js'
import { notifyBotMessage } from '../services/agent-chat/sidebar-live.js'
import { getSessionState } from '../services/session-control.js'
import { resolveFollowUpSessionId } from '../services/objective-sessions.js'
import { recordFollowUpInJsonl, sendFollowUp } from '../services/session-manager.js'
import { enqueueFollowUp } from '../services/followup-queue.js'
import { noteStartReason } from '../services/session-start-reasons.js'
import { logObjectiveAudit } from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { workspaceKbRoot } from '../services/doc-ingest/kb-paths.js'
import { noteKbWrite } from '../services/kb-semantic/service.js'

const router = Router()

interface DecisionRequest extends AuthRequest {
  /** Set when the caller is a card's own worker (CC_SESSION_TOKEN). */
  sessionObjectiveId?: number
}

function loadObjective(id: number): Objective | undefined {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
}

/** A worker's session token (scoped to one card), else normal auth. */
function workerOrAuth(req: DecisionRequest, res: Response, next: NextFunction): void {
  const token = sessionTokenFromHeaders(req.headers)
  if (token) {
    const claims = verifySessionToken(token)
    if (!claims) {
      res.status(401).json({ error: 'Session token is not valid' })
      return
    }
    req.sessionObjectiveId = claims.objectiveId
    next()
    return
  }
  void requireAuth(req, res, next)
}

/** Card access for the caller: its own card for a worker token, ownership otherwise. */
function cardAccessError(req: DecisionRequest, objective: Objective): { status: number; error: string } | null {
  if (req.sessionObjectiveId !== undefined) {
    return req.sessionObjectiveId === objective.id ? null : { status: 403, error: 'Session token is not valid for this card' }
  }
  const err = requireOwnership(req, objective)
  return err ? { status: 403, error: err } : null
}

/** Questions and choices: a person in the web UI who owns the card, or an admin. */
function personError(req: DecisionRequest, objective: Objective | undefined): string | null {
  const denied = 'Only the card owner or an admin, signed in to the web UI, can answer a decision'
  if (req.sessionObjectiveId !== undefined || req.agentKey || !req.user || !authenticatedViaCookie(req)) return denied
  if (req.user.role === 'admin') return null
  if (!objective) return denied
  return requireOwnership(req, objective) ? denied : null
}

function fail(res: Response, err: unknown): void {
  if (err instanceof DecisionError) {
    res.status(err.status).json({ error: err.message, ...(err.errors.length ? { errors: err.errors } : {}) })
    return
  }
  console.error('[decisions] route failed:', err)
  res.status(500).json({ error: 'Something went wrong with that decision' })
}

function refreshKbLog(workspace: string): void {
  setImmediate(() => {
    writeDecisionLogToKb(getDb(), workspace, { kbRoot: ws => workspaceKbRoot(ws), noteWrite: abs => noteKbWrite(abs) })
  })
}

// POST /api/decisions — raise a decision with a briefing.
router.post('/', workerOrAuth, (req: DecisionRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const objectiveId = Number(b.objective_id ?? req.sessionObjectiveId)
  const objective = Number.isInteger(objectiveId) ? loadObjective(objectiveId) : undefined
  if (!objective) {
    res.status(404).json({ error: 'Card not found: pass objective_id' })
    return
  }
  const denied = cardAccessError(req, objective)
  if (denied) {
    res.status(denied.status).json({ error: denied.error })
    return
  }
  const db = getDb()
  const source = req.sessionObjectiveId !== undefined ? 'worker' : req.agentKey ? 'bot' : 'owner'
  const agentSlug = typeof b.agent_slug === 'string' && b.agent_slug.trim()
    ? b.agent_slug.trim().slice(0, 80)
    : (objective.owner_bot ?? null)
  const out = raiseDecision(db, {
    objective_id: objective.id,
    workspace: objective.workspace ?? '',
    source,
    agent_slug: agentSlug,
    briefing: (b.briefing && typeof b.briefing === 'object' ? b.briefing : b) as Record<string, unknown>,
  })
  if (!out.ok) {
    res.status(400).json({
      error: 'A decision needs a briefing: one question, 2-4 options with pros, cons and what happens next, and your recommendation.',
      errors: out.errors,
    })
    return
  }
  logActivity({
    project: objective.project || 'operationkit',
    workspace: objective.workspace,
    objective_id: objective.id,
    event_type: 'decision',
    title: `Decision needed: ${out.decision.briefing.question}`.slice(0, 200),
    detail: out.decision.briefing.options.map(o => `${o.key}) ${o.label}`).join('; '),
    metadata: { kind: 'decision_raised', decision_id: out.decision.id, source, flags: out.decision.flags },
  })
  broadcast({ type: 'objective_updated', payload: mapObjective(loadObjective(objective.id) as Objective) })
  refreshKbLog(objective.workspace ?? '')
  res.status(201).json({ decision: out.decision, superseded: out.superseded, ...(out.decision.flags.includes('long') ? { warning: 'The briefing is long; aim for under about 200 words.' } : {}) })
})

// GET /api/decisions?objective_id=N
router.get('/', workerOrAuth, (req: DecisionRequest, res) => {
  const id = Number(req.query.objective_id)
  const objective = Number.isInteger(id) ? loadObjective(id) : undefined
  if (!objective) {
    res.status(404).json({ error: 'Card not found: pass objective_id' })
    return
  }
  const denied = cardAccessError(req, objective)
  if (denied) {
    res.status(denied.status).json({ error: denied.error })
    return
  }
  const db = getDb()
  res.json({ objective_id: id, decisions: listDecisionsForCard(db, id).map(d => withReopenFlag(db, d)) })
})

// GET /api/decisions/log — the queryable learning log.
router.get('/log', requireAuth, (req: AuthRequest, res) => {
  const q = req.query
  const workspace = typeof q.workspace === 'string' && q.workspace ? q.workspace : null
  const objectiveId = q.objective_id ? Number(q.objective_id) : null
  const since = typeof q.since === 'string' && q.since ? q.since : null
  const limit = q.limit ? Number(q.limit) : 100
  const db = getDb()
  let entries = decisionLog(db, { workspace, objective_id: Number.isInteger(objectiveId) ? objectiveId : null, since, limit })
  if (req.user!.role !== 'admin') {
    const cache = new Map<number, boolean>()
    entries = entries.filter(e => {
      if (!cache.has(e.objective_id)) {
        const o = loadObjective(e.objective_id)
        cache.set(e.objective_id, !!o && userOwnsObjective(req.user!.id, o))
      }
      return cache.get(e.objective_id)
    })
  }
  res.json({ entries, count: entries.length })
})

// GET /api/decisions/feedback?workspace= — the questions fed back into briefing prompts.
router.get('/feedback', requireAuth, (req: AuthRequest, res) => {
  if (req.user!.role !== 'admin') {
    res.status(403).json({ error: 'Admins only' })
    return
  }
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null
  res.json({ workspace, questions: recentOwnerQuestions(getDb(), workspace, 20) })
})

/** The queue is a person's own: never an agent key or a worker token. */
function queueViewer(req: DecisionRequest, res: Response): { id: number; role: string } | null {
  if (req.agentKey || !req.user) {
    res.status(403).json({ error: 'The Needs you queue is for a person signed in to the web UI' })
    return null
  }
  return { id: req.user.id, role: req.user.role }
}

function botNames(): Map<string, string> {
  try {
    return new Map(listChatAgents().agents.map(a => [a.slug, a.name]))
  } catch {
    return new Map()
  }
}

// GET /api/decisions/queue — the "Needs you" stack (obj 901084).
router.get('/queue', requireAuth, (req: DecisionRequest, res) => {
  const viewer = queueViewer(req, res)
  if (!viewer) return
  const db = getDb()
  let cleared = 0
  try {
    cleared = sweepStaleDecisions(db).cleared
  } catch (err) {
    console.warn('[decisions] stale sweep failed before the queue read:', err instanceof Error ? err.message : String(err))
  }
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null
  const names = botNames()
  const items = listDecisionQueue(db, viewer, { workspace }).map(i => ({
    ...i,
    card: { ...i.card, bot_name: i.card.bot ? (names.get(i.card.bot) ?? null) : null },
  }))
  res.json({ items, count: items.length, cleared })
})

// GET /api/decisions/queue/count — the top-nav badge.
router.get('/queue/count', requireAuth, (req: DecisionRequest, res) => {
  const viewer = queueViewer(req, res)
  if (!viewer) return
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null
  res.json({ count: decisionQueueCount(getDb(), viewer, { workspace }) })
})

// GET /api/decisions/queue/history — the person's own decided items (obj 901139).
// Each carries its card, so a decided item always leads back to the card thread.
router.get('/queue/history', requireAuth, (req: DecisionRequest, res) => {
  const viewer = queueViewer(req, res)
  if (!viewer) return
  const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : null
  const limit = req.query.limit ? Number(req.query.limit) : 30
  const names = botNames()
  const items = listDecidedHistory(getDb(), viewer, { workspace, limit: Number.isFinite(limit) ? limit : 30 }).map(i => ({
    ...i,
    card: { ...i.card, bot_name: i.card.bot ? (names.get(i.card.bot) ?? null) : null },
  }))
  res.json({ items, count: items.length })
})

function loadForPerson(req: DecisionRequest, res: Response): { decision: NonNullable<ReturnType<typeof getDecision>>; objective: Objective | undefined } | null {
  const id = Number(req.params.id)
  const decision = Number.isInteger(id) ? getDecision(getDb(), id) : null
  if (!decision) {
    res.status(404).json({ error: 'Decision not found' })
    return null
  }
  return { decision, objective: loadObjective(decision.objective_id) }
}

// GET /api/decisions/:id
router.get('/:id', workerOrAuth, (req: DecisionRequest, res) => {
  const got = loadForPerson(req, res)
  if (!got) return
  if (got.objective) {
    const denied = cardAccessError(req, got.objective)
    if (denied) {
      res.status(denied.status).json({ error: denied.error })
      return
    }
  } else if (req.user?.role !== 'admin') {
    res.status(404).json({ error: 'Decision not found' })
    return
  }
  res.json({ decision: withReopenFlag(getDb(), got.decision) })
})

// POST /api/decisions/:id/questions {body}
router.post('/:id/questions', requireAuth, async (req: DecisionRequest, res) => {
  const got = loadForPerson(req, res)
  if (!got) return
  const denied = personError(req, got.objective)
  if (denied) {
    res.status(403).json({ error: denied })
    return
  }
  const db = getDb()
  try {
    const { question, answered } = askAndAnswer(db, got.decision.id, { author: req.user!.username, body: String(req.body?.body ?? '') })
    logActivity({
      project: got.objective?.project || 'operationkit',
      workspace: got.objective?.workspace ?? got.decision.workspace,
      objective_id: got.decision.objective_id,
      event_type: 'decision',
      title: `Question on decision #${got.decision.id}`,
      detail: question.body.slice(0, 500),
      metadata: { kind: 'decision_question', decision_id: got.decision.id, question_id: question.id },
    })
    const settled = answered.then(() => refreshKbLog(got.decision.workspace))
    if (req.query.wait === '1' || req.body?.wait === true) {
      await Promise.race([settled, new Promise(r => setTimeout(r, 60_000).unref?.())])
    } else {
      settled.catch(() => {})
    }
    res.status(201).json({ question, decision: getDecision(db, got.decision.id) })
  } catch (err) {
    fail(res, err)
  }
})

/** The real delivery path, wired to the session layer. */
function liveDeps(userId: number | null = null): ApplyDeps {
  return {
    // obj 901151: a choice on a finished bot card goes to the bot, not a dead end.
    deliverToBot: (db, d, o) => deliverDecisionToBot(db, d, o, { userId }, { notify: notifyBotMessage }),
    consumeDelivery: (db, id, objectiveId) => consumeDelivery(db, id, objectiveId),
    // obj 901453: a deploy / merge answer goes to the bot's chat (the only place it can run).
    deliverToChat: (db, d, action) =>
      deliverDecisionToChat(db, d, action, { userId }, {
        notify: notifyBotMessage,
        botName: slug => listChatAgents().agents.find(a => a.slug === slug)?.name ?? null,
      }),
    getSessionState,
    resolveSessionId: (db, o) => resolveFollowUpSessionId(db, o),
    recordInJsonl: (sid, text, sender, queued) => recordFollowUpInJsonl(sid, text, undefined, sender, queued ? { queued: true } : undefined),
    enqueue: (db, id, sid, text, sender) => { enqueueFollowUp(db, id, sid, text, sender) },
    sendFollowUp: (sid, text, objective, sender) => { sendFollowUp(sid, text, objective, { skipJsonl: true, sender }) },
    audit: (db, o, actor) =>
      logObjectiveAudit(db, {
        objectiveId: o.id,
        eventType: 'status_change',
        fromStatus: o.status,
        toStatus: 'review',
        actor,
        pathway: 'decision-reopen-and-apply',
        sessionId: o.session_id ?? null,
        titleSnapshot: o.title ?? null,
        workspace: o.workspace ?? null,
      }),
    broadcast: o => broadcast({ type: 'objective_updated', payload: mapObjective(o) }),
    noteStart: (id, actor) => noteStartReason(id, 'follow_up', actor, 'decision'),
    defer: fn => setImmediate(fn),
  }
}

let depsOverride: ApplyDeps | null = null
/** Tests: replace the session-layer wiring (null restores it). */
export function __setDecisionApplyDeps(d: ApplyDeps | null): void {
  depsOverride = d
}

// POST /api/decisions/:id/decide {choice, note?, reopen?}
router.post('/:id/decide', requireAuth, (req: DecisionRequest, res) => {
  const got = loadForPerson(req, res)
  if (!got) return
  const denied = personError(req, got.objective)
  if (denied) {
    res.status(403).json({ error: denied })
    return
  }
  const db = getDb()
  const reopen = req.body?.reopen === true
  let decision = got.decision
  try {
    // obj 901084: an ask that outlived its card is cleared, never applied.
    if (decision.state === 'open') {
      const stale = staleReasonForCard(db, decision.objective_id)
      if (stale) {
        sweepStaleDecisions(db, { objectiveId: decision.objective_id, adopt: false })
        res.status(409).json({
          error: `This decision is ${stale}, so nothing was sent and nothing changed.`,
          code: 'decision_stale',
          reason: stale,
          decision: getDecision(db, decision.id),
        })
        return
      }
    }
    if (decision.state === 'decided' && (decision.outcome === 'card_done' || decision.outcome === 'delivered') && reopen) {
      // obj 901151: the bot already acted on it (checked first: the next run that
      // picked it up is also what makes the ask "replaced by a newer run").
      if (decision.outcome === 'delivered' && deliveryConsumed(db, decision.id)) {
        res.status(409).json({
          error: 'The bot already picked this answer up in a later session, so the card was not reopened.',
          code: 'decision_delivered',
          decision: withReopenFlag(db, decision),
        })
        return
      }
      // obj 901084: never reopen a card for an ask that has since gone stale.
      const stale = staleReasonForCard(db, decision.objective_id)
      if (stale) {
        res.status(409).json({
          error: `This decision is ${stale}, so the card was not reopened and nothing was sent.`,
          code: 'decision_stale',
          reason: stale,
          decision: withReopenFlag(db, decision),
        })
        return
      }
      // "Reopen and apply" on a choice already recorded against a done card.
    } else {
      const choice = resolveChoice(decision, req.body?.choice)
      if (!choice) {
        const valid = decision.incomplete ? ['approve', 'deny', OWN_ANSWER_CHOICE] : [...decision.briefing.options.map(o => o.key), 'deny', OWN_ANSWER_CHOICE]
        res.status(400).json({ error: `Pick one of: ${valid.join(', ')}`, valid_choices: valid })
        return
      }
      const note = typeof req.body?.answer === 'string' && req.body.answer.trim()
        ? req.body.answer
        : typeof req.body?.note === 'string' ? req.body.note : null
      if (choice === OWN_ANSWER_CHOICE && !note?.trim()) {
        res.status(400).json({ error: 'Write your answer: an own answer needs text (answer).', code: 'answer_required' })
        return
      }
      decision = recordChoice(db, decision.id, { choice, by: req.user!.username, note })
    }
    const applied = applyDecision(db, decision, { sender: senderFromRequest(req), actor: req.user!.username, reopen }, depsOverride ?? liveDeps(req.user!.id))
    logActivity({
      project: got.objective?.project || 'operationkit',
      workspace: got.objective?.workspace ?? decision.workspace,
      objective_id: decision.objective_id,
      event_type: 'decision',
      title: applied.outcome_text.slice(0, 200),
      metadata: { kind: 'decision_decided', decision_id: decision.id, chosen: decision.chosen, outcome: applied.outcome, by: req.user!.username },
    })
    refreshKbLog(decision.workspace)
    res.json({
      decision: withReopenFlag(db, applied.decision),
      outcome: applied.outcome,
      outcome_text: applied.outcome_text,
      can_reopen: applied.outcome === 'card_done' || applied.outcome === 'delivered',
      objective: applied.objective ? mapObjective(applied.objective) : null,
    })
  } catch (err) {
    fail(res, err)
  }
})

export default router
