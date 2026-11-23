/**
 * obj 901330 — per-bot secret allowlists and connector scoping for the eight
 * Example bots, applied in card sessions. Every value below is a FAKE test string;
 * the key NAMES mirror the real store so the packs are exercised as shipped.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { clearSecretAuditLogForTests } from '../__fixtures__/secret-audit-log.js'

process.env.CC_VERIFIED_SENDER_STAMPS = '0'
process.env.CC_SESSION_KB_ACCESS = '0'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 23).toString('base64')
process.env.TEST_CRED_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
process.env.GOOGLE_OAUTH_CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-google-client-secret'
process.env.DB_PATH = path.join(os.tmpdir(), `cc-bot-scope-${process.pid}-${Date.now()}.db`)
delete process.env.CC_SECRETS_SESSION_ENV_MODE
delete process.env.CC_BOT_SESSION_SCOPE
delete process.env.CC_CONNECTOR_ACCESS_DEFAULT_DENY

const { initDb, getDb } = await import('../db/index.js')
const store = await import('./secrets-store.js')
const scope = await import('./bot-session-scope.js')
const { buildSpawnEnv, githubSessionAccess } = await import('./session-spawn-env.js')
const { buildSecretsInventoryBlock } = await import('./session-trust-prompt.js')
const { setAccess } = await import('../connectors/access.js')
const gh = await import('./user-github-tokens.js')
const google = await import('./user-google-connections.js')
const policy = await import('./secret-env-policy.js')
const broker = await import('./secrets-broker.js')
const mcp = await import('./workspace-mcp-servers.js')

const OPERATOR = 1
const WS = 'your-org'
const FAKE_PAT = 'github_pat_FAKE_TEST_ONLY_0000'
const FAKE_REFRESH = '1//FAKE_TEST_ONLY_refresh'

/** Every name a scoped pack mentions, plus the out-of-pack keys the card calls out. */
const STORE_KEYS = [
  'STRIPE_SECRET_KEY', 'STRIPE_READONLY_BACKFILL_KEY', 'STRIPE_RESTRICTED_KEY', 'STRIPE_WEBHOOK_SECRET',
  'RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'TWILIO_SID', 'TWILIO_TOKEN',
  'DOCUSEAL_API_KEY', 'DOCUSEAL_API_URL', 'TWENTY_API_URL', 'TWENTY_BD_API_KEY', 'TWENTY_API_KEY_EXAMPLE',
  'GRANOLA_API_KEY', 'EMAILBISON_API_KEY', 'EMAILBISON_BASE_URL', 'SENDIVO_API_KEY', 'TELNYX_API_KEY',
  'APIFY_API_TOKEN', 'GETLEADS_API_KEY', 'MILLIONVERIFIER_API_KEY', 'MILLIONVERIFIER_BASE_URL',
  'BOUNCEBAN_API_KEY', 'BOUNCEBAN_BASE_URL', 'POSTHOG_OK_TOKEN', 'POSTHOG_PERSONAL_KEY', 'POSTHOG_HOST',
  'INSTANTLY_API_KEY', 'MERCURY_API_KEY', 'RAMP_CLIENT_SECRET', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_KEY',
]

function card(agent: string, over: Partial<Objective> & { owner_bot?: string | null } = {}): Objective {
  return { id: 901330, workspace: WS, project: 'x', created_by: OPERATOR, agent_context: agent, ...over } as Objective
}
function spawn(agent: string, over: Partial<Objective> & { owner_bot?: string | null } = {}): Record<string, string> {
  return buildSpawnEnv({ objective: card(agent, over), homeDir: '/tmp/h', sessionKind: 'worker' })
}
function storeKeysIn(env: Record<string, string>): string[] {
  return STORE_KEYS.filter(k => k in env).sort()
}

beforeAll(() => initDb())
beforeEach(() => {
  const db = getDb()
  clearSecretAuditLogForTests(db)
  db.exec(`DELETE FROM secret_versions; DELETE FROM secrets; DELETE FROM secret_env_allowlist;
           DELETE FROM settings WHERE key IN ('secrets_session_env_mode','bot_session_scope_enabled','connector_access_default_deny');
           DELETE FROM user_github_tokens; DELETE FROM user_google_connections; DELETE FROM workspace_mcp_servers; DELETE FROM users;`)
  try { db.exec('DELETE FROM connector_access') } catch { /* created lazily */ }
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OPERATOR)
  for (const k of STORE_KEYS) store.setSecret({ scope: { scopeType: 'global' }, key: k, value: `fake-${k.toLowerCase()}`, actorUserId: OPERATOR })
  gh.upsert(OPERATOR, { rawToken: FAKE_PAT, login: 'm1keluka', githubUserId: 1, email: '1+m1keluka@users.noreply.github.com', scopes: null, tokenType: 'pat_fine' })
  google.upsert(OPERATOR, {
    googleEmail: 'owner@example.test', googleSub: 'sub-1', refreshToken: FAKE_REFRESH, accessToken: 'fake-access',
    accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: google.GOOGLE_SCOPES.join(' '),
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID as string,
  })
})
afterEach(() => {
  delete process.env.CC_SECRETS_SESSION_ENV_MODE
  delete process.env.CC_BOT_SESSION_SCOPE
  delete process.env.CC_CONNECTOR_ACCESS_DEFAULT_DENY
})

describe('packs', () => {
  it('covers exactly the eight your-org bots', () => {
    expect(Object.keys(scope.EXAMPLE_BOT_PACKS).sort()).toEqual([
      'example-business-development', 'example-cfo', 'example-client-success', 'example-cto',
      'example-general-counsel', 'example-gtm-engineer', 'example-paid-ads', 'example-seo',
    ])
  })
  it('never lists the keys the card rules out', () => {
    const all = Object.values(scope.EXAMPLE_BOT_PACKS).flatMap(p => [...p.keys, ...(p.keyPrefixes ?? [])])
    for (const banned of ['STRIPE_SECRET_KEY', 'POSTHOG_OK_TOKEN', 'POSTHOG_PERSONAL_KEY']) expect(all).not.toContain(banned)
    expect(all.some(k => /INSTANTLY|MERCURY|RAMP_/.test(k))).toBe(false)
  })
})

describe('test 1 — a scoped bot receives only its own keys (default migration mode)', () => {
  it('the global mode is still migration (no live flip) and an unscoped agent still gets everything', () => {
    expect(policy.getSessionEnvMode()).toBe('migration')
    expect(storeKeysIn(spawn('general'))).toEqual([...STORE_KEYS].sort())
  })

  const expected: Record<string, string[]> = {
    'example-cfo': ['STRIPE_READONLY_BACKFILL_KEY'],
    'example-general-counsel': ['DOCUSEAL_API_KEY', 'DOCUSEAL_API_URL'],
    'example-seo': ['POSTHOG_HOST'],
    'example-paid-ads': ['POSTHOG_HOST'],
    'example-client-success': ['GRANOLA_API_KEY', 'TWENTY_API_URL', 'TWENTY_BD_API_KEY'],
    'example-business-development': ['GRANOLA_API_KEY', 'TWENTY_API_URL', 'TWENTY_BD_API_KEY'],
    'example-cto': ['RAILWAY_API_TOKEN', 'RAILWAY_TOKEN', 'TWENTY_API_KEY_EXAMPLE', 'TWENTY_API_URL'],
    'example-gtm-engineer': [
      'APIFY_API_TOKEN', 'BOUNCEBAN_API_KEY', 'BOUNCEBAN_BASE_URL', 'EMAILBISON_API_KEY', 'EMAILBISON_BASE_URL',
      'GETLEADS_API_KEY', 'MILLIONVERIFIER_API_KEY', 'MILLIONVERIFIER_BASE_URL', 'SENDIVO_API_KEY',
      'TELNYX_API_KEY', 'TWENTY_API_KEY_EXAMPLE', 'TWENTY_API_URL',
    ],
  }
  for (const [bot, keys] of Object.entries(expected)) {
    it(`${bot}: env holds exactly its pack`, () => {
      expect(storeKeysIn(spawn(bot))).toEqual([...keys].sort())
    })
  }

  it('example-cfo: STRIPE_SECRET_KEY is absent, even when an allowlist row names it', () => {
    policy.addAllowlistEntry('agent', 'example-cfo', 'STRIPE_SECRET_KEY', OPERATOR)
    policy.addAllowlistEntry('agent', '*', 'STRIPE_SECRET_KEY', OPERATOR)
    const env = spawn('example-cfo')
    expect(env.STRIPE_SECRET_KEY).toBeUndefined()
    expect(env.STRIPE_READONLY_BACKFILL_KEY).toBe('fake-stripe_readonly_backfill_key')
  })
  it('Railway and Twilio never reach a bot without them on its list', () => {
    for (const bot of ['example-cfo', 'example-seo', 'example-general-counsel', 'example-client-success']) {
      const env = spawn(bot)
      expect(Object.keys(env).filter(k => /^(RAILWAY|TWILIO)_/.test(k))).toEqual([])
    }
  })
  it("SEO / paid ads never borrow Casey's PostHog keys; GTM never gets Instantly; CFO never Mercury/Ramp", () => {
    for (const bot of ['example-seo', 'example-paid-ads']) {
      policy.addAllowlistEntry('agent', bot, 'POSTHOG_OK_TOKEN', OPERATOR)
      expect(spawn(bot).POSTHOG_OK_TOKEN).toBeUndefined()
      expect(spawn(bot).POSTHOG_PERSONAL_KEY).toBeUndefined()
    }
    policy.addAllowlistEntry('agent', 'example-gtm-engineer', 'INSTANTLY_API_KEY', OPERATOR)
    expect(spawn('example-gtm-engineer').INSTANTLY_API_KEY).toBeUndefined()
    policy.addAllowlistEntry('agent', 'example-cfo', 'MERCURY_API_KEY', OPERATOR)
    expect(spawn('example-cfo').MERCURY_API_KEY).toBeUndefined()
  })
  it('not-yet-saved keys stay off until saved under the named key, then appear', () => {
    expect(spawn('example-paid-ads')[scope.PENDING_KEYS.META]).toBeUndefined()
    expect(spawn('example-seo')[scope.PENDING_KEYS.POSTHOG_EXAMPLE]).toBeUndefined()
    store.setSecret({ scope: { scopeType: 'global' }, key: scope.PENDING_KEYS.POSTHOG_EXAMPLE, value: 'fake-posthog', actorUserId: OPERATOR })
    expect(spawn('example-seo')[scope.PENDING_KEYS.POSTHOG_EXAMPLE]).toBe('fake-posthog')
  })
  it('an explicit allowlist row for the bot adds to its pack (not a different bot\'s)', () => {
    policy.addAllowlistEntry('agent', 'example-seo', 'OPENAI_API_KEY', OPERATOR)
    expect(spawn('example-seo').OPENAI_API_KEY).toBe('fake-openai_api_key')
    expect(spawn('example-paid-ads').OPENAI_API_KEY).toBeUndefined()
  })
  it('a store GH_TOKEN secret does not reach a scoped bot as an override', () => {
    store.setSecret({ scope: { scopeType: 'global' }, key: 'GH_TOKEN', value: 'fake-gh-override', actorUserId: OPERATOR })
    expect(spawn('example-seo').GH_TOKEN).toBeUndefined()
    expect(spawn('example-cto').GH_TOKEN).toBeUndefined()
    expect(spawn('general').GH_TOKEN).toBe('fake-gh-override')
  })
  it('the prompt lists only the names the env holds', () => {
    const text = buildSecretsInventoryBlock(card('example-cfo')).join('\n')
    expect(text).toContain('STRIPE_READONLY_BACKFILL_KEY')
    expect(text).not.toContain('`STRIPE_SECRET_KEY`')
    expect(text).not.toContain('RAILWAY_')
  })
  it('a card OWNED by a scoped bot is scoped even under the general persona', () => {
    const s = scope.sessionBotScope(card('general', { owner_bot: 'example-cfo' }), { ownerSlugs: () => ['example-cfo'] })
    expect(s?.slugs).toEqual(['example-cfo'])
    expect(scope.cardBotSlugs(card('general', { owner_bot: 'x' }), () => ['example-cfo'])).toEqual(['general', 'example-cfo'])
    // No owner and an unscoped persona: no scope.
    expect(scope.sessionBotScope(card('general'), { ownerSlugs: () => [] })).toBeNull()
  })
  it('kill switch bot_session_scope_enabled=0 restores the global policy', () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('bot_session_scope_enabled', '0')`).run()
    expect(spawn('example-cfo').STRIPE_SECRET_KEY).toBe('fake-stripe_secret_key')
  })
})

describe('test 2 — a second bot with a different list does not receive the first bot\'s keys', () => {
  it('CFO and CTO are disjoint', () => {
    const cfo = spawn('example-cfo')
    const cto = spawn('example-cto')
    expect(cto.STRIPE_READONLY_BACKFILL_KEY).toBeUndefined()
    expect(cfo.RAILWAY_API_TOKEN).toBeUndefined()
    expect(cfo.TWENTY_API_URL).toBeUndefined()
  })
  it('GTM does not get GC\'s DocuSeal or CS\'s Granola; CS does not get GTM\'s sending stack', () => {
    const gtm = spawn('example-gtm-engineer')
    const cs = spawn('example-client-success')
    expect(gtm.DOCUSEAL_API_KEY).toBeUndefined()
    expect(gtm.GRANOLA_API_KEY).toBeUndefined()
    expect(gtm.TWENTY_BD_API_KEY).toBeUndefined()
    expect(cs.EMAILBISON_API_KEY).toBeUndefined()
    expect(cs.TELNYX_API_KEY).toBeUndefined()
  })
  it('two scoped bots on one card get only what BOTH allow', () => {
    const s = scope.sessionBotScope(card('example-client-success', { owner_bot: 'example-cto' }), { ownerSlugs: () => ['example-cto'] })!
    const keep = scope.botKeyFilter(s)
    expect(keep('TWENTY_API_URL')).toBe(true)
    expect(keep('GRANOLA_API_KEY')).toBe(false)
    expect(keep('RAILWAY_TOKEN')).toBe(false)
    expect([...s.connectors]).toEqual([])
  })
  it('the secrets broker applies the same list to the bot\'s session token', () => {
    getDb().prepare(`INSERT OR REPLACE INTO objectives (id, title, status, workspace, agent_context) VALUES (901330, 't', 'working', ?, 'example-cfo')`).run(WS)
    const keyFilter = scope.sessionBrokerKeyFilter(901330)!
    expect(keyFilter('STRIPE_SECRET_KEY')).toBe(false)
    expect(keyFilter('STRIPE_READONLY_BACKFILL_KEY')).toBe(true)
    const names = broker.listForCaller({ userId: OPERATOR, isAdmin: true, workspaces: [WS], keyFilter }).map(i => i.name)
    expect(names).toEqual(['STRIPE_READONLY_BACKFILL_KEY'])
    getDb().prepare(`UPDATE objectives SET agent_context = 'general' WHERE id = 901330`).run()
    expect(scope.sessionBrokerKeyFilter(901330)).toBeUndefined()
  })
})

describe('test 3 — connectors need an explicit Who can use it grant naming the bot', () => {
  it('no connector_access row: Operator\'s GitHub and Google are absent for every scoped bot', () => {
    for (const bot of Object.keys(scope.EXAMPLE_BOT_PACKS)) {
      const env = spawn(bot)
      expect(env.GH_TOKEN).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.GOOGLE_REFRESH_TOKEN).toBeUndefined()
      expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    }
    expect(githubSessionAccess(card('example-cto'))).toMatchObject({ state: 'unavailable', reason: 'no_grant' })
  })
  it('a grant naming example-cto gives GitHub to example-cto only — no other bot', () => {
    setAccess('github', OPERATOR, { agents: ['example-cto', 'general'], workspaces: null, allow_delegated: false })
    expect(spawn('example-cto').GH_TOKEN).toBe(FAKE_PAT)
    for (const bot of Object.keys(scope.EXAMPLE_BOT_PACKS).filter(b => b !== 'example-cto')) {
      expect(spawn(bot).GH_TOKEN).toBeUndefined()
    }
    expect(spawn('some-other-agent').GH_TOKEN).toBeUndefined()
  })
  it('a grant cannot widen a bot past its pack (GitHub for CFO stays off)', () => {
    setAccess('github', OPERATOR, { agents: ['example-cfo'], workspaces: null, allow_delegated: false })
    expect(spawn('example-cfo').GH_TOKEN).toBeUndefined()
    expect(githubSessionAccess(card('example-cfo'))).toMatchObject({ state: 'unavailable', reason: 'bot_scope' })
  })
  it('Google: granted bots on the pack get it, marked drafts-only / read+drafts', () => {
    setAccess('google-workspace', OPERATOR, { agents: ['example-cfo', 'example-general-counsel'], workspaces: null, allow_delegated: false })
    const cfo = spawn('example-cfo')
    expect(cfo.GOOGLE_WORKSPACE_CONNECTION).toBe('user')
    expect(cfo.CC_GOOGLE_USE).toBe('read_and_drafts')
    expect(spawn('example-general-counsel').CC_GOOGLE_USE).toBe('drafts_only')
    // On the pack but not named in the grant → absent.
    expect(spawn('example-client-success').GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    // Granted elsewhere, not on the pack → absent.
    expect(spawn('example-cto').GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
  })
  it('default (no row, flag off): an unscoped agent keeps today\'s behaviour', () => {
    expect(spawn('general').GH_TOKEN).toBe(FAKE_PAT)
  })
  it('connector_access_default_deny=1: no grant → an arbitrary agent gets neither; a grant names exactly who', () => {
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('connector_access_default_deny', '1')`).run()
    const env = spawn('some-other-agent')
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GOOGLE_WORKSPACE_CONNECTION).toBe('absent')
    setAccess('github', OPERATOR, { agents: ['general'], workspaces: null, allow_delegated: false })
    expect(spawn('general').GH_TOKEN).toBe(FAKE_PAT)
    expect(spawn('some-other-agent').GH_TOKEN).toBeUndefined()
  })
  it('workspace MCP servers are withheld from a scoped bot unless on its list', () => {
    getDb().prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES (?, 'Example')`).run(WS)
    const row = mcp.createServer({ workspace: WS, name: 'Open', url: 'https://mcp.example.test/mcp', auth_type: 'none' }, OPERATOR)
    getDb().prepare(`UPDATE workspace_mcp_servers SET status = 'connected', enabled = 1 WHERE id = ?`).run(row.id)
    expect(spawn('general')[mcp.WORKSPACE_MCP_ENV]).toBeDefined()
    expect(spawn('example-cto')[mcp.WORKSPACE_MCP_ENV]).toBeUndefined()
  })
})

describe('test 4 — enforce mode: plan + fail-closed behaviour, no live flip', () => {
  it('nothing in this change writes the mode or the connector default', () => {
    spawn('example-cfo')
    spawn('general')
    const rows = getDb().prepare(`SELECT key FROM settings WHERE key IN ('secrets_session_env_mode','connector_access_default_deny','bot_session_scope_enabled')`).all()
    expect(rows).toEqual([])
  })
  it('enforce with an EMPTY allowlist gives an unscoped agent no store keys at all', () => {
    process.env.CC_SECRETS_SESSION_ENV_MODE = 'enforce'
    expect(storeKeysIn(spawn('general'))).toEqual([])
  })
  it('enforce mode leaves a scoped bot on exactly its pack', () => {
    process.env.CC_SECRETS_SESSION_ENV_MODE = 'enforce'
    expect(storeKeysIn(spawn('example-cfo'))).toEqual(['STRIPE_READONLY_BACKFILL_KEY'])
  })
  it('an unreadable allowlist in enforce mode injects nothing (fail closed)', () => {
    process.env.CC_SECRETS_SESSION_ENV_MODE = 'enforce'
    getDb().exec('ALTER TABLE secret_env_allowlist RENAME TO secret_env_allowlist_hidden')
    try {
      expect(storeKeysIn(spawn('general'))).toEqual([])
      // A scoped bot still gets its pack (the code list) but no allowlist extras.
      expect(storeKeysIn(spawn('example-cfo'))).toEqual(['STRIPE_READONLY_BACKFILL_KEY'])
    } finally {
      getDb().exec('ALTER TABLE secret_env_allowlist_hidden RENAME TO secret_env_allowlist')
    }
  })
  it('the design note with the enforce plan is in the repo', async () => {
    const fs = await import('fs')
    const p = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../docs/design/BOT-SECRET-SCOPE.md')
    const text = fs.readFileSync(p, 'utf8')
    expect(text).toMatch(/enforce/i)
    expect(text).toMatch(/connector_access_default_deny/)
  })
})

describe('review CLI', () => {
  it('`bots` lists each pack by name with saved / not-saved, and never a value', async () => {
    const cli = await import('../scripts/secrets-env-allowlist.js')
    const lines: string[] = []
    expect(cli.run(['bots'], l => lines.push(l))).toBe(0)
    const text = lines.join('\n')
    expect(text).toContain('per-bot scope: ON')
    expect(text).toMatch(/example-paid-ads[\s\S]*not saved: POSTHOG_EXAMPLE_584614_PROJECT_KEY, META_SYSTEM_USER_TOKEN/)
    expect(text).toMatch(/RAILWAY_\*: RAILWAY_API_TOKEN, RAILWAY_TOKEN/)
    expect(text).not.toContain('fake-')
  })
})

describe('tmux mode — inherited server env', () => {
  it('a scoped bot\'s wrapper unsets every store name its env does not carry', () => {
    const env = spawn('example-cfo')
    const line = scope.withheldUnsetLine(env)
    expect(line.startsWith('\nunset ')).toBe(true)
    const names = line.trim().split(/\s+/).slice(1)
    expect(names).toContain('STRIPE_SECRET_KEY')
    expect(names).toContain('RAILWAY_TOKEN')
    expect(names).not.toContain('STRIPE_READONLY_BACKFILL_KEY')
  })
  it('an unscoped session wrapper is unchanged', () => {
    expect(scope.withheldUnsetLine(spawn('general'))).toBe('')
  })
})
