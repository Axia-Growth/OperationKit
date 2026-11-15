/**
 * Board ownership routes on /api/objectives (obj 900869).
 *
 *   GET  /:id/bot-approval   — may a bot approve this card? (eligibility only)
 *   POST /:id/bot-approve    — a bot approves an ELIGIBLE Needs You card
 *   POST /:id/claim          — a bot claims a card (owner_bot := that bot)
 *
 * The approval rules live in services/bot-approval.ts; grants are the existing
 * delegation grants (obj 900839) — nothing here creates or widens one.
 */
import type { Router, Response } from 'express'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import type { Objective } from '@operationkit/shared'
import { botApprovalEligibility, type ApprovalCard } from '../services/bot-approval.js'
import { writeDelegationAudit } from '../services/delegated-approvals.js'
import { resolveBot } from '../services/bots/bot-registry.js'
import { logObjectiveAudit } from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from './feed.js'
import { mapObjective, requireOwnership } from './objectives-helpers.js'
import { runStatusChange } from './objectives-status.js'

function loadCard(id: string): (Objective & ApprovalCard) | undefined {
  return getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(id) as (Objective & ApprovalCard) | undefined
}

function isBotKey(req: AuthRequest): boolean {
  return !!req.agentKey && req.authVia === 'agent_api_key' && !!req.user
}

function requireBotKey(req: AuthRequest, res: Response): boolean {
  if (isBotKey(req)) return true
  res.status(403).json({
    error: 'This route is for a bot on a named agent key. A person approves a card with the Approve button (or bulk triage on Needs You).',
    code: 'requires_bot_key',
  })
  return false
}

export function registerObjectiveOwnershipRoutes(router: Router): void {
  /**
   * Eligibility preview. A bot (agent key) asks about itself; a signed-in person
   * may ask about a named bot (`?bot=`) as if that person had issued the key.
   */
  router.get('/:id/bot-approval', (req: AuthRequest, res) => {
    const card = loadCard(String(req.params.id))
    if (!card) { res.status(404).json({ error: 'Objective not found' }); return }
    const own = requireOwnership(req, card)
    if (own) { res.status(403).json({ error: own }); return }
    const declared = req.query.bot ?? req.query.owner_bot ?? req.agentKey?.label
    if (declared === undefined || declared === '') {
      res.status(400).json({ error: 'Name the bot: ?bot=<bot name>' })
      return
    }
    const db = getDb()
    res.json(botApprovalEligibility(db, {
      card,
      declaredBot: declared,
      keyOwnerUserId: req.user?.id ?? null,
      keyWorkspaces: req.agentKey?.workspaces ?? null,
    }))
  })

  router.post('/:id/bot-approve', async (req: AuthRequest, res) => {
    if (!requireBotKey(req, res)) return
    const card = loadCard(String(req.params.id))
    if (!card) { res.status(404).json({ error: 'Objective not found' }); return }
    const own = requireOwnership(req, card)
    if (own) { res.status(403).json({ error: own }); return }

    const db = getDb()
    const key = req.agentKey!
    const declared = (req.body as { owner_bot?: unknown } | undefined)?.owner_bot ?? key.label
    const elig = botApprovalEligibility(db, {
      card,
      declaredBot: declared,
      keyOwnerUserId: req.user!.id,
      keyWorkspaces: key.workspaces ?? null,
    })
    if (!elig.eligible) {
      try {
        writeDelegationAudit(db, {
          event: 'approval_denied',
          objective_id: card.id,
          workspace: card.workspace ?? null,
          bot_name: elig.bot,
          action: `card_${elig.need}`,
          actor: req.user!.username,
          agent_key_id: key.id,
          agent_key_label: key.label,
          reason: elig.refusal ?? 'ineligible',
        })
      } catch (err) {
        console.warn('[bot-approve] audit write failed:', (err as Error).message)
      }
      res.status(403).json({ error: elig.reason, code: elig.refusal, eligibility: elig })
      return
    }

    const result = await runStatusChange(req, card.id, 'done', {
      actor: `bot:${elig.bot} (key ${key.label})`,
      pathway: `bot-approve:${elig.basis}`,
      humanTerminal: false,
    })
    if (result.code !== 200) {
      // A completion gate (floor / CI-green …) refused. The card did not move.
      res.status(result.code).json({ ...(result.body as object), eligibility: elig })
      return
    }

    const line = elig.basis === 'grant'
      ? `Approved by ${elig.bot} under merge grant #${elig.grant_id} (Needs You → Done)`
      : `Closed by ${elig.bot}: its own work, AI review passed, nothing gated pending (Needs You → Done)`
    try {
      writeDelegationAudit(db, {
        event: 'approval_used',
        grant_id: elig.grant_id ?? null,
        objective_id: card.id,
        workspace: card.workspace ?? null,
        bot_name: elig.bot,
        action: `card_${elig.need}`,
        actor: req.user!.username,
        agent_key_id: key.id,
        agent_key_label: key.label,
        reason: elig.basis ?? null,
      })
      logActivity({
        project: card.project || 'operationkit',
        workspace: card.workspace ?? undefined,
        objective_id: card.id,
        event_type: 'decision',
        title: line,
        detail: elig.reason,
        metadata: { kind: 'bot_approval', basis: elig.basis, grant_id: elig.grant_id ?? null, bot: elig.bot, agent_key_id: key.id, agent_key_label: key.label },
      })
    } catch (err) {
      console.warn('[bot-approve] audit/card line failed:', (err as Error).message)
    }
    res.json({ approved: true, line, eligibility: elig, objective: result.body })
  })

  /**
   * A bot claims a card: from now on the card shows that bot as its owner while
   * it works. A Needs You card stays the human's until it leaves Needs You —
   * claiming is not approving.
   */
  router.post('/:id/claim', (req: AuthRequest, res) => {
    if (!requireBotKey(req, res)) return
    const card = loadCard(String(req.params.id))
    if (!card) { res.status(404).json({ error: 'Objective not found' }); return }
    const own = requireOwnership(req, card)
    if (own) { res.status(403).json({ error: own }); return }
    if (card.status === 'done' || card.status === 'cancelled') {
      res.status(409).json({ error: `Card #${card.id} is ${card.status}; there is nothing to claim.` })
      return
    }
    const db = getDb()
    const declared = (req.body as { owner_bot?: unknown } | undefined)?.owner_bot ?? req.agentKey!.label
    const bot = resolveBot(declared, db)
    if (!bot.ok) { res.status(400).json({ error: bot.error, known_bots: bot.known }); return }
    const before = card.owner_bot ?? null
    if (before !== bot.bot.id) {
      db.prepare("UPDATE objectives SET owner_bot = ?, updated_at = datetime('now') WHERE id = ?").run(bot.bot.id, card.id)
      logObjectiveAudit(db, {
        objectiveId: card.id,
        eventType: 'owner_change',
        fromStatus: card.status,
        toStatus: card.status,
        actor: `bot:${bot.bot.id} (key ${req.agentKey!.label})`,
        pathway: `owner-claim:${before ?? 'none'}->${bot.bot.id}`,
        sessionId: card.session_id,
        titleSnapshot: card.title,
        workspace: card.workspace,
      })
    }
    const updated = mapObjective(db.prepare('SELECT * FROM objectives WHERE id = ?').get(card.id) as Objective)
    broadcast({ type: 'objective_updated', payload: updated })
    res.json(updated)
  })
}
