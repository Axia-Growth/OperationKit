/**
 * obj 901029 — both halves of the worker-browser contract, through the REAL
 * spawn entry point (`spawnInTmux`). Only the process-spawning edges (tmux via
 * execSync, docker via execFileSync) are faked, as in session-jail-wiring.test.ts.
 *
 *   marked card   (cardBrowser: true)  → pinned Chromium, sandbox ON, egress guard,
 *                                         in BOTH spawn modes; refused (no browser)
 *                                         when the guard is down.
 *   unmarked card (cardBrowser absent) → no browser config, no browser env, the
 *                                         stock jail image, Docker's default seccomp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { PLAYWRIGHT_MCP_VERSION, CHROMIUM_REVISION } from '../lib/browser-pins.js'

const execSyncCalls: string[] = []
const execFileSyncCalls: Array<{ file: string; argv: string[] }> = []

vi.mock('child_process', () => ({
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => { execFileSyncCalls.push({ file, argv }); return 'abc123def456\n' },
}))
vi.mock('node:child_process', () => ({
  execFile: () => undefined,
  execSync: (cmd: string) => { execSyncCalls.push(String(cmd)); return Buffer.from('') },
  execFileSync: (file: string, argv: string[]) => { execFileSyncCalls.push({ file, argv }); return 'abc123def456\n' },
}))

const SID = 'cc-901029-1763260000000'
let tmp: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = [
  'SESSION_ISOLATION', 'CC_SCRIPT_DIR', 'CC_JAIL_HOME_ROOT', 'CARD_BROWSER_PROXY_PORT', 'SESSION_JAIL_BROWSER_IMAGE', 'SESSION_JAIL_IMAGE',
  'CARD_BROWSER_WORKER_IN_APP_CONTAINER', 'CARD_BROWSER_WORKER_PROXY_PORT', 'CARD_BROWSER_WORKER_LOOPBACK_PORTS', 'CARD_BROWSER_ALLOW_LOOPBACK',
]

function spawnOpts(root: string, cardBrowser?: boolean) {
  return {
    sessionId: SID,
    objectiveId: 901029,
    homeDir: path.join(root, 'home'),
    workdir: path.join(root, 'worktree'),
    worktreeRoot: path.join(root, 'worktree'),
    prompt: 'take a screenshot',
    jsonlPath: path.join(root, 'transcripts', 'session.jsonl'),
    logPath: path.join(root, 'transcripts', 'session.log'),
    env: { CC_ACTING_USER_ID: '1' },
    ...(cardBrowser === undefined ? {} : { cardBrowser }),
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port
      s.close(() => resolve(p))
    })
  })
}

/** Fresh module graph; optionally start the shared egress guard IN that graph. */
async function load(opts: { guard: boolean }) {
  vi.resetModules()
  const proxy = await import('./browser-egress-proxy.js')
  const { resolveBrowserPolicy } = await import('../lib/browser-policy.js')
  const { resolveWorkerBrowserPolicy } = await import('../lib/card-browser.js')
  if (opts.guard) {
    await proxy.startSharedBrowserEgressProxy(resolveBrowserPolicy({}))
    await proxy.startSharedWorkerBrowserEgressProxy(resolveWorkerBrowserPolicy({}), Number(process.env.CARD_BROWSER_WORKER_PROXY_PORT))
  }
  const { spawnInTmux } = await import('./session-tmux.js')
  const stop = async () => { await proxy.stopSharedBrowserEgressProxy(); await proxy.stopSharedWorkerBrowserEgressProxy() }
  return { spawnInTmux, stop }
}

function tmuxWrapper(): string {
  return fs.readFileSync(path.join(tmp, 'cc-scripts', `${SID}.sh`), 'utf8')
}
function jailWrapper(): string {
  return fs.readFileSync(path.join(tmp, 'jail-homes', SID, '.cc', `${SID}.sh`), 'utf8')
}
function dockerRunArgv(): string[] {
  const run = execFileSyncCalls.find((c) => c.file === 'docker' && c.argv[0] === 'run')
  expect(run, 'docker run was called').toBeTruthy()
  return run!.argv
}

beforeEach(async () => {
  execSyncCalls.length = 0
  execFileSyncCalls.length = 0
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'card-browser-'))
  for (const d of ['home', 'worktree', 'transcripts']) fs.mkdirSync(path.join(tmp, d), { recursive: true })
  fs.writeFileSync(path.join(tmp, 'transcripts', 'session.jsonl'), '{"type":"prompt"}\n')
  fs.writeFileSync(path.join(tmp, 'transcripts', 'session.log'), 'header\n')
  process.env.CC_SCRIPT_DIR = path.join(tmp, 'cc-scripts')
  process.env.CC_JAIL_HOME_ROOT = path.join(tmp, 'jail-homes')
  process.env.CARD_BROWSER_PROXY_PORT = String(await freePort())
  process.env.CARD_BROWSER_WORKER_PROXY_PORT = String(await freePort())
  delete process.env.CARD_BROWSER_WORKER_IN_APP_CONTAINER
  delete process.env.CARD_BROWSER_WORKER_LOOPBACK_PORTS
  delete process.env.CARD_BROWSER_ALLOW_LOOPBACK
  delete process.env.SESSION_ISOLATION
  delete process.env.SESSION_JAIL_BROWSER_IMAGE
  delete process.env.SESSION_JAIL_IMAGE
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('tmux mode (live droplet): worker browser is opt-in per card', () => {
  it('a MARKED card is REFUSED by default (no browser in the app container) and gets the locked-down Playwright MCP config only with CARD_BROWSER_WORKER_IN_APP_CONTAINER=on', async () => {
    // Default: refused — Chromium belongs in the card sandbox (a jail), not the app container.
    {
      const { spawnInTmux, stop } = await load({ guard: true })
      try {
        spawnInTmux(spawnOpts(tmp, true))
      } finally { await stop() }
      const wrapper = tmuxWrapper()
      expect(wrapper).not.toContain('--mcp-config')
      expect(wrapper).toContain('export CC_CARD_BROWSER="0"')
      expect(wrapper).toMatch(/export CC_CARD_BROWSER_REFUSED=".*only available in jailed sessions \(SESSION_ISOLATION=docker\)/)
      expect(wrapper).not.toContain('CC_BROWSER_EXECUTABLE')
      expect(fs.existsSync(path.join(tmp, 'cc-scripts', `${SID}.mcp.json`))).toBe(false)
      expect(fs.existsSync(path.join(tmp, 'cc-scripts', 'cc-browser.mjs'))).toBe(false)
    }

    // Operator opt-in: the browser, behind the WORKER guard (not the reviewer's shared one).
    process.env.CARD_BROWSER_WORKER_IN_APP_CONTAINER = 'on'
    const { spawnInTmux, stop } = await load({ guard: true })
    try {
      spawnInTmux(spawnOpts(tmp, true))
    } finally { await stop() }
    const wrapper = tmuxWrapper()
    const cfgPath = path.join(tmp, 'cc-scripts', `${SID}.mcp.json`)
    expect(wrapper).toContain(`--mcp-config ${JSON.stringify(cfgPath)}`)
    expect(wrapper).toContain('export CC_CARD_BROWSER="1"')
    expect(wrapper).toContain('export CC_BROWSER_SANDBOX="1"')
    expect(wrapper).toContain(`export CC_BROWSER_PROXY="http://127.0.0.1:${process.env.CARD_BROWSER_WORKER_PROXY_PORT}"`)
    expect(wrapper).toContain('export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1"')

    const args: string[] = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mcpServers.playwright.args
    expect(args).toContain(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`)
    expect(args).toContain('--sandbox')
    expect(args).not.toContain('--no-sandbox')
    expect(args[args.indexOf('--proxy-server') + 1]).toBe(`http://127.0.0.1:${process.env.CARD_BROWSER_WORKER_PROXY_PORT}`)
    expect(args[args.indexOf('--proxy-bypass') + 1]).toBe('<-loopback>')
    expect(args[args.indexOf('--user-data-dir') + 1]).toBe(path.join(tmp, 'home', '.cache', 'playwright-mcp'))
    expect(fs.existsSync(path.join(tmp, 'cc-scripts', 'cc-browser.mjs'))).toBe(true)
  })

  it('an UNMARKED card gets no browser at all (unchanged from before)', async () => {
    const { spawnInTmux, stop } = await load({ guard: true })
    try {
      spawnInTmux(spawnOpts(tmp))
    } finally { await stop() }
    const wrapper = tmuxWrapper()
    expect(wrapper).not.toContain('--mcp-config')
    expect(wrapper).not.toContain('CC_CARD_BROWSER')
    expect(wrapper).not.toContain('CC_BROWSER_')
    expect(fs.existsSync(path.join(tmp, 'cc-scripts', `${SID}.mcp.json`))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'cc-scripts', 'cc-browser.mjs'))).toBe(false)
  })

  it('cardBrowser: false is the same as unmarked', async () => {
    const { spawnInTmux } = await load({ guard: false })
    spawnInTmux(spawnOpts(tmp, false))
    expect(tmuxWrapper()).not.toContain('CC_CARD_BROWSER')
  })

  it('a MARKED card whose guard is down is REFUSED: no MCP config, no browser env, reason exported', async () => {
    process.env.CARD_BROWSER_WORKER_IN_APP_CONTAINER = 'on'
    const { spawnInTmux } = await load({ guard: false })
    spawnInTmux(spawnOpts(tmp, true))
    const wrapper = tmuxWrapper()
    expect(wrapper).not.toContain('--mcp-config')
    expect(wrapper).toContain('export CC_CARD_BROWSER="0"')
    expect(wrapper).toMatch(/export CC_CARD_BROWSER_REFUSED=".*egress guard is not running/)
    expect(wrapper).not.toContain('CC_BROWSER_EXECUTABLE')
  })
})

describe('jail mode (SESSION_ISOLATION=docker): browser image + seccomp + in-jail guard only when marked', () => {
  it('a MARKED card runs the browser image under the browser seccomp profile with the guard started in-jail', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const { spawnInTmux } = await load({ guard: false }) // the control-plane guard is irrelevant in a jail
    spawnInTmux(spawnOpts(tmp, true))
    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail-browser:local')
    expect(argv).not.toContain('ok-jail:local')
    const sec = argv.filter((a, i) => argv[i - 1] === '--security-opt')
    expect(sec).toContain('no-new-privileges')
    expect(sec.some((s) => /^seccomp=\/.*jail-browser-seccomp\.json$/.test(s))).toBe(true)
    expect(argv.join(' ')).not.toMatch(/unconfined|--privileged|--cap-add/)
    expect(argv[argv.indexOf('--cap-drop') + 1]).toBe('ALL')
    const cmd = argv[argv.length - 1]
    expect(cmd).toContain('tsx /home/jailuser/.cc/browser-guard/run.ts')
    // The guard must be up before the session starts: its prefix precedes tmux.
    expect(cmd.indexOf('browser-guard/run.ts')).toBeLessThan(cmd.indexOf('tmux new-session'))

    const home = path.join(tmp, 'jail-homes', SID, '.cc')
    for (const f of ['browser-guard/run.ts', 'browser-guard/services/browser-egress-proxy.ts', 'browser-guard/lib/browser-policy.ts', 'cc-browser.mjs']) {
      expect(fs.existsSync(path.join(home, f)), f).toBe(true)
    }
    // Copied verbatim: one guard implementation, two places it runs.
    expect(fs.readFileSync(path.join(home, 'browser-guard/services/browser-egress-proxy.ts'), 'utf8'))
      .toBe(fs.readFileSync(path.join(__dirname, 'browser-egress-proxy.ts'), 'utf8'))

    const wrapper = jailWrapper()
    expect(wrapper).toContain('export CC_CARD_BROWSER="1"')
    expect(wrapper).toContain('export CC_BROWSER_PROXY="http://127.0.0.1:3099"')
    expect(wrapper).toContain(`export CC_BROWSER_EXECUTABLE="/usr/local/share/playwright/chromium-${CHROMIUM_REVISION}/chrome-linux64/chrome"`)
    expect(wrapper).toContain(`--mcp-config "/home/jailuser/.cc/${SID}.browser-mcp.json"`)
    const args: string[] = JSON.parse(fs.readFileSync(path.join(home, `${SID}.browser-mcp.json`), 'utf8')).mcpServers.playwright.args
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--proxy-server') + 1]).toBe('http://127.0.0.1:3099')
    expect(args[args.indexOf('--user-data-dir') + 1]).toBe('/home/jailuser/.cache/playwright-mcp')
  })

  it('an UNMARKED card keeps the stock image, Docker\'s default seccomp and no browser files', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const { spawnInTmux } = await load({ guard: false })
    spawnInTmux(spawnOpts(tmp))
    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail:local')
    expect(argv).not.toContain('ok-jail-browser:local')
    expect(argv.join(' ')).not.toContain('seccomp=')
    expect(argv[argv.length - 1]).not.toContain('browser-guard')
    const home = path.join(tmp, 'jail-homes', SID, '.cc')
    expect(fs.existsSync(path.join(home, 'browser-guard'))).toBe(false)
    expect(fs.existsSync(path.join(home, 'cc-browser.mjs'))).toBe(false)
    expect(jailWrapper()).not.toContain('CC_CARD_BROWSER')
    expect(jailWrapper()).not.toContain('--mcp-config')
  })

  it('SESSION_JAIL_BROWSER_IMAGE overrides the browser image (pin by digest in real installs)', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    process.env.SESSION_JAIL_BROWSER_IMAGE = 'ok-jail-browser@sha256:abc'
    const { spawnInTmux } = await load({ guard: false })
    spawnInTmux(spawnOpts(tmp, true))
    expect(dockerRunArgv()).toContain('ok-jail-browser@sha256:abc')
  })
})

describe('no secret reaches the browser process, its env, its MCP config or its profile', () => {
  // Built at runtime so no secret-shaped literal sits in the source (gitleaks).
  const PLANTED = ['planted', 'secret', '901051'].join('-')
  function secretOpts(root: string) {
    const o = spawnOpts(root, true)
    const secrets = Object.fromEntries(['GH_TOKEN', 'APIFY_API_TOKEN', 'CC_SESSION_TOKEN'].map((k) => [k, PLANTED]))
    return { ...o, env: { ...o.env, ...secrets } }
  }
  function assertCleanConfig(cfgFile: string, home: string) {
    const raw = fs.readFileSync(cfgFile, 'utf8')
    expect(raw).not.toContain(PLANTED)
    const server = JSON.parse(raw).mcpServers.playwright
    expect(server.env, 'no env block in the MCP config').toBeUndefined()
    // The MCP server (and the Chromium it launches) starts from an EMPTY env
    // plus a fixed non-secret list — it does not inherit the session's secrets.
    expect(server.command).toBe('env')
    expect(server.args[0]).toBe('-i')
    const npx = server.args.indexOf('npx')
    const pairs: string[] = server.args.slice(1, npx)
    expect(pairs.map((p: string) => p.split('=')[0]).sort()).toEqual(['HOME', 'LANG', 'PATH', 'PLAYWRIGHT_BROWSERS_PATH'])
    expect(pairs).toContain(`HOME=${home}`)
    expect(server.args[npx + 2]).toBe(`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`)
  }
  function assertNoSecretUnder(dir: string) {
    if (!fs.existsSync(dir)) return
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      const full = path.join(dir, f)
      if (fs.statSync(full).isFile()) expect(fs.readFileSync(full, 'utf8'), full).not.toContain(PLANTED)
    }
  }

  it('tmux mode: MCP config starts the browser under env -i, launcher + profile carry no secret', async () => {
    process.env.CARD_BROWSER_WORKER_IN_APP_CONTAINER = 'on'
    process.env.GH_TOKEN_PLANTED_901051 = PLANTED
    const { spawnInTmux, stop } = await load({ guard: true })
    try {
      spawnInTmux(secretOpts(tmp))
    } finally { await stop(); delete process.env.GH_TOKEN_PLANTED_901051 }
    assertCleanConfig(path.join(tmp, 'cc-scripts', `${SID}.mcp.json`), path.join(tmp, 'home'))
    expect(fs.readFileSync(path.join(tmp, 'cc-scripts', 'cc-browser.mjs'), 'utf8')).not.toContain(PLANTED)
    assertNoSecretUnder(path.join(tmp, 'home', '.cache', 'playwright-mcp'))
  })

  it('jail mode: same — the in-jail MCP config, launcher and guard copy carry no secret', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    const { spawnInTmux } = await load({ guard: false })
    spawnInTmux(secretOpts(tmp))
    const home = path.join(tmp, 'jail-homes', SID, '.cc')
    assertCleanConfig(path.join(home, `${SID}.browser-mcp.json`), '/home/jailuser')
    expect(fs.readFileSync(path.join(home, 'cc-browser.mjs'), 'utf8')).not.toContain(PLANTED)
    assertNoSecretUnder(path.join(home, 'browser-guard'))
    assertNoSecretUnder(path.join(tmp, 'jail-homes', SID, '.cache', 'playwright-mcp'))
  })

  it('the reviewer MCP config is unchanged (no env -i wrapper there)', async () => {
    const { writePlaywrightMcpConfig } = await import('../lib/card-browser.js')
    const { resolveBrowserPolicy } = await import('../lib/browser-policy.js')
    const out = writePlaywrightMcpConfig({ outPath: path.join(tmp, 'r.mcp.json'), profileDir: '/p', chromiumBin: '/c', policy: resolveBrowserPolicy({}), proxyPort: 3099 })
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).mcpServers.playwright.command).toBe('npx')
  })
})

describe('buildJailRunArgv seccomp option', () => {
  const base = {
    objectiveId: 1, sessionId: 'cc-1-2', worktreePath: '/tmp/w', homePath: '/tmp/h', image: 'ok-jail:local',
  }
  it('adds the profile alongside (not instead of) the existing controls', async () => {
    const { buildJailRunArgv } = await import('./session-jail.js')
    const argv = buildJailRunArgv({ ...base, seccompProfile: '/app/server/src/lib/jail-browser-seccomp.json' })
    expect(argv).toContain('seccomp=/app/server/src/lib/jail-browser-seccomp.json')
    expect(argv).toContain('no-new-privileges')
    expect(argv).toContain('--read-only')
  })
  it('refuses unconfined or a relative path', async () => {
    const { buildJailRunArgv } = await import('./session-jail.js')
    expect(() => buildJailRunArgv({ ...base, seccompProfile: 'unconfined' })).toThrow(/never unconfined/)
    expect(() => buildJailRunArgv({ ...base, seccompProfile: '/x/unconfined.json' })).toThrow()
    expect(() => buildJailRunArgv({ ...base, seccompProfile: 'rel/p.json' })).toThrow()
  })
  it('is absent by default', async () => {
    const { buildJailRunArgv } = await import('./session-jail.js')
    expect(buildJailRunArgv(base).join(' ')).not.toContain('seccomp')
  })
})

describe('the worker browser can never reach the Command Center API over loopback (obj 901051)', () => {
  const API = [
    ['http://127.0.0.1:3002', '127.0.0.1', '127.0.0.1'],
    ['http://localhost:3002', 'localhost', '127.0.0.1'],
    ['http://[::1]:3002', '[::1]', '::1'],
  ] as const
  const INTERNAL = [
    ['10.0.0.5'], ['172.16.0.9'], ['192.168.1.1'], ['169.254.10.10'], ['fe80::1'], ['fd00::5'], ['169.254.169.254'],
  ] as const

  async function jailPlan(env: NodeJS.ProcessEnv = {}) {
    const { planJailCardBrowser } = await import('./card-browser-spawn.js')
    const r = planJailCardBrowser({
      sessionId: SID,
      scriptDirHost: path.join(tmp, 'jail', '.cc'),
      scriptDirGuest: '/home/jailuser/.cc',
      jailHomeGuest: '/home/jailuser',
      env,
    })
    if (!r.ok) throw new Error(r.reason)
    return r.plan
  }
  async function tmuxPlan(env: NodeJS.ProcessEnv) {
    const { planTmuxCardBrowser } = await import('./card-browser-spawn.js')
    const r = planTmuxCardBrowser({ sessionId: SID, homeDir: path.join(tmp, 'home'), scriptDir: path.join(tmp, 'cc-scripts'), guardPort: 3098, chromiumBin: '/c', env })
    if (!r.ok) throw new Error(r.reason)
    return r.plan
  }
  /** The policy literally embedded in the in-jail guard runner (what the guard enforces). */
  function embeddedRunnerPolicy() {
    const src = fs.readFileSync(path.join(tmp, 'jail', '.cc', 'browser-guard', 'run.ts'), 'utf8')
    const m = /^const policy = (.*)$/m.exec(src)
    expect(m, 'runner embeds a policy').toBeTruthy()
    return JSON.parse(m![1])
  }
  function mcpArgs(file: string): string[] {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.playwright
    return s.args
  }

  it('jail mode, default env: the embedded runner policy has allowLoopback false and refuses 127.0.0.1/localhost/[::1]:3002', async () => {
    const { decideEgress } = await import('../lib/browser-policy.js')
    const plan = await jailPlan({})
    const embedded = embeddedRunnerPolicy()
    expect(embedded.allowLoopback).toBe(false)
    expect(plan.policy.allowLoopback).toBe(false)
    for (const policy of [embedded, plan.policy]) {
      for (const [url, host, ip] of API) {
        expect(decideEgress(policy, { scheme: 'http', host, port: 3002 }, [ip]).allow, url).toBe(false)
      }
      // Any other loopback port too: loopback is off, not just 3002.
      expect(decideEgress(policy, { scheme: 'http', host: '127.0.0.1', port: 5173 }, ['127.0.0.1']).allow).toBe(false)
    }
    // Chromium is forced to send loopback through the guard (no silent bypass).
    const args = mcpArgs(plan.jail!.mcpConfigHostPath)
    expect(args[args.indexOf('--proxy-bypass') + 1]).toBe('<-loopback>')
    expect(args[args.indexOf('--allowed-origins') + 1] ?? '').not.toMatch(/localhost|127\.0\.0\.1|\[::1\]/)
  })

  it.each(INTERNAL)('jail + tmux plans refuse internal address %s (private, link-local, ULA, metadata)', async (addr) => {
    const { decideEgress } = await import('../lib/browser-policy.js')
    const env = { OK_DOMAIN: 'ops.example.com', CARD_BROWSER_WORKER_IN_APP_CONTAINER: 'on' } as NodeJS.ProcessEnv
    await jailPlan(env)
    const tmux = await tmuxPlan(env)
    for (const policy of [embeddedRunnerPolicy(), tmux.policy]) {
      // literal address, and an allowlisted name resolving to it
      expect(decideEgress(policy, { scheme: 'http', host: addr.includes(':') ? `[${addr}]` : addr, port: 80 }, [addr]).allow).toBe(false)
      expect(decideEgress(policy, { scheme: 'https', host: 'ops.example.com', port: 443 }, [addr]).allow).toBe(false)
    }
  })

  it('tmux opt-in, default env: the worker plan refuses the API over loopback (and is not the reviewer policy)', async () => {
    const { decideEgress, resolveBrowserPolicy } = await import('../lib/browser-policy.js')
    const plan = await tmuxPlan({ CARD_BROWSER_WORKER_IN_APP_CONTAINER: 'on' })
    expect(plan.policy.allowLoopback).toBe(false)
    for (const [url, host, ip] of API) {
      expect(decideEgress(plan.policy, { scheme: 'http', host, port: 3002 }, [ip]).allow, url).toBe(false)
    }
    const args = mcpArgs(plan.mcpConfigPath!)
    expect(args[args.indexOf('--proxy-bypass') + 1]).toBe('<-loopback>')
    // The reviewer policy is unchanged by this PR (still allows loopback for previews).
    expect(resolveBrowserPolicy({}).allowLoopback).toBe(true)
  })

  it('CARD_BROWSER_ALLOW_LOOPBACK=on does not open loopback for a worker', async () => {
    const plan = await jailPlan({ CARD_BROWSER_ALLOW_LOOPBACK: 'on' })
    expect(plan.policy.allowLoopback).toBe(false)
    expect(embeddedRunnerPolicy().allowLoopback).toBe(false)
  })

  it('CARD_BROWSER_WORKER_LOOPBACK_PORTS opens only those preview ports; 3002 and the guard ports can never be listed', async () => {
    const { decideEgress } = await import('../lib/browser-policy.js')
    await jailPlan({ CARD_BROWSER_WORKER_LOOPBACK_PORTS: '5173;3002;3099;3098' })
    const p = embeddedRunnerPolicy()
    expect(p.loopbackPorts).toEqual([5173])
    expect(p.warnings.join('\n')).toMatch(/ignoring 3002/)
    expect(decideEgress(p, { scheme: 'http', host: 'localhost', port: 5173 }, ['127.0.0.1']).allow).toBe(true)
    for (const port of [3002, 3099, 3098, 8080]) {
      for (const [, host, ip] of API) {
        expect(decideEgress(p, { scheme: 'http', host, port }, [ip]).allow, `${host}:${port}`).toBe(false)
      }
    }
    // Even an operator wildcard allowlist cannot reach the API port.
    const { resolveWorkerBrowserPolicy } = await import('../lib/card-browser.js')
    const wide = resolveWorkerBrowserPolicy({ CARD_BROWSER_ALLOWED_ORIGINS: '*', CARD_BROWSER_WORKER_LOOPBACK_PORTS: '5173' })
    expect(decideEgress(wide, { scheme: 'http', host: '127.0.0.1', port: 3002 }, ['127.0.0.1']).allow).toBe(false)
    expect(decideEgress(wide, { scheme: 'http', host: '127.0.0.2', port: 3002 }, ['127.0.0.2']).allow).toBe(false)
    const args = mcpArgs(path.join(tmp, 'jail', '.cc', `${SID}.browser-mcp.json`))
    expect(args[args.indexOf('--proxy-bypass') + 1]).toBe('<-loopback>')
  })

  it('the API port constant matches the jail forwarder (JAIL_CC_LOOPBACK_PORT)', async () => {
    const { JAIL_CC_LOOPBACK_PORT } = await import('./session-jail.js')
    const { CC_API_LOOPBACK_PORT, workerForbiddenLoopbackPorts } = await import('../lib/card-browser.js')
    expect(CC_API_LOOPBACK_PORT).toBe(JAIL_CC_LOOPBACK_PORT)
    expect(workerForbiddenLoopbackPorts({})).toEqual(expect.arrayContaining([3002, 3099]))
  })

  it('the running WORKER guard answers 403 to a proxied request for 127.0.0.1:3002', async () => {
    const http = await import('node:http')
    const proxy = await import('./browser-egress-proxy.js')
    const { resolveWorkerBrowserPolicy } = await import('../lib/card-browser.js')
    const g = await proxy.startSharedWorkerBrowserEgressProxy(resolveWorkerBrowserPolicy({}), Number(process.env.CARD_BROWSER_WORKER_PROXY_PORT))
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: g!.port, method: 'GET', path: 'http://127.0.0.1:3002/api/internal/objectives', headers: { host: '127.0.0.1:3002' } },
          (r) => { r.resume(); r.on('end', () => resolve(r.statusCode || 0)) },
        )
        req.on('error', reject)
        req.end()
      })
      expect(status).toBe(403)
    } finally { await proxy.stopSharedWorkerBrowserEgressProxy() }
  })
})
