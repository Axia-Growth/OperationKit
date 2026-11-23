/**
 * Bot approvals on Needs You cards (obj 900869).
 *
 * Needs You is the human queue. A bot may take a card OUT of it by approving
 * it, but only when the card is eligible, and eligibility is decided here and
 * nowhere else. Two ways in, both narrow:
 *
 *  1. `grant` — the card is waiting on a signature the delegation-grant system
 *     already names (obj 900839, services/delegated-approvals.ts). Today that is
 *     `merge`: a card with an open pull request. The bot must hold an ACTIVE
 *     grant for exactly that action in the card's workspace, issued by the
 *     person who owns the bot's agent key, who must still be an admin. This
 *     module issues nothing — it reads `findActiveGrant`, the same lookup the
 *     DELEGATED chat stamp uses, so there is ONE grant system, not two.
 *
 *  2. `rule:own_work_reviewed` — the card needs no new human signature: nothing
 *     gated is pending (no open PR), the card is THIS bot's own work, and the
 *     independent AI reviewer already passed it. Closing it is bookkeeping, not
 *     a decision.
 *
 * Never eligible, whatever grant exists (default deny):
 *  - the card is not in Needs You (status review with no agent session);
 *  - the card is waiting on a secret (a human must supply it);
 *  - the card is a Strategy (the owner's own top tier);
 *  - the card is on the money path (`isMoneyPath`, the auto-merge exclusion);
 *  - the bot is not in the registry, or the key may not reach the workspace.
 *
 * What "approve" does: the same review → done move a person's Approve click
 * makes, through the same PATCH handler (`runStatusChange`) so every completion
 * gate still runs. It does NOT merge anything — merging stays with the merge
 * lane / the owner, exactly as for a human Approve. (The one bot path that
 * merges is a separate, explicit request: `approval: merge` on the card message,
 * services/grant-merge.ts, obj 901231.) It is audited three ways:
 * the objective_audit row (actor = the bot, pathway `bot-approve:<basis>`), a
 * `delegation_audit` row when a grant was used (event `approval_used`), and a
 * `decision` line on the card.
 */
import type { Database } from 'better-sqlite3'
import {
  cardNeedsHuman,
  type ApprovalNeed,
  type BotApprovalEligibility,
  type Objective,
} from '@operationkit/shared'
import { isMoneyPath } from './merge-lane.js'
import { findActiveGrant } from './delegated-approvals.js'
import { resolveBot } from './bots/bot-registry.js'
import { cardOwnerBot } from './bots/card-owner.js'

/** The card fields eligibility reads. */
export type ApprovalCard = Pick<
  Objective,
  'id' | 'status' | 'session_id' | 'workspace' | 'title' | 'description' | 'owner_bot' | 'agent_context' | 'is_strategy' | 'pr_url' | 'pr_number'
> & {
  needs_secret?: unknown
  ai_review_verdict?: string | null
}

/** True when the card has a pull request that is neither merged nor closed. */
export function hasOpenPr(db: Database, card: Pick<Objective, 'id' | 'pr_url' | 'pr_number'>): boolean {
  let rows: { pr_number: number; state: string }[] = []
  try {
    rows = db.prepare('SELECT pr_number, state FROM objective_prs WHERE objective_id = ?').all(card.id) as typeof rows
  } catch {
    rows = []
  }
  if (rows.some(r => r.state === 'open')) return true
  if (!card.pr_url && card.pr_number == null) return false
  // The card points at a PR. If the PR log knows it, believe the log; if the
  // log has never heard of it, assume it is still open (the safe reading: it
  // then needs a merge grant rather than slipping through as "nothing pending").
  const known = rows.find(r => card.pr_number != null && r.pr_number === Number(card.pr_number))
  return known ? known.state === 'open' : rows.length === 0
}

function needsSecretCount(raw: unknown): number {
  if (Array.isArray(raw)) return raw.length
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v.length : 0
    } catch {
      return 0
    }
  }
  return 0
}

export interface EligibilityInput {
  card: ApprovalCard
  /** What the bot says it is (owner_bot on the request, else the key label). */
  declaredBot: unknown
  /** Owner of the agent key (the grantor a grant must belong to). */
  keyOwnerUserId: number | null
  /** The key's workspace allowlist; null = every workspace its owner can see. */
  keyWorkspaces: string[] | null
  now?: Date
}

/**
 * Decide whether a bot may approve this card right now. Pure apart from reads.
 */
export function botApprovalEligibility(db: Database, input: EligibilityInput): BotApprovalEligibility {
  const { card } = input
  const openPr = hasOpenPr(db, card)
  const need: ApprovalNeed = openPr ? 'merge' : 'close'
  const no = (refusal: BotApprovalEligibility['refusal'], reason: string, bot: string | null = null): BotApprovalEligibility =>
    ({ eligible: false, need, bot, refusal, reason })

  const resolved = resolveBot(input.declaredBot, db)
  if (!resolved.ok) return no('unknown_bot', `No approval: ${resolved.error}`)
  const bot = resolved.bot.id

  if (!cardNeedsHuman(card)) {
    return no('not_in_needs_you', `Card #${card.id} is not in Needs You (status ${card.status}${card.session_id ? ', an agent is still on it' : ''}), so there is nothing to approve.`, bot)
  }
  const workspace = (card.workspace ?? '').trim()
  if (input.keyWorkspaces && !input.keyWorkspaces.includes(workspace)) {
    return no('key_workspace_forbidden', `This agent key may not reach workspace "${workspace}".`, bot)
  }
  if (needsSecretCount(card.needs_secret) > 0) {
    return no('needs_secret', `Card #${card.id} is waiting on a secret only a person can supply.`, bot)
  }
  if (card.is_strategy) {
    return no('strategy', `Card #${card.id} is a Strategy; only the owner closes a Strategy.`, bot)
  }
  if (isMoneyPath(card)) {
    return no('money_path', `Card #${card.id} is on the money path (billing/payments); it always needs the owner.`, bot)
  }

  if (need === 'merge') {
    const grant = input.keyOwnerUserId != null && workspace
      ? findActiveGrant(db, { botName: bot, workspace, action: 'merge', grantorUserId: input.keyOwnerUserId, now: input.now })
      : null
    if (!grant) {
      return no(
        'no_active_grant',
        `Card #${card.id} has an open pull request, so approving it is a merge decision. ${bot} holds no active merge grant in "${workspace}" — the owner issues one in Settings → Bots → ${bot} → Approve on my behalf.`,
        bot,
      )
    }
    return {
      eligible: true,
      need,
      bot,
      basis: 'grant',
      grant_id: grant.id,
      reason: `${bot} may approve: active merge grant #${grant.id} in "${workspace}".`,
    }
  }

  // need === 'close': nothing gated pending. Only the bot's own, reviewed work.
  // One rule for "whose card is this" (services/bots/card-owner.ts): owner_bot
  // when set, else the bot behind agent_context (never the default slug). It
  // also carries the PR 797 guard: a registered bot that only shares the display
  // name of the chat bot that filed and works the card is not its owner.
  const isOwn = cardOwnerBot(card, db)?.botId === bot
  if (!isOwn) {
    return no('not_bot_owned', `Card #${card.id} is not ${bot}'s own work, and ${bot} holds no grant that covers it. A person approves it.`, bot)
  }
  if (card.ai_review_verdict !== 'pass') {
    return no('no_passing_review', `Card #${card.id} has no passing AI review, so closing it still needs a person.`, bot)
  }
  return {
    eligible: true,
    need,
    bot,
    basis: 'rule:own_work_reviewed',
    reason: `${bot} may close it: its own work, AI review passed, nothing gated pending.`,
  }
}
