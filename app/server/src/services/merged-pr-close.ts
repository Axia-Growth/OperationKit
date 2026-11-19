/**
 * Close a card when its pull request is merged on GitHub (obj 901454).
 *
 * A PR merged by hand on GitHub left its card in `review` forever: the
 * `pull_request` closed+merged webhook recorded the PR state and withdrew the
 * sign-off ask (`recordPRTerminalState` → `onPRMerged`) but never moved the
 * card. The merge IS the sign-off, so the webhook now moves the card to done
 * through the real status handler (`runStatusChange`), the same way the grant
 * merge and the Dev close tool do, so every completion gate still applies.
 *
 * Which cards move — deliberately narrow:
 *  - the card's OWN current PR is this one (`pr_number` + the repo in `pr_url`);
 *    an older PR in `objective_prs` that merged later never closes the card;
 *  - the card is in `review` or `ai_review` (a `working` card has a live
 *    session; done / cancelled / queue / planning cards are left alone);
 *  - never a Strategy, never a deleted card, never a card carrying a reserved
 *    PR (645 + the configured list — only the owner closes those).
 *
 * The move is a server action (`humanTerminal: false`), acted as the first
 * admin so the ownership check passes. Never throws.
 */
import type { Objective, User } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import { runStatusChange } from '../routes/objectives-status.js'
import { logActivity } from '../routes/feed.js'
import { repoFromPrUrl } from './ci-green-gate-run.js'
import { loadReservedPrs, reservedPrMatch, type ReservedPr } from './grant-merge.js'

export const MERGED_PR_CLOSE_PATHWAY = 'github-webhook:pr-merged'
const CLOSABLE = new Set(['review', 'ai_review'])

export interface MergedPrCloseResult {
  objectiveId: number
  outcome: 'closed' | 'skipped' | 'refused'
  reason: string
}

export async function closeCardsForMergedPr(
  input: { repo: string; prNumber: number },
  deps: { reserved?: readonly ReservedPr[] } = {},
): Promise<MergedPrCloseResult[]> {
  const out: MergedPrCloseResult[] = []
  const repo = String(input.repo || '').toLowerCase()
  const prNumber = Number(input.prNumber)
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) return out
  try {
    const db = getDb()
    const cards = (db
      .prepare('SELECT * FROM objectives WHERE pr_number = ? AND deleted_at IS NULL')
      .all(prNumber) as Objective[])
      .filter(c => (repoFromPrUrl(c.pr_url) ?? '').toLowerCase() === repo)
    if (!cards.length) return out
    const reserved = deps.reserved ?? loadReservedPrs()
    let admin: User | undefined
    for (const card of cards) {
      const skip = (outcome: 'skipped' | 'refused', reason: string) => out.push({ objectiveId: card.id, outcome, reason })
      if (!CLOSABLE.has(String(card.status))) { skip('skipped', `card is ${card.status}`); continue }
      if (card.is_strategy) { skip('skipped', 'strategy'); continue }
      if (reservedPrMatch(card, reserved)) { skip('skipped', 'reserved PR'); continue }
      admin ??= db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as User | undefined
      if (!admin) { skip('refused', 'no admin user to act as'); continue }
      const req = { user: admin, headers: {}, authVia: 'session' } as unknown as AuthRequest
      const r = await runStatusChange(req, card.id, 'done', {
        actor: 'server:github-webhook (PR merged)',
        pathway: MERGED_PR_CLOSE_PATHWAY,
        humanTerminal: false,
      })
      if (r.code !== 200) {
        skip('refused', (r.body as { error?: string } | undefined)?.error ?? `status ${r.code}`)
        continue
      }
      try {
        logActivity({
          project: card.project || 'operationkit',
          workspace: card.workspace ?? undefined,
          objective_id: card.id,
          event_type: 'decision',
          title: `PR #${prNumber} (${repo}) was merged on GitHub, so card #${card.id} is done`,
          metadata: { kind: 'merged_pr_close', repo, pr_number: prNumber },
        })
      } catch { /* the feed never decides the move */ }
      out.push({ objectiveId: card.id, outcome: 'closed', reason: `PR #${prNumber} merged` })
    }
  } catch (err) {
    console.error('[merged-pr-close] %s#%s:', repo, prNumber, (err as Error).message)
  }
  return out
}
