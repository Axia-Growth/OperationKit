/**
 * obj 900208 — coding sessions use the GitHub connection from Settings →
 * Connectors; a GH_TOKEN secret is an optional override, not the only path.
 *
 * Covers the three gaps that made Example Project cards ask for a GH_TOKEN secret:
 *   1. plain `git push` over https had no credential helper → since obj 901743
 *      the broker's git credential helper (connector-broker-shims.ts, tested there)
 *   2. the prompt never named the connector token → buildGithubAccessLines
 *   3. ownerless child cards → internal-create-ownership.test.ts
 *
 * obj 901743 (public issue #136): the token is no longer in the session env;
 * a connected session carries CC_GITHUB_BROKER=1 instead.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-gh-connector-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
process.env.CC_SESSION_KB_ACCESS = '0'

const { initDb, getDb } = await import('../db/index.js')
const tokens = await import('./user-github-tokens.js')
const {
  buildSpawnEnv,
  githubSessionAccess,
} = await import('./session-spawn-env.js')
const { buildGithubAccessLines } = await import('./session-trust-prompt.js')
const { setAccess } = await import('../connectors/access.js')

const OWNER = 11
const OTHER = 12
const PAT = 'github_pat_11CONNECTOR_ownerSecret_9999'

function seedUser(id: number, username: string): void {
  getDb().prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'member')`).run(id, username)
}
function connect(userId: number): void {
  tokens.upsert(userId, { rawToken: PAT, login: 'owner-gh', githubUserId: 1, email: '1+owner-gh@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
}
function card(over: Partial<Objective> & { agent_key_id?: number | null; agent_key_label?: string | null } = {}): Objective {
  return { id: 900208, workspace: 'ws-a', agent_context: 'cto', project: 'x', created_by: OWNER, ...over } as Objective
}
function addKey(userId: number, connectors: string[]): number {
  const r = getDb()
    .prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, connectors) VALUES (?, 'cos-bot', ?, 'abcd', '[]', ?)`)
    .run(userId, `h${Math.random()}`, JSON.stringify(connectors))
  return Number(r.lastInsertRowid)
}

beforeAll(() => { initDb() })
beforeEach(() => {
  getDb().exec('DELETE FROM user_github_tokens; DELETE FROM agent_api_keys; DELETE FROM users;')
  try { getDb().exec('DELETE FROM connector_access') } catch { /* lazy */ }
  seedUser(OWNER, 'owner')
  seedUser(OTHER, 'other')
})

describe('buildSpawnEnv — GitHub connector reaches coding sessions', () => {
  it('connected owner: the GitHub broker is on, the PAT is not in the env', () => {
    connect(OWNER)
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.CC_GITHUB_BROKER).toBe('1')
    expect(env.CC_SESSION_TOKEN).toBeTruthy() // the broker authenticates with it
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(PAT)
    // The git helper is wired by session-tmux.ts now, not by buildSpawnEnv.
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })
  it('not connected: no broker and no helper (env unchanged)', () => {
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.CC_GITHUB_BROKER).toBeUndefined()
    expect(env.GIT_CONFIG_COUNT).toBeUndefined()
  })
  it('scoping: another user\'s connection never reaches this card', () => {
    connect(OTHER)
    const env = buildSpawnEnv({ objective: card(), homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.CC_GITHUB_BROKER).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain(PAT)
  })
})

describe('githubSessionAccess + buildGithubAccessLines — the prompt names the real fix', () => {
  const none = new Set<string>()
  it('connected: names the account and says not to ask for a GH_TOKEN secret', () => {
    connect(OWNER)
    expect(githubSessionAccess(card())).toMatchObject({ state: 'connected', login: 'owner-gh' })
    const text = buildGithubAccessLines(card(), none).join('\n')
    expect(text).toContain('connected as `owner-gh`')
    expect(text).toContain('Settings → Connectors')
    expect(text).toContain('Do NOT ask for a `GH_TOKEN` secret')
    expect(text).not.toContain(PAT)
  })
  it('not connected: points at Settings → Connectors, Secrets only as an optional override', () => {
    expect(githubSessionAccess(card())).toMatchObject({ state: 'unavailable', reason: 'not_connected' })
    const text = buildGithubAccessLines(card(), none).join('\n')
    expect(text).toContain('Settings → Connectors → GitHub')
    expect(text).toContain('only an optional override')
  })
  it('no owner: says so instead of asking for a secret', () => {
    const c = card({ created_by: null } as Partial<Objective>)
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'no_owner' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('this card has no owner')
  })
  it('agent key without GitHub: names the key and Settings → API keys', () => {
    connect(OWNER)
    const keyId = addKey(OWNER, [])
    const c = card({ agent_key_id: keyId, agent_key_label: 'cos-bot' })
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'key_connector' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('API key "cos-bot"')
    // …and the spawn env agrees: the key's limit is honoured.
    const env = buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
    expect(env.CC_GITHUB_BROKER).toBeUndefined()
    expect(env.GH_TOKEN).toBeUndefined()
  })
  it('agent key WITH GitHub: connected', () => {
    connect(OWNER)
    const keyId = addKey(OWNER, ['github'])
    expect(githubSessionAccess(card({ agent_key_id: keyId }))).toMatchObject({ state: 'connected' })
  })
  it('delegated card: names the opt-in, and the opt-in turns it on', () => {
    connect(OWNER)
    const c = card({ created_by: OTHER, assigned_user_id: OWNER } as Partial<Objective>)
    expect(githubSessionAccess(c)).toMatchObject({ state: 'unavailable', reason: 'delegated_card' })
    expect(buildGithubAccessLines(c, none).join('\n')).toContain('work assigned by others')
    setAccess('github', OWNER, { agents: null, workspaces: null, allow_delegated: true })
    expect(githubSessionAccess(c)).toMatchObject({ state: 'connected' })
  })
  it('a GH_TOKEN secret is reported as an override', () => {
    const text = buildGithubAccessLines(card(), new Set(['GH_TOKEN'])).join('\n')
    expect(text).toContain('overrides any GitHub connection')
  })
  it('the decision is the same one buildSpawnEnv makes (broker on ⇔ connected)', () => {
    connect(OWNER)
    for (const c of [card(), card({ created_by: null } as Partial<Objective>), card({ created_by: OTHER, assigned_user_id: OWNER } as Partial<Objective>)]) {
      const env = buildSpawnEnv({ objective: c, homeDir: '/tmp/h', sessionKind: 'worker' })
      const brokered = env.CC_GITHUB_BROKER === '1'
      expect(githubSessionAccess(c).state === 'connected').toBe(brokered)
      expect(JSON.stringify(env)).not.toContain(PAT)
    }
  })
})
