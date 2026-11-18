/**
 * GitHub credential for the grant-approved merge (obj 901372).
 *
 * `mergeUnderGrant` shells `gh` from the SERVER process (the chat tool
 * `merge_approved_pr` and the card-message `approval: merge` path both land
 * there). Until now that `gh` could only authenticate from the server's own
 * login: `GH_TOKEN` in the server env, or a `hosts.yml` in `GH_CONFIG_DIR`
 * (`/etc/gh`, a host mount). An install that connected GitHub only through
 * Settings → Integrations has neither: the connection is a per-person token in
 * the encrypted store, which is handed to card sessions at spawn
 * (`userGitIdentityEnv`) and to nothing else. Card workers opened PRs fine and
 * every merge died on "gh auth login".
 *
 * This resolves a credential at call time, most established first:
 *
 *   1. the server's own login (env token, else a `hosts.yml` holding a token):
 *      unchanged behaviour for installs that have one;
 *   2. the GitHub connection of the person the merge is approved ON BEHALF OF
 *      (the grantor), through the same owner-scoped guard a card spawn uses
 *      (`getDecryptedForUser` + the person's "Who can use it" rule);
 *   3. the workspace's GitHub integration token.
 *
 * None of those → `null`, and the caller refuses with a plain sentence instead
 * of gh's raw "run gh auth login" text.
 *
 * The token never reaches argv, a log line, an error message or disk: it is put
 * on the `gh` child's env only, and anything the child printed is scrubbed of it
 * before it is turned into an error.
 */
import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ExecFn } from './ci-green-gate-decide.js'
import { defaultExec, ghExecEnv } from './ci-green-gate-github.js'
import { CONNECTOR_ID as GITHUB_CONNECTOR, getDecryptedForUser } from './user-github-tokens.js'
import { checkConnectorCredential } from './connector-guard.js'
import { getRawConfig } from './workspace-integrations.js'
import { redactSecret } from './repo-git-auth.js'

export type MergeCredentialSource = 'server_env' | 'server_gh_login' | 'person_connection' | 'workspace_integration'

export interface MergeGithubAuth {
  exec: ExecFn
  source: MergeCredentialSource
}

export interface MergeGithubAuthQuery {
  /** The person the merge is approved on behalf of (the grantor). */
  grantorUserId?: number | null
  /** The card's workspace. */
  workspace?: string | null
  /** The chat bot's slug when the merge came from a chat turn. */
  agent?: string | null
}

export interface MergeGithubAuthDeps {
  env?: NodeJS.ProcessEnv
  /** Does the server's gh config dir hold a login? Injectable for tests. */
  serverGhLogin?: (env: NodeJS.ProcessEnv) => boolean
  /** Build the `gh` runner for a stored token. Injectable for tests. */
  tokenExec?: (token: string) => ExecFn
  /** The server-login `gh` runner (reads at call time so a test mock applies). */
  serverExec?: ExecFn
}

/** What the tool says when there is nothing to authenticate with. */
export const NO_MERGE_CREDENTIAL_MESSAGE =
  'The server has no GitHub credential for merges. Connect GitHub for the person who gave the merge grant ' +
  '(Settings → Integrations → GitHub), or give the server its own GitHub login.'

/** True when `<GH_CONFIG_DIR>/hosts.yml` is readable and holds a token. Never throws. */
export function serverGhLoginPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const dir = ghExecEnv(env).GH_CONFIG_DIR as string
    return /^\s*oauth_token:\s*\S/m.test(fs.readFileSync(path.join(dir, 'hosts.yml'), 'utf8'))
  } catch {
    return false
  }
}

/** A `gh` runner that authenticates with `token` through the child's env only. */
export function ghExecWithToken(token: string, baseEnv: NodeJS.ProcessEnv = process.env): ExecFn {
  return (file, args) =>
    new Promise((resolve, reject) => {
      const env = { ...ghExecEnv(baseEnv), GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1' }
      execFile(file, args, { timeout: 20000, maxBuffer: 8 * 1024 * 1024, env }, (err, stdout) => {
        if (err) reject(new Error(redactSecret(err.message, token)))
        else resolve(String(stdout).trim())
      })
    })
}

/**
 * The credential `gh` should use for this merge, or `null` when the server has
 * none. Reads only; never throws; never returns or logs token material.
 */
export function resolveMergeGithubAuth(q: MergeGithubAuthQuery, deps: MergeGithubAuthDeps = {}): MergeGithubAuth | null {
  const env = deps.env ?? process.env
  const serverExec: ExecFn = deps.serverExec ?? ((file, args) => defaultExec(file, args))
  const tokenExec = deps.tokenExec ?? ((t: string) => ghExecWithToken(t, env))

  if (env.GH_TOKEN || env.GITHUB_TOKEN) return { exec: serverExec, source: 'server_env' }
  if ((deps.serverGhLogin ?? serverGhLoginPresent)(env)) return { exec: serverExec, source: 'server_gh_login' }

  const grantor = typeof q.grantorUserId === 'number' && q.grantorUserId > 0 ? q.grantorUserId : null
  const workspace = (q.workspace || '').trim()
  if (grantor != null) {
    try {
      const actor = { kind: 'server' as const, reason: 'grant-merge' }
      const use = { workspace: workspace || null, ...(q.agent ? { agent: q.agent } : {}) }
      const allowed = checkConnectorCredential({ connectorId: GITHUB_CONNECTOR, ownerUserId: grantor, actor, use }).allowed
      const token = allowed ? getDecryptedForUser(grantor, actor) : null
      if (token) return { exec: tokenExec(token), source: 'person_connection' }
    } catch { /* fall through */ }
  }
  if (workspace) {
    try {
      const cfg = getRawConfig(workspace, 'github')
      const token = typeof cfg?.token === 'string' ? cfg.token : ''
      if (token) return { exec: tokenExec(token), source: 'workspace_integration' }
    } catch { /* fall through */ }
  }
  return null
}

/** gh's own "you are not logged in" text (no credential reached the process). */
export function isGhNotLoggedIn(message: string): boolean {
  return /gh auth login|populate the GH_TOKEN|GH_TOKEN environment variable|not logged in(to)? any/i.test(message)
}

/** GitHub turned the credential down (expired, revoked, or not authorised for the org). */
export function isGhCredentialRejected(message: string): boolean {
  return /HTTP 401|Bad credentials|authentication failed|token (has )?expired|SAML|SSO/i.test(message)
}
