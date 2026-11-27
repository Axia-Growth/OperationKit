import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  buildSpawnEnv,
  spawnSecurityPolicy,
  resolveSpawnTier,
  userGitIdentityEnv,
  resolveFallbackGitIdentity,
  GIT_IDENTITY_MISSING_MESSAGE,
} from './session-manager.js'
import { GIT_SSH_COMMAND } from '../config.js'
import type { Objective } from '@operationkit/shared'

// obj 900452: `verified_sender_stamps` now defaults ON (which also strips the
// signing key and adds CC_STRIP_SIGNING_SECRETS). This file pins the legacy
// flags-OFF spawn env, so it turns stamps off explicitly; the default-ON spawn
// env is asserted in lib/session-trust.test.ts.
process.env.CC_VERIFIED_SENDER_STAMPS = '0'

// These tests exercise the owner's own credential, so they read it as the
// server acting for that owner (services/connector-guard.ts).
const SERVER_ACTOR = { kind: 'server' as const }

// obj 900204: `session_kb_access` defaults ON and adds CC_SESSION_TOKEN /
// CC_OBJECTIVE_ID / CC_STRIP_SIGNING_SECRETS to the spawn env. The base-block
// no-regression cases below are about the LEGACY block, so pin it off here and
// cover the default-ON shape in its own describe at the bottom of this file.
process.env.CC_SESSION_KB_ACCESS = '0'

// obj-2202 / onboarding gate B1–B4 — spawn-env scoping refactor.
//
// THE load-bearing guarantee: with both scoping flags OFF (the committed default)
// and the default ADMIN tier, buildSpawnEnv() returns a BYTE-FOR-BYTE identical env
// to the old duplicated inline block at every spawn site. If this ever drifts, an
// admin session's runtime secret/identity env has silently changed — a regression
// the moment it ships. We also lock the two-tier policy and the W4 extension hook.

// A minimal objective — buildSpawnEnv only reads created_by (W4 hook) and, on the
// scoped seam, workspace/project (which return '' today). Cast a partial.
function fakeObjective(over: Partial<Objective> = {}): Objective {
  return { id: 42, workspace: 'example', project: 'example-platform', created_by: 7, ...over } as Objective
}

function legacyInlineEnv(homeDir: string): Record<string, string> {
  return {
    HOME: homeDir,
    USER: 'ccuser',
    TERM: 'dumb',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    GIT_SSH_COMMAND,
    GH_CONFIG_DIR: '/etc/gh',
    SUPABASE_ACCESS_TOKEN: process.env.SUPABASE_ACCESS_TOKEN || '',
  }
}

// obj-701130 — the base env above is NO LONGER the whole story for an UNLINKED
// owner. buildSpawnEnv ALWAYS sets GIT_AUTHOR_*/GIT_COMMITTER_* after the base
// block when no per-user identity was injected, so an env-less spawn can never
// fall through to whatever ~/.gitconfig or /etc/gitconfig the host carries. With
// no install fallback configured (OK_FALLBACK_GIT_NAME/EMAIL unset, as here) the
// values are EMPTY, so git refuses to commit, and GIT_IDENTITY=absent plus
// GIT_IDENTITY_HELP tell the session why. These keys append in this exact order
// (after the base keys, before any flag-gated scoped secrets).
function expectedEnv(homeDir: string): Record<string, string> {
  return {
    ...legacyInlineEnv(homeDir),
    GIT_AUTHOR_NAME: '',
    GIT_AUTHOR_EMAIL: '',
    GIT_COMMITTER_NAME: '',
    GIT_COMMITTER_EMAIL: '',
    GIT_IDENTITY: 'absent',
    GIT_IDENTITY_HELP: GIT_IDENTITY_MISSING_MESSAGE,
    // obj-706070 — per-user Google Workspace. With no connection row for the
    // objective's owner the resolver contributes exactly ONE key: the explicit
    // -absence marker. No token keys, and specifically no fallback to anyone
    // else's Google credential. Deliberate addition to the key contract.
    GOOGLE_WORKSPACE_CONNECTION: 'absent',
    WORKSPACE_MCP_CREDENTIALS_DIR: `${process.env.CC_SCRIPT_DIR || '/tmp/cc-scripts'}/google-creds/absent-7`,
    CC_ACTING_USER_ID: '7',
  }
}

describe('buildSpawnEnv — no-regression base block + obj-701130 git-author fallback (flags OFF default + admin tier)', () => {
  const HOME = '/home/ccuser-a'

  it('base block equals the legacy inline literal, PLUS the blanked git identity (obj-701130)', () => {
    // Was: expect(env).toEqual(legacyInlineEnv(HOME)). DELIBERATELY CHANGED —
    // buildSpawnEnv always sets the git identity for an unlinked owner so no spawn
    // can hit a host /etc/gitconfig. The base keys are still byte-identical.
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
    expect(env).toEqual(expectedEnv(HOME))
  })

  it('preserves the exact key set AND key order the wrapper serializes', () => {
    // The wrapper script does Object.entries(env).map(export ...). Order is part of
    // the byte-for-byte contract, so assert the ordered key list explicitly. The
    // GIT_AUTHOR_*/GIT_COMMITTER_* + GIT_IDENTITY keys (obj-701130) append after
    // the base block, in the order the code assigns them.
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
    expect(Object.keys(env)).toEqual([
      'HOME', 'USER', 'TERM', 'PATH', 'GIT_SSH_COMMAND', 'GH_CONFIG_DIR',
      'SUPABASE_ACCESS_TOKEN',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
      'GIT_IDENTITY', 'GIT_IDENTITY_HELP',
      // obj-706070: the per-user Google resolver ALWAYS appends this marker so a
      // session can distinguish "acting user's Google account" from "none". With
      // no connection seeded it is the only Google key ('absent'); the token keys
      // appear only on the connected branch (session-google-credential.test.ts).
      'GOOGLE_WORKSPACE_CONNECTION',
      'WORKSPACE_MCP_CREDENTIALS_DIR',
      'CC_ACTING_USER_ID',
    ])
  })

  it('is identical across all 5 spawn kinds for a given homeDir (single source of truth)', () => {
    const kinds = ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const
    const envs = kinds.map((k) => buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: k }))
    for (const env of envs) expect(env).toEqual(expectedEnv(HOME))
  })

  it('threads the per-site homeDir through unchanged (HOME differs, nothing else)', () => {
    const a = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    const b = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-b', sessionKind: 'planner' })
    expect(a.HOME).toBe('/home/ccuser-a')
    expect(b.HOME).toBe('/home/ccuser-b')
    expect({ ...a, HOME: 'x' }).toEqual({ ...b, HOME: 'x' })
  })

  it('passes SUPABASE_ACCESS_TOKEN through verbatim when present (flag off)', () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
    try {
      const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: HOME, sessionKind: 'worker' })
      expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_ACCESS_TOKEN
      else process.env.SUPABASE_ACCESS_TOKEN = prev
    }
  })
})

describe('userGitIdentityEnv — W4 hook, UNLINKED-owner fallback (filled by obj-2221)', () => {
  // The hook itself is unchanged: for an owner with no linked token it still
  // returns {} (fakeObjective().created_by = 7 has no token row in this test DB).
  // What buildSpawnEnv does with that {} is decided by the install config
  // (obj-701130): its own fallback identity, or a blanked identity that makes
  // `git commit` fail. The LINKED path is proven in session-user-git-identity.test.ts.
  afterEach(() => { vi.unstubAllEnvs() })

  it('the hook still returns {} for an owner with no linked token (fallback is applied by buildSpawnEnv, not here)', () => {
    expect(userGitIdentityEnv(7, SERVER_ACTOR)).toEqual({})
    expect(userGitIdentityEnv(null, SERVER_ACTOR)).toEqual({})
    expect(userGitIdentityEnv(undefined, SERVER_ACTOR)).toEqual({})
  })

  it('NO install fallback: the identity is blanked so git refuses to commit, with a connect-GitHub message', () => {
    vi.stubEnv('OK_FALLBACK_GIT_NAME', '')
    vi.stubEnv('OK_FALLBACK_GIT_EMAIL', '')
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    // Present-but-empty: env beats every gitconfig, and git rejects an empty ident.
    for (const k of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) {
      expect(env).toHaveProperty(k, '')
    }
    expect(env.GIT_IDENTITY).toBe('absent')
    expect(env.GIT_IDENTITY_HELP).toMatch(/Settings → Connectors → GitHub/)
    // No vendor identity is shipped in the product.
    expect(JSON.stringify(env)).not.toMatch(/m1keluka/)
  })

  it('install fallback set: an unlinked owner commits as the install\'s own bot/operator identity', () => {
    vi.stubEnv('OK_FALLBACK_GIT_NAME', ' acme-bot ')
    vi.stubEnv('OK_FALLBACK_GIT_EMAIL', '12345+acme-bot@users.noreply.github.com')
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GIT_AUTHOR_NAME).toBe('acme-bot')
    expect(env.GIT_AUTHOR_EMAIL).toBe('12345+acme-bot@users.noreply.github.com')
    expect(env.GIT_COMMITTER_NAME).toBe('acme-bot')
    expect(env.GIT_COMMITTER_EMAIL).toBe('12345+acme-bot@users.noreply.github.com')
    expect(env.GIT_IDENTITY).toBe('install')
    expect(env.GIT_IDENTITY_HELP).toBeUndefined()
  })
})

describe('resolveFallbackGitIdentity — install config (obj-701130)', () => {
  it('returns null unless BOTH name and email are set', () => {
    expect(resolveFallbackGitIdentity({})).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: 'acme-bot' })).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_EMAIL: 'bot@acme.test' })).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: '  ', OK_FALLBACK_GIT_EMAIL: 'bot@acme.test' })).toBeNull()
  })

  it('trims and returns a well-formed identity', () => {
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: ' Acme Bot ', OK_FALLBACK_GIT_EMAIL: ' bot@acme.test ' }))
      .toEqual({ name: 'Acme Bot', email: 'bot@acme.test' })
  })

  it('rejects values git would reject or that could smuggle a second ident', () => {
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: 'a<b>', OK_FALLBACK_GIT_EMAIL: 'bot@acme.test' })).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: 'bot', OK_FALLBACK_GIT_EMAIL: 'not-an-email' })).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: 'bot', OK_FALLBACK_GIT_EMAIL: 'a b@acme.test' })).toBeNull()
    expect(resolveFallbackGitIdentity({ OK_FALLBACK_GIT_NAME: 'bot', OK_FALLBACK_GIT_EMAIL: '<bot@acme.test>' })).toBeNull()  })
})

describe('spawnSecurityPolicy — two-tier (admin vs member)', () => {
  it('ADMIN tier grants every capability (unchanged current behavior)', () => {
    expect(spawnSecurityPolicy(true)).toEqual({
      dockerSocket: true,
      adminTokenFile: true,
      siblingHomeAccess: true,
      adminDopplerToken: true,
      supabaseToken: true,
    })
  })

  it('MEMBER tier denies docker socket, admin-token file, sibling homes, and org secrets', () => {
    const p = spawnSecurityPolicy(false)
    expect(p.dockerSocket).toBe(false)
    expect(p.adminTokenFile).toBe(false)
    expect(p.siblingHomeAccess).toBe(false)
    expect(p.adminDopplerToken).toBe(false)
    expect(p.supabaseToken).toBe(false)
  })

  it('resolveSpawnTier fails safe to admin for an unknown/unseeded owner (role-resolved seam, obj-2411)', () => {
    // The seam now resolves from the owner's GLOBAL role (member ⇒ 'member', else
    // admin). With no users row for this owner in the ambient test DB it must fail
    // SAFE to 'admin' = today's full-capability behavior — never silently downgrade.
    // The positive member-tier case is proven in session-spawn-env-doppler.test.ts
    // against a seeded member user + isolated DB.
    expect(resolveSpawnTier(fakeObjective({ created_by: 987654 }))).toBe('admin')
    expect(resolveSpawnTier(fakeObjective({ created_by: null as unknown as number }))).toBe('admin')
  })
})

describe('buildSpawnEnv — member tier with flags OFF still == current behavior', () => {
  // The FLAG, not the tier alone, gates the change. With flags off, even an
  // explicit member spawn gets today's env — proving zero behavior change ships
  // until the cutover flips a flag.
  it('member spawn (flags off) still receives org Supabase and never a DOPPLER_TOKEN', () => {
    const prev = process.env.SUPABASE_ACCESS_TOKEN
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
    try {
      const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: false })
      expect(env.DOPPLER_TOKEN).toBeUndefined()
      expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
    } finally {
      if (prev === undefined) delete process.env.SUPABASE_ACCESS_TOKEN
      else process.env.SUPABASE_ACCESS_TOKEN = prev
    }
  })
})

describe('buildSpawnEnv — flags ON cutover behavior (member scoped, admin unchanged)', () => {
  // Flags are read at module import from process.env. Re-import a fresh module
  // graph with the flags set ON to exercise the dormant cutover branch without
  // touching the committed defaults.
  const KEYS = ['USE_SCOPED_DOPPLER_TOKENS', 'SCOPE_SUPABASE_ACCESS_TOKEN', 'SUPABASE_ACCESS_TOKEN'] as const
  let saved: Record<string, string | undefined>
  beforeEach(() => {
    saved = {}
    for (const k of KEYS) saved[k] = process.env[k]
    process.env.USE_SCOPED_DOPPLER_TOKENS = '1'
    process.env.SCOPE_SUPABASE_ACCESS_TOKEN = '1'
    process.env.SUPABASE_ACCESS_TOKEN = 'org-supabase-token-xyz'
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.resetModules()
  })

  it('member spawn: no DOPPLER_TOKEN; Supabase withheld when SCOPE_SUPABASE_ACCESS_TOKEN is on', async () => {
    vi.resetModules()
    const sm = await import('./session-manager.js')
    const obj = { id: 42, workspace: 'example', project: 'example-platform', created_by: 7 } as Objective
    const env = sm.buildSpawnEnv({ objective: obj, homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: false })
    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('')
  })

  it('admin spawn: no DOPPLER_TOKEN; keeps org Supabase', async () => {
    vi.resetModules()
    const sm = await import('./session-manager.js')
    const obj = { id: 42, workspace: 'example', project: 'example-platform', created_by: 7 } as Objective
    const env = sm.buildSpawnEnv({ objective: obj, homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })
    expect(env.DOPPLER_TOKEN).toBeUndefined()
    expect(env.SUPABASE_ACCESS_TOKEN).toBe('org-supabase-token-xyz')
  })
})

// ── obj 900204 — knowledge-base access rides on the spawn env ───────────────

describe('buildSpawnEnv — session_kb_access (obj 900204)', () => {
  afterEach(() => { process.env.CC_SESSION_KB_ACCESS = '0' })

  it('ON: adds exactly the objective-scoped token keys, and drops the signing keys', async () => {
    const { verifySessionToken } = await import('../lib/session-trust.js')
    process.env.CC_SESSION_KB_ACCESS = '1'
    const on = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })
    process.env.CC_SESSION_KB_ACCESS = '0'
    const base = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })

    const added = Object.keys(on).filter(k => !(k in base))
    expect(added.sort()).toEqual(['CC_OBJECTIVE_ID', 'CC_SESSION_TOKEN', 'CC_STRIP_SIGNING_SECRETS'])
    expect(on.CC_OBJECTIVE_ID).toBe('42')
    expect(verifySessionToken(on.CC_SESSION_TOKEN)).toMatchObject({ objectiveId: 42, workspace: 'example' })
    // A session that still held the signing key could mint a token for ANY
    // workspace, so the scope only holds while these are absent.
    expect(on.JWT_SECRET).toBeUndefined()
    expect(on.CC_JWT_SECRET).toBeUndefined()
  })

  it('the token is scoped to THIS card, so two cards never share one', async () => {
    const { verifySessionToken } = await import('../lib/session-trust.js')
    process.env.CC_SESSION_KB_ACCESS = '1'
    const a = buildSpawnEnv({ objective: fakeObjective({ id: 1, workspace: 'example' }), homeDir: '/h', sessionKind: 'worker', isAdminSpawn: true })
    const b = buildSpawnEnv({ objective: fakeObjective({ id: 2, workspace: 'example2' }), homeDir: '/h', sessionKind: 'worker', isAdminSpawn: true })
    expect(verifySessionToken(a.CC_SESSION_TOKEN)).toMatchObject({ objectiveId: 1, workspace: 'example' })
    expect(verifySessionToken(b.CC_SESSION_TOKEN)).toMatchObject({ objectiveId: 2, workspace: 'example2' })
  })

  it('OFF: the spawn env is exactly what it was before this card', () => {
    const env = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })
    expect(env.CC_SESSION_TOKEN).toBeUndefined()
    expect(env.CC_OBJECTIVE_ID).toBeUndefined()
    expect(env.CC_STRIP_SIGNING_SECRETS).toBeUndefined()
  })

  // obj 901525 — the AI reviewer may read its workspace's knowledge base
  // through this token (to check a deliverable that lives there) but must
  // never write it: sessionKind='reviewer' mints a READ-ONLY token.
  it("a reviewer's token is minted read-only; a worker's is not", async () => {
    const { verifySessionToken } = await import('../lib/session-trust.js')
    process.env.CC_SESSION_KB_ACCESS = '1'
    const reviewerEnv = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'reviewer', isAdminSpawn: true })
    const workerEnv = buildSpawnEnv({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind: 'worker', isAdminSpawn: true })
    expect(verifySessionToken(reviewerEnv.CC_SESSION_TOKEN)).toMatchObject({ objectiveId: 42, workspace: 'example', readOnly: true })
    expect(verifySessionToken(workerEnv.CC_SESSION_TOKEN)).toMatchObject({ objectiveId: 42, workspace: 'example' })
    expect(verifySessionToken(workerEnv.CC_SESSION_TOKEN)?.readOnly).toBeUndefined()
  })
})

// obj 901743 (public issue #136): GitHub and Google credentials never reach a
// spawned agent's process env, even when BOTH connectors are linked and the
// Secrets store also holds copies. The connections are stubbed at their module
// seams (the real-DB versions live in session-github-connector / -google-credential
// / connector-isolation tests); what is asserted here is buildSpawnEnv itself and
// what the jail would receive through renderEnvFile.
describe('buildSpawnEnv — linked GitHub + Google never put plaintext credentials in the env (obj 901743)', () => {
  const PAT = 'github_pat_11SPAWNENV_linkedOwnerSecret_42'
  const REFRESH = '1//spawn-env-linked-refresh-token'
  const CLIENT_SECRET = 'GOCSPX-spawn-env-client-secret'
  const STORE_GH = 'ghp_storeCopyOfAGithubToken00000'
  const STORE_GOOGLE_SECRET = 'GOCSPX-store-copy-secret'

  afterEach(() => {
    vi.doUnmock('./user-github-tokens.js')
    vi.doUnmock('./user-google-connections.js')
    vi.doUnmock('./secrets-store.js')
    vi.doUnmock('./connector-guard.js')
    vi.resetModules()
  })

  async function loadLinked() {
    vi.resetModules()
    vi.doMock('./connector-guard.js', async orig => {
      const real = (await orig()) as Record<string, unknown>
      const allow = () => ({ allowed: true })
      return { ...real, checkConnectorCredential: allow, canUseConnectorCredential: allow }
    })
    vi.doMock('./user-github-tokens.js', async orig => ({
      ...((await orig()) as Record<string, unknown>),
      getForUser: () => ({ github_login: 'owner-gh', github_email: '7+owner-gh@users.noreply.github.com' }),
      getDecryptedForUser: () => PAT,
    }))
    vi.doMock('./user-google-connections.js', async orig => ({
      ...((await orig()) as Record<string, unknown>),
      getForUser: () => ({ google_email: 'owner@example.com', client_id: 'primary' }),
      getOAuthClientById: () => ({ clientId: 'cid.apps.googleusercontent.com', clientSecret: CLIENT_SECRET }),
      getDecryptedRefreshToken: () => REFRESH,
    }))
    vi.doMock('./secrets-store.js', async orig => ({
      ...((await orig()) as Record<string, unknown>),
      resolveSecrets: () => ({
        GH_TOKEN: STORE_GH,
        GITHUB_TOKEN: STORE_GH,
        GOOGLE_OAUTH_CLIENT_ID: 'store-cid',
        GOOGLE_OAUTH_CLIENT_SECRET: STORE_GOOGLE_SECRET,
        GOOGLE_REFRESH_TOKEN: '1//store-refresh',
        UNRELATED_API_KEY: 'kept',
      }),
    }))
    const spawn = await import('./session-spawn-env.js')
    const jail = await import('./session-jail.js')
    return { buildSpawnEnv: spawn.buildSpawnEnv, renderEnvFile: jail.renderEnvFile }
  }

  const FORBIDDEN = ['GH_TOKEN', 'GITHUB_TOKEN', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']
  const VALUES = [PAT, REFRESH, CLIENT_SECRET, STORE_GH, STORE_GOOGLE_SECRET, '1//store-refresh']

  it('every spawn kind: identity + broker markers only, no credential name or value', async () => {
    const { buildSpawnEnv: build } = await loadLinked()
    for (const sessionKind of ['worker', 'arena', 'followup', 'planner', 'reviewer'] as const) {
      const env = build({ objective: fakeObjective(), homeDir: '/home/ccuser-a', sessionKind, isAdminSpawn: true })
      for (const k of FORBIDDEN) expect(env[k], `${sessionKind} ${k}`).toBeUndefined()
      expect(Object.keys(env).filter(k => k.startsWith('CC_MCP_TOKEN_'))).toEqual([])
      const all = JSON.stringify(env)
      for (const v of VALUES) expect(all, sessionKind).not.toContain(v)
      // What the session DOES get: who it acts as, and that the broker is on.
      expect(env.GIT_AUTHOR_EMAIL).toBe('7+owner-gh@users.noreply.github.com')
      expect(env.USER_GOOGLE_EMAIL).toBe('owner@example.com')
      expect(env.CC_GITHUB_BROKER).toBe('1')
      expect(env.CC_GOOGLE_BROKER).toBe('1')
      expect(env.CC_SESSION_TOKEN).toMatch(/^ccs_/)
      expect(env.UNRELATED_API_KEY).toBe('kept')
      // Google is the broker's MCP endpoint, authenticated by the session's own token.
      const servers = JSON.parse(env.CC_WORKSPACE_MCP_SERVERS) as { key: string; url: string; headers: Record<string, string> }[]
      const g = servers.find(s => s.key === 'google-workspace')!
      expect(g.url).toMatch(/\/api\/session-broker\/google\/mcp$/)
      expect(g.headers).toEqual({ 'X-CC-Session-Token': '${CC_SESSION_TOKEN}' })
    }
  })

  it('renderEnvFile of that env (what a jail receives) carries none of them either', async () => {
    const { buildSpawnEnv: build, renderEnvFile: render } = await loadLinked()
    const file = render(build({ objective: fakeObjective(), homeDir: '/home/jailuser', sessionKind: 'worker', isAdminSpawn: true }))
    for (const k of FORBIDDEN) expect(file).not.toMatch(new RegExp(`^${k}=`, 'm'))
    for (const v of VALUES) expect(file).not.toContain(v)
    expect(file).toMatch(/^CC_GITHUB_BROKER=1$/m)
  })
})
