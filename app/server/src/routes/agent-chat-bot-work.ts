/**
 * Bot visibility (obj 900947) — mounted under /api/agent-chat
 *
 *   GET /bot-status                       every bot's sidebar line + status dot, and
 *                                         "Needs you" across all bots
 *   GET /agents/:slug/work                the bot's Work tab: Running / In review /
 *                                         Queued / Recently done, spend vs ceiling, PR
 *   GET /agents/:slug/activity            High Agency Activity feed: daily summary +
 *                                         one entry per wake (?limit=, default 30)
 *   GET /agents/:slug/activity/:wakeId    one wake expanded into the full run
 *
 * READ-ONLY. Nothing here writes a card, a ceiling or an approval.
 *
 * SCOPE. Every view covers the caller's workspaces (an admin: all of them)
 * narrowed to the workspaces the bot is GRANTED (bot-workspaces.ts), and inside
 * those a member sees only the cards the board list shows them: every card
 * where their membership is objective_visibility = 'all', else only cards they
 * are assigned to, created, or are an assignee on. A wake the caller may not
 * see is a 404 — the same answer as a wake that does not exist, so the route
 * is not an existence oracle.
 *
 * An agent API key gets 403: these are a person's views in the Bots page.
 */
import { Router, type Response } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { findAgent, listAgents } from '../services/agent-chat/engine.js'
import { buildBotActivity, buildBotActivityRun, buildBotStatus, buildBotWork, type BotViewer } from '../services/agent-chat/bot-work.js'

const router: Router = Router()

/** The signed-in person; bot-work.ts turns this into their board visibility. */
export function viewerOf(req: AuthRequest): BotViewer {
  return { id: req.user!.id, role: req.user!.role }
}

function refuseApiKey(req: AuthRequest, res: Response): boolean {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'A bot\'s work and activity are read in the Bots page by a signed-in person.' })
    return true
  }
  return false
}

function botOr404(req: AuthRequest, res: Response): { slug: string; name: string } | null {
  const a = findAgent(String(req.params.slug))
  if (!a) {
    res.status(404).json({ error: `No bot "${req.params.slug}" on this install` })
    return null
  }
  return { slug: a.slug, name: a.name }
}

function failed(res: Response, what: string, err: unknown): void {
  console.error(`[agent-chat] ${what} failed:`, err instanceof Error ? err.message : err)
  res.status(500).json({ error: 'That did not load. Try again.' })
}

router.get('/bot-status', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  try {
    const bots = listAgents().agents.map(a => ({ slug: a.slug, name: a.name }))
    res.json(buildBotStatus(getDb(), bots, { viewer: viewerOf(req) }))
  } catch (err) {
    failed(res, 'bot status', err)
  }
})

router.get('/agents/:slug/work', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  const bot = botOr404(req, res)
  if (!bot) return
  try {
    res.json(buildBotWork(getDb(), bot, { viewer: viewerOf(req) }))
  } catch (err) {
    failed(res, 'bot work', err)
  }
})

router.get('/agents/:slug/activity', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  const bot = botOr404(req, res)
  if (!bot) return
  try {
    res.json(buildBotActivity(getDb(), bot, { viewer: viewerOf(req), limit: Number(req.query.limit) || 30 }))
  } catch (err) {
    failed(res, 'bot activity', err)
  }
})

router.get('/agents/:slug/activity/:wakeId', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  const bot = botOr404(req, res)
  if (!bot) return
  const wakeId = Number(req.params.wakeId)
  if (!Number.isInteger(wakeId) || wakeId <= 0) {
    res.status(400).json({ error: 'wakeId must be a card id' })
    return
  }
  try {
    const run = buildBotActivityRun(getDb(), bot, wakeId, { viewer: viewerOf(req) })
    if (!run) {
      res.status(404).json({ error: 'No such wake for this bot' })
      return
    }
    res.json({ run })
  } catch (err) {
    failed(res, 'bot activity run', err)
  }
})

export default router
