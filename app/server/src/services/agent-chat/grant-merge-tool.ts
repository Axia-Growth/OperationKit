// ── Grant-approved merge from a chat turn (obj 901347) ──
//
// PR 858 (obj 901231) let the owner bot squash-merge a ready PR under an
// "Approve on my behalf" grant, but only by posting `approval: merge` on the
// card through an agent key (MCP `send_message` / `POST /api/objectives/:id/
// message`). A chat bot talking with the person in the product had no way to do
// it. This is that way, and it is deliberately a thin door onto the SAME path:
//
//   chat turn → merge_approved_pr {id}
//     1. the person can see the card (getBoardCard: person × bot workspaces);
//     2. the card is THIS bot's own (botMayActOnOwnCard → cardOwnerBot), in a
//        workspace the bot may use — never another bot's card;
//     3. the grant: decideChatBotApproval — the same grantDecision as the card
//        message path. The bot is the SERVER-derived identity of the chat bot
//        running the turn (not declared), the grantor is the person the turn
//        acts for, and the grant must be active (not expired, not revoked) for
//        `merge` in the CARD's workspace. No grant → `approval_denied`, nothing
//        merged;
//     4. runGrantApprovedMerge → mergeUnderGrant: reserved PRs (645 seed +
//        grant_merge_reserved_prs / CC_GRANT_MERGE_RESERVED_PRS) refused before
//        any GitHub call, review/strategy/project/money-path, verdict pass,
//        strict live CI green, PR open + CLEAN/HAS_HOOKS, then
//        `gh pr merge --squash --delete-branch --match-head-commit <sha>`, then
//        the card → done through the status handler. Same `approval_used` /
//        `approval_denied` rows, same `grant_merge` card line.
//
// What it is NOT:
//  - Full access is not consulted at all: Full access never adds this tool and
//    never stands in for a grant.
//  - `settings.auto_merge_enabled` is never read or written.
//  - A card-wake turn never reaches this tool: runChatTool sends every wake
//    call to the own-card tools first, and they do not include it.
//
// The tool is OFFERED only when the person chatting holds an active merge grant
// for this bot somewhere (hasAnyActiveGrant). That is a convenience, not the
// gate: every call is re-checked per card above.
import type { Objective, User } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import type { AuthRequest } from '../../middleware/auth.js'
import { botMayActOnOwnCard } from '../../lib/high-agency-wake-scope.js'
import { runGrantApprovedMerge } from '../../routes/grant-merge-route.js'
import { chatTurnAuditLabel, decideChatBotApproval, hasAnyActiveGrant, writeDelegationAudit } from '../delegated-approvals.js'
import { chatBotIdentity } from '../bots/register-chat-bot.js'
import { botMayUseWorkspace } from './bot-workspaces.js'
import { getBoardCard, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

export const GRANT_MERGE_FN = 'merge_approved_pr'
export const GRANT_MERGE_FNS: ReadonlySet<string> = new Set([GRANT_MERGE_FN])

const SPEC: ToolSpec = {
  type: 'function',
  function: {
    name: GRANT_MERGE_FN,
    description:
      'Squash-merge the pull request of one of YOUR OWN cards, under the "Approve on my behalf" merge grant the person gave you. ' +
      'Only works when the card is in review, its AI review passed, CI is green and the PR is open and cleanly mergeable; then the card is marked done. ' +
      'Anything else is refused with a reason and nothing is merged. Some PRs are reserved and are never merged this way. Call it only when the person asks you to merge.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: 'Card number (one of your own cards, with a PR).' },
        note: { type: 'string', description: 'One line on why this is ready (goes on the card audit trail).' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
}

/** The bot identity grants name for this chat bot (registry id, else automatic). Null = none. */
export function chatBotGrantName(agent: ToolContext['agent']): string | null {
  try {
    return chatBotIdentity({ slug: agent.slug, name: agent.name, file_name: agent.file_name ?? null }, getDb())?.bot.id ?? null
  } catch {
    return null
  }
}

/** Offered only to an ordinary chat turn whose person holds an active merge grant for this bot. */
export function grantMergeToolSpecs(ctx: ToolContext): ToolSpec[] {
  // obj 901394: a card wake with the chat tool scope is a normal turn of this bot for
  // this person, so the same grant offers the same tool. A bot-to-bot wake never merges.
  if (ctx.botWake || (ctx.cardWake && ctx.cardWake.toolScope !== 'chat')) return []
  const botName = chatBotGrantName(ctx.agent)
  if (!botName) return []
  if (!hasAnyActiveGrant(getDb(), { botName, action: 'merge', grantorUserId: ctx.userId, now: ctx.now?.() })) return []
  return [{ ...SPEC, function: { ...SPEC.function } }]
}

function refused(id: number, code: string, error: string): ToolOutcome {
  return { result: { merged: false, code, error }, summary: `Did not merge card #${id}: ${error}`, objective_id: id }
}

export async function runGrantMergeTool(ctx: ToolContext, fnName: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (fnName !== GRANT_MERGE_FN) throw new ToolUseError(`Unknown tool "${fnName}".`)
  // A wake turn never merges (runChatTool already routes wakes elsewhere; this is belt and braces).
  if (ctx.botWake || (ctx.cardWake && ctx.cardWake.toolScope !== 'chat')) throw new ToolUseError('Merging is not available in a wake turn.')
  const id = Number(args.id)
  if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
  const note = typeof args.note === 'string' ? args.note.trim().slice(0, 500) : ''
  const message = `Merge requested from chat by ${ctx.agent.name || ctx.agent.slug}${note ? `: ${note}` : '.'}`
  const db = getDb()
  const label = chatTurnAuditLabel(ctx.agent.slug)
  const botName = chatBotGrantName(ctx.agent)

  // 1. The person (narrowed to the bot's workspaces) must be able to see it.
  getBoardCard(ctx, id)
  const card = db.prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as Objective | undefined
  if (!card) throw new ToolUseError(`Card #${id} is not on a board you can see.`)
  const workspace = (card.workspace || '').trim()

  // 2. Only this bot's OWN card, in a workspace the bot may use.
  const own = workspace && botMayUseWorkspace(ctx.agent.slug, workspace)
    ? botMayActOnOwnCard({ slug: ctx.agent.slug, workspace }, id, db)
    : { ok: false as const, reason: 'other_workspace' as const }
  if (!own.ok) {
    try {
      writeDelegationAudit(db, {
        event: 'approval_denied', objective_id: id, workspace: workspace || null, bot_name: botName, action: 'merge',
        actor: ctx.username, agent_key_id: null, agent_key_label: label, reason: `grant_merge:${own.reason}`, message,
      })
    } catch (err) {
      console.warn('[grant-merge-tool] audit write failed:', (err as Error).message)
    }
    return refused(id, own.reason, `card #${id} is not one of your own cards, so you may not merge it.`)
  }

  // 3. The grant — the same rule as the card-message path.
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.userId) as User | undefined
  const d = decideChatBotApproval(
    db,
    { user: user ? { id: user.id, username: user.username } : null, botName, chatSlug: ctx.agent.slug },
    card,
    'merge',
    message,
    ctx.now?.(),
  )
  if (d.kind !== 'allowed') {
    const code = d.kind === 'denied' ? d.code : 'no_approval'
    const error = d.kind === 'denied' ? d.error : 'No approval was made.'
    return refused(id, code, error)
  }

  // 4. The PR 858 merge path, unchanged: policy, reserved PRs, CI, merge, audit, done.
  const req = { user, headers: {}, authVia: 'session' } as unknown as AuthRequest
  const r = await runGrantApprovedMerge(req, card, d, message, { id: null, label, agent: ctx.agent.slug })
  const body = r.body as { merged?: boolean; code?: string; error?: string; pr_url?: string; merge_line?: string }
  if (r.status !== 200) {
    if (body.merged) {
      return { result: { merged: true, done: false, code: body.code, error: body.error, pr_url: body.pr_url }, summary: `Merged the PR of card #${id}, but the card could not be marked done`, objective_id: id }
    }
    return refused(id, body.code ?? 'refused', body.error ?? `refused (${r.status})`)
  }
  return {
    result: { merged: true, done: true, pr_url: body.pr_url, line: body.merge_line },
    summary: body.merge_line ?? `Squash-merged the PR of card #${id} and marked it done`,
    objective_id: id,
  }
}
