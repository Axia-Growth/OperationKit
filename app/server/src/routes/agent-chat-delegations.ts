/**
 * "Approve on my behalf" grants for a bot (obj 900839), on the bot's settings
 * page: Settings → Bots → <bot>.
 *
 *   GET    /api/agent-chat/agents/:slug/delegations       admin: list + options
 *   POST   /api/agent-chat/agents/:slug/delegations       owner: issue a grant
 *   DELETE /api/agent-chat/agents/:slug/delegations/:id   owner: revoke
 *
 * Issuing and revoking are the OWNER's browser click only: an admin signed in
 * with the httpOnly cookie. An agent key, a legacy API key and a Bearer JWT
 * are all refused, so a bot can never grant, widen or extend its own
 * approvals — and there is deliberately no update route: a grant cannot be
 * extended, only revoked and re-issued.
 *
 * The grant is issued for the REGISTRY bot this chat bot speaks as
 * (services/bots/bot-registry.ts), because that is the name a bot puts on the
 * approval message. A chat bot with no registry identity cannot hold a grant.
 */
import { Router, type Response } from 'express'
import type { DelegationGrantsResponse } from '@operationkit/shared'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { findAgent } from '../services/agent-chat/engine.js'
import type { ChatAgent } from '../services/agent-chat/agent-defs.js'
import { botForAgentSlug, resolveBot, type BotDefinition } from '../services/bots/bot-registry.js'
import { listWorkspaces } from '../services/workspaces.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  createGrant,
  DelegationError,
  listGrantsForBot,
  revokeGrant,
} from '../services/delegated-approvals.js'
import { logActivity } from './feed.js'

const router: Router = Router()

/** The signed-in owner, in the browser. Everything else is refused. */
export function isOwnerBrowserSession(req: AuthRequest): boolean {
  return (
    req.user?.role === 'admin' &&
    req.authVia === 'session' &&
    !req.agentKey &&
    authenticatedViaCookie(req)
  )
}

function ownerOr403(req: AuthRequest, res: Response): boolean {
  if (isOwnerBrowserSession(req)) return true
  res.status(403).json({
    error: 'Only the owner, signed in to Command Center in the browser, can issue or revoke an approval grant. A bot or an API key can never grant itself approvals.',
    code: 'owner_only',
  })
  return false
}

function agentOr404(req: AuthRequest, res: Response): ChatAgent | null {
  const a = findAgent(String(req.params.slug))
  if (!a) res.status(404).json({ error: `No agent "${req.params.slug}" on this install` })
  return a
}

/** The registry bot a chat bot speaks as: its slug first, then its names. */
export function registryBotFor(a: Pick<ChatAgent, 'slug' | 'name' | 'file_name'>): BotDefinition | null {
  const db = getDb()
  const bySlug = botForAgentSlug(a.slug, db)
  if (bySlug) return bySlug
  for (const name of [a.name, a.file_name]) {
    if (!name) continue
    const r = resolveBot(name, db)
    if (r.ok) return r.bot
  }
  return null
}

function workspaceOptions(): { slug: string; name: string }[] {
  try {
    return listWorkspaces().map(w => ({ slug: w.slug, name: w.name }))
  } catch {
    return []
  }
}

function payload(req: AuthRequest, a: ChatAgent): DelegationGrantsResponse {
  const bot = registryBotFor(a)
  if (!bot) {
    return {
      bot: null,
      bot_unavailable_reason: `${a.name} is not in the bot registry, so its messages cannot be matched to a grant. Add it to the registry (settings.bot_registry or settings.bot_agent_slugs) first.`,
      workspace_options: [],
      grants: [],
      can_manage: false,
    }
  }
  return {
    bot: { id: bot.id, name: bot.name },
    workspace_options: workspaceOptions(),
    grants: listGrantsForBot(getDb(), bot.id),
    can_manage: isOwnerBrowserSession(req),
  }
}

function delegationError(res: Response, err: unknown): boolean {
  if (err instanceof DelegationError) {
    res.status(err.status).json({ error: err.message, code: err.code })
    return true
  }
  return false
}

router.get('/agents/:slug/delegations', (req: AuthRequest, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ error: 'Only the owner can see approval grants.', code: 'owner_only' })
    return
  }
  const a = agentOr404(req, res)
  if (!a) return
  res.json(payload(req, a))
})

router.post('/agents/:slug/delegations', (req: AuthRequest, res) => {
  if (!ownerOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const bot = registryBotFor(a)
  if (!bot) {
    res.status(409).json({ error: `${a.name} is not in the bot registry, so it cannot hold a grant.`, code: 'bot_not_registered' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  try {
    const grant = createGrant(getDb(), {
      grantor: { id: req.user!.id, username: req.user!.username },
      botName: bot.id,
      agentSlug: a.slug,
      workspace: body.workspace,
      actions: body.actions,
      expiresAt: body.expires_at,
      allowedWorkspaces: workspaceOptions().map(w => w.slug),
    })
    try {
      logActivity({
        project: 'operationkit',
        workspace: grant.workspace,
        event_type: 'decision',
        title: `${req.user!.username} let ${bot.name} approve ${grant.actions.join(', ')} in ${grant.workspace} on their behalf (grant #${grant.id})`,
        detail: `Expires ${grant.expires_at} UTC`,
        metadata: { kind: 'delegation_grant_created', grant_id: grant.id, bot: bot.id, slug: a.slug, actions: grant.actions, actor: req.user!.username },
      })
    } catch { /* the activity feed is best-effort; the audit table already has it */ }
    res.status(201).json({ ...payload(req, a), created: grant })
  } catch (err) {
    if (delegationError(res, err)) return
    throw err
  }
})

router.delete('/agents/:slug/delegations/:id', (req: AuthRequest, res) => {
  if (!ownerOr403(req, res)) return
  const a = agentOr404(req, res)
  if (!a) return
  const bot = registryBotFor(a)
  const id = Number(req.params.id)
  if (!bot || !Number.isInteger(id) || id <= 0) {
    res.status(404).json({ error: 'No such grant for this bot.', code: 'grant_not_found' })
    return
  }
  try {
    const r = revokeGrant(getDb(), id, bot.id, req.user!.username)
    if (r.changed) {
      try {
        logActivity({
          project: 'operationkit',
          workspace: r.grant.workspace,
          event_type: 'decision',
          title: `${req.user!.username} revoked grant #${id} (${bot.name} approving on their behalf in ${r.grant.workspace})`,
          metadata: { kind: 'delegation_grant_revoked', grant_id: id, bot: bot.id, slug: a.slug, actor: req.user!.username },
        })
      } catch { /* best-effort */ }
    }
    res.json({ ...payload(req, a), revoked: r.grant })
  } catch (err) {
    if (delegationError(res, err)) return
    throw err
  }
})

export default router
