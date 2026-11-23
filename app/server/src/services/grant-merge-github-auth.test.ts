/**
 * obj 901372 — the grant-approved merge finds a GitHub credential at call time.
 *
 * The bug: `merge_approved_pr` ran `gh` in the server process, which had no
 * login of its own (no GH_TOKEN, no hosts.yml in GH_CONFIG_DIR), while GitHub
 * was connected in Settings → Integrations. Every merge died on gh's raw
 * "run gh auth login" text.
 *
 *  1. no credential anywhere → refused `github_credential_missing` with the
 *     plain sentence, and `gh` is never run;
 *  2. the grantor's connected GitHub account is used when the server has no
 *     login of its own (token on the child env only, never in argv/errors);
 *  3. the server's own login still wins when it exists (unchanged installs);
 *  4. another person's connection is never borrowed; the person's own
 *     "Who can use it" rule is honoured; the workspace integration is the
 *     last fallback;
 *  5. gh's own not-logged-in / 401 text is turned into the plain refusal.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ExecFn } from './ci-green-gate-decide.js'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString('base64')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-grant-merge-auth-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')

const { initDb, getDb } = await import('../db/index.js')
const tokens = await import('./user-github-tokens.js')
const { setAccess } = await import('../connectors/access.js')
const { createWorkspace } = await import('./workspaces.js')
const { mergeUnderGrant } = await import('./grant-merge.js')
const {
  resolveMergeGithubAuth,
  serverGhLoginPresent,
  ghExecWithToken,
  isGhNotLoggedIn,
  isGhCredentialRejected,
  NO_MERGE_CREDENTIAL_MESSAGE,
} = await import('./grant-merge-github-auth.js')

const GRANTOR = 21
const OTHER = 22
const PAT = 'github_pat_11MERGE_grantorSecret_4242'
const NO_SERVER_LOGIN = { env: {} as NodeJS.ProcessEnv, serverGhLogin: () => false }

function link(userId: number, raw: string): void {
  tokens.upsert(userId, { rawToken: raw, login: `gh-${userId}`, githubUserId: userId, email: `${userId}@users.noreply.github.com`, scopes: null, tokenType: 'pat_fine' })
}

/** A recording stand-in for the `gh` runner bound to one token. */
function recorder() {
  const used: string[] = []
  const calls: string[][] = []
  const tokenExec = (token: string): ExecFn => {
    used.push(token)
    return async (file, args) => {
      calls.push([file, ...args])
      if (args[0] === 'api') {
        if (String(args[1]).endsWith('/protection')) throw new Error('HTTP 404 Not Found')
        return '[]'
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        const fields = args[args.indexOf('--json') + 1]
        if (fields === 'state,mergeStateStatus') return JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN' })
        return JSON.stringify({ number: Number(args[2]), url: `https://github.com/acme/app/pull/${args[2]}`, headRefOid: 'abc1234', baseRefName: 'main', statusCheckRollup: [{ name: 'gate', status: 'COMPLETED', conclusion: 'SUCCESS' }], state: 'OPEN' })
      }
      return ''
    }
  }
  return { used, calls, tokenExec }
}

let prSeq = 500
function card(workspace = 'growth') {
  prSeq += 1
  return {
    id: prSeq, title: 'fixture', description: '', status: 'review', type: 'task', workspace, project: 'app',
    pr_url: `https://github.com/acme/app-${prSeq}/pull/${prSeq}`, pr_number: prSeq, is_strategy: 0, ai_review_verdict: 'pass',
  } as unknown as Parameters<typeof mergeUnderGrant>[0]
}

beforeAll(() => {
  initDb()
  const db = getDb()
  for (const [id, name] of [[GRANTOR, 'grantor'], [OTHER, 'other']] as const) {
    db.prepare(`INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'admin')`).run(id, name)
  }
  createWorkspace({ slug: 'growth', name: 'Growth', default_agent_pool: ['general'] })
})

beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM workspace_integrations;')
  setAccess('github', GRANTOR, { agents: null, workspaces: null })
})

describe('1. no GitHub credential anywhere', () => {
  it('refuses with the plain sentence and never runs gh', async () => {
    const r = recorder()
    const out = await mergeUnderGrant(card(), {
      reserved: [],
      auth: { grantorUserId: GRANTOR },
      resolveAuth: q => resolveMergeGithubAuth(q, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec }),
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('github_credential_missing')
    expect(out.status).toBe(503)
    expect(out.error).toContain('The server has no GitHub credential for merges')
    expect(out.error).toContain('Nothing was merged')
    expect(out.error).not.toMatch(/gh auth login/)
    expect(r.calls).toEqual([])
  })

  it('resolver returns null with no grantor, no workspace token and no server login', () => {
    expect(resolveMergeGithubAuth({ grantorUserId: null, workspace: 'growth' }, NO_SERVER_LOGIN)).toBeNull()
    expect(resolveMergeGithubAuth({}, NO_SERVER_LOGIN)).toBeNull()
  })
})

describe("2. the grantor's connected GitHub account", () => {
  it('is used for every gh call of the merge when the server has no login of its own', async () => {
    link(GRANTOR, PAT)
    const r = recorder()
    const out = await mergeUnderGrant(card(), {
      reserved: [],
      auth: { grantorUserId: GRANTOR, agent: 'dev' },
      resolveAuth: q => resolveMergeGithubAuth(q, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec }),
    })
    expect(out.ok).toBe(true)
    expect(r.used).toEqual([PAT])
    const merge = r.calls.find(c => c[1] === 'pr' && c[2] === 'merge')
    expect(merge).toBeTruthy()
    expect(merge).toContain('--match-head-commit')
    // The token is never an argument.
    expect(JSON.stringify(r.calls)).not.toContain(PAT)
  })

  it('reports where the credential came from, not the credential', () => {
    link(GRANTOR, PAT)
    const a = resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'growth' }, { ...NO_SERVER_LOGIN, tokenExec: recorder().tokenExec })
    expect(a?.source).toBe('person_connection')
    expect(JSON.stringify(a)).not.toContain(PAT)
  })

  it('a failing gh call never carries the token in its error', async () => {
    const exec = ghExecWithToken(PAT, { PATH: process.env.PATH })
    // `node -e` stands in for gh: it prints the token it was given and fails.
    const err = await exec(process.execPath, ['-e', 'console.error(process.env.GH_TOKEN); process.exit(3)']).then(() => null, e => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain(PAT)
  })

  it('passes the token to the child through its env', async () => {
    const exec = ghExecWithToken(PAT, { PATH: process.env.PATH })
    const out = await exec(process.execPath, ['-e', 'process.stdout.write(String(process.env.GH_TOKEN === process.argv[1]))', PAT])
    expect(out).toBe('true')
  })
})

describe("3. the server's own login still wins", () => {
  it('an env token on the server process → the server runner, the person token is not read', () => {
    link(GRANTOR, PAT)
    const r = recorder()
    const serverExec: ExecFn = async () => 'server'
    const a = resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'growth' }, { env: { GH_TOKEN: 'x' }, serverGhLogin: () => false, tokenExec: r.tokenExec, serverExec })
    expect(a?.source).toBe('server_env')
    expect(a?.exec).toBe(serverExec)
    expect(r.used).toEqual([])
  })

  it('a hosts.yml holding a token in GH_CONFIG_DIR → the server runner', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'gh-'))
    expect(serverGhLoginPresent({ GH_CONFIG_DIR: dir })).toBe(false) // no hosts.yml: the reported failure
    fs.writeFileSync(path.join(dir, 'hosts.yml'), 'github.com:\n    user: bot\n')
    expect(serverGhLoginPresent({ GH_CONFIG_DIR: dir })).toBe(false) // a file with no token is not a login
    fs.writeFileSync(path.join(dir, 'hosts.yml'), 'github.com:\n    oauth_token: abc\n    user: bot\n')
    expect(serverGhLoginPresent({ GH_CONFIG_DIR: dir })).toBe(true)
    const a = resolveMergeGithubAuth({ grantorUserId: GRANTOR }, { env: { GH_CONFIG_DIR: dir } })
    expect(a?.source).toBe('server_gh_login')
  })
})

describe('4. whose credential', () => {
  it("another person's GitHub connection is never borrowed", () => {
    link(OTHER, 'github_pat_11OTHER_person_0000')
    const r = recorder()
    expect(resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'growth' }, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec })).toBeNull()
    expect(r.used).toEqual([])
  })

  it("the person's own Who can use it rule is honoured", () => {
    link(GRANTOR, PAT)
    setAccess('github', GRANTOR, { agents: null, workspaces: ['elsewhere'] })
    const r = recorder()
    expect(resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'growth', agent: 'dev' }, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec })).toBeNull()
    expect(resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'elsewhere', agent: 'dev' }, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec })?.source).toBe('person_connection')
  })

  it('the workspace GitHub integration token is the last fallback', () => {
    getDb().prepare(`INSERT INTO workspace_integrations (workspace, kind, config, status) VALUES ('growth', 'github', ?, 'connected')`)
      .run(JSON.stringify({ org: 'acme', token: 'ws-token-777' }))
    const r = recorder()
    const a = resolveMergeGithubAuth({ grantorUserId: GRANTOR, workspace: 'growth' }, { ...NO_SERVER_LOGIN, tokenExec: r.tokenExec })
    expect(a?.source).toBe('workspace_integration')
    expect(r.used).toEqual(['ws-token-777'])
  })
})

describe("5. gh's own auth errors become the plain refusal", () => {
  const GH_RAW = 'Command failed: gh pr view 12 --repo acme/app\nTo get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.'

  it('recognises the not-logged-in and rejected texts', () => {
    expect(isGhNotLoggedIn(GH_RAW)).toBe(true)
    expect(isGhNotLoggedIn('HTTP 404 Not Found')).toBe(false)
    expect(isGhCredentialRejected('HTTP 401: Bad credentials (https://api.github.com/graphql)')).toBe(true)
    expect(isGhCredentialRejected('Pull request is not mergeable')).toBe(false)
  })

  it('a stale server login that gh reports as not logged in → github_credential_missing, not the raw text', async () => {
    const out = await mergeUnderGrant(card(), { reserved: [], exec: async () => { throw new Error(GH_RAW) } })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('github_credential_missing')
    expect(out.error).toContain(NO_MERGE_CREDENTIAL_MESSAGE)
    expect(out.error).not.toMatch(/gh auth login/)
  })

  it('a 401 from GitHub → github_credential_rejected', async () => {
    const out = await mergeUnderGrant(card(), { reserved: [], exec: async () => { throw new Error('HTTP 401: Bad credentials') } })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.code).toBe('github_credential_rejected')
    expect(out.error).toContain('Reconnect GitHub')
  })
})
