/**
 * Operation Kit Dev: close cards the owner already merged by hand (obj 901424, scope 3).
 *
 * The owner merges some PRs himself on GitHub. The card then sits in review
 * waiting for "done", which for a bot has meant an admin sign-off (an agent key
 * needs a passing review or override_reason; MCP says done is a human
 * signature). Here the MERGE is the sign-off, read live from GitHub:
 *
 *  - done on a card WITH a PR: GitHub must say the PR is MERGED. Any card the
 *    person and the bot can see, in a workspace the bot may use.
 *  - done on a card with NO PR, and cancelled on any card: Dev's own cards only
 *    (owned or filed by Dev).
 *  - Never a Strategy, never a card carrying a reserved PR (645 and the
 *    configured list), never a card that is not on a board the person sees.
 *
 * The move runs the real status handler (`runStatusChange`), so every completion
 * gate still applies; it is recorded as the bot acting for the admin, not as a
 * human terminal. Every call writes a dev_ops_audit row.
 */
import type { Objective, ObjectiveStatus, User } from '@operationkit/shared'
import { getDb } from '../../db/index.js'
import type { AuthRequest } from '../../middleware/auth.js'
import { runStatusChange } from '../../routes/objectives-status.js'
import { logActivity } from '../../routes/feed.js'
import { repoFromPrUrl } from '../ci-green-gate-run.js'
import { loadReservedPrs, reservedPrMatch, type ReservedPr } from '../grant-merge.js'
import { writeDevOpsAudit } from './audit.js'
import { isDevCard, prNumberOf, type DevActor, type DevMergeCard, type DevMergeDeps } from './merge.js'
import { resolveMergeGithubAuth } from '../grant-merge-github-auth.js'

export type DevCloseStatus = 'done' | 'cancelled'

export interface DevCloseResult {
  ok: boolean
  code: 'closed' | 'already' | 'strategy' | 'reserved_pr' | 'not_dev_card' | 'pr_not_merged' | 'pr_state_unreadable' | 'github_credential_missing' | 'status_refused' | 'bad_status'
  message: string
}

export async function devCloseCard(
  card: DevMergeCard & Pick<Objective, 'status'>,
  status: DevCloseStatus,
  actor: DevActor,
  note: string,
  deps: DevMergeDeps & { reserved?: readonly ReservedPr[] } = {},
): Promise<DevCloseResult> {
  const audit = (r: DevCloseResult) => {
    writeDevOpsAudit({
      bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: `close_${status}`,
      target: `card #${card.id}`, objective_id: card.id,
      outcome: r.ok ? 'done' : 'refused', code: r.code, detail: note ? `${r.message} Note: ${note}` : r.message,
    })
    return r
  }
  if (status !== 'done' && status !== 'cancelled') return audit({ ok: false, code: 'bad_status', message: 'status must be done or cancelled.' })
  if (card.is_strategy) return audit({ ok: false, code: 'strategy', message: `Card #${card.id} is a Strategy; only the owner closes it.` })
  const hit = reservedPrMatch(card, deps.reserved ?? loadReservedPrs())
  if (hit) return audit({ ok: false, code: 'reserved_pr', message: `Card #${card.id} carries reserved PR #${hit.number}; only the owner closes it.` })
  if (card.status === status) return audit({ ok: true, code: 'already', message: `Card #${card.id} is already ${status}.` })

  const prNumber = prNumberOf(card)
  let reason: string
  if (status === 'done' && prNumber > 0) {
    const repo = repoFromPrUrl(card.pr_url)
    if (!repo) return audit({ ok: false, code: 'pr_state_unreadable', message: `Card #${card.id} has PR #${prNumber} but no GitHub link; cannot confirm it was merged.` })
    const exec = deps.exec ?? resolveMergeGithubAuth({ workspace: card.workspace, grantorUserId: actor.userId, agent: actor.botSlug })?.exec
    if (!exec) return audit({ ok: false, code: 'github_credential_missing', message: 'The server has no GitHub credential to confirm the merge.' })
    let state = ''
    try {
      const raw = await exec('gh', ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'state,mergeStateStatus'])
      state = String((JSON.parse(raw) as { state?: string }).state ?? '').toUpperCase()
    } catch (err) {
      return audit({ ok: false, code: 'pr_state_unreadable', message: `Could not read PR #${prNumber} on ${repo} (${(err as Error).message}).` })
    }
    if (state !== 'MERGED') {
      return audit({ ok: false, code: 'pr_not_merged', message: `PR #${prNumber} on ${repo} is ${state.toLowerCase() || 'unknown'}, not merged. A card with a PR is marked done here only after its PR is merged.` })
    }
    reason = `PR #${prNumber} (${repo}) is merged on GitHub`
  } else {
    if (!isDevCard(card)) {
      return audit({ ok: false, code: 'not_dev_card', message: `Card #${card.id} is not a Dev bot card. ${status === 'done' ? 'Without a merged PR, only' : 'Only'} Dev's own cards are closed this way.` })
    }
    reason = status === 'done' ? 'Dev card with no PR' : 'Dev card cancelled'
  }

  const db = getDb()
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(actor.userId) as User | undefined
  const req = { user, headers: {}, authVia: 'session' } as unknown as AuthRequest
  const r = await runStatusChange(req, card.id, status as ObjectiveStatus, {
    actor: `bot:${actor.botSlug} (chat, for ${actor.username})`,
    pathway: `dev-ops:close-${status}`,
    humanTerminal: false,
  })
  if (r.code !== 200) {
    return audit({ ok: false, code: 'status_refused', message: `The board refused moving card #${card.id} to ${status}: ${(r.body as { error?: string } | undefined)?.error ?? `status ${r.code}`}` })
  }
  try {
    logActivity({
      project: card.project || 'operationkit',
      workspace: card.workspace ?? undefined,
      objective_id: card.id,
      event_type: 'decision',
      title: `The Dev bot marked card #${card.id} ${status} for ${actor.username} (${reason})${note ? `: ${note.slice(0, 300)}` : ''}`,
      metadata: { kind: 'dev_ops_close', status, reason },
    })
  } catch { /* the feed never decides the move */ }
  return audit({ ok: true, code: 'closed', message: `Card #${card.id} is ${status} (${reason}).` })
}
