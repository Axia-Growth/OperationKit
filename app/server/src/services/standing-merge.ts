/**
 * Standing merge (obj 901388): a bot merges its own passed PR under the owner's
 * merge grant WITHOUT being asked each time.
 *
 * On card #901383 the owner chose autonomy level A: Operation Kit Dev merges
 * its own passed pull requests; the owner deploys. The merge path already
 * existed (PR 858 / 875) but only ran when a person typed "merge" in chat or a
 * bot sent `approval: merge`. This module is the third door onto that SAME
 * path, opened only by a per-grant switch the owner ticks in the browser:
 * "Merge without asking me each time" (`delegation_grants.standing_merge`).
 *
 * Why the server does it (option a), not a bot wake (option b): no judgement is
 * needed. Every rule that decides whether a merge is safe already lives in
 * `mergeUnderGrant` (services/grant-merge.ts); a model turn would add cost and a
 * way to get it wrong, and nothing it could add.
 *
 * When: right after the reviewer-PASS branch of the state poller
 * (`kickStandingMerge`) and on a 60s sweep (`startStandingMergeSweeper`, host
 * only) that catches a card which reached review another way and re-looks at a
 * PR whose CI is still running.
 *
 * Per card, in order:
 *  1. there is a grant with the switch on for this bot × the card's workspace.
 *     NO such grant ever issued → this module does nothing at all (today's
 *     behaviour, byte for byte: not one read of a card).
 *  2. the card is the bot's OWN (`botMayActOnOwnCard` → `cardOwnerBot`) in a
 *     workspace the bot may use — the same gate as the chat tool;
 *  3. the grant: `decideStandingMergeApproval` → the shared `grantDecision`
 *     with `standingOnly` (active, not revoked, not expired, grantor still an
 *     admin, merge ticked, switch on);
 *  4. CI still running → WAIT (no refusal, no audit row) and look again on the
 *     next sweep, for at most `standingMergeCiWaitMs()` (60 min);
 *  5. `runGrantApprovedMerge` UNCHANGED → `mergeUnderGrant` (reserved PRs
 *     before any GitHub call, review/strategy/project/money-path, verdict pass,
 *     strict live CI, PR open + CLEAN/HAS_HOOKS, `--match-head-commit`) → card
 *     done. Audit rows are the usual `approval_used` / `approval_denied`, with
 *     `agent_key_label = standing:<slug>` so a standing merge is told apart
 *     from a chat merge (`chat:<slug>`) or a card message (the key's label).
 *
 * A refusal is FINAL for that review: the card stays in review, one line goes
 * on the card (`activity_log` kind `standing_merge_refused`, keyed by the
 * review iteration + reviewer session), and it is not tried again until a NEW
 * AI review finishes. A person can still merge from chat at any time.
 *
 * Telling the owner: a standing merge posts one line in the bot's chat with
 * the person who gave the grant ("merged, not live until you deploy"). A
 * grant that ended (expired / revoked / grantor no longer admin) is said once
 * per grant in that chat and once per card on the card, with the date it
 * ended and where to renew it.
 *
 * Never read or written here: `settings.auto_merge_enabled`. Never done here:
 * deploy, migration, any change to the grant.
 */
import type { Objective, User } from '@operationkit/shared'
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'
import type { AuthRequest } from '../middleware/auth.js'
import {
  decideStandingMergeApproval,
  listStandingGrants,
  sqliteUtc,
  standingMergeAuditLabel,
  writeDelegationAudit,
  type StandingGrantRow,
} from './delegated-approvals.js'
import { loadReservedPrs, precheckGrantMerge, readMergeCi } from './grant-merge.js'
import { BRANCH_UPDATED_CODE } from './grant-merge-update-branch.js'
import { cardOwnerBot, ownerHasSlug } from './bots/card-owner.js'
import type { ExecFn } from './ci-green-gate-decide.js'

export const STANDING_MERGE_TICK_MS = 60_000
export const STANDING_MERGE_REFUSED_KIND = 'standing_merge_refused'
export const STANDING_MERGE_GRANT_ENDED_KIND = 'standing_merge_grant_ended'
const DEFAULT_CI_WAIT_MINUTES = 60

/** How long a standing merge waits for running CI before it gives up (env `CC_STANDING_MERGE_CI_WAIT_MINUTES`). */
export function standingMergeCiWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CC_STANDING_MERGE_CI_WAIT_MINUTES)
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_CI_WAIT_MINUTES) * 60_000
}

/** Where a person renews a grant, in the words the settings page uses. */
export function renewWhere(botName: string): string {
  return `Bots → ${botName} → Settings → Approve on my behalf`
}

export type StandingMergeOutcome =
  | 'merged'
  | 'merged_not_done'
  | 'waiting'
  | 'refused'
  | 'skipped'

export interface StandingMergeResult {
  objective_id: number
  outcome: StandingMergeOutcome
  code?: string
  grant_id?: number
  detail?: string
}

export interface StandingMergeDeps {
  db?: Database.Database
  /**
   * GitHub runner for the CI look only (tests); by default the CI look resolves
   * the same credential as the merge (obj 901372). The merge itself always goes
   * through mergeUnderGrant with its own resolution.
   */
  exec?: ExecFn
  now?: () => Date
  /** Live sidebar push after a chat line; defaults to the real one. */
  notify?: (userId: number, slug: string) => void
  /** Only look at this card (the reviewer-pass kick). */
  onlyCardId?: number
}

// ── process-local state ───────────────────────────────────────────────────────

/** Cards being merged right now: two overlapping sweeps never both try one. */
const inFlight = new Set<number>()
/** review key → first time CI was seen still running (bounded wait). */
const ciWaitSince = new Map<string, number>()

/** Test hook. */
export function resetStandingMergeState(): void {
  inFlight.clear()
  ciWaitSince.clear()
}

// ── helpers ───────────────────────────────────────────────────────────────────

type CardRow = Objective & { ai_review_iteration?: number | null }

/** One AI review = one attempt. A new review (new iteration / reviewer session) is a new attempt. */
export function reviewKey(card: { id: number; ai_review_iteration?: number | null; ai_review_session_id?: string | null }): string {
  return `${card.id}:${card.ai_review_iteration ?? 0}:${card.ai_review_session_id ?? 'none'}`
}

function alreadyNoted(db: Database.Database, cardId: number, key: string): boolean {
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = ?
            AND json_extract(metadata, '$.review_key') = ? LIMIT 1`,
      )
      .get(cardId, STANDING_MERGE_REFUSED_KIND, key)
  } catch {
    return false
  }
}

function endedDate(sqlite: string): string {
  return String(sqlite).slice(0, 10)
}

/** Why a grant with the switch on no longer counts, or null when it is live. */
export function grantEnded(g: StandingGrantRow, now: Date): { code: 'grant_revoked' | 'grant_expired' | 'grantor_not_admin'; sentence: string } | null {
  if (g.revoked_at) return { code: 'grant_revoked', sentence: `was revoked on ${endedDate(g.revoked_at)}` }
  if (g.expires_at <= sqliteUtc(now)) return { code: 'grant_expired', sentence: `ended on ${endedDate(g.expires_at)}` }
  if (g.grantor_role !== 'admin') return { code: 'grantor_not_admin', sentence: `no longer counts: ${g.grantor_username ?? `user #${g.granting_user_id}`} who gave it is not an admin any more` }
  return null
}

async function loadChatBits() {
  const [{ logActivity }, { runGrantApprovedMerge }, { findAgent }, { chatBotGrantName }, { botMayUseWorkspace }, { botMayActOnOwnCard }, { notifyBotMessage }] = await Promise.all([
    import('../routes/feed.js'),
    import('../routes/grant-merge-route.js'),
    import('./agent-chat/engine.js'),
    import('./agent-chat/grant-merge-tool.js'),
    import('./agent-chat/bot-workspaces.js'),
    import('../lib/high-agency-wake-scope.js'),
    import('./agent-chat/sidebar-live.js'),
  ])
  return { logActivity, runGrantApprovedMerge, findAgent, chatBotGrantName, botMayUseWorkspace, botMayActOnOwnCard, notifyBotMessage }
}
type Bits = Awaited<ReturnType<typeof loadChatBits>>

function postChat(db: Database.Database, bits: Bits, deps: StandingMergeDeps, userId: number, slug: string, content: string, meta: Record<string, unknown>): void {
  try {
    db.prepare("INSERT INTO agent_chat_messages (user_id, agent_slug, role, content, meta) VALUES (?, ?, 'assistant', ?, ?)").run(
      userId,
      slug,
      content,
      JSON.stringify(meta),
    )
    ;(deps.notify ?? bits.notifyBotMessage)(userId, slug)
  } catch (err) {
    console.warn(`[standing-merge] could not post to ${slug}'s chat:`, (err as Error).message)
  }
}

/** The one line on the card for a refusal; the marker that stops a retry for this review. */
function noteRefusal(
  db: Database.Database,
  bits: Bits,
  card: CardRow,
  key: string,
  r: { code: string; error: string; grantId?: number; bot: string; slug: string },
): void {
  try {
    bits.logActivity({
      project: card.project || 'operationkit',
      workspace: card.workspace ?? undefined,
      objective_id: card.id,
      event_type: 'decision',
      title: `Not merged on its own (standing merge): ${r.error}`,
      detail: 'The card stays in review. It is tried again only after a new AI review passes; you can still ask the bot to merge it in chat.',
      metadata: { kind: STANDING_MERGE_REFUSED_KIND, review_key: key, code: r.code, grant_id: r.grantId ?? null, bot: r.bot, slug: r.slug },
    })
  } catch (err) {
    console.warn(`[standing-merge] card #${card.id}: could not write the refusal note:`, (err as Error).message)
  }
  console.log(`[standing-merge] card #${card.id} not merged (${r.code}): ${r.error}`)
}

function denyAudit(db: Database.Database, card: CardRow, g: StandingGrantRow, slug: string, reason: string, message: string): void {
  try {
    writeDelegationAudit(db, {
      event: 'approval_denied',
      grant_id: g.id,
      objective_id: card.id,
      workspace: card.workspace ?? null,
      bot_name: g.bot_name,
      action: 'merge',
      actor: g.grantor_username,
      agent_key_id: null,
      agent_key_label: standingMergeAuditLabel(slug),
      reason,
      message,
    })
  } catch (err) {
    console.warn('[standing-merge] audit write failed:', (err as Error).message)
  }
}

// ── the sweep ─────────────────────────────────────────────────────────────────

/**
 * One pass. Returns what happened per card looked at (tests and logs). Never
 * throws for one card's failure; a bad card does not stop the others.
 */
export async function runStandingMergeSweep(deps: StandingMergeDeps = {}): Promise<StandingMergeResult[]> {
  const db = deps.db ?? getDb()
  const now = deps.now?.() ?? new Date()
  const grants = listStandingGrants(db)
  if (grants.length === 0) return [] // no switch ever ticked: nothing to do, nothing read

  const bits = await loadChatBits()
  const out: StandingMergeResult[] = []

  // Newest live grant per bot × workspace × chat bot; else the newest ended one.
  const groups = new Map<string, { live: StandingGrantRow | null; ended: StandingGrantRow | null }>()
  for (const g of grants) {
    if (!g.agent_slug) continue
    const k = `${g.bot_name}\u0000${g.workspace}\u0000${g.agent_slug.toLowerCase()}`
    const cur = groups.get(k) ?? { live: null, ended: null }
    if (!grantEnded(g, now)) cur.live ??= g
    else cur.ended ??= g
    groups.set(k, cur)
  }

  for (const { live, ended } of groups.values()) {
    const g = live ?? ended!
    const slug = g.agent_slug!.toLowerCase()
    const agent = bits.findAgent(slug)
    if (!agent) continue // bot uninstalled: nothing to act as
    if (bits.chatBotGrantName(agent) !== g.bot_name) continue // the slug now speaks as another bot
    const botLabel = agent.name || slug

    const params: unknown[] = [g.workspace]
    let sql = `SELECT * FROM objectives WHERE deleted_at IS NULL AND status = 'review' AND pr_number > 0
                 AND ai_review_verdict IS NOT NULL AND TRIM(COALESCE(workspace, '')) = ?`
    // An ended grant only explains a card that WOULD have merged: a passed one.
    if (!live) sql += ` AND ai_review_verdict = 'pass'`
    if (deps.onlyCardId != null) {
      sql += ' AND id = ?'
      params.push(deps.onlyCardId)
    }
    let cards: CardRow[] = []
    try {
      cards = db.prepare(sql + ' ORDER BY id').all(...params) as CardRow[]
    } catch (err) {
      console.warn('[standing-merge] card read failed:', (err as Error).message)
      continue
    }

    for (const card of cards) {
      const owned = ownerHasSlug(cardOwnerBot(card, db), slug)
      const worked = String(card.agent_context ?? '').trim().toLowerCase() === slug
      if (!owned && !worked) continue // not this bot's business at all
      if (inFlight.has(card.id)) continue
      const key = reviewKey(card)
      if (alreadyNoted(db, card.id, key)) continue
      inFlight.add(card.id)
      try {
        out.push(await attemptCard(db, bits, deps, now, card, key, g, live, slug, botLabel))
      } catch (err) {
        console.warn(`[standing-merge] card #${card.id} failed:`, (err as Error).message)
        out.push({ objective_id: card.id, outcome: 'skipped', detail: (err as Error).message })
      } finally {
        inFlight.delete(card.id)
      }
    }
  }
  return out
}

async function attemptCard(
  db: Database.Database,
  bits: Bits,
  deps: StandingMergeDeps,
  now: Date,
  card: CardRow,
  key: string,
  g: StandingGrantRow,
  live: StandingGrantRow | null,
  slug: string,
  botLabel: string,
): Promise<StandingMergeResult> {
  const message = `Standing merge: ${botLabel} merges its own passed card under grant #${g.id} ("Merge without asking me each time"), without being asked.`
  const refuse = (code: string, error: string, grantId = g.id): StandingMergeResult => {
    noteRefusal(db, bits, card, key, { code, error, grantId, bot: g.bot_name, slug })
    ciWaitSince.delete(key)
    return { objective_id: card.id, outcome: 'refused', code, grant_id: grantId, detail: error }
  }

  // The grant with the switch on has ended: say when, and where to renew it.
  if (!live) {
    const why = grantEnded(g, now)!
    const error = `the standing merge grant #${g.id} for ${botLabel} ${why.sentence}. Renew it in ${renewWhere(botLabel)}.`
    denyAudit(db, card, g, slug, `standing_merge:${why.code}`, message)
    const r = refuse(why.code, error)
    tellGrantEndedOnce(db, bits, deps, g, slug, error)
    return r
  }

  // Only the bot's OWN card, in a workspace the bot may use (same gate as chat).
  const workspace = (card.workspace || '').trim()
  const own = bits.botMayUseWorkspace(slug, workspace)
    ? bits.botMayActOnOwnCard({ slug, workspace }, card.id, db)
    : ({ ok: false, reason: 'other_workspace' } as const)
  if (!own.ok) {
    denyAudit(db, card, g, slug, `grant_merge:${own.reason}`, message)
    return refuse(own.reason, `card #${card.id} is not one of ${botLabel}'s own cards, so it is never merged under ${botLabel}'s grant.`)
  }

  // The grant, through the shared rule (switch on, active, grantor still admin).
  const grantor = db.prepare('SELECT * FROM users WHERE id = ?').get(g.granting_user_id) as User | undefined
  if (!grantor) return refuse('no_person', `the person who gave grant #${g.id} no longer exists.`)
  const d = decideStandingMergeApproval(db, { grantor: { id: grantor.id, username: grantor.username }, botName: g.bot_name, chatSlug: slug }, card, message, now)
  if (d.kind !== 'allowed') {
    return refuse(d.kind === 'denied' ? d.code : 'no_approval', d.kind === 'denied' ? d.error : 'No approval was made.')
  }

  // CI still running is a wait, not a refusal (bounded). Reserved / project /
  // verdict / money-path refusals need no GitHub call: precheck first.
  const waitMs = standingMergeCiWaitMs()
  const waiting = (detail: string): StandingMergeResult | null => {
    const since = ciWaitSince.get(key) ?? now.getTime()
    ciWaitSince.set(key, since)
    if (now.getTime() - since >= waitMs) return null // waited long enough: let the merge path refuse it
    return { objective_id: card.id, outcome: 'waiting', grant_id: d.grantId, detail }
  }
  if (!precheckGrantMerge(card, loadReservedPrs())) {
    const ci = await readMergeCi(card, { exec: deps.exec, auth: { grantorUserId: grantor.id, workspace, agent: slug } })
    if (!ci.green && (('pending' in ci && ci.pending) || ('unreadable' in ci && ci.unreadable))) {
      const w = waiting(ci.reason)
      if (w) return w
    }
  }

  const req = { user: grantor, headers: {}, authVia: 'session' } as unknown as AuthRequest
  const r = await bits.runGrantApprovedMerge(req, card, d, message, { id: null, label: standingMergeAuditLabel(slug), agent: slug })
  const body = r.body as { merged?: boolean; code?: string; error?: string; pr_url?: string; pending?: boolean }

  if (body.merged) {
    ciWaitSince.delete(key)
    const prNumber = Number(card.pr_number)
    const tail = r.status === 200 ? 'Card done.' : `The card could not be marked done (${body.error ?? `status ${r.status}`}); it stays in review.`
    postChat(
      db, bits, deps, grantor.id, slug,
      `Merged PR #${prNumber} for card #${card.id} on my own, under your standing merge grant #${d.grantId}: AI review passed and CI was green. ${tail} Merged, not live until you deploy.`,
      { kind: 'standing_merge', objective_id: card.id, pr_number: prNumber, pr_url: body.pr_url ?? card.pr_url, grant_id: d.grantId },
    )
    if (r.status !== 200) {
      // Merged but not done: never try this review again (the PR is no longer open).
      noteRefusal(db, bits, card, key, { code: 'merged_not_done', error: body.error ?? 'merged, but the card could not be marked done', grantId: d.grantId, bot: g.bot_name, slug })
      return { objective_id: card.id, outcome: 'merged_not_done', grant_id: d.grantId, detail: body.error }
    }
    return { objective_id: card.id, outcome: 'merged', grant_id: d.grantId }
  }

  // obj 901465 (main's PR 896): the PR was BEHIND, so the merge path updated the
  // branch from its base itself (GitHub update-branch) and merged nothing. CI now
  // runs on the new head: that is a wait, never a final refusal. The wait clock
  // restarts for the new head; a later sweep merges once its CI is green and
  // GitHub says CLEAN (same path, pinned to that head).
  if (body.code === BRANCH_UPDATED_CODE) {
    ciWaitSince.set(key, now.getTime())
    return { objective_id: card.id, outcome: 'waiting', grant_id: d.grantId, detail: body.error ?? 'branch updated from its base; CI running on the new head' }
  }

  // A push between the look and the merge re-started CI: still a wait.
  if (body.pending) {
    const w = waiting(body.error ?? 'CI still running')
    if (w) return w
  }
  return refuse(body.code ?? 'refused', body.error ?? `refused (${r.status})`, d.grantId)
}

/** Once per ended grant: tell its owner in the bot's chat when it ended and where to renew it. */
function tellGrantEndedOnce(db: Database.Database, bits: Bits, deps: StandingMergeDeps, g: StandingGrantRow, slug: string, error: string): void {
  try {
    const told = db
      .prepare(`SELECT 1 FROM activity_log WHERE json_extract(metadata, '$.kind') = ? AND json_extract(metadata, '$.grant_id') = ? LIMIT 1`)
      .get(STANDING_MERGE_GRANT_ENDED_KIND, g.id)
    if (told) return
    bits.logActivity({
      project: 'operationkit',
      workspace: g.workspace,
      event_type: 'decision',
      title: `Standing merge stopped: ${error}`,
      metadata: { kind: STANDING_MERGE_GRANT_ENDED_KIND, grant_id: g.id, bot: g.bot_name, slug },
    })
    postChat(db, bits, deps, g.granting_user_id, slug, `I did not merge a passed card on my own: ${error[0].toUpperCase()}${error.slice(1)}`, {
      kind: STANDING_MERGE_GRANT_ENDED_KIND,
      grant_id: g.id,
    })
  } catch (err) {
    console.warn('[standing-merge] could not tell the owner the grant ended:', (err as Error).message)
  }
}

// ── scheduling (host only) ────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null
let running: Promise<unknown> | null = null

function runOnce(deps: StandingMergeDeps = {}): void {
  if (running) return // the next tick picks up anything this one missed
  running = runStandingMergeSweep(deps)
    .catch(err => console.warn('[standing-merge] sweep failed:', (err as Error).message))
    .finally(() => {
      running = null
    })
}

/** Host only (index.ts, never on a scratch instance): a sweep every 60s. */
export function startStandingMergeSweeper(): void {
  if (timer) return
  timer = setInterval(() => runOnce(), STANDING_MERGE_TICK_MS)
  timer.unref?.()
}

export function stopStandingMergeSweeper(): void {
  if (timer) clearInterval(timer)
  timer = null
}

/**
 * Called from the reviewer-PASS branch of the state poller. A no-op unless the
 * sweeper runs (host only) — and the sweep itself does nothing without a grant
 * that has the switch on.
 */
export function kickStandingMerge(cardId: number): void {
  if (!timer) return
  setImmediate(() => {
    if (inFlight.has(cardId)) return
    runStandingMergeSweep({ onlyCardId: cardId }).catch(err => console.warn('[standing-merge] kick failed:', (err as Error).message))
  })
}
