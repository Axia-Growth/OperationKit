/**
 * Bot-to-bot threads in the Bots UI (obj 900859) — mounted under /api/agent-chat
 *
 *   GET /bot-conversations              conversations the caller may see (?bot=<slug>&limit=)
 *   GET /bot-conversations/:id          one conversation with every entry on it
 *
 * READ-ONLY for people: bots write these threads (message_bot + the wake), a
 * person reads them. Visibility follows the tenant boundary, the workspace:
 *
 *   admin (signed in)   → every workspace
 *   member              → conversations in workspaces they belong to
 *   agent API key       → 403 (a bot's threads are not a remote-agent surface)
 *
 * A conversation outside the caller's workspaces is a 404 — identical to one
 * that does not exist, so the route is not an existence oracle.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { getDb } from '../db/index.js'
import { conversationInScope, conversationMessages, listConversations, type BotMessage } from '../services/agent-chat/bot-messaging.js'

const router: Router = Router()

/** null = every workspace (admin); else exactly the caller's own. */
function callerScope(req: AuthRequest): string[] | null {
  if (req.user?.role === 'admin') return null
  return getUserWorkspaces(req.user!.id).map(w => w.workspace)
}

function refuseApiKey(req: AuthRequest, res: import('express').Response): boolean {
  if (req.authVia === 'agent_api_key') {
    res.status(403).json({ error: 'Bot conversations are read in the Bots page by a signed-in person.' })
    return true
  }
  return false
}

const SLUG_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/i

router.get('/bot-conversations', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  const bot = typeof req.query.bot === 'string' && req.query.bot ? req.query.bot : undefined
  if (bot !== undefined && !SLUG_RE.test(bot)) {
    res.status(400).json({ error: 'bot must be a bot slug' })
    return
  }
  const conversations = listConversations({ workspaces: callerScope(req), bot, limit: Number(req.query.limit) || 50 })
  res.json({ conversations })
})

/** The person a message was sent for, by name — only ever for rows the caller may already read. */
function usernames(ids: number[]): Map<number, string> {
  if (ids.length === 0) return new Map()
  const rows = getDb()
    .prepare(`SELECT id, username FROM users WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .all(...ids) as { id: number; username: string }[]
  return new Map(rows.map(r => [r.id, r.username]))
}

function publicEntry(m: BotMessage, names: Map<number, string>) {
  return {
    id: m.id,
    kind: m.kind,
    from_slug: m.from_slug,
    to_slug: m.to_slug,
    body: m.body,
    tool_name: m.tool_name,
    depth: m.depth,
    in_reply_to: m.in_reply_to,
    sent_for: m.sent_by_user_id != null ? names.get(m.sent_by_user_id) ?? null : null,
    status: m.status,
    attempts: m.attempts,
    next_attempt_at: m.status === 'pending' ? m.next_attempt_at : null,
    last_error: m.last_error,
    provider: m.provider,
    model: m.model,
    ok: m.kind === 'tool' ? m.meta?.ok !== false : undefined,
    created_at: m.created_at,
    delivered_at: m.delivered_at,
  }
}

router.get('/bot-conversations/:id', (req: AuthRequest, res) => {
  if (refuseApiKey(req, res)) return
  const c = conversationInScope(Math.trunc(Number(req.params.id)), callerScope(req))
  if (!c) {
    res.status(404).json({ error: 'Bot conversation not found' })
    return
  }
  const messages = conversationMessages(c, { limit: Number(req.query.limit) || 300 })
  const names = usernames([...new Set(messages.map(m => m.sent_by_user_id).filter((x): x is number => x != null))])
  res.json({ conversation: c, messages: messages.map(m => publicEntry(m, names)) })
})

export default router
