/**
 * Outcome-first intake routes (obj 901764). Mounted on the agent-chat router,
 * so every path is under /api/agent-chat and behind requireAuth.
 *
 *   GET    /outcome-proposals/:id           the proposal, the cards it filed, and the workspace's standing rules
 *   PUT    /outcome-proposals/:id           save the person's edits {proposal}
 *   POST   /outcome-proposals/:id/approve   {proposal?, file_anyway?} → file the cards and start the outcome card
 *   POST   /outcome-proposals/:id/discard
 *   GET    /outcome-rules?workspace=        standing outcome rules for a workspace
 *   POST   /outcome-rules                   {workspace, text, applies_to} → save one
 *   DELETE /outcome-rules/:id               remove one (soft delete)
 *
 * A proposal belongs to the person who was chatting; only they see or change
 * it, and approve / edit / discard need their signed-in BROWSER (a cookie
 * session) — never an API key or a bot. Approval files the cards through the
 * bot's own create path (`createCard`) and starts the outcome card with the
 * board's own Start (`runStatusChange`), so every rail those have applies.
 */
import { Router, type Response } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { userHasWorkspace } from '../middleware/workspace.js'
import { authenticatedViaCookie } from '../lib/message-provenance.js'
import {
  addRule,
  approveProposal,
  discardProposal,
  getProposal,
  getRule,
  listRules,
  removeRule,
  updateProposal,
  type ProposalRow,
} from '../services/outcome-intake.js'
import { findAgent } from '../services/agent-chat/engine.js'
import { agentHasTool, createCard, ToolUseError, type ToolContext } from '../services/agent-chat/tools.js'
import { runStatusChange } from './objectives-status.js'

const router: Router = Router()

type Db = Parameters<typeof getProposal>[0]
const db = (): Db => getDb() as unknown as Db

/** The person, in the browser — never an API key or a bearer token. */
function signedInBrowser(req: AuthRequest): boolean {
  return !!req.user && !req.agentKey && req.authVia !== 'agent_api_key' && req.authVia !== 'legacy_api_key' && authenticatedViaCookie(req)
}

function idParam(req: AuthRequest): number | null {
  const n = Number(req.params.id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** The caller's own proposal, or the response is already sent. Someone else's reads exactly like a missing one. */
function ownProposal(req: AuthRequest, res: Response): ProposalRow | null {
  const id = idParam(req)
  const row = id ? getProposal(db(), id) : null
  if (!row || row.user_id !== req.user?.id) {
    res.status(404).json({ error: 'Proposal not found' })
    return null
  }
  return row
}

function canReadWorkspace(req: AuthRequest, workspace: string): boolean {
  if (!req.user) return false
  return req.user.role === 'admin' || userHasWorkspace(req.user.id, workspace)
}

/** What the panel needs: the proposal, what it filed, and the standing rules that will apply. */
function view(req: AuthRequest, row: ProposalRow) {
  const ids = [row.card_id, ...row.child_ids].filter((n): n is number => typeof n === 'number')
  const cards = ids.length
    ? (getDb().prepare(`SELECT id, title, status FROM objectives WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number; title: string; status: string }[])
    : []
  const order = new Map(ids.map((id, i) => [id, i]))
  cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  return {
    id: row.id,
    status: row.status,
    workspace: row.workspace,
    agent_slug: row.agent_slug,
    proposal: row.proposal,
    card_id: row.card_id,
    child_ids: row.child_ids,
    start_note: row.start_note,
    created_at: row.created_at,
    decided_at: row.decided_at,
    cards,
    rules: listRules(db(), row.workspace),
    can_edit: row.status === 'pending' && signedInBrowser(req),
  }
}

router.get('/outcome-proposals/:id', (req: AuthRequest, res) => {
  const row = ownProposal(req, res)
  if (!row) return
  res.json(view(req, row))
})

router.put('/outcome-proposals/:id', (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only the person, signed in to the app, can edit this breakdown' })
    return
  }
  const row = ownProposal(req, res)
  if (!row) return
  const out = updateProposal(db(), row.id, (req.body ?? {}).proposal)
  if (!out.ok) {
    res.status(out.code === 'invalid' ? 400 : out.code === 'not_found' ? 404 : 409).json({ error: out.error, errors: out.errors })
    return
  }
  res.json(view(req, out.row))
})

router.post('/outcome-proposals/:id/discard', (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only the person, signed in to the app, can discard this breakdown' })
    return
  }
  const row = ownProposal(req, res)
  if (!row) return
  const out = discardProposal(db(), row.id)
  if (!out.ok) {
    res.status(out.code === 'not_found' ? 404 : 409).json({ error: out.error })
    return
  }
  res.json(view(req, out.row))
})

router.post('/outcome-proposals/:id/approve', async (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only the person, signed in to the app, can approve this breakdown. A bot or an API key never approves its own proposal.' })
    return
  }
  const row = ownProposal(req, res)
  if (!row) return
  // The cards are the bot's cards: filed as it, through its own create path.
  const agent = findAgent(row.agent_slug)
  if (!agent || !agentHasTool(agent, 'create_objective')) {
    res.status(409).json({ error: `The bot that proposed this (${row.agent_slug}) can no longer file cards, so nothing was filed.` })
    return
  }
  const user = req.user!
  const ctx: ToolContext = {
    userId: user.id,
    username: user.username,
    workspace: row.workspace,
    agent,
    kbRoot: '',
    connectors: { mail: null, calendar: null },
  }
  const body = (req.body ?? {}) as { proposal?: unknown; file_anyway?: unknown }
  const out = await approveProposal(
    db(),
    row.id,
    body.proposal,
    { userId: user.id, fileAnyway: body.file_anyway === true },
    {
      approvedBy: user.username,
      fileCard: input => {
        const r = createCard(ctx, input.title, input.description, row.workspace, input.parentId ?? undefined, {
          idempotencyKey: input.idempotencyKey,
          fileAnyway: input.fileAnyway,
          doneWhen: input.doneWhen,
          stopConditions: input.stopConditions,
        })
        return r.filed ? { filed: true, id: r.id, reused: r.reused } : { filed: false, duplicate: r.duplicate }
      },
      startCard: async id => {
        // The board's own Start: the session cap, the duplicate-start guard and every
        // other gate apply exactly as they do to a click on the card.
        const r = await runStatusChange(req, id, 'working', { actor: 'user', pathway: 'outcome-intake-approve', humanTerminal: true })
        const b = (r.body ?? {}) as { status?: string; error?: string }
        if (r.code === 200) return { ok: true, status: b.status }
        return { ok: false, reason: b.error ?? `start refused (${r.code})` }
      },
    },
  )
  if (!out.ok) {
    const code = out.code === 'invalid' || out.code === 'refused' ? 400 : out.code === 'not_found' ? 404 : 409
    res.status(code).json({ error: out.error, code: out.code, errors: out.errors, duplicate: out.duplicate })
    return
  }
  // Say it in the chat lane the proposal came from, so the bot (and the person
  // scrolling back) sees what was filed. A plain assistant line, never a turn.
  try {
    const ids = [out.cardId, ...out.childIds].map(n => `#${n}`).join(', ')
    getDb()
      .prepare('INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta, thread_id) VALUES (?, ?, \'assistant\', ?, ?, ?)')
      .run(
        user.id,
        row.agent_slug,
        `You approved the breakdown "${row.proposal.card.title}". Filed ${ids}. ${out.startNote}`,
        JSON.stringify({ kind: 'outcome_approved', outcome_proposal_id: row.id, objective_id: out.cardId }),
        row.thread_id,
      )
  } catch (err) {
    console.warn('[outcome-intake] could not post the approval line:', err instanceof Error ? err.message : String(err))
  }
  res.json({ ...view(req, out.row), started: out.started })
})

// ── standing rules ──

router.get('/outcome-rules', (req: AuthRequest, res) => {
  const ws = typeof req.query.workspace === 'string' ? req.query.workspace.trim() : ''
  if (!ws) {
    res.status(400).json({ error: 'workspace is required' })
    return
  }
  if (!canReadWorkspace(req, ws)) {
    res.status(403).json({ error: 'You are not a member of that workspace' })
    return
  }
  res.json({ workspace: ws, rules: listRules(db(), ws) })
})

router.post('/outcome-rules', (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only a person, signed in to the app, can save a standing rule' })
    return
  }
  const b = (req.body ?? {}) as { workspace?: unknown; text?: unknown; applies_to?: unknown }
  const ws = typeof b.workspace === 'string' ? b.workspace.trim() : ''
  if (!ws || !canReadWorkspace(req, ws)) {
    res.status(403).json({ error: 'You are not a member of that workspace' })
    return
  }
  const out = addRule(db(), { workspace: ws, text: b.text, appliesTo: b.applies_to, userId: req.user!.id })
  if (!out.ok) {
    res.status(400).json({ error: out.error })
    return
  }
  res.status(out.existing ? 200 : 201).json({ rule: out.rule, existing: out.existing, rules: listRules(db(), ws) })
})

router.delete('/outcome-rules/:id', (req: AuthRequest, res) => {
  if (!signedInBrowser(req)) {
    res.status(403).json({ error: 'Only a person, signed in to the app, can remove a standing rule' })
    return
  }
  const id = idParam(req)
  const rule = id ? getRule(db(), id) : null
  if (!rule || rule.deleted_at || !canReadWorkspace(req, rule.workspace)) {
    res.status(404).json({ error: 'Rule not found' })
    return
  }
  // A rule shapes every card in its workspace: an install admin or whoever saved it may remove it.
  if (req.user!.role !== 'admin' && rule.created_by !== req.user!.id) {
    res.status(403).json({ error: 'Only an admin or the person who saved this rule can remove it' })
    return
  }
  removeRule(db(), { id: rule.id, userId: req.user!.id })
  res.json({ ok: true, rules: listRules(db(), rule.workspace) })
})

// Exported for tests: ToolUseError messages from createCard reach the person verbatim.
export { ToolUseError }
export default router
