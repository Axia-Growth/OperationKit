/**
 * Needs You bulk triage (obj 900869) — /api/board-triage.
 *
 *   GET  /owners    — who a card can be handed to: people + registry bots
 *   GET  /batches   — recent bulk actions (the audit trail, newest first)
 *   POST /batches   — run ONE confirmed bulk action over up to TRIAGE_MAX_BATCH cards
 *                     (`dry_run: true` = list exactly what it would touch and
 *                     change nothing: no batch row, no card move, no audit row)
 *
 * A HUMAN tool. Only a person signed in to the web app (httpOnly cookie
 * session) may call it — never an agent key, a legacy API key or a Bearer JWT.
 * The path is not on the agent surface either (agent-key-guard answers
 * off_surface for /api/board-triage), so a bot cannot reach it at all; a bot
 * approves one eligible card at a time through POST /api/objectives/:id/bot-approve.
 *
 * Every card is checked on its own: the caller must be allowed to change it
 * (requireOwnership — admin, creator or assignee), and approve/dismiss only act
 * on a card that is in Needs You right now. A card that fails a check is
 * SKIPPED with a reason; the rest of the batch still runs. Status moves go
 * through the same PATCH handler a click uses (runStatusChange), so every
 * completion gate still applies, and each move writes its objective_audit row
 * with pathway `bulk-triage:<batch id>`.
 */
import { Router, type Response } from 'express'
import { getDb } from '../db/index.js'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  TRIAGE_MAX_BATCH,
  cardNeedsHuman,
  isTriageAction,
  type Objective,
  type ObjectiveStatus,
  type TriageAction,
  type TriageBatchPreview,
  type TriageBatchResponse,
  type TriageBatchSummary,
  type TriageItemOutcome,
  type TriageOwnerOptions,
  type TriagePreviewItem,
} from '@operationkit/shared'
import { listBots, resolveBot } from '../services/bots/bot-registry.js'
import { logObjectiveAudit } from '../services/objective-audit.js'
import { broadcast } from '../ws/index.js'
import { mapObjective, requireOwnership, setAssignees } from './objectives-helpers.js'
import { runStatusChange } from './objectives-status.js'

const router: Router = Router()
router.use(requireAuth)

/** A person in the browser: cookie session, no agent key. */
export function isPersonInBrowser(req: AuthRequest): boolean {
  return !!req.user && req.authVia === 'session' && !req.agentKey && authenticatedViaCookie(req)
}

function personOr403(req: AuthRequest, res: Response): boolean {
  if (isPersonInBrowser(req)) return true
  res.status(403).json({
    error: 'Bulk triage is for a person signed in to the app in the browser. A bot approves one eligible card at a time (POST /api/objectives/:id/bot-approve).',
    code: 'person_only',
  })
  return false
}

const ACTION_TARGET: Record<Exclude<TriageAction, 'reassign'>, ObjectiveStatus> = {
  approve: 'done',
  dismiss: 'cancelled',
}

router.get('/owners', (req: AuthRequest, res) => {
  if (!personOr403(req, res)) return
  const db = getDb()
  const user = req.user!
  const humans = user.role === 'admin'
    ? (db.prepare('SELECT id, username FROM users ORDER BY username').all() as { id: number; username: string }[])
    : (db.prepare(
        `SELECT DISTINCT u.id, u.username FROM users u
           JOIN user_workspaces uw ON uw.user_id = u.id
          WHERE uw.workspace IN (SELECT workspace FROM user_workspaces WHERE user_id = ?)
          ORDER BY u.username`,
      ).all(user.id) as { id: number; username: string }[])
  const body: TriageOwnerOptions = {
    humans,
    bots: listBots(db).map(b => ({ id: b.id, name: b.name })),
  }
  res.json(body)
})

router.get('/batches', (req: AuthRequest, res) => {
  if (!personOr403(req, res)) return
  const db = getDb()
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
  const admin = req.user!.role === 'admin'
  const rows = (admin
    ? db.prepare('SELECT * FROM board_triage_batches ORDER BY id DESC LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM board_triage_batches WHERE actor_user_id = ? ORDER BY id DESC LIMIT ?').all(req.user!.id, limit)
  ) as Array<Record<string, unknown>>
  const out: TriageBatchSummary[] = rows.map(r => ({
    id: Number(r.id),
    action: r.action as TriageAction,
    actor: String(r.actor),
    requested: Number(r.requested),
    ok: Number(r.ok),
    skipped: Number(r.skipped),
    failed: Number(r.failed),
    note: (r.note as string | null) ?? null,
    params: r.params_json ? (JSON.parse(String(r.params_json)) as Record<string, unknown>) : {},
    created_at: String(r.created_at),
  }))
  res.json({ batches: out })
})

router.get('/batches/:id', (req: AuthRequest, res) => {
  if (!personOr403(req, res)) return
  const db = getDb()
  const batch = db.prepare('SELECT * FROM board_triage_batches WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!batch || (req.user!.role !== 'admin' && Number(batch.actor_user_id) !== req.user!.id)) {
    res.status(404).json({ error: 'No such batch' })
    return
  }
  const items = db.prepare('SELECT objective_id, title_snapshot, result, from_status, to_status, error, created_at FROM board_triage_items WHERE batch_id = ? ORDER BY id').all(req.params.id)
  res.json({ batch, items })
})

interface ParsedBatch {
  action: TriageAction
  ids: number[]
  assignees?: number[] | undefined
  ownerBot?: string | null | undefined
  note: string | null
  dryRun: boolean
}

function parseBatch(body: unknown): ParsedBatch | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isTriageAction(b.action)) return { error: 'action must be one of: approve, dismiss, reassign' }
  if (!Array.isArray(b.objective_ids) || b.objective_ids.length === 0) return { error: 'objective_ids must be a non-empty list of card ids' }
  const ids = [...new Set(b.objective_ids.map(Number))]
  if (ids.some(n => !Number.isInteger(n) || n <= 0)) return { error: 'objective_ids must be positive integers' }
  if (ids.length > TRIAGE_MAX_BATCH) return { error: `At most ${TRIAGE_MAX_BATCH} cards per batch — split the selection.` }
  const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim().slice(0, 500) : null
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') return { error: 'dry_run must be true or false' }
  const dryRun = b.dry_run === true
  if (b.action !== 'reassign') return { action: b.action, ids, note, dryRun }

  let assignees: number[] | undefined
  if (b.assigned_user_ids !== undefined) {
    if (!Array.isArray(b.assigned_user_ids)) return { error: 'assigned_user_ids must be a list of user ids' }
    assignees = [...new Set(b.assigned_user_ids.map(Number))]
    if (assignees.some(n => !Number.isInteger(n) || n <= 0)) return { error: 'assigned_user_ids must be positive integers' }
  }
  let ownerBot: string | null | undefined
  if (b.owner_bot !== undefined) {
    ownerBot = b.owner_bot === null || b.owner_bot === '' ? null : String(b.owner_bot)
  }
  if (assignees === undefined && ownerBot === undefined) {
    return { error: 'reassign needs assigned_user_ids and/or owner_bot (null clears the bot)' }
  }
  return { action: 'reassign', ids, assignees, ownerBot, note, dryRun }
}

/**
 * The per-card checks that decide whether a card is touched at all. The real
 * run and the dry run both call this, so a preview can never promise a card
 * the real action would skip. `null` = the action goes ahead for this card.
 */
function precheck(
  req: AuthRequest,
  id: number,
  card: Objective | undefined,
  action: TriageAction,
): TriageItemOutcome | null {
  if (!card || card.deleted_at) {
    return { objective_id: id, title: null, result: 'failed', from_status: null, to_status: null, error: 'Card not found' }
  }
  const denied = requireOwnership(req, card)
  if (denied) {
    return { objective_id: id, title: card.title, result: 'skipped', from_status: card.status, to_status: null, error: denied }
  }
  // approve / dismiss: only a card that is in Needs You right now.
  if (action !== 'reassign' && !cardNeedsHuman(card)) {
    return {
      objective_id: id, title: card.title, result: 'skipped', from_status: card.status, to_status: null,
      error: card.status === 'review' ? 'An agent is still running on this card — it is not in Needs You.' : `Not in Needs You (status ${card.status}).`,
    }
  }
  return null
}

const PREVIEW_NOTE: Record<TriageAction, string> = {
  approve: 'Nothing was changed. On the real run each card still passes the usual completion checks before it moves to Done; a card that fails one is reported as failed and stays where it is.',
  dismiss: 'Nothing was changed. On the real run each card moves to Cancelled through the usual status change; a card that changed in the meantime is skipped.',
  reassign: 'Nothing was changed. On the real run each card gets the new owner and stays in its column.',
}

/** Dry run: the same checks as the real action, and not one write. */
function previewBatch(
  req: AuthRequest,
  parsed: ParsedBatch,
  botId: string | null | undefined,
): TriageBatchPreview {
  const db = getDb()
  const items: TriagePreviewItem[] = parsed.ids.map(id => {
    const card = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
    const stop = precheck(req, id, card, parsed.action)
    if (stop) {
      return {
        objective_id: id, title: stop.title, result: stop.result === 'failed' ? 'failed' : 'skipped',
        from_status: stop.from_status, to_status: null, ...(stop.error ? { error: stop.error } : {}),
      }
    }
    const c = card!
    if (parsed.action === 'reassign') {
      const parts: string[] = []
      if (botId !== undefined) parts.push(`bot: ${c.owner_bot ?? 'none'} → ${botId ?? 'none'}`)
      if (parsed.assignees !== undefined) parts.push(`person: ${c.assigned_user_id ?? 'none'} → ${parsed.assignees.length ? parsed.assignees.join(', ') : 'none'}`)
      return { objective_id: id, title: c.title, result: 'would_change', from_status: c.status, to_status: c.status, change: parts.join('; ') }
    }
    const target = ACTION_TARGET[parsed.action]
    return {
      objective_id: id, title: c.title, result: 'would_change', from_status: c.status, to_status: target,
      change: `Needs You → ${target === 'done' ? 'Done' : 'Cancelled'}`,
    }
  })
  const count = (r: TriagePreviewItem['result']) => items.filter(i => i.result === r).length
  return {
    dry_run: true,
    action: parsed.action,
    requested: parsed.ids.length,
    would_change: count('would_change'),
    skipped: count('skipped'),
    failed: count('failed'),
    items,
    note: PREVIEW_NOTE[parsed.action],
  }
}

router.post('/batches', async (req: AuthRequest, res) => {
  if (!personOr403(req, res)) return
  const parsed = parseBatch(req.body)
  if ('error' in parsed) { res.status(400).json({ error: parsed.error }); return }
  const db = getDb()
  const user = req.user!

  // Validate reassign targets ONCE, before any card moves.
  let botId: string | null | undefined
  if (parsed.action === 'reassign') {
    if (parsed.ownerBot !== undefined && parsed.ownerBot !== null) {
      const bot = resolveBot(parsed.ownerBot, db)
      if (!bot.ok) { res.status(400).json({ error: bot.error, known_bots: bot.known }); return }
      botId = bot.bot.id
    } else {
      botId = parsed.ownerBot
    }
    if (parsed.assignees && parsed.assignees.length > 0) {
      const placeholders = parsed.assignees.map(() => '?').join(',')
      const found = db.prepare(`SELECT id FROM users WHERE id IN (${placeholders})`).all(...parsed.assignees) as { id: number }[]
      if (found.length !== parsed.assignees.length) {
        const known = new Set(found.map(f => f.id))
        res.status(400).json({ error: `Unknown user id(s): ${parsed.assignees.filter(a => !known.has(a)).join(', ')}` })
        return
      }
    }
  }

  // Dry run: answer before the first write (the batch row below is one).
  if (parsed.dryRun) {
    res.json(previewBatch(req, parsed, botId))
    return
  }

  const params: Record<string, unknown> = {}
  if (parsed.assignees !== undefined) params.assigned_user_ids = parsed.assignees
  if (botId !== undefined) params.owner_bot = botId
  const batchId = Number(db.prepare(
    'INSERT INTO board_triage_batches (action, actor_user_id, actor, requested, params_json, note) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(parsed.action, user.id, user.username, parsed.ids.length, JSON.stringify(params), parsed.note).lastInsertRowid)
  const pathway = `bulk-triage:${batchId}`
  const insertItem = db.prepare(
    'INSERT INTO board_triage_items (batch_id, objective_id, title_snapshot, workspace, result, from_status, to_status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )

  const items: TriageItemOutcome[] = []
  for (const id of parsed.ids) {
    const card = db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective | undefined
    const record = (o: TriageItemOutcome) => {
      items.push(o)
      insertItem.run(batchId, id, card?.title ?? null, card?.workspace ?? null, o.result, o.from_status, o.to_status, o.error ?? null)
    }
    const stop = precheck(req, id, card, parsed.action)
    if (stop) { record(stop); continue }
    if (!card) continue // unreachable: precheck fails a missing card

    if (parsed.action === 'reassign') {
      try {
        const before = { owner_bot: card.owner_bot ?? null, assigned_user_id: card.assigned_user_id }
        if (parsed.assignees !== undefined) {
          setAssignees(id, parsed.assignees)
          db.prepare("UPDATE objectives SET assigned_user_id = ?, updated_at = datetime('now') WHERE id = ?").run(parsed.assignees[0] ?? null, id)
        }
        if (botId !== undefined) {
          db.prepare("UPDATE objectives SET owner_bot = ?, updated_at = datetime('now') WHERE id = ?").run(botId, id)
        }
        logObjectiveAudit(db, {
          objectiveId: id,
          eventType: 'owner_change',
          fromStatus: card.status,
          toStatus: card.status,
          actor: `user:${user.username}`,
          pathway: `${pathway} bot:${before.owner_bot ?? 'none'}->${botId === undefined ? '(unchanged)' : botId ?? 'none'}` +
            (parsed.assignees !== undefined ? ` humans:${before.assigned_user_id ?? 'none'}->[${parsed.assignees.join(',')}]` : ''),
          sessionId: card.session_id,
          titleSnapshot: card.title,
          workspace: card.workspace,
        })
        const updated = mapObjective(db.prepare('SELECT * FROM objectives WHERE id = ?').get(id) as Objective)
        broadcast({ type: 'objective_updated', payload: updated })
        record({ objective_id: id, title: card.title, result: 'ok', from_status: card.status, to_status: card.status })
      } catch (err) {
        record({ objective_id: id, title: card.title, result: 'failed', from_status: card.status, to_status: null, error: (err as Error).message })
      }
      continue
    }

    const target = ACTION_TARGET[parsed.action]
    try {
      const r = await runStatusChange(req, id, target, { actor: `user:${user.username}`, pathway, humanTerminal: true })
      if (r.code === 200) {
        record({ objective_id: id, title: card.title, result: 'ok', from_status: card.status, to_status: target })
      } else {
        const msg = (r.body as { error?: string } | undefined)?.error ?? `HTTP ${r.code}`
        record({ objective_id: id, title: card.title, result: 'failed', from_status: card.status, to_status: null, error: msg })
      }
    } catch (err) {
      record({ objective_id: id, title: card.title, result: 'failed', from_status: card.status, to_status: null, error: (err as Error).message })
    }
  }

  const count = (r: TriageItemOutcome['result']) => items.filter(i => i.result === r).length
  const ok = count('ok'), skipped = count('skipped'), failed = count('failed')
  db.prepare("UPDATE board_triage_batches SET ok = ?, skipped = ?, failed = ?, finished_at = datetime('now') WHERE id = ?").run(ok, skipped, failed, batchId)
  console.log(`[board-triage] batch #${batchId} ${parsed.action} by ${user.username}: ${ok} ok, ${skipped} skipped, ${failed} failed of ${parsed.ids.length}`)
  const body: TriageBatchResponse = { batch_id: batchId, action: parsed.action, requested: parsed.ids.length, ok, skipped, failed, items }
  res.json(body)
})

export default router
