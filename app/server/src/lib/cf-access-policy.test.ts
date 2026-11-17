/**
 * Cloudflare Access allow-policy sync (obj 900023).
 *
 * Every Cloudflare call is mocked — this suite NEVER touches a real account.
 * The fake token is assembled at runtime from harmless parts so no
 * secret-shaped literal is committed (the OSS publish gate scans for those).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  CfAccessPolicyClient,
  DEFAULT_POLICY_NAME,
  VERIFY_ROBOT_POLICY_NAME,
  allowListCovers,
  cfAccessPolicyConfig,
  normaliseEmail,
  type CfAccessPolicyConfig,
} from './cf-access-policy.js'

const ACCOUNT = 'abc123def4567890abc123def4567890'
const AUD = 'aud-tag-for-this-install'
const APP_ID = 'app-1'
const POLICY_ID = 'pol-1'
// Assembled, not a literal: keeps the gitleaks-style gate quiet.
const FAKE_TOKEN = ['not', 'a', 'real', 'token'].join('-')

function cfg(over: Partial<CfAccessPolicyConfig> = {}): CfAccessPolicyConfig {
  return {
    accountId: ACCOUNT,
    apiToken: FAKE_TOKEN,
    aud: AUD,
    appId: null,
    policyName: DEFAULT_POLICY_NAME,
    protectedEmails: [],
    ...over,
  }
}

interface Call { method: string; url: string; body: unknown; headers: Record<string, string> }

/**
 * A fake Cloudflare. `policies` is mutated by PUT so idempotency can be
 * observed across calls the way it happens in production.
 */
function fakeCf(opts: {
  apps?: Array<{ id: string; aud: string }>
  policies?: Array<Record<string, unknown>>
  status?: number
  envelope?: unknown
} = {}) {
  const calls: Call[] = []
  const apps = opts.apps ?? [{ id: APP_ID, aud: AUD }]
  const policies = opts.policies ?? [
    { id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow', precedence: 1, include: [{ email: { email: 'owner@example.com' } }] },
    { id: 'pol-robot', name: VERIFY_ROBOT_POLICY_NAME, decision: 'non_identity', precedence: 2, include: [{ service_token: { token_id: 't' } }] },
  ]
  const fetchImpl = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const method = init?.method ?? 'GET'
    const body = init?.body ? JSON.parse(init.body) : undefined
    calls.push({ method, url, body, headers: init?.headers ?? {} })
    const ok = (result: unknown) => ({ ok: true, status: opts.status ?? 200, json: async () => opts.envelope ?? { success: true, result } })
    if (opts.status && opts.status >= 400) {
      return { ok: false, status: opts.status, json: async () => opts.envelope ?? { success: false, errors: [{ code: 10000 }] } }
    }
    if (opts.envelope !== undefined) return ok(null)
    if (method === 'GET' && url.endsWith('/access/apps')) return ok(apps)
    if (method === 'GET' && url.endsWith('/policies')) return ok(policies)
    if (method === 'PUT' && url.includes('/policies/')) {
      const id = url.slice(url.lastIndexOf('/') + 1)
      const target = policies.find(p => p.id === id)
      if (target) Object.assign(target, body)
      return ok({ id })
    }
    return { ok: false, status: 404, json: async () => ({ success: false, errors: [{ code: 1003 }] }) }
  }
  return { calls, policies, fetchImpl: fetchImpl as never }
}

describe('cfAccessPolicyConfig', () => {
  const base = { OK_CF_ACCOUNT_ID: ACCOUNT, OK_CF_ACCESS_API_TOKEN: FAKE_TOKEN, OK_CF_ACCESS_AUD: AUD }

  it('is null unless a token and the AUD are present', () => {
    expect(cfAccessPolicyConfig({} as NodeJS.ProcessEnv)).toBeNull()
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCESS_API_TOKEN: '' } as NodeJS.ProcessEnv)).toBeNull()
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCESS_AUD: '' } as NodeJS.ProcessEnv)).toBeNull()
  })

  it('a missing account id is resolved later from the token (an install that never recorded it)', () => {
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCOUNT_ID: '' } as NodeJS.ProcessEnv)?.accountId).toBeNull()
  })

  it('never puts a malformed account id into a URL: it is dropped and resolved from the token', () => {
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCOUNT_ID: '../../etc' } as NodeJS.ProcessEnv)?.accountId).toBeNull()
  })

  it('a token from Settings wins over the env fallback', () => {
    const settings = ['from', 'settings', 'token'].join('-')
    expect(cfAccessPolicyConfig(base as NodeJS.ProcessEnv, settings)?.apiToken).toBe(settings)
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCESS_API_TOKEN: '' } as NodeJS.ProcessEnv, settings)?.apiToken).toBe(settings)
  })

  it('refuses to be pointed at the verify-robot policy', () => {
    expect(cfAccessPolicyConfig({ ...base, OK_CF_ACCESS_POLICY_NAME: VERIFY_ROBOT_POLICY_NAME } as NodeJS.ProcessEnv)).toBeNull()
  })

  it('defaults the policy name and parses protected emails', () => {
    const c = cfAccessPolicyConfig({ ...base, OK_CF_ACCESS_PROTECTED_EMAILS: ' Owner@Example.com , nope , b@example.com ' } as NodeJS.ProcessEnv)
    expect(c?.policyName).toBe(DEFAULT_POLICY_NAME)
    expect(c?.protectedEmails).toEqual(['owner@example.com', 'b@example.com'])
  })
})

describe('allowListCovers', () => {
  it('matches an exact email and a domain rule, case-insensitively', () => {
    const list = { emails: ['a@example.com'], domains: ['example.org'] }
    expect(allowListCovers(list, 'A@Example.com')).toBe('email')
    expect(allowListCovers(list, 'anyone@EXAMPLE.org')).toBe('domain')
    expect(allowListCovers(list, 'nobody@elsewhere.com')).toBeNull()
  })

  it('never matches a non-email', () => {
    expect(allowListCovers({ emails: [], domains: ['example.com'] }, 'example.com')).toBeNull()
  })
})

describe('normaliseEmail', () => {
  it('lower-cases and trims, and rejects anything without an @', () => {
    expect(normaliseEmail('  Ann@Example.COM ')).toBe('ann@example.com')
    expect(normaliseEmail('ann')).toBeNull()
    expect(normaliseEmail(null)).toBeNull()
  })
})

describe('CfAccessPolicyClient.addEmail', () => {
  let cf: ReturnType<typeof fakeCf>
  beforeEach(() => { cf = fakeCf() })

  it('appends exactly one email rule and keeps the existing include entries', async () => {
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    const res = await client.addEmail('New.Person@example.com')
    expect(res).toEqual({ ok: true, changed: true, reason: 'added' })

    const put = cf.calls.find(c => c.method === 'PUT')!
    expect(put.url).toContain(`/accounts/${ACCOUNT}/access/apps/${APP_ID}/policies/${POLICY_ID}`)
    expect((put.body as { include: unknown[] }).include).toEqual([
      { email: { email: 'owner@example.com' } },
      { email: { email: 'new.person@example.com' } },
    ])
    // The policy's own identity is preserved, not rewritten.
    expect(put.body).toMatchObject({ name: DEFAULT_POLICY_NAME, decision: 'allow', precedence: 1 })
  })

  it('is idempotent: re-adding the same email performs no write', async () => {
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    await client.addEmail('new@example.com')
    const writesAfterFirst = cf.calls.filter(c => c.method === 'PUT').length
    const second = await client.addEmail('NEW@example.com')
    expect(second).toEqual({ ok: true, changed: false, reason: 'already_allowed' })
    expect(cf.calls.filter(c => c.method === 'PUT').length).toBe(writesAfterFirst)
  })

  it('writes nothing when a domain rule already covers the address', async () => {
    const cf2 = fakeCf({
      policies: [{ id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow', include: [{ email_domain: { domain: 'example.com' } }] }],
    })
    const client = new CfAccessPolicyClient(cfg(), cf2.fetchImpl)
    const res = await client.addEmail('anyone@example.com')
    expect(res).toEqual({ ok: true, changed: false, reason: 'covered_by_domain' })
    expect(cf2.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('never writes to the verify-robot policy', async () => {
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    await client.addEmail('new@example.com')
    expect(cf.calls.filter(c => c.method !== 'GET').every(c => !c.url.includes('pol-robot'))).toBe(true)
    const robot = cf.policies.find(p => p.id === 'pol-robot')!
    expect(robot.include).toEqual([{ service_token: { token_id: 't' } }])
  })

  it('refuses a policy whose decision is not allow', async () => {
    const cf2 = fakeCf({ policies: [{ id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'bypass', include: [] }] })
    const client = new CfAccessPolicyClient(cfg(), cf2.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'policy_refused' })
    expect(cf2.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('only ever resolves the app whose AUD matches this install', async () => {
    const cf2 = fakeCf({ apps: [{ id: 'other-app', aud: 'someone-elses-aud' }, { id: APP_ID, aud: AUD }] })
    const client = new CfAccessPolicyClient(cfg(), cf2.fetchImpl)
    await client.addEmail('new@example.com')
    expect(cf2.calls.filter(c => c.url.includes('/apps/')).every(c => !c.url.includes('other-app'))).toBe(true)
  })

  it('reports app_not_found when no app carries this AUD, and writes nothing', async () => {
    const cf2 = fakeCf({ apps: [{ id: 'other-app', aud: 'someone-elses-aud' }] })
    const client = new CfAccessPolicyClient(cfg(), cf2.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'app_not_found' })
    expect(cf2.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('reports policy_not_found when the allow policy is missing', async () => {
    const cf2 = fakeCf({ policies: [{ id: 'pol-robot', name: VERIFY_ROBOT_POLICY_NAME, decision: 'non_identity', include: [] }] })
    const client = new CfAccessPolicyClient(cfg(), cf2.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'policy_not_found' })
  })
})

describe('CfAccessPolicyClient.removeEmail', () => {
  it('drops exactly the one email rule', async () => {
    const cf = fakeCf({
      policies: [{
        id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow',
        include: [{ email: { email: 'keep@example.com' } }, { email: { email: 'go@example.com' } }],
      }],
    })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.removeEmail('GO@example.com')).toEqual({ ok: true, changed: true, reason: 'removed' })
    const put = cf.calls.find(c => c.method === 'PUT')!
    expect((put.body as { include: unknown[] }).include).toEqual([{ email: { email: 'keep@example.com' } }])
  })

  it('is idempotent: removing an absent email performs no write', async () => {
    const cf = fakeCf()
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.removeEmail('never@example.com')).toEqual({ ok: true, changed: false, reason: 'not_present' })
    expect(cf.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('leaves a domain rule alone even when it covers the address', async () => {
    const cf = fakeCf({
      policies: [{
        id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow',
        include: [{ email_domain: { domain: 'example.com' } }, { email: { email: 'keep@other.com' } }],
      }],
    })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.removeEmail('someone@example.com')).toEqual({ ok: true, changed: false, reason: 'not_present' })
    expect(cf.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('never removes an installer-managed (protected) address', async () => {
    const cf = fakeCf()
    const client = new CfAccessPolicyClient(cfg({ protectedEmails: ['owner@example.com'] }), cf.fetchImpl)
    expect(await client.removeEmail('owner@example.com')).toEqual({ ok: true, changed: false, reason: 'protected' })
    expect(cf.calls.length).toBe(0)
  })

  it('refuses a removal that would leave the policy matching nobody', async () => {
    const cf = fakeCf({
      policies: [{ id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow', include: [{ email: { email: 'last@example.com' } }] }],
    })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.removeEmail('last@example.com')).toEqual({ ok: true, changed: false, reason: 'would_empty_policy' })
    expect(cf.calls.some(c => c.method === 'PUT')).toBe(false)
  })
})

/**
 * The default install is a name-by-name list. The app adds teammates one
 * {email} entry at a time and must NEVER introduce a domain-wide allow on its
 * own, whatever sequence of adds, re-emails and removes it is asked to do.
 */
describe('the app never writes an email_domain rule', () => {
  const hasDomainRule = (inc: unknown) => (inc as Array<Record<string, unknown>>).some(r => 'email_domain' in r)

  it('on the email-list default, adds, re-emails and removes only ever send {email} entries', async () => {
    const cf = fakeCf()
    const client = new CfAccessPolicyClient(cfg({ protectedEmails: ['owner@example.com'] }), cf.fetchImpl)
    await client.addEmail('a@company.com')
    await client.addEmail('b@company.com')
    await client.addEmail('c@company.com')
    await client.addEmail('new-b@company.com')
    await client.removeEmail('b@company.com')
    await client.removeEmail('a@company.com')
    const puts = cf.calls.filter(c => c.method === 'PUT')
    expect(puts.length).toBeGreaterThan(0)
    for (const p of puts) {
      const inc = (p.body as { include: Array<Record<string, unknown>> }).include
      expect(hasDomainRule(inc)).toBe(false)
      for (const r of inc) expect(Object.keys(r)).toEqual(['email'])
    }
    expect(cf.policies[0].include).toEqual([
      { email: { email: 'owner@example.com' } },
      { email: { email: 'c@company.com' } },
      { email: { email: 'new-b@company.com' } },
    ])
  })
})

describe('an email change moves the entry', () => {
  it('adds the new address and removes the old one, leaving everything else', async () => {
    const cf = fakeCf({
      policies: [{
        id: POLICY_ID, name: DEFAULT_POLICY_NAME, decision: 'allow',
        include: [{ email_domain: { domain: 'example.org' } }, { email: { email: 'old@example.com' } }],
      }],
    })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    await client.addEmail('new@example.com')
    await client.removeEmail('old@example.com')
    const final = cf.policies[0].include as unknown[]
    expect(final).toEqual([{ email_domain: { domain: 'example.org' } }, { email: { email: 'new@example.com' } }])
  })
})

describe('insufficient rights and transport failures', () => {
  it('maps 403 to forbidden without writing', async () => {
    const cf = fakeCf({ status: 403 })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'forbidden' })
    expect(cf.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('maps Cloudflare 200 + success:false + code 10000 to forbidden', async () => {
    const cf = fakeCf({ envelope: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'forbidden' })
  })

  it('maps a network failure to unreachable', async () => {
    const client = new CfAccessPolicyClient(cfg(), (async () => { throw new Error('ECONNRESET') }) as never)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'unreachable' })
  })

  it('maps an unreadable non-auth error to cloudflare_error', async () => {
    const cf = fakeCf({ envelope: { success: false, errors: [{ code: 1003 }] } })
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    expect(await client.addEmail('new@example.com')).toEqual({ ok: false, reason: 'cloudflare_error' })
  })
})

describe('the token never escapes', () => {
  it('appears only in the Authorization header, never in a URL, body or result', async () => {
    const cf = fakeCf()
    const client = new CfAccessPolicyClient(cfg(), cf.fetchImpl)
    const results = [
      await client.addEmail('new@example.com'),
      await client.removeEmail('new@example.com'),
      await client.allowList(),
    ]
    expect(cf.calls.length).toBeGreaterThan(0)
    for (const call of cf.calls) {
      expect(call.url).not.toContain(FAKE_TOKEN)
      expect(JSON.stringify(call.body ?? null)).not.toContain(FAKE_TOKEN)
      expect(call.headers.Authorization).toBe(`Bearer ${FAKE_TOKEN}`)
    }
    expect(JSON.stringify(results)).not.toContain(FAKE_TOKEN)
  })

  it('keeps the token out of every failure reason', async () => {
    for (const bad of [fakeCf({ status: 403 }), fakeCf({ envelope: { success: false, errors: [{ code: 1003 }] } })]) {
      const client = new CfAccessPolicyClient(cfg(), bad.fetchImpl)
      const res = await client.addEmail('new@example.com')
      expect(JSON.stringify(res)).not.toContain(FAKE_TOKEN)
      expect(res.ok).toBe(false)
    }
  })
})
