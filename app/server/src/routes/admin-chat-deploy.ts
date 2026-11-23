/**
 * Deploy on your word — the owner's switch and the last chat deploy (obj 901393).
 * Mounted under /api/admin, so the admin.ts facade already applies requireAuth +
 * requireAdmin (admin role only; agent keys are rejected).
 *
 *   GET /api/admin/chat-deploy → { enabled, can_manage, bots, last }
 *   PUT /api/admin/chat-deploy { enabled } → owner signed in in the browser ONLY
 *       (isOwnerBrowserSession: admin + session cookie, no agent key / bearer).
 *
 * Switching it on deploys nothing: it only lets the chat tool act when the owner
 * asks for a deploy in chat. Off by default.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { chatDeployBots, isChatDeployEnabled, lastChatDeploy, setChatDeployEnabled } from '../services/chat-deploy.js'
import { isOwnerBrowserSession } from './agent-chat-delegations.js'
import { logActivity } from './feed.js'

const router = Router()

router.get('/chat-deploy', (req: AuthRequest, res) => {
  const db = getDb()
  res.json({
    enabled: isChatDeployEnabled(db),
    can_manage: isOwnerBrowserSession(req),
    bots: chatDeployBots(db),
    last: lastChatDeploy(db),
  })
})

router.put('/chat-deploy', (req: AuthRequest, res) => {
  if (!isOwnerBrowserSession(req)) {
    res.status(403).json({ error: 'Only the owner, signed in in the browser, can switch deploy on your word on or off.', code: 'owner_only' })
    return
  }
  const enabled = req.body?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'enabled must be true or false' })
    return
  }
  const db = getDb()
  setChatDeployEnabled(db, enabled)
  try {
    logActivity({
      project: 'operationkit',
      event_type: 'decision',
      title: 'chat_deploy_setting',
      detail: `Deploy on your word switched ${enabled ? 'ON' : 'OFF'} by ${req.user?.username ?? 'unknown'}.`,
      metadata: { kind: 'chat_deploy_setting', enabled, user_id: req.user?.id ?? null },
    })
  } catch {
    /* the setting is written; the feed line is best-effort */
  }
  console.log(`[chat-deploy] switched ${enabled ? 'ON' : 'OFF'} by ${req.user?.username ?? 'unknown'}`)
  res.json({ enabled: isChatDeployEnabled(db), can_manage: true, bots: chatDeployBots(db), last: lastChatDeploy(db) })
})

export default router
