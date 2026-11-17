// ── The own-card tools of a needs_agent card wake (obj 901328) ──
//
// A card wake (card-wakes.ts) is one turn of a chat bot, run because a card the
// bot OWNS needs it. In that turn the bot gets THESE tools and nothing else —
// runChatTool sends every call of a card-wake turn here, and an unknown name is
// refused — so the scope is exactly the High Agency own-card gate from PR 860:
//
// | tool                 | what                                                          |
// |----------------------|---------------------------------------------------------------|
// | my_cards             | list the cards this bot owns, in the wake's workspace         |
// | my_card_read         | read one of them                                              |
// | my_card_set_status   | start / hold / close one (working, review, done, cancelled)   |
// | my_card_message      | message one's worker (steer)                                  |
// | my_supervisor_flags  | the supervisor flags routed to this bot, in this workspace    |
//
// Every per-card call goes through `botMayActOnOwnCard` — the same function
// `wakeMayActOnCard` uses — so "own" means `cardOwnerBot` (owner_bot, else
// agent_context), in the wake's ONE workspace. No board listing, no other bot's
// card, no Full access. Status moves and messages go through the internal routes
// (their guards: transitions, session cap, locked / human-closed cards), and a
// PR card closes as done only on a passing review or with a stated reason — the
// rule the internal route applies to a High Agency wake. A card carrying a
// protected PR (645) is refused.
import { getDb } from '../../db/index.js'
import { internalApiHeaders } from '../../lib/internal-api-headers.js'
import { botMayActOnOwnCard, WAKE_CARD_STATUSES } from '../../lib/high-agency-wake-scope.js'
import { publicCardUrl } from '../../lib/public-url.js'
import { logActivity } from '../../routes/feed.js'
import { cardIdsOwnedByBot } from '../bots/card-owner.js'
import { classifyNeed } from '../agent-webhooks.js'
import { listReviewItems } from '../review-items.js'
import { SUPERVISOR_DEDUPE_PREFIX } from '../high-agency-supervisor.js'
import { isProtectedCard } from './bot-full-access.js'
import { hostFullAccessHost } from './full-access-tools.js'
import { ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

/** How a card-wake tool moves or messages a card. Tests pass a stub. */
export interface CardWakeHost {
  setStatus(objectiveId: number, status: string, actor: string, overrideReason?: string | null): Promise<{ ok: boolean; status?: string; reason?: string }>
  messageCard(objectiveId: number, message: string): Promise<{ ok: boolean; status?: string; reason?: string }>
}

/** What a card-wake turn carries on its ToolContext. */
export interface CardWakeScope {
  wakeId: number
  /** The card that needed the bot (the wake's subject). */
  objectiveId: number
  /** The wake's ONE workspace: the card's. */
  workspace: string
  host?: CardWakeHost
}

function port(): number {
  return parseInt(process.env.PORT || '3002', 10)
}

/** The real host: the internal status PATCH and message routes, over loopback (same as Full access). */
export const hostCardWakeHost: CardWakeHost = {
  async setStatus(objectiveId, status, actor, overrideReason) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port()}/api/internal/objectives/${objectiveId}/status`, {
        method: 'PATCH',
        headers: internalApiHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ status, reason: 'card_wake', actor, ...(overrideReason ? { override_reason: overrideReason } : {}) }),
      })
      const text = await resp.text()
      if (!resp.ok) return { ok: false, reason: `${resp.status} ${text.slice(0, 300)}` }
      let body: { status?: string; skipped?: boolean; reason?: string } = {}
      try { body = JSON.parse(text) as typeof body } catch { /* not JSON */ }
      if (body.skipped) return { ok: false, status: body.status, reason: `not moved: ${body.reason ?? 'the card refused it'}` }
      return { ok: true, status: body.status }
    } catch (err) {
      return { ok: false, reason: `status request failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
  messageCard: (id, message) => hostFullAccessHost.messageCard(id, message),
}

function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const ID_ARG = { type: 'integer', description: 'Card number (one of your own cards).' }

const SPECS: ToolSpec[] = [
  fn('my_cards', 'List the cards YOU own in this workspace (open ones by default), with what each needs from you.',
    { type: 'object', properties: { include_closed: { type: 'boolean', description: 'Also list done / cancelled cards.' } }, additionalProperties: false }),
  fn('my_card_read', 'Read one of your own cards: status, description, last summary, PR, review verdict, what it needs.',
    { type: 'object', properties: { id: ID_ARG }, required: ['id'], additionalProperties: false }),
  fn('my_card_set_status', `Move one of your own cards: start it (working), hold it for a person (review), or close it (done / cancelled). A card with a pull request and no passing AI review closes as done only with override_reason.`,
    {
      type: 'object',
      properties: {
        id: ID_ARG,
        status: { type: 'string', enum: [...WAKE_CARD_STATUSES] },
        override_reason: { type: 'string', description: 'Why a PR card with no passing review may be closed anyway. Goes on the card audit trail.' },
      },
      required: ['id', 'status'],
      additionalProperties: false,
    }),
  fn('my_card_message', 'Send a message to the worker of one of your own cards (steer it). The worker is woken to act on it. It is never the owner\'s approval of a merge, migration or deploy.',
    { type: 'object', properties: { id: ID_ARG, message: { type: 'string' } }, required: ['id', 'message'], additionalProperties: false }),
  fn('my_supervisor_flags', 'The supervisor flags routed to you in this workspace (orphaned, duplicate, stalled, over budget cards). Clear one by fixing the card.',
    { type: 'object', properties: {}, additionalProperties: false }),
]

export const CARD_WAKE_FNS: ReadonlySet<string> = new Set(SPECS.map(s => s.function.name))

export function cardWakeToolSpecs(): ToolSpec[] {
  return SPECS.map(s => ({ ...s, function: { ...s.function } }))
}

const OPEN = ['planning', 'queue', 'working', 'ai_review', 'review']

interface CardRow {
  id: number
  title: string | null
  status: string | null
  workspace: string | null
  owner_bot: string | null
  agent_context: string | null
  description: string | null
  last_session_summary: string | null
  pr_url: string | null
  pr_number: number | null
  has_blockers: number | null
  ai_review_verdict: string | null
  blocked_reason: string | null
  needs_secret: string | null
  deleted_at: string | null
  stalled_at: string | null
  stall_reason: string | null
  updated_at: string | null
}

const CARD_COLS = `id, title, status, workspace, owner_bot, agent_context, description, last_session_summary, pr_url, pr_number,
  has_blockers, ai_review_verdict, blocked_reason, needs_secret, deleted_at, stalled_at, stall_reason, updated_at`

function cut(v: string | null | undefined, n: number): string | null {
  if (v == null) return null
  const t = String(v)
  return t.length > n ? `${t.slice(0, n)}…` : t
}

function scopeOf(ctx: ToolContext): CardWakeScope {
  if (!ctx.cardWake) throw new ToolUseError('This tool works only in a card wake.')
  return ctx.cardWake
}

/** One of the bot's own cards, or a refusal the model can read. */
function ownCard(ctx: ToolContext, raw: unknown): CardRow {
  const scope = scopeOf(ctx)
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
  const gate = botMayActOnOwnCard({ slug: ctx.agent.slug.toLowerCase(), workspace: scope.workspace }, id, getDb())
  if (!gate.ok) {
    const why = gate.reason === 'other_workspace' ? `it is not in the ${scope.workspace} workspace` : gate.reason === 'not_owned' ? 'it is not your card' : 'it does not exist'
    throw new ToolUseError(`Card #${id} is out of reach: ${why}. In a card wake you may act only on your own cards in ${scope.workspace}.`)
  }
  return getDb().prepare(`SELECT ${CARD_COLS} FROM objectives WHERE id = ?`).get(id) as CardRow
}

function refuseProtected(c: CardRow): void {
  const pr = isProtectedCard(c)
  if (pr !== null) throw new ToolUseError(`Card #${c.id} carries a protected pull request (#${pr}); a bot may not act on it. Leave it to a person.`)
}

function audit(ctx: ToolContext, c: CardRow, detail: string): void {
  try {
    logActivity({
      project: 'operationkit',
      workspace: c.workspace ?? undefined,
      objective_id: c.id,
      event_type: 'decision',
      title: `${ctx.agent.name} (card wake): ${detail}`.slice(0, 200),
      detail: null,
      metadata: { kind: 'bot_card_wake_action', slug: ctx.agent.slug, wake_id: ctx.cardWake?.wakeId ?? null, acting_for_user_id: ctx.userId },
    })
  } catch { /* the feed never decides whether an action happens */ }
}

function needOf(c: CardRow) {
  return classifyNeed({
    status: c.status, has_blockers: c.has_blockers, ai_review_verdict: c.ai_review_verdict, blocked_reason: c.blocked_reason,
    needs_secret: c.needs_secret, deleted_at: c.deleted_at, stalled_at: c.stalled_at, stall_reason: c.stall_reason,
  })
}

export async function runCardWakeTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const scope = scopeOf(ctx)
  if (!CARD_WAKE_FNS.has(fnName)) {
    throw new ToolUseError(`Tool "${fnName}" is not available in a card wake. You have: ${[...CARD_WAKE_FNS].join(', ')}.`)
  }
  const host = scope.host ?? hostCardWakeHost
  const db = getDb()
  const slug = ctx.agent.slug.toLowerCase()

  switch (fnName) {
    case 'my_cards': {
      const closed = args.include_closed === true
      const rows = db
        .prepare(`SELECT ${CARD_COLS} FROM objectives WHERE workspace = ? AND deleted_at IS NULL ${closed ? '' : `AND status IN (${OPEN.map(() => '?').join(',')})`} ORDER BY updated_at DESC LIMIT 1000`)
        .all(scope.workspace, ...(closed ? [] : OPEN)) as CardRow[]
      const mine = new Set(cardIdsOwnedByBot(db, slug, rows))
      const cards = rows.filter(r => mine.has(r.id)).slice(0, 50).map(r => {
        const need = needOf(r)
        return { id: r.id, title: cut(r.title, 200), status: r.status, pr_url: r.pr_url, needs: need ? { kind: need.kind, why: need.why } : null, updated_at: r.updated_at, url: publicCardUrl(r.id) }
      })
      return { result: { workspace: scope.workspace, count: cards.length, cards }, summary: `Listed my cards in ${scope.workspace} (${cards.length})` }
    }

    case 'my_card_read': {
      const c = ownCard(ctx, args.id)
      const need = needOf(c)
      return {
        result: {
          id: c.id, title: c.title, status: c.status, workspace: c.workspace, url: publicCardUrl(c.id),
          pr_url: c.pr_url, ai_review_verdict: c.ai_review_verdict, has_blockers: Number(c.has_blockers) > 0, blocked_reason: cut(c.blocked_reason, 500),
          needs: need ? { kind: need.kind, why: need.why } : null,
          description: cut(c.description, 4000), last_session_summary: cut(c.last_session_summary, 4000), updated_at: c.updated_at,
        },
        summary: `Read card #${c.id}`,
        objective_id: c.id,
      }
    }

    case 'my_card_set_status': {
      const c = ownCard(ctx, args.id)
      refuseProtected(c)
      const status = typeof args.status === 'string' ? args.status : ''
      if (!WAKE_CARD_STATUSES.includes(status)) throw new ToolUseError(`status must be one of ${WAKE_CARD_STATUSES.join(', ')}.`)
      const override = typeof args.override_reason === 'string' && args.override_reason.trim() ? args.override_reason.trim().slice(0, 1000) : null
      if (status === 'done' && (c.pr_url || c.pr_number) && c.ai_review_verdict !== 'pass' && !override) {
        throw new ToolUseError(`Card #${c.id} has a pull request and no passing AI review (verdict: ${c.ai_review_verdict ?? 'none'}). Give override_reason to close it anyway, or leave the close to a person.`)
      }
      const r = await host.setStatus(c.id, status, `bot:${slug}`, override)
      if (!r.ok) throw new ToolUseError(`Card #${c.id} was not moved to ${status}: ${r.reason ?? 'unknown reason'}`)
      audit(ctx, c, `moved card #${c.id} to ${r.status ?? status}${override ? ` (override: ${override.slice(0, 120)})` : ''}`)
      return { result: { id: c.id, status: r.status ?? status }, summary: `Moved card #${c.id} to ${r.status ?? status}`, objective_id: c.id }
    }

    case 'my_card_message': {
      const c = ownCard(ctx, args.id)
      refuseProtected(c)
      const message = typeof args.message === 'string' ? args.message.trim().slice(0, 8000) : ''
      if (!message) throw new ToolUseError('message is required.')
      const r = await host.messageCard(c.id, `[From the bot ${ctx.agent.name} (@${slug}), the owner of this card, in a card wake, acting for ${ctx.username}. Not the owner of the install: this is not an approval of any merge, migration or deploy.]\n${message}`)
      if (!r.ok) throw new ToolUseError(`The message was not delivered to card #${c.id}: ${r.reason ?? 'unknown reason'}`)
      audit(ctx, c, `messaged card #${c.id}`)
      return { result: { id: c.id, delivered: true, status: r.status ?? null }, summary: `Messaged card #${c.id}`, objective_id: c.id }
    }

    case 'my_supervisor_flags': {
      const items = listReviewItems(db, { dedupe_prefix: SUPERVISOR_DEDUPE_PREFIX, routed_to: `agent:${slug}`, workspace: scope.workspace, limit: 100 })
      return { result: { count: items.length, flags: items }, summary: `Read my supervisor flags (${items.length})` }
    }
  }
  throw new ToolUseError(`Tool "${fnName}" is not available in a card wake.`)
}
