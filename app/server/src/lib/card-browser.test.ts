/**
 * obj 901029 — the pieces of the worker browser that do not need a spawn:
 * the prompt block (granted / unavailable), the generated launcher's refusals, the seccomp delta, and
 * the prompt block. Spawn-level halves live in services/card-browser-spawn.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  BROWSER_ENV_ALLOWLIST,
  FORBIDDEN_BROWSER_ARGS,
  browserCleanEnvPairs,
  buildCardBrowserEnv,
  buildCardBrowserPromptBlock,
  buildJailGuardPrefix,
  jailBrowserImage,
  jailBrowserSeccompProfilePath,
  renderCardBrowserLauncher,
  renderJailGuardRunner,
} from './card-browser.js'
import { decideEgress, resolveBrowserPolicy } from './browser-policy.js'
import { buildPlaywrightMcpArgs as reviewerArgs } from '../services/session-reviewer-prompt.js'
import { buildPlaywrightMcpArgs } from './card-browser.js'

describe('the worker prompt says what the spawn actually got (obj 901075)', () => {
  it('granted: how to use the launcher, and to carry on if check fails', () => {
    const block = buildCardBrowserPromptBlock({ granted: true }).join('\n')
    expect(block).toContain('$CC_BROWSER_LAUNCHER')
    expect(block).toMatch(/If `check` fails .*carry on with the card without the browser/)
    expect(block).not.toMatch(/needs_browser/)
  })

  it('refused: says the browser is unavailable and why, and to carry on without it', () => {
    const block = buildCardBrowserPromptBlock({ granted: false, reason: 'the browser jail image ok-jail-browser:local is not on this host' }).join('\n')
    expect(block).toContain('No browser is available in this session: the browser jail image ok-jail-browser:local is not on this host')
    expect(block).toContain('Carry on with the card without one')
    expect(block).not.toContain('$CC_BROWSER_LAUNCHER')
  })
})

describe('one launch contract for reviewer, arena and worker', () => {
  it('the reviewer module re-exports the same function', () => {
    expect(reviewerArgs).toBe(buildPlaywrightMcpArgs)
  })
  it('env carries the pinned binary, sandbox flag and guard', () => {
    const env = buildCardBrowserEnv({ launcherPath: '/l.mjs', chromiumBin: '/c', proxyPort: 3099, policy: { sandbox: true, egressGuard: true } })
    expect(env).toMatchObject({
      CC_CARD_BROWSER: '1', CC_BROWSER_EXECUTABLE: '/c', CC_BROWSER_SANDBOX: '1',
      CC_BROWSER_PROXY: 'http://127.0.0.1:3099', CC_BROWSER_EGRESS_GUARD: 'on', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    })
    const off = buildCardBrowserEnv({ launcherPath: '/l.mjs', chromiumBin: '/c', proxyPort: null, policy: { sandbox: false, egressGuard: false } })
    expect(off.CC_BROWSER_PROXY).toBeUndefined()
    expect(off.CC_BROWSER_SANDBOX).toBe('0')
    expect(off.CC_BROWSER_EGRESS_GUARD).toBe('off')
  })
  it('browser jail image defaults to the separate browser build', () => {
    expect(jailBrowserImage({})).toBe('ok-jail-browser:local')
    expect(jailBrowserImage({ SESSION_JAIL_BROWSER_IMAGE: 'x@sha256:1' })).toBe('x@sha256:1')
  })
  it('the in-jail guard runner embeds the resolved policy and a fixed port', () => {
    const policy = resolveBrowserPolicy({ OK_DOMAIN: 'ok.example.com' })
    const src = renderJailGuardRunner(policy, 3099)
    expect(src).toContain("from './services/browser-egress-proxy.js'")
    expect(src).toContain('https://ok.example.com')
    expect(src).toContain('169.254.169.254')
    expect(src).toContain('port: 3099')
    // env -i: the guard never inherits the jail env (the card's secrets).
    expect(buildJailGuardPrefix('/home/jailuser/.cc/browser-guard')).toBe('env -i PATH="$PATH" HOME="$HOME" LANG="${LANG:-C.UTF-8}" tsx /home/jailuser/.cc/browser-guard/run.ts >/tmp/cc-browser-guard.log 2>&1 & ')
    expect(() => buildJailGuardPrefix('/x; rm -rf /')).toThrow()
  })
})

describe('the generated launcher refuses anything that would undo a control', () => {
  let dir: string
  let fakeChrome: string
  let guard: net.Server
  let guardPort: number
  let mod: { lockedLaunchOptions: (o?: Record<string, unknown>) => Promise<Record<string, unknown>> }
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['CC_BROWSER_GUARD_WAIT_MS', 'CC_CARD_BROWSER', 'CC_BROWSER_EXECUTABLE', 'CC_BROWSER_PROXY', 'CC_BROWSER_SANDBOX', 'CC_BROWSER_EGRESS_GUARD', 'CC_PLAYWRIGHT_MODULE']

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-'))
    fakeChrome = path.join(dir, 'chrome')
    fs.writeFileSync(fakeChrome, '#!/bin/sh\n')
    const file = path.join(dir, 'cc-browser.mjs')
    fs.writeFileSync(file, renderCardBrowserLauncher())
    mod = await import(pathToFileURL(file).href)
    guard = net.createServer((s) => s.end())
    await new Promise<void>((r) => guard.listen(0, '127.0.0.1', () => r()))
    guardPort = (guard.address() as net.AddressInfo).port
    for (const k of KEYS) saved[k] = process.env[k]
  })
  afterAll(async () => {
    await new Promise<void>((r) => guard.close(() => r()))
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    fs.rmSync(dir, { recursive: true, force: true })
  })
  beforeEach(() => {
    process.env.CC_CARD_BROWSER = '1'
    process.env.CC_BROWSER_EXECUTABLE = fakeChrome
    process.env.CC_BROWSER_PROXY = `http://127.0.0.1:${guardPort}`
    process.env.CC_BROWSER_SANDBOX = '1'
    process.env.CC_BROWSER_EGRESS_GUARD = 'on'
    process.env.CC_BROWSER_GUARD_WAIT_MS = '300'
  })

  it('locks headless + pinned binary + sandbox + guard when everything is in place', async () => {
    const o = await mod.lockedLaunchOptions({ args: ['--window-size=1440,900'] })
    expect(o).toMatchObject({
      headless: true,
      executablePath: fakeChrome,
      chromiumSandbox: true,
      proxy: { server: `http://127.0.0.1:${guardPort}` },
    })
    expect(o.args).toEqual(['--disable-dev-shm-usage', '--window-size=1440,900'])
  })

  it('refuses on a card that was not given a browser', async () => {
    delete process.env.CC_CARD_BROWSER
    await expect(mod.lockedLaunchOptions()).rejects.toThrow(/not given a browser/)
    process.env.CC_CARD_BROWSER = '1'
    delete process.env.CC_BROWSER_EXECUTABLE
    await expect(mod.lockedLaunchOptions()).rejects.toThrow(/CC_BROWSER_EXECUTABLE/)
  })

  it('waits a bounded time for a guard that is still starting', async () => {
    const late = net.createServer((s) => s.end())
    const port = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)) }) })
    process.env.CC_BROWSER_PROXY = `http://127.0.0.1:${port}`
    process.env.CC_BROWSER_GUARD_WAIT_MS = '3000'
    setTimeout(() => late.listen(port, '127.0.0.1'), 600)
    try {
      expect((await mod.lockedLaunchOptions()).proxy).toEqual({ server: `http://127.0.0.1:${port}` })
    } finally { await new Promise<void>((r) => late.close(() => r())) }
  })

  it('refuses when the egress guard is not reachable (fail closed, never unguarded)', async () => {
    const dead = await new Promise<number>((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => r(p)) }) })
    process.env.CC_BROWSER_PROXY = `http://127.0.0.1:${dead}`
    await expect(mod.lockedLaunchOptions()).rejects.toThrow(/egress guard .* not reachable/)
  })

  it('refuses when no guard is configured and the operator did not switch it off', async () => {
    delete process.env.CC_BROWSER_PROXY
    await expect(mod.lockedLaunchOptions()).rejects.toThrow(/CC_BROWSER_PROXY is not set/)
    process.env.CC_BROWSER_EGRESS_GUARD = 'off'
    const o = await mod.lockedLaunchOptions()
    expect(o.proxy).toBeUndefined()
  })

  it.each([...FORBIDDEN_BROWSER_ARGS])('refuses the Chromium switch %s', async (flag) => {
    await expect(mod.lockedLaunchOptions({ args: [flag] })).rejects.toThrow(/refused/)
    await expect(mod.lockedLaunchOptions({ args: [`${flag}=x`] })).rejects.toThrow(/refused/)
  })

  it.each(['executablePath', 'proxy', 'chromiumSandbox', 'ignoreDefaultArgs', 'channel', 'env'])('refuses overriding launch option %s', async (k) => {
    await expect(mod.lockedLaunchOptions({ [k]: k === 'chromiumSandbox' ? false : 'x' })).rejects.toThrow(/fixed by the card browser lockdown/)
  })

  it('never hands Chromium the session env: only the non-secret allowlist reaches the browser process', async () => {
    // Built at runtime so no secret-shaped literal sits in the source (gitleaks).
    const marker = ['planted', 'value', '901051'].join('-')
    const planted = Object.fromEntries(['GH_TOKEN', 'CC_SESSION_TOKEN', 'ANTHROPIC_API_KEY', 'APIFY_API_TOKEN'].map((k) => [k, marker]))
    const before: Record<string, string | undefined> = {}
    for (const [k, v] of Object.entries(planted)) { before[k] = process.env[k]; process.env[k] = v }
    try {
      const o = await mod.lockedLaunchOptions()
      const env = o.env as Record<string, string>
      expect(env, 'Playwright defaults env to process.env when this is missing').toBeTruthy()
      for (const k of Object.keys(env)) expect(BROWSER_ENV_ALLOWLIST as readonly string[]).toContain(k)
      for (const k of Object.keys(planted)) expect(env).not.toHaveProperty(k)
      expect(JSON.stringify(o)).not.toContain(marker)
      // The launcher's own control variables do not leak into Chromium either.
      for (const k of Object.keys(env)) expect(k.startsWith('CC_')).toBe(false)
    } finally {
      for (const [k, v] of Object.entries(before)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  })

  it('keeps the sandbox off only when the operator turned it off', async () => {
    process.env.CC_BROWSER_SANDBOX = '0'
    expect((await mod.lockedLaunchOptions()).chromiumSandbox).toBe(false)
  })

  it('refuses when the pinned binary is not there (not the browser image)', async () => {
    process.env.CC_BROWSER_EXECUTABLE = path.join(dir, 'missing-chrome')
    await expect(mod.lockedLaunchOptions()).rejects.toThrow(/pinned Chromium not found/)
  })
})

describe('the browser jail seccomp profile = Docker default + chroot/clone/unshare/setns, nothing else', () => {
  const profile = JSON.parse(fs.readFileSync(jailBrowserSeccompProfilePath(), 'utf8')) as {
    defaultAction: string
    syscalls: Array<{ names: string[]; action: string; includes?: { caps?: string[] }; excludes?: unknown; args?: unknown; comment?: string }>
  }
  const added = profile.syscalls.filter((r) => r.comment?.startsWith('obj 901029'))

  it('is still deny-by-default', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO')
  })
  it('adds exactly one unconditional rule, for exactly the namespace syscalls + chroot', () => {
    expect(added).toHaveLength(1)
    // chroot: Chromium's zygote chroots into /proc/self/fdinfo/ inside its new
    // user namespace (Jail Browser Proof, PR 814). Nothing else is added.
    expect([...added[0].names].sort()).toEqual(['chroot', 'clone', 'setns', 'unshare'])
    expect(added[0].action).toBe('SCMP_ACT_ALLOW')
    expect(added[0].includes).toBeUndefined()
    expect(added[0].args).toBeUndefined()
  })
  it('leaves mount/bpf/perf_event_open etc. behind CAP_SYS_ADMIN (which the jail never has)', () => {
    const unconditional = new Set(
      profile.syscalls.filter((r) => r.action === 'SCMP_ACT_ALLOW' && !r.includes && !r.excludes).flatMap((r) => r.names),
    )
    for (const s of ['mount', 'umount2', 'bpf', 'perf_event_open', 'kexec_load', 'init_module', 'ptrace', 'pivot_root', 'open_by_handle_at']) {
      expect(unconditional.has(s), s).toBe(false)
    }
  })
})

describe('no secret reaches the worker browser (obj 901029 / 901051)', () => {
  it('the MCP server env is a fixed non-secret list, never the session env', () => {
    const pairs = browserCleanEnvPairs('/home/jailuser')
    expect(pairs.map((p) => p.split('=')[0]).sort()).toEqual(['HOME', 'LANG', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH'])
    expect(() => browserCleanEnvPairs('/home/x; curl evil')).toThrow(/invalid browser HOME/)
  })

  it('the allowlist names no credential-shaped variable', () => {
    for (const k of BROWSER_ENV_ALLOWLIST) expect(k).not.toMatch(/TOKEN|SECRET|KEY|PASS|AUTH|COOKIE|JWT/i)
  })
})

describe('the egress guard policy a worker browser runs under refuses internal addresses', () => {
  const p = resolveBrowserPolicy({ OK_DOMAIN: 'ops.example.com' } as NodeJS.ProcessEnv)
  const t = (host: string) => ({ scheme: 'https', host, port: 443 })

  it.each([
    ['RFC1918 10/8', '10.0.0.5'],
    ['RFC1918 172.16/12', '172.16.0.9'],
    ['RFC1918 192.168/16', '192.168.1.1'],
    ['link-local', '169.254.10.10'],
    ['IPv6 link-local', 'fe80::1'],
    ['IPv6 ULA', 'fd00::5'],
    ['cloud metadata (AWS/GCP/Azure/DO)', '169.254.169.254'],
    ['AWS IMDS over IPv6', 'fd00:ec2::254'],
    ['IPv4-mapped private', '::ffff:10.0.0.1'],
  ])('refuses %s (%s) even behind an allowlisted name', (_label, addr) => {
    expect(decideEgress(p, t('ops.example.com'), [addr]).allow).toBe(false)
  })

  it('refuses the cloud metadata hostname itself', () => {
    expect(decideEgress(p, { scheme: 'http', host: '169.254.169.254', port: 80 }, ['169.254.169.254']).allow).toBe(false)
  })

  it('refuses localhost / loopback whenever the operator turns loopback off (CARD_BROWSER_ALLOW_LOOPBACK=off)', () => {
    const strict = resolveBrowserPolicy({ OK_DOMAIN: 'ops.example.com', CARD_BROWSER_ALLOW_LOOPBACK: 'off' } as NodeJS.ProcessEnv)
    for (const [host, addr] of [['localhost', '127.0.0.1'], ['127.0.0.1', '127.0.0.1'], ['[::1]', '::1']]) {
      expect(decideEgress(strict, { scheme: 'http', host, port: 3002 }, [addr]).allow, host).toBe(false)
    }
    // …and Chromium is forced to send loopback through the guard in that case.
    expect(buildPlaywrightMcpArgs('/p', '/c', strict, 3099)).toEqual(expect.arrayContaining(['--proxy-bypass', '<-loopback>']))
  })

  it('refuses a public name that resolves to loopback (DNS rebinding), even with loopback allowed', () => {
    const wide = resolveBrowserPolicy({ OK_DOMAIN: 'ops.example.com', CARD_BROWSER_ALLOWED_ORIGINS: 'https://rebind.example.com' } as NodeJS.ProcessEnv)
    expect(decideEgress(wide, t('rebind.example.com'), ['127.0.0.1']).allow).toBe(false)
  })
})

describe('launcher sign-in to the install\'s own site (obj 901106)', () => {
  let dir: string
  let mod: { signIn: (ctx: unknown, o?: Record<string, unknown>) => Promise<Record<string, unknown>> }
  let cp: import('http').Server
  let lastHeaders: Record<string, unknown> = {}
  let reply: { status: number; body: unknown } = { status: 200, body: {} }
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['CC_SESSION_TOKEN', 'CC_CONTROL_PLANE_URL']

  beforeAll(async () => {
    const http = await import('http')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-launcher-signin-'))
    const file = path.join(dir, 'cc-browser.mjs')
    fs.writeFileSync(file, renderCardBrowserLauncher())
    mod = await import(pathToFileURL(file).href)
    cp = http.createServer((req, res) => {
      lastHeaders = { ...req.headers, _url: req.url, _method: req.method }
      res.writeHead(reply.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
    await new Promise<void>((r) => cp.listen(0, '127.0.0.1', () => r()))
    for (const k of KEYS) saved[k] = process.env[k]
    process.env.CC_CONTROL_PLANE_URL = `http://127.0.0.1:${(cp.address() as net.AddressInfo).port}`
  })
  afterAll(async () => {
    await new Promise<void>((r) => cp.close(() => r()))
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('asks the control plane with the card token and puts the cookies in the context, never in the result', async () => {
    process.env.CC_SESSION_TOKEN = 'ccs_card.token'
    const cookies = [{ name: 'token', value: 'ccb_secret.mac', domain: 'ai.x.test', path: '/' }]
    reply = { status: 200, body: { ok: true, public_url: 'https://ai.x.test', expires_at: 'soon', identity: { username: 'bot:opkit-dev (card #7)' }, cf_access: { status: 'ok' }, cookies } }
    const added: unknown[] = []
    const info = await mod.signIn({ addCookies: async (c: unknown[]) => { added.push(...c) } })
    expect(lastHeaders._method).toBe('POST')
    expect(lastHeaders._url).toBe('/api/card-browser/session')
    expect(lastHeaders['x-cc-session-token']).toBe('ccs_card.token')
    expect(added).toEqual(cookies)
    expect(info).toEqual({ public_url: 'https://ai.x.test', expires_at: 'soon', identity: { username: 'bot:opkit-dev (card #7)' }, cf_access: { status: 'ok' } })
    expect(JSON.stringify(info)).not.toContain('ccb_secret')
  })

  it('refuses clearly when the control plane says no, or the session has no card token', async () => {
    process.env.CC_SESSION_TOKEN = 'ccs_card.token'
    reply = { status: 401, body: { error: 'Card #7 is not running' } }
    await expect(mod.signIn({ addCookies: async () => {} })).rejects.toThrow(/sign-in refused \(HTTP 401\): Card #7 is not running/)
    delete process.env.CC_SESSION_TOKEN
    await expect(mod.signIn({ addCookies: async () => {} })).rejects.toThrow(/CC_SESSION_TOKEN is not set/)
  })

  it('the launcher explains a Cloudflare Access redirect instead of a bare tunnel error', () => {
    const src = renderCardBrowserLauncher()
    expect(src).toContain("'--sign-in'")
    expect(src).toContain('behind Cloudflare Access')
    expect(src).toContain("cmd === 'sign-in'")
  })

  it('the worker prompt tells a granted card how to sign in, read-only', () => {
    const block = buildCardBrowserPromptBlock({ granted: true }).join('\n')
    expect(block).toContain('--sign-in')
    expect(block).toMatch(/READ-ONLY session as this card's bot/)
  })
})
