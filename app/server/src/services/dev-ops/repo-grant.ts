/**
 * "GitHub repo rights" for Operation Kit Dev (obj 901492): a per-repo grant, OFF
 * by default, that an admin switches on in the browser.
 *
 * The operator tools (switch.ts) let Dev merge the PR of one of its OWN cards.
 * This grant is what lets it act on a pull request by repo and number, with no
 * card needed: merge it (repo-merge.ts `devRepoMerge`) and update its branch /
 * re-run its CI (`devRefreshPrCi`). It is listed per repo: a repo that has no
 * active row here is out of reach, whatever the model asks for.
 *
 *  - Only the bot whose chat slug is `operation-kit-dev` is eligible, the same
 *    rule as the operator-tools switch. No row or setting adds a second bot.
 *  - No row = OFF. There is no default-on and no wildcard: a repo is named in
 *    full (`owner/name`), one row each.
 *  - Granting and revoking are cookie-admin only (routes/agent-chat.ts); a bot
 *    or an API key can never grant itself a repo.
 *  - The grant sits UNDER the operator-tools switch: with the switch off, or in
 *    a wake turn, or for a non-admin, the tools do not exist (devOpsGate).
 *  - It grants no deploy, no production migration and no repo-setting change.
 */
import { getDb } from '../../db/index.js'
import { isDevOpsBot, DEV_OPS_BOT_SLUG } from './switch.js'

export interface RepoGrant {
  repo: string
  granted_by: number | null
  granted_by_username: string | null
  created_at: string
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/

/**
 * `owner/name` from `owner/name`, a github.com repo URL or a PR URL. Lower-cased
 * (GitHub repo names are case-insensitive). Null when it is not exactly one
 * repo: no wildcards, no `..`, no extra path.
 */
export function parseRepo(input: unknown): string | null {
  if (typeof input !== 'string') return null
  let s = input.trim()
  const url = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s#?]+)(?:\/pull\/\d+)?\/?(?:[#?].*)?$/i.exec(s)
  if (url) s = url[1]
  s = s.replace(/\.git$/i, '')
  if (!REPO_RE.test(s)) return null
  const name = s.split('/')[1]
  // Idempotent by construction: a name that still ends in `.git` after one strip is
  // refused, so parsing a parsed name can never yield a different repo.
  if (name === '.' || name === '..' || /\.git$/i.test(name)) return null
  return s.toLowerCase()
}

/** The repos an admin switched on for this bot. Empty for any bot but Operation Kit Dev. */
export function listRepoGrants(slug: string): RepoGrant[] {
  if (!isDevOpsBot(slug)) return []
  try {
    return getDb().prepare(
      'SELECT repo, granted_by, granted_by_username, created_at FROM dev_ops_repo_grants WHERE bot_slug = ? AND revoked_at IS NULL ORDER BY repo',
    ).all(DEV_OPS_BOT_SLUG) as RepoGrant[]
  } catch {
    return []
  }
}

/** Is this exact repo switched on for this bot? Re-read on every call. Fails closed. */
export function repoGrantActive(slug: string, repo: string | null | undefined): boolean {
  const r = parseRepo(repo)
  if (!r || !isDevOpsBot(slug)) return false
  try {
    return !!getDb().prepare('SELECT 1 FROM dev_ops_repo_grants WHERE bot_slug = ? AND repo = ? AND revoked_at IS NULL').get(DEV_OPS_BOT_SLUG, r)
  } catch {
    return false
  }
}

export type RepoGrantChange = 'granted' | 'revoked' | 'unchanged' | 'bot_not_eligible' | 'bad_repo'

/** Switch one repo on or off. Returns what happened; never throws on a bad name. */
export function setRepoGrant(slug: string, repoInput: unknown, enabled: boolean, user: { id: number; username: string }): { change: RepoGrantChange; repo: string | null } {
  if (!isDevOpsBot(slug)) return { change: 'bot_not_eligible', repo: null }
  const repo = parseRepo(repoInput)
  if (!repo) return { change: 'bad_repo', repo: null }
  const db = getDb()
  const active = db.prepare('SELECT id FROM dev_ops_repo_grants WHERE bot_slug = ? AND repo = ? AND revoked_at IS NULL').get(DEV_OPS_BOT_SLUG, repo) as { id: number } | undefined
  if (enabled) {
    if (active) return { change: 'unchanged', repo }
    db.prepare('INSERT INTO dev_ops_repo_grants (bot_slug, repo, granted_by, granted_by_username) VALUES (?, ?, ?, ?)').run(DEV_OPS_BOT_SLUG, repo, user.id, user.username)
    return { change: 'granted', repo }
  }
  if (!active) return { change: 'unchanged', repo }
  db.prepare("UPDATE dev_ops_repo_grants SET revoked_at = datetime('now'), revoked_by = ? WHERE id = ?").run(user.id, active.id)
  return { change: 'revoked', repo }
}
