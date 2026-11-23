// ── "Deploy on your word": post the outcome back into the chat (obj 901393) ──
//
// A backend deploy restarts the server, so the chat turn that started it can
// only say "deploying PRs X, Y; I will post the result here". This reconciler
// keeps that promise: on boot and every 10 s (host only) it settles every
// started chat deploy whose script has finished (services/chat-deploy.ts →
// settleChatDeploys), then posts the outcome — live, rolled back and why, or
// failed and why — into the SAME chat thread the owner asked in, and writes a
// card line "Deployed by <bot> on <owner>'s word" on every card the deploy made
// live. Each outcome is posted once (`chat_deploys.reported_at`).
import type { Database } from 'better-sqlite3'
import { getDb } from '../../db/index.js'
import { logActivity } from '../../routes/feed.js'
import { markReported, outcomeLine, settleChatDeploys, unreportedChatDeploys, type ChatDeployRow } from '../chat-deploy.js'
import { addMessage } from './engine.js'
import { notifyBotMessage } from './sidebar-live.js'
import { getThread, MAIN_LANE, touchThread, type ChatLane } from './threads.js'

function laneFor(row: ChatDeployRow): ChatLane {
  if (row.thread_id == null) return MAIN_LANE
  try {
    return getThread(row.user_id, row.agent_slug, row.thread_id) ? { kind: 'thread', id: row.thread_id } : MAIN_LANE
  } catch {
    return MAIN_LANE
  }
}

/** One line on each card the deploy made live. */
export function writeDeployCardLines(db: Database, row: ChatDeployRow): number {
  let n = 0
  const bot = row.bot_name || row.agent_slug
  const seen = new Set<number>()
  for (const pr of row.prs) {
    if (pr.card_id == null || seen.has(pr.card_id)) continue
    seen.add(pr.card_id)
    const card = db.prepare('SELECT id, project, workspace FROM objectives WHERE id = ?').get(pr.card_id) as
      | { id: number; project: string | null; workspace: string | null }
      | undefined
    if (!card) continue
    try {
      logActivity({
        project: card.project || 'operationkit',
        workspace: card.workspace ?? undefined,
        objective_id: card.id,
        event_type: 'milestone',
        title: 'chat_deploy',
        detail: `Deployed by ${bot} on ${row.username}'s word (deploy #${row.id}${pr.pr_number != null ? `, PR #${pr.pr_number}` : ''}, mode ${row.mode}).`,
        metadata: { kind: 'chat_deploy', chat_deploy_id: row.id, pr_number: pr.pr_number, bot: row.agent_slug, owner_user_id: row.user_id, to_commit: row.to_commit },
      })
      n++
    } catch (err) {
      console.warn(`[chat-deploy] card line for #${card.id} failed:`, (err as Error).message)
    }
  }
  return n
}

/** Settle finished deploys and post each outcome once. Returns how many were posted. Never throws. */
export function reportChatDeploys(db: Database = getDb()): number {
  let posted = 0
  try {
    settleChatDeploys(db)
    for (const row of unreportedChatDeploys(db)) {
      const lane = laneFor(row)
      try {
        addMessage(
          row.user_id,
          row.agent_slug,
          { role: 'assistant', content: outcomeLine(row), provider: null, model: null, tool_name: null, meta: { kind: 'chat_deploy', chat_deploy_id: row.id, ok: row.outcome === 'deployed' } },
          [],
          lane,
        )
        touchThread(lane)
      } catch (err) {
        console.warn(`[chat-deploy] posting the outcome of #${row.id} failed:`, (err as Error).message)
        continue
      }
      if (row.outcome === 'deployed') writeDeployCardLines(db, row)
      markReported(db, row.id)
      notifyBotMessage(row.user_id, row.agent_slug)
      posted++
    }
  } catch (err) {
    console.warn('[chat-deploy] reconcile failed:', (err as Error).message)
  }
  return posted
}

let timer: ReturnType<typeof setInterval> | null = null
const TICK_MS = 10_000

/** index.ts, host instance only: settle + report at boot and every 10 s. */
export function startChatDeployReconciler(): void {
  if (timer) return
  setImmediate(() => reportChatDeploys())
  timer = setInterval(() => reportChatDeploys(), TICK_MS)
  timer.unref?.()
}

export function stopChatDeployReconciler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
