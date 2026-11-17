/**
 * Settings → Users ⟷ Cloudflare Access reconciliation (obj 900023).
 * Cloudflare is mocked throughout; nothing here reaches a real account.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CfAccessPolicyClient, DEFAULT_POLICY_NAME, type CfAccessPolicyConfig } from '../lib/cf-access-policy.js'
import {
  cfAccessStatuses,
  clearCfAccessStatusCache,
  installerAllowList,
  setCfAccessPolicyClientForTests,
  syncUserAccessEmail,
} from './cf-access-user-sync.js'

// cf-access-token.ts -> secrets-store -> db/index.ts reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in this test') } }))

const ACCOUNT = 'abc123def4567890abc123def4567890'
const AUD = 'aud-tag-for-this-install'
const FAKE_TOKEN = ['not', 'a', 'real', 'token'].join('-')

/** Env of an install that IS behind Cloudflare Access (cfAccessConfig non-null). */
const ACCESS_ENV = { OK_CF_ACCESS_TEAM: 'acme', OK_CF_ACCESS_AUD: AUD } as NodeJS.ProcessEnv
const SYNC_ENV = { ...ACCESS_ENV, OK_CF_ACCOUNT_ID: ACCOUNT, OK_CF_ACCESS_API_TOKEN: FAKE_TOKEN } as NodeJS.ProcessEnv

function cfg(over: Partial<CfAccessPolicyConfig> = {}): CfAccessPolicyConfig {
  return { accountId: ACCOUNT, apiToken: FAKE_TOKEN, aud: AUD, appId: 'app-1', policyName: DEFAULT_POLICY_NAME, protectedEmails: [], ...over }
}

function fakeCf(include: Array<Record<string, unknown>>, opts: { status?: number } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  const policy: Record<string, unknown> = { id: 'pol-1', name: DEFAULT_POLICY_NAME, decision: 'allow', precedence: 1, include }
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body })
    if (opts.status) return { ok: false, status: opts.status, json: async () => ({ success: false, errors: [{ code: 10000 }] }) }
    if (method === 'GET' && url.endsWith('/policies')) return { ok: true, status: 200, json: async () => ({ success: true, result: [policy] }) }
    if (method === 'PUT') { Object.assign(policy, body); return { ok: true, status: 200, json: async () => ({ success: true, result: policy }) } }
    return { ok: true, status: 200, json: async () => ({ success: true, result: [{ id: 'app-1', aud: AUD }] }) }
  }
  return { calls, policy, client: (c = cfg()) => new CfAccessPolicyClient(c, fetchImpl as never) }
}

let logs: string[]
beforeEach(() => {
  logs = []
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')) })
  clearCfAccessStatusCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  setCfAccessPolicyClientForTests(null)
  clearCfAccessStatusCache()
})

describe('cfAccessStatuses', () => {
  it('says not_applicable on an install that is not behind Cloudflare Access', async () => {
    const out = await cfAccessStatuses(['a@example.com'], {} as NodeJS.ProcessEnv)
    expect(out.get('a@example.com')).toEqual({ status: 'not_applicable', detail: 'access_not_configured' })
  })

  it('reports "blocked" (never an error) when the install holds no Cloudflare token', async () => {
    setCfAccessPolicyClientForTests(null)
    const out = await cfAccessStatuses(['a@example.com'], ACCESS_ENV)
    expect(out.get('a@example.com')).toEqual({ status: 'blocked', detail: 'sync_not_configured' })
  })

  it('reports "blocked" with the forbidden reason when the token lacks Access rights', async () => {
    const cf = fakeCf([], { status: 403 })
    setCfAccessPolicyClientForTests(cf.client())
    const out = await cfAccessStatuses(['a@example.com'], SYNC_ENV)
    expect(out.get('a@example.com')).toEqual({ status: 'blocked', detail: 'forbidden' })
  })

  it('separates allowed-directly, allowed-by-domain and not-allowed', async () => {
    const cf = fakeCf([{ email: { email: 'direct@other.com' } }, { email_domain: { domain: 'example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    const out = await cfAccessStatuses(['Direct@other.com', 'someone@EXAMPLE.com', 'nobody@elsewhere.com'], SYNC_ENV)
    expect(out.get('direct@other.com')).toEqual({ status: 'can_sign_in', detail: 'allowed_directly' })
    expect(out.get('someone@example.com')).toEqual({ status: 'can_sign_in', detail: 'allowed_by_domain' })
    expect(out.get('nobody@elsewhere.com')).toEqual({ status: 'blocked', detail: 'not_allowed' })
  })

  it('reads Cloudflare once for a whole page of users', async () => {
    const cf = fakeCf([{ email: { email: 'a@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    await cfAccessStatuses(['a@example.com', 'b@example.com', 'c@example.com'], SYNC_ENV)
    expect(cf.calls.filter(c => c.url.endsWith('/policies')).length).toBe(1)
  })

  it('skips users with no email', async () => {
    const cf = fakeCf([])
    setCfAccessPolicyClientForTests(cf.client())
    const out = await cfAccessStatuses([null, '', undefined], SYNC_ENV)
    expect(out.size).toBe(0)
    expect(cf.calls.length).toBe(0)
  })
})

/**
 * An install that already set the OPTIONAL ACCESS_ALLOWED_EMAIL_DOMAIN (obj 900023;
 * not the default, which is a name-by-name list) keeps working. An admin who
 * adds a teammate in Settings → Users must see "can sign in" with NO Cloudflare
 * token on the server, because the domain rule already lets them through.
 */
describe('pre-existing optional domain rule (not the default), no Cloudflare token', () => {
  const DOMAIN_ENV = { ...ACCESS_ENV, OK_CF_ACCESS_ALLOWED_DOMAIN: 'example-capital.com' } as NodeJS.ProcessEnv

  it('shows a newly added company teammate as "can sign in" without any token or Cloudflare call', async () => {
    const cf = fakeCf([])
    // A client is injected only so we can prove it is never called.
    setCfAccessPolicyClientForTests(cf.client())
    const out = await cfAccessStatuses(['New.Hire@Example-Capital.com'], DOMAIN_ENV)
    expect(out.get('new.hire@example-capital.com')).toEqual({ status: 'can_sign_in', detail: 'allowed_by_domain' })
    expect(cf.calls).toHaveLength(0)
  })

  it('with no token at all, company addresses can sign in and outsiders read "blocked at Cloudflare"', async () => {
    setCfAccessPolicyClientForTests(null)
    const out = await cfAccessStatuses(['a@example-capital.com', 'adviser@other-firm.com'], DOMAIN_ENV)
    expect(out.get('a@example-capital.com')).toEqual({ status: 'can_sign_in', detail: 'allowed_by_domain' })
    expect(out.get('adviser@other-firm.com')).toEqual({ status: 'blocked', detail: 'sync_not_configured' })
  })

  it('treats addresses the installer listed (ACCESS_ALLOWED_EMAILS) as allowed without a token', async () => {
    setCfAccessPolicyClientForTests(null)
    const env = { ...DOMAIN_ENV, OK_CF_ACCESS_PROTECTED_EMAILS: 'adviser@other-firm.com' } as NodeJS.ProcessEnv
    const out = await cfAccessStatuses(['adviser@other-firm.com'], env)
    expect(out.get('adviser@other-firm.com')).toEqual({ status: 'can_sign_in', detail: 'allowed_directly' })
  })

  it('does not match a look-alike domain (suffix or subdomain)', async () => {
    setCfAccessPolicyClientForTests(null)
    const out = await cfAccessStatuses(['x@evil-example-capital.com', 'y@mail.example-capital.com'], DOMAIN_ENV)
    expect(out.get('x@evil-example-capital.com')?.status).toBe('blocked')
    expect(out.get('y@mail.example-capital.com')?.status).toBe('blocked')
  })

  it('ignores a malformed domain value instead of matching everything', () => {
    expect(installerAllowList({ OK_CF_ACCESS_ALLOWED_DOMAIN: '' } as NodeJS.ProcessEnv).domains).toEqual([])
    expect(installerAllowList({ OK_CF_ACCESS_ALLOWED_DOMAIN: '*' } as NodeJS.ProcessEnv).domains).toEqual([])
    expect(installerAllowList({ OK_CF_ACCESS_ALLOWED_DOMAIN: '@Example-Capital.com ' } as NodeJS.ProcessEnv).domains).toEqual(['example-capital.com'])
  })

  it('still never shows a badge on an install that is not behind Cloudflare Access', async () => {
    const out = await cfAccessStatuses(['a@example-capital.com'], { OK_CF_ACCESS_ALLOWED_DOMAIN: 'example-capital.com' } as NodeJS.ProcessEnv)
    expect(out.get('a@example-capital.com')).toEqual({ status: 'not_applicable', detail: 'access_not_configured' })
  })
})

describe('syncUserAccessEmail', () => {
  it('adds a newly created user to the allow policy', async () => {
    const cf = fakeCf([{ email: { email: 'owner@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    const report = await syncUserAccessEmail(null, 'New@example.com', SYNC_ENV)
    expect(report).toEqual({ added: 'new@example.com' })
    expect(cf.policy.include).toEqual([{ email: { email: 'owner@example.com' } }, { email: { email: 'new@example.com' } }])
  })

  it('is idempotent: re-running the same create writes nothing the second time', async () => {
    const cf = fakeCf([{ email: { email: 'owner@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    await syncUserAccessEmail(null, 'new@example.com', SYNC_ENV)
    const writes = cf.calls.filter(c => c.method === 'PUT').length
    const again = await syncUserAccessEmail(null, 'new@example.com', SYNC_ENV)
    expect(again).toEqual({})
    expect(cf.calls.filter(c => c.method === 'PUT').length).toBe(writes)
  })

  it('removes a deleted user from the allow policy', async () => {
    const cf = fakeCf([{ email: { email: 'owner@example.com' } }, { email: { email: 'gone@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    expect(await syncUserAccessEmail('gone@example.com', null, SYNC_ENV)).toEqual({ removed: 'gone@example.com' })
    expect(cf.policy.include).toEqual([{ email: { email: 'owner@example.com' } }])
  })

  it('moves the entry when the email changes', async () => {
    const cf = fakeCf([{ email_domain: { domain: 'example.org' } }, { email: { email: 'old@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    expect(await syncUserAccessEmail('old@example.com', 'new@example.com', SYNC_ENV))
      .toEqual({ added: 'new@example.com', removed: 'old@example.com' })
    expect(cf.policy.include).toEqual([{ email_domain: { domain: 'example.org' } }, { email: { email: 'new@example.com' } }])
  })

  it('does nothing at all when the email did not change', async () => {
    const cf = fakeCf([{ email: { email: 'same@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    expect(await syncUserAccessEmail('Same@example.com', 'same@EXAMPLE.com', SYNC_ENV)).toEqual({})
    expect(cf.calls.length).toBe(0)
  })

  it('is a quiet no-op when the install has no Cloudflare token', async () => {
    setCfAccessPolicyClientForTests(null)
    expect(await syncUserAccessEmail(null, 'new@example.com', {} as NodeJS.ProcessEnv)).toEqual({})
    expect(logs.join('\n')).toBe('')
  })

  it('reports — never throws — when the token lacks Access rights', async () => {
    const cf = fakeCf([], { status: 403 })
    setCfAccessPolicyClientForTests(cf.client())
    const report = await syncUserAccessEmail(null, 'new@example.com', SYNC_ENV)
    expect(report).toEqual({ failure: 'forbidden' })
  })

  it('never throws even when the client itself blows up', async () => {
    const exploding = { addEmail: async () => { throw new Error('boom') }, removeEmail: async () => { throw new Error('boom') }, config: cfg(), invalidate() {} }
    setCfAccessPolicyClientForTests(exploding as unknown as CfAccessPolicyClient)
    await expect(syncUserAccessEmail(null, 'new@example.com', SYNC_ENV)).resolves.toEqual({ failure: 'cloudflare_error' })
  })
})

describe('the token never reaches a log line or a returned value', () => {
  it('logs the outcome without the credential', async () => {
    const cf = fakeCf([{ email: { email: 'owner@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    const report = await syncUserAccessEmail(null, 'new@example.com', SYNC_ENV)
    expect(logs.join('\n')).toContain('[cf-access-sync]')
    expect(logs.join('\n')).not.toContain(FAKE_TOKEN)
    expect(JSON.stringify(report)).not.toContain(FAKE_TOKEN)
  })

  it('keeps the credential out of the per-user status payload', async () => {
    const cf = fakeCf([{ email: { email: 'a@example.com' } }])
    setCfAccessPolicyClientForTests(cf.client())
    const out = await cfAccessStatuses(['a@example.com', 'b@example.com'], SYNC_ENV)
    expect(JSON.stringify([...out])).not.toContain(FAKE_TOKEN)
    expect(logs.join('\n')).not.toContain(FAKE_TOKEN)
  })
})

describe('cfAccessApplies', () => {
  it('is false when this install is not behind Cloudflare Access', async () => {
    const { cfAccessApplies } = await import('./cf-access-user-sync.js')
    expect(cfAccessApplies({} as NodeJS.ProcessEnv)).toBe(false)
    expect(cfAccessApplies({ OK_CF_ACCESS_TEAM: 'acme' } as NodeJS.ProcessEnv)).toBe(false)
  })

  it('is true once the team domain and AUD are both configured', async () => {
    const { cfAccessApplies } = await import('./cf-access-user-sync.js')
    expect(cfAccessApplies(ACCESS_ENV)).toBe(true)
  })
})
