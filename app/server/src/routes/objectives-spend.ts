/**
 * Card spend panel routes (obj 900909, systems audit #10).
 *
 *   GET /api/objectives/:id/spend
 *     The card's cost ceiling (explicit, or the per-effort default), measured
 *     spend so far, burn rate and projection, the guard stage and its last
 *     action, and why the last start was refused. Anyone who can read the card.
 *
 *   PUT /api/objectives/:id/spend
 *     `{ cost_usd?: number, degrade_allowed?: boolean }`. Sets an explicit cost
 *     ceiling for THIS card and/or whether the guard may move it to a cheaper
 *     tier. A ceiling is a spend decision, so only a person signed in to the web
 *     UI (httpOnly cookie) who is an admin or the card's owner may change it —
 *     never an agent key, a Bearer JWT or a session token.
 */
import type { Response, Router } from 'express'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import { canReadObjective, mapObjective, requireOwnership } from './objectives-helpers.js'
import { applySpendSettings, buildSpendGuardView } from '../services/spend-guard.js'
import { computeLiveObjectiveSpend } from '../services/session-usage.js'
import { isFiniteCeiling } from '../services/job-accounting.js'
import { broadcast } from '../ws/index.js'

/** Largest ceiling the card panel accepts — a typo guard, not a policy. */
export const MAX_CARD_CEILING_USD = 100_000

function loadReadable(req: AuthRequest, res: Response): Objective | null {
  const objective = getDb().prepare('SELECT * FROM objectives WHERE id = ?').get(req.params.id) as Objective | undefined
  if (!objective || !canReadObjective(req, objective)) {
    res.status(404).json({ error: 'Objective not found' })
    return null
  }
  return objective
}

function measure(objective: Objective): () => number {
  return () => computeLiveObjectiveSpend(objective.id, objective.session_id ? [objective.session_id] : [])
}

export function registerObjectiveSpendRoutes(router: Router): void {
  router.get('/:id/spend', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    res.json(buildSpendGuardView(getDb(), objective, measure(objective)))
  })

  router.put('/:id/spend', (req: AuthRequest, res) => {
    const objective = loadReadable(req, res)
    if (!objective) return
    if (req.agentKey || !authenticatedViaCookie(req) || !req.user) {
      res.status(403).json({ error: 'Only a person signed in to the web app can change a card\'s spend ceiling' })
      return
    }
    const ownershipError = requireOwnership(req, objective)
    if (ownershipError) {
      res.status(403).json({ error: 'Only the card\'s owner or an admin can change its spend ceiling' })
      return
    }
    const body = (req.body ?? {}) as Record<string, unknown>
    const unknown = Object.keys(body).filter(k => k !== 'cost_usd' && k !== 'degrade_allowed')
    if (unknown.length) {
      res.status(400).json({ error: `unsupported field(s): ${unknown.join(', ')}`, supported: ['cost_usd', 'degrade_allowed'] })
      return
    }
    let costUsd: number | undefined
    if (body.cost_usd !== undefined) {
      const n = typeof body.cost_usd === 'string' ? Number(body.cost_usd) : body.cost_usd
      if (!isFiniteCeiling(n) || n > MAX_CARD_CEILING_USD) {
        res.status(400).json({ error: `cost_usd must be a number above 0 and at most ${MAX_CARD_CEILING_USD}` })
        return
      }
      costUsd = Math.round(n * 100) / 100
    }
    let degradeAllowed: boolean | undefined
    if (body.degrade_allowed !== undefined) {
      if (typeof body.degrade_allowed !== 'boolean') {
        res.status(400).json({ error: 'degrade_allowed must be true or false' })
        return
      }
      degradeAllowed = body.degrade_allowed
    }
    if (costUsd === undefined && degradeAllowed === undefined) {
      res.status(400).json({ error: 'Nothing to change: send cost_usd and/or degrade_allowed' })
      return
    }
    const db = getDb()
    applySpendSettings(db, objective, { costUsd, degradeAllowed }, req.user.username || `user ${req.user.id}`)
    const row = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective.id) as Objective
    try { broadcast({ type: 'objective_updated', payload: mapObjective(row) }) } catch { /* board refresh is best effort */ }
    res.json(buildSpendGuardView(db, row, measure(row)))
  })
}
