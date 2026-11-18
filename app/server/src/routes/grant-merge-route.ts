/**
 * The route half of the grant-approved merge (obj 901231). The rules live in
 * services/grant-merge.ts; this file runs them for one card message, then
 * moves the card to done through the same PATCH handler a click uses
 * (`runStatusChange`) so every completion gate still applies, and writes the
 * audit trail: a `delegation_audit` row for the grant use (or the refusal) and
 * a `decision` line on the card naming the merge.
 */
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import { writeDelegationAudit, type DelegationDecision } from '../services/delegated-approvals.js'
import { mergeUnderGrant } from '../services/grant-merge.js'
import { runStatusChange } from './objectives-status.js'
import { logActivity } from './feed.js'

type Allowed = Extract<DelegationDecision, { kind: 'allowed' }>

/**
 * Which door the approval came through, for the audit row and the card line.
 * The card-message path omits it (the request's agent key is used); a chat
 * turn (obj 901347, services/agent-chat/grant-merge-tool.ts) has no agent key
 * and passes `{ id: null, label: 'chat:<slug>' }`.
 */
export interface GrantMergeVia {
  id: number | null
  label: string
  /** The chat bot's slug, for the person's GitHub "Who can use it" rule (obj 901372). */
  agent?: string
}

export async function runGrantApprovedMerge(
  req: AuthRequest,
  card: Objective,
  d: Allowed,
  message: string,
  via?: GrantMergeVia,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const db = getDb()
  const key: GrantMergeVia = via ?? { id: req.agentKey!.id, label: req.agentKey!.label }
  const actor = req.user?.username ?? 'unknown'
  const base = {
    objective_id: card.id,
    workspace: card.workspace ?? null,
    bot_name: d.bot,
    action: 'merge',
    actor,
    agent_key_id: key.id,
    agent_key_label: key.label,
    message,
  }

  // The grantor is the person this request acts for (grantDecision keys the grant
  // on req.user), so theirs is the GitHub connection a merge may fall back to.
  const merged = await mergeUnderGrant(card, { auth: { grantorUserId: req.user?.id ?? null, agent: via?.agent ?? null } })
  if (!merged.ok) {
    try {
      writeDelegationAudit(db, { ...base, event: 'approval_denied', grant_id: d.grantId, reason: `grant_merge:${merged.code}` })
    } catch (err) {
      console.warn('[grant-merge] audit write failed:', (err as Error).message)
    }
    console.warn(`[grant-merge] card #${card.id} refused (${merged.code}): ${merged.error}`)
    return { status: merged.status, body: { error: merged.error, code: merged.code, merged: false } }
  }

  const mergeLine = `Squash-merged PR #${merged.prNumber} (${merged.repo}) — approved by ${d.bot} on behalf of ${d.onBehalfOf} under grant #${d.grantId} (merge)`
  try {
    writeDelegationAudit(db, {
      ...base,
      event: 'approval_used',
      grant_id: d.grantId,
      reason: `grant_merge:squash-merged ${merged.repo}#${merged.prNumber} at ${merged.headSha || 'unknown sha'}; ${merged.ci}`,
    })
    logActivity({
      project: card.project || 'operationkit',
      workspace: card.workspace ?? undefined,
      objective_id: card.id,
      event_type: 'decision',
      title: mergeLine,
      detail: `> ${message.trim().slice(0, 500)}`,
      metadata: {
        kind: 'grant_merge',
        grant_id: d.grantId,
        bot: d.bot,
        on_behalf_of: d.onBehalfOf,
        repo: merged.repo,
        pr_number: merged.prNumber,
        head_sha: merged.headSha,
        agent_key_id: key.id,
        agent_key_label: key.label,
      },
    })
  } catch (err) {
    console.warn('[grant-merge] audit/card line failed:', (err as Error).message)
  }

  // Only now, with the PR merged, close the card.
  const done = await runStatusChange(req, card.id, 'done', {
    actor: via ? `bot:${d.bot} (${key.label})` : `bot:${d.bot} (key ${key.label})`,
    pathway: `grant-merge:#${d.grantId}`,
    humanTerminal: false,
  })
  if (done.code !== 200) {
    console.warn(`[grant-merge] card #${card.id}: PR #${merged.prNumber} merged but the done move was refused (${done.code})`)
    return {
      status: done.code,
      body: {
        ...(done.body as object),
        merged: true,
        pr_url: merged.prUrl,
        error: `PR #${merged.prNumber} was squash-merged, but the card could not be marked done: ${(done.body as { error?: string } | undefined)?.error ?? `status ${done.code}`}`,
        code: 'merged_not_done',
      },
    }
  }
  return {
    status: 200,
    body: { ...(done.body as object), merged: true, pr_url: merged.prUrl, merge_line: mergeLine },
  }
}
