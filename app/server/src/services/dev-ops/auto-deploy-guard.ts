/**
 * Guarded auto-deploy for Operation Kit Dev merges — the GUARD only (obj 901466).
 *
 * Design: docs/design/guarded-auto-deploy.md. The owner approves the design in
 * the pull request; nothing here starts a deploy.
 *
 * This file answers one question with no side effects: "given these facts about
 * the batch of commits waiting on main and the state of the install, may an
 * automatic deploy run now?" Every refusal in the design has one code here and
 * one test in auto-deploy-guard.test.ts.
 *
 * What is NOT in this file, on purpose (follow-up cards in the PR):
 *  - gathering the facts (GitHub compare + commit → PR lookup, the host
 *    preflight for a dirty checkout, the dev_ops_deploys reads),
 *  - the trigger (the dev-ops tick) and the call to startDevDeploy,
 *  - the admin switch route + UI and the chat line.
 * Until those land, the switch below is read by nothing that deploys.
 *
 * The switch is its OWN setting, `dev_auto_deploy_enabled`, off when there is
 * no row. It is not `settings.auto_deploy_enabled` (the old self-deploy.sh
 * path in services/auto-deploy.ts), and it does not touch `devOpsGate`.
 */
import type { Database } from 'better-sqlite3'

export const DEV_AUTO_DEPLOY_SETTING = 'dev_auto_deploy_enabled'
export const DEV_AUTO_DEPLOY_WINDOW_SETTING = 'dev_auto_deploy_window'
export const DEV_AUTO_DEPLOY_MAX_FILES_SETTING = 'dev_auto_deploy_max_files'
export const DEV_AUTO_DEPLOY_DAILY_CAP_SETTING = 'dev_auto_deploy_daily_cap'
export const DEFAULT_DAILY_CAP = 3

/** How a commit's pull request reached main. Only the server's own merge paths count. */
export type MergedVia = 'dev_ops' | 'standing_merge' | 'grant_merge' | 'person' | 'auto_merge' | 'unknown'
const SERVER_MERGE_PATHS: ReadonlySet<MergedVia> = new Set(['dev_ops', 'standing_merge', 'grant_merge'])

export interface BatchCommit {
  sha: string
  /** Files the commit changed (for the migration and size rules). */
  files: string[]
  /** The ONE merged PR whose merge commit is this sha; null when GitHub names none (a direct push). */
  pr: {
    repo: string
    number: number
    /** The card that carries this PR; null when no card does. */
    card: {
      id: number
      /** `isDevCard()` from merge.ts. */
      dev_card: boolean
      ai_review_verdict: string | null
    } | null
    merged_via: MergedVia
    /** Every check on the PR head the merge was pinned to finished green. */
    ci_green: boolean
  } | null
}

export interface AutoDeployFacts {
  /** Commits on origin/main that the live install does not run yet, oldest first. */
  batch: BatchCommit[]
  /** loadReservedPrs() from grant-merge.ts, flattened to repo + number. */
  reserved: Array<{ repo: string | null; number: number }>
  /** From the host preflight: tracked files changed in the live code folder. */
  checkout_dirty: boolean
  /** The live code folder's HEAD is not an ancestor of origin/main (local commits). */
  checkout_ahead: boolean
  /** A dev_ops_deploys row is still `started` (chat or automatic). */
  deploy_running: boolean
  /** Card ids in planning / working: a live session a restart would cut. */
  working_cards: number[]
  /** The most recent AUTOMATIC deploy, if any. */
  last_auto: { id: number; status: string; cleared: boolean } | null
  /** Automatic deploys started in the last 24 hours. */
  auto_deploys_last_24h: number
  now: Date
}

export interface AutoDeployPolicy {
  enabled: boolean
  /** [startHour, endHour) in `timeZone`; null = any time. 9..18 = 09:00-17:59. */
  window: { start: number; end: number } | null
  /** 0 = no cap. */
  max_files: number
  daily_cap: number
  timeZone: string
}

export type AutoDeployRefusal =
  | 'switch_off'
  | 'nothing_to_deploy'
  | 'not_dev_merge'
  | 'migration_in_batch'
  | 'reserved_pr'
  | 'checkout_dirty'
  | 'checkout_ahead'
  | 'deploy_running'
  | 'cards_working'
  | 'rollback_not_cleared'
  | 'daily_cap'
  | 'outside_window'
  | 'batch_too_large'

export type AutoDeployDecision =
  | { deploy: true; to_sha: string; commits: number; files: number; message: string }
  | { deploy: false; code: AutoDeployRefusal; message: string; shas?: string[] }

/**
 * Which changed files make a commit a database change. Same rule, byte for byte,
 * as lib/migration-paths.ts in PR 888 / 892; when that lands this file should
 * import it instead.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i
export function isMigrationPath(file: string): boolean {
  const p = String(file || '').trim().replace(/^\.?\//, '')
  if (!p || TEST_FILE.test(p)) return false
  if (p.startsWith('app/server/src/db/')) return true
  return /(^|\/)migrations\//.test(p)
}

/** Why a single commit did not come through a Dev merge, or null when it did. */
export function commitProvenanceGap(c: BatchCommit): string | null {
  if (!c.pr) return 'no merged pull request (pushed straight to main)'
  if (!c.pr.card) return `PR #${c.pr.number} has no card`
  if (!c.pr.card.dev_card) return `PR #${c.pr.number} (card #${c.pr.card.id}) is not a Dev card`
  if (!SERVER_MERGE_PATHS.has(c.pr.merged_via)) return `PR #${c.pr.number} was merged by ${c.pr.merged_via === 'person' ? 'a person' : c.pr.merged_via}, not by Dev`
  if (c.pr.card.ai_review_verdict !== 'pass') return `PR #${c.pr.number} has no passed AI review (verdict: ${c.pr.card.ai_review_verdict ?? 'none'})`
  if (!c.pr.ci_green) return `PR #${c.pr.number} was not green on CI at merge`
  return null
}

function hourIn(now: Date, timeZone: string): number {
  try {
    const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now)
    return Number(h) % 24
  } catch {
    return now.getUTCHours()
  }
}

export function inWindow(hour: number, w: { start: number; end: number }): boolean {
  if (w.start === w.end) return true
  return w.start < w.end ? hour >= w.start && hour < w.end : hour >= w.start || hour < w.end
}

const short = (s: string) => s.slice(0, 12)
const no = (code: AutoDeployRefusal, message: string, shas?: string[]): AutoDeployDecision =>
  ({ deploy: false, code, message, ...(shas && shas.length ? { shas } : {}) })

/**
 * The decision. Order matters only for which reason is reported first: the
 * switch, then the batch itself (provenance, migrations, reserved PRs), then
 * the install's state, then the owner's limits.
 */
export function decideDevAutoDeploy(facts: AutoDeployFacts, policy: AutoDeployPolicy): AutoDeployDecision {
  if (!policy.enabled) return no('switch_off', 'Automatic deploy is off.')
  if (facts.batch.length === 0) return no('nothing_to_deploy', 'The live install already runs main.')

  const foreign = facts.batch
    .map(c => ({ c, gap: commitProvenanceGap(c) }))
    .filter((x): x is { c: BatchCommit; gap: string } => x.gap != null)
  if (foreign.length) {
    const first = foreign[0]
    return no('not_dev_merge',
      `Not deploying: ${foreign.length} of ${facts.batch.length} waiting commit(s) did not come from a passed, green Dev merge (${short(first.c.sha)}: ${first.gap}). The owner deploys this batch.`,
      foreign.map(x => x.c.sha))
  }

  const mig = facts.batch.filter(c => c.files.some(isMigrationPath))
  if (mig.length) {
    const paths = Array.from(new Set(mig.flatMap(c => c.files.filter(isMigrationPath)))).slice(0, 5)
    return no('migration_in_batch',
      `Not deploying: the batch changes the database (${paths.join(', ')}). Production migrations stay with the owner.`,
      mig.map(c => c.sha))
  }

  for (const c of facts.batch) {
    const hit = c.pr && facts.reserved.find(r => r.number === c.pr!.number && (r.repo == null || r.repo === c.pr!.repo))
    if (hit) return no('reserved_pr', `Not deploying: PR #${hit.number} in the batch is reserved for the owner.`, [c.sha])
  }

  if (facts.checkout_dirty) return no('checkout_dirty', 'Not deploying: the live code folder has local edits to tracked files.')
  if (facts.checkout_ahead) return no('checkout_ahead', 'Not deploying: the live code folder has commits that are not on main.')
  if (facts.deploy_running) return no('deploy_running', 'Not deploying: a deploy is already running.')
  if (facts.working_cards.length) {
    const ids = facts.working_cards.slice(0, 5).map(id => `#${id}`).join(', ')
    return no('cards_working', `Waiting: ${facts.working_cards.length} card(s) are running (${ids}); a restart would cut them.`)
  }
  if (facts.last_auto && facts.last_auto.status !== 'deployed' && facts.last_auto.status !== 'started' && !facts.last_auto.cleared) {
    return no('rollback_not_cleared',
      `Stopped: automatic deploy #${facts.last_auto.id} ended ${facts.last_auto.status} and the owner has not cleared it.`)
  }
  if (facts.auto_deploys_last_24h >= policy.daily_cap) {
    return no('daily_cap', `Waiting: ${facts.auto_deploys_last_24h} automatic deploys in the last 24 hours (cap ${policy.daily_cap}).`)
  }
  if (policy.window && !inWindow(hourIn(facts.now, policy.timeZone), policy.window)) {
    return no('outside_window', `Waiting: outside the deploy window ${policy.window.start}:00-${policy.window.end}:00 (${policy.timeZone}).`)
  }
  const files = new Set(facts.batch.flatMap(c => c.files)).size
  if (policy.max_files > 0 && files > policy.max_files) {
    return no('batch_too_large', `Not deploying: the batch changes ${files} files (limit ${policy.max_files}). The owner deploys it.`)
  }

  const to = facts.batch[facts.batch.length - 1].sha
  return {
    deploy: true, to_sha: to, commits: facts.batch.length, files,
    message: `Deploying ${facts.batch.length} Dev merge(s), ${files} file(s), to ${short(to)}.`,
  }
}

function readSetting(db: Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

/** "9-18" → {start: 9, end: 18}; anything else → null (any time). */
export function parseWindow(v: string | null): { start: number; end: number } | null {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(v ?? '')
  if (!m) return null
  const start = Number(m[1]), end = Number(m[2])
  if (start > 23 || end > 24) return null
  return { start, end: end % 24 }
}

/**
 * The owner's policy, read at the time of use. No row = OFF. Unreadable = OFF.
 * Only the exact value '1' switches it on.
 */
export function readDevAutoDeployPolicy(db: Database, timeZone: string): AutoDeployPolicy {
  const enabled = readSetting(db, DEV_AUTO_DEPLOY_SETTING) === '1'
  const maxFiles = Number(readSetting(db, DEV_AUTO_DEPLOY_MAX_FILES_SETTING) ?? 0)
  const cap = Number(readSetting(db, DEV_AUTO_DEPLOY_DAILY_CAP_SETTING) ?? DEFAULT_DAILY_CAP)
  return {
    enabled,
    window: parseWindow(readSetting(db, DEV_AUTO_DEPLOY_WINDOW_SETTING)),
    max_files: Number.isFinite(maxFiles) && maxFiles > 0 ? Math.floor(maxFiles) : 0,
    daily_cap: Number.isFinite(cap) && cap >= 0 ? Math.floor(cap) : DEFAULT_DAILY_CAP,
    timeZone,
  }
}
