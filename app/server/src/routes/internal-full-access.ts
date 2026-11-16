/**
 * Full access for a CARD SESSION (obj 900972) — the High Agency wake path.
 *
 * A bot's chat turn gets its Full access tools in-process
 * (services/agent-chat/full-access-tools.ts). A card the bot works — a High
 * Agency wake, or a card it filed — is a session on the internal API instead,
 * so these two routes are how that session learns whether it carries Full
 * access and does the one thing the card API has no route for:
 *
 *   GET  /api/internal/full-access                       does this card carry Full access, and which exclusions are on
 *   POST /api/internal/full-access/cards/:id/take-over   become the worker and owner of a card in the same workspace
 *
 * Both need the card's own session token (`X-CC-Session-Token`): the caller is
 * derived from it, never from the body. The card carries Full access only when
 * it is worked by a bot (agent_context = the bot's slug) that has Full access
 * in the card's workspace, the card runs for an install admin, and it provably
 * came from an admin or the bot's own High Agency schedule
 * (`cardSessionFullAccess`). A card that carries a protected pull request is
 * refused (`protectedCardRefusal`). Messaging and restarting other cards use the
 * existing /message and /status routes; /message accepts the same relation
 * (routes/internal-hermes.ts). Every use and every refusal is audit-logged.
 */
import type { Router } from 'express'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import { sessionTokenFromHeaders, verifySessionToken } from '../lib/session-trust.js'
import { cardSessionFullAccess, fullAccessActive, getFullAccess, protectedCardRefusal, writeFullAccessAudit } from '../services/agent-chat/bot-full-access.js'
import { botOwnershipRefusal, ownerBotName } from '../services/agent-chat/full-access-tools.js'
import { findAgent } from '../services/agent-chat/engine.js'
import { broadcast } from '../ws/index.js'
import { logActivity } from './feed.js'

interface CallerCard { id: number; workspace: string; agent_context: string | null }

/** The calling card, from its session token. null = no valid token. */
function callerCard(headers: Record<string, string | string[] | undefined>): CallerCard | null {
  let claims = null
  try { claims = verifySessionToken(sessionTokenFromHeaders(headers)) } catch { claims = null }
  if (!claims) return null
  const row = getDb().prepare('SELECT id, workspace, agent_context FROM objectives WHERE id = ? AND deleted_at IS NULL').get(claims.objectiveId) as CallerCard | undefined
  return row ?? null
}

export function registerInternalFullAccessRoutes(router: Router): void {
  router.get('/full-access', (req, res) => {
    const card = callerCard(req.headers)
    if (!card) {
      res.status(401).json({ error: 'Send this card\'s session token: -H "X-CC-Session-Token: $CC_SESSION_TOKEN".' })
      return
    }
    const slug = cardSessionFullAccess(card.id, card.workspace)
    if (!slug) {
      res.json({ card: card.id, workspace: card.workspace, bot: card.agent_context, full_access: false })
      return
    }
    const a = getFullAccess(slug, card.workspace)
    res.json({
      card: card.id,
      workspace: card.workspace,
      bot: slug,
      full_access: true,
      expires_at: a.expires_at,
      billing_switched_on: a.allow.billing,
      never_allowed: ['secret_values', 'keys', 'dns_access'],
      note: 'Full access covers this workspace only. Secrets, keys and DNS / Cloudflare Access are never part of it; billing only when switched on. A card that carries a protected pull request is out of reach. It never approves a merge, a prod migration or a deploy.',
    })
  })

  router.post('/full-access/cards/:id/take-over', (req, res) => {
    const from = callerCard(req.headers)
    if (!from) {
      res.status(401).json({ error: 'Send this card\'s session token: -H "X-CC-Session-Token: $CC_SESSION_TOKEN".' })
      return
    }
    const db = getDb()
    const id = Number(req.params.id)
    const target = Number.isInteger(id) && id > 0
      ? (db.prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as Objective | undefined)
      : undefined
    const slug = target ? cardSessionFullAccess(from.id, target.workspace) : null
    if (!target || !slug) {
      // Same answer for a missing card and one out of reach.
      if (from.agent_context) {
        writeFullAccessAudit({
          event: 'ability_refused', slug: from.agent_context, workspace: from.workspace, actor: `bot:${from.agent_context}`,
          ability: 'card_take_over', objective_id: Number.isInteger(id) ? id : null,
          detail: fullAccessActive(from.agent_context, from.workspace) ? `card #${from.id}: the target is not in its workspace, or this card was not filed by an admin or the bot's own wake` : `card #${from.id} carries no Full access`,
        })
      }
      res.status(403).json({ error: `Card #${req.params.id} is not in a workspace where this card's bot has Full access.` })
      return
    }
    const protectedRefusal = protectedCardRefusal({ slug, workspace: target.workspace, ability: 'card_take_over', card: target, detail: `card #${from.id} tried to take over card #${target.id}, which carries a protected pull request` })
    if (protectedRefusal) {
      res.status(403).json({ error: protectedRefusal, code: 'protected_pr' })
      return
    }
    const poolError = botOwnershipRefusal(slug, target.workspace, target.project ?? null)
    if (poolError) {
      res.status(400).json({ error: poolError })
      return
    }
    const agent = findAgent(slug)
    const owner = ownerBotName(agent ?? { slug, name: slug })
    db.prepare("UPDATE objectives SET agent_context = ?, owner_bot = ?, updated_at = datetime('now') WHERE id = ?").run(slug, owner, target.id)
    const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(target.id) as Objective
    try { broadcast({ type: 'objective_updated', payload: updated }) } catch { /* no WS server in tests */ }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : ''
    const detail = `card #${from.id} took over card #${target.id} from ${target.agent_context || 'nobody'}${note ? ` — ${note}` : ''}`
    writeFullAccessAudit({ event: 'ability_used', slug, workspace: target.workspace, actor: `bot:${slug}`, ability: 'card_take_over', objective_id: target.id, detail })
    try {
      logActivity({
        project: 'operationkit', workspace: target.workspace, objective_id: target.id, event_type: 'decision',
        title: `${agent?.name ?? slug} (Full access): ${detail}`.slice(0, 200), detail: null,
        metadata: { kind: 'bot_full_access_used', slug, ability: 'card_take_over', workspace: target.workspace, from_objective_id: from.id },
      })
    } catch { /* the activity feed is best-effort */ }
    res.json({ id: target.id, agent_context: slug, owner_bot: owner, previous_agent: target.agent_context ?? null })
  })
}
