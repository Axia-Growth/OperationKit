/**
 * A merge made under a bot's merge grant never deploys itself (obj 901389).
 *
 * The owner chose autonomy level A on card #901383 (decision #29): Operation Kit
 * Dev may merge its own passed pull requests under an "Approve on my behalf"
 * MERGE grant (services/grant-merge.ts), and the owner deploys. Auto-deploy on
 * merge (services/auto-deploy.ts, `settings.auto_deploy_enabled`) used to fire on
 * EVERY merge to the install's own `main`, so a grant merge would have gone live
 * with no owner step.
 *
 * This module answers one question for the merged-PR webhook: "was this PR
 * merged under a merge grant, and if so does an active DEPLOY grant cover it?"
 *
 *  - Grant merge, no active deploy grant from the same admin for that bot in
 *    that workspace → do NOT auto-deploy; log why. The owner deploys.
 *  - Grant merge + an active deploy grant (`delegation_grants.allow_deploy`, the
 *    existing approval; nothing new) → auto-deploy exactly as today.
 *  - Anything else (a person's merge, the background auto-merge) → unchanged.
 *
 * How a grant merge is recognised, in order:
 *  1. the in-process marker `grant-merge.ts` sets just before it sends
 *     `gh pr merge` (GitHub can deliver the webhook before the route has written
 *     its audit row — the merge and the webhook race);
 *  2. the durable `delegation_audit` `approval_used` row the route writes after
 *     the merge (`reason = 'grant_merge:squash-merged <repo>#<n> at …'`).
 * Either one is enough. Unknown = not a grant merge = today's behaviour.
 */
import type { Database } from 'better-sqlite3'
import { findActiveGrant } from './delegated-approvals.js'

/** Who / what merged a PR under a grant. */
export interface GrantMergeRecord {
  grantId: number
  bot: string
  workspace: string
  grantorUserId: number
  objectiveId: number | null
}

// ── 1. the in-process marker (set by mergeUnderGrant around `gh pr merge`) ──

interface Marker {
  grantId: number
  objectiveId: number | null
  expiresAt: number
}
const MARKER_TTL_MS = 30 * 60_000
const markers = new Map<string, Marker>()

function key(repo: string, prNumber: number): string {
  return `${String(repo).trim().toLowerCase()}#${Number(prNumber)}`
}

/** Mark a PR as being merged under grant #N. Called just before `gh pr merge`. */
export function noteGrantMergeInFlight(repo: string, prNumber: number, grantId: number, objectiveId: number | null, now = Date.now()): void {
  markers.set(key(repo, prNumber), { grantId, objectiveId, expiresAt: now + MARKER_TTL_MS })
}

/** Test hook. */
export function resetGrantMergeMarkers(): void {
  markers.clear()
}

function markerGrantId(repo: string, prNumber: number, now: number): { grantId: number; objectiveId: number | null } | null {
  const m = markers.get(key(repo, prNumber))
  if (!m) return null
  if (m.expiresAt <= now) {
    markers.delete(key(repo, prNumber))
    return null
  }
  return { grantId: m.grantId, objectiveId: m.objectiveId }
}

// ── 2. the durable audit row ──

/** The `delegation_audit` reason prefix `runGrantApprovedMerge` writes on success. */
export function grantMergeReasonPrefix(repo: string, prNumber: number): string {
  return `grant_merge:squash-merged ${repo}#${prNumber} `
}

interface AuditRow { grant_id: number | null; objective_id: number | null }

function auditGrant(db: Database, repo: string, prNumber: number): { grantId: number; objectiveId: number | null } | null {
  try {
    const row = db
      .prepare(
        `SELECT grant_id, objective_id FROM delegation_audit
          WHERE event = 'approval_used' AND action = 'merge' AND grant_id IS NOT NULL
            AND lower(substr(reason, 1, ?)) = lower(?)
          ORDER BY id DESC LIMIT 1`,
      )
      .get(grantMergeReasonPrefix(repo, prNumber).length, grantMergeReasonPrefix(repo, prNumber)) as AuditRow | undefined
    if (!row || row.grant_id == null) return null
    return { grantId: Number(row.grant_id), objectiveId: row.objective_id == null ? null : Number(row.objective_id) }
  } catch {
    return null
  }
}

/**
 * The grant a PR was merged under, or null when it was not a grant merge (or
 * nothing on record says so). Reads only.
 */
export function findGrantMerge(db: Database, repo: string, prNumber: number, now = Date.now()): GrantMergeRecord | null {
  if (!repo || !Number.isInteger(prNumber) || prNumber <= 0) return null
  const hit = markerGrantId(repo, prNumber, now) ?? auditGrant(db, repo, prNumber)
  if (!hit) return null
  const g = db
    .prepare('SELECT bot_name, workspace, granting_user_id FROM delegation_grants WHERE id = ?')
    .get(hit.grantId) as { bot_name: string; workspace: string; granting_user_id: number } | undefined
  if (!g) {
    // The grant row is gone; it still WAS a grant merge. No grantor = no deploy grant can cover it.
    return { grantId: hit.grantId, bot: 'unknown bot', workspace: '', grantorUserId: 0, objectiveId: hit.objectiveId }
  }
  return { grantId: hit.grantId, bot: g.bot_name, workspace: g.workspace, grantorUserId: Number(g.granting_user_id), objectiveId: hit.objectiveId }
}

// ── the decision the webhook asks for ──

export type MergeDeployDecision =
  | { deploy: true; reason: 'not_grant_merge' }
  | { deploy: true; reason: 'deploy_grant'; grantMerge: GrantMergeRecord; deployGrantId: number }
  | { deploy: false; reason: 'grant_merge_without_deploy_grant'; grantMerge: GrantMergeRecord }
  | { deploy: false; reason: 'production_issue_fix'; objectiveId: number }

/**
 * obj 901771 — the card (origin 'production-issue') whose pull request this is,
 * or null. A fix filed from a production signal never auto-deploys, whoever
 * merged it: a person deploys it. Matches on the PR number AND the repo (from the
 * card's pr_url), so a same-numbered PR in another repo is not a match.
 */
export function productionIssueCardForPr(db: Database, repo: string, prNumber: number): number | null {
  const rows = db
    .prepare(
      `SELECT id, pr_url FROM objectives
        WHERE origin = 'production-issue' AND deleted_at IS NULL AND (pr_number = ? OR pr_url LIKE ?)
        ORDER BY id DESC`,
    )
    .all(prNumber, `%/pull/${prNumber}`) as Array<{ id: number; pr_url: string | null }>
  const want = repo.toLowerCase()
  for (const r of rows) {
    const m = /github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/i.exec(r.pr_url ?? '')
    if (!m) return r.id // number matched and no URL to tell repos apart: fail closed (no auto-deploy)
    if (m[1].toLowerCase() === want && Number(m[2]) === prNumber) return r.id
  }
  return null
}

/**
 * Whether a merged PR on the install's own `main` may auto-deploy (when
 * auto-deploy is on at all — the caller checks that). Never throws: a lookup
 * error is treated as "not a grant merge", which is exactly today's behaviour.
 */
export function decideMergeAutoDeploy(db: Database, repo: string, prNumber: number, now = new Date()): MergeDeployDecision {
  try {
    const pi = productionIssueCardForPr(db, repo, prNumber)
    if (pi != null) return { deploy: false, reason: 'production_issue_fix', objectiveId: pi }
  } catch {
    /* unreadable: fall through to today's behaviour */
  }
  let gm: GrantMergeRecord | null = null
  try {
    gm = findGrantMerge(db, repo, prNumber, now.getTime())
  } catch {
    gm = null
  }
  if (!gm) return { deploy: true, reason: 'not_grant_merge' }
  if (gm.grantorUserId > 0 && gm.workspace) {
    try {
      const dg = findActiveGrant(db, { botName: gm.bot, workspace: gm.workspace, action: 'deploy', grantorUserId: gm.grantorUserId, now })
      if (dg) return { deploy: true, reason: 'deploy_grant', grantMerge: gm, deployGrantId: dg.id }
    } catch {
      /* unreadable grant table: fail closed for a grant merge */
    }
  }
  return { deploy: false, reason: 'grant_merge_without_deploy_grant', grantMerge: gm }
}

/** The one log line for a skipped auto-deploy. */
export function skippedDeployLine(repo: string, prNumber: number, gm: GrantMergeRecord): string {
  return (
    `[auto-deploy] SKIPPED — ${repo}#${prNumber} was merged by bot "${gm.bot}" under merge grant #${gm.grantId}` +
    `${gm.objectiveId ? ` (card #${gm.objectiveId})` : ''}; no active deploy grant from the same admin covers that bot in ` +
    `${gm.workspace ? `workspace "${gm.workspace}"` : 'its workspace'}. Merged, not live until the owner deploys.`
  )
}
