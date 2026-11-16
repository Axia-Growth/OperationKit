/**
 * card-browser.ts — the browser for WORKER card sessions (obj 901029; on for
 * every card since obj 901075 — there is no per-card switch).
 *
 * Until now only reviewer and design-arena sessions got a browser
 * (`writeReviewerPlaywrightMcpConfig`). A plain worker got none, by design —
 * a global registration once wedged the host (2026-06-22) — so any card that
 * asked its worker for a screenshot or an end-to-end run died at step 1
 * (#900494, #901024: `libglib-2.0.so.0: cannot open shared object file`).
 *
 * Every worker spawn now asks for the browser (obj 901075 dropped the
 * `needs_browser` opt-in). Everything the card browser lockdown (obj 900024)
 * requires is reused, not re-implemented:
 *
 *   * the PINNED Playwright / Chromium (browser-pins.ts),
 *   * the SAME policy (browser-policy.ts → resolveBrowserPolicy),
 *   * the SAME egress guard code (services/browser-egress-proxy.ts),
 *   * the OS sandbox ON, and FAIL CLOSED when any of those is missing.
 *
 * Two spawn modes, one browser path:
 *
 *   tmux (SESSION_ISOLATION unset — the live droplet): the worker runs in the
 *     app container, which already has the pinned Chromium with its setuid
 *     sandbox helper. A worker is REFUSED a browser here by default (Chromium would
 *     sit next to the secrets store); only CARD_BROWSER_WORKER_IN_APP_CONTAINER=on
 *     gives it one, behind the worker guard.
 *
 *   docker (SESSION_ISOLATION=docker — client installs): the worker runs in a
 *     jail. Every worker's jail is started from a SEPARATE image built with
 *     WITH_BROWSER=1 (`ok-jail-browser:local`), with a seccomp profile that
 *     adds only chroot/clone/unshare/setns to Docker's default (Chromium's
 *     user-namespace sandbox; the jail keeps cap-drop ALL + no-new-privileges),
 *     and with the egress guard running INSIDE the jail — from a copy of the
 *     same TS source — so "loopback" means the jail, never the control plane.
 *     When that image is missing (or docker refuses it) the card falls back to
 *     the stock image, which has no Chromium at all, and carries on.
 *
 * Code paths that must use `launch()` from the generated launcher get the
 * guard + sandbox for free; the launcher refuses to start when the guard is
 * not reachable, and refuses arguments that would undo any control.
 * Honest limit: the guard fences the BROWSER (what a hostile page can reach).
 * It is not a fence around the worker's own shell, which already has the
 * network the card was given.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROMIUM_REVISION, PLAYWRIGHT_MCP_VERSION, PLAYWRIGHT_VERSION } from './browser-pins.js'
import { LOOPBACK_ORIGINS, resolveBrowserPolicy, type BrowserPolicy } from './browser-policy.js'

/** Where every image (app + browser jail) installs Playwright's browsers. */
export const PLAYWRIGHT_BROWSERS_ROOT = '/usr/local/share/playwright'

/** Global npm root in both images (node:22 base and the app image). */
export const GLOBAL_NODE_MODULES = '/usr/local/lib/node_modules'

/** The browser-jail image. Built from app/jail/Dockerfile with WITH_BROWSER=1. */
export const DEFAULT_JAIL_BROWSER_IMAGE = 'ok-jail-browser:local'

/** Loopback port the in-jail egress guard listens on (inside the jail's netns). */
export const JAIL_BROWSER_GUARD_PORT = 3099

/**
 * The Command Center API port. Inside a jail, session-jail.ts forwards
 * 127.0.0.1:3002 to the control plane (JAIL_CC_LOOPBACK_PORT); in the app
 * container it is the app itself. A worker browser must never reach it.
 */
export const CC_API_LOOPBACK_PORT = 3002

/** Default port of the app-container WORKER egress guard (tmux opt-in only). */
export const DEFAULT_WORKER_EGRESS_PROXY_PORT = 3098

/** The tmux-mode worker guard's port (CARD_BROWSER_WORKER_PROXY_PORT). */
export function workerEgressProxyPort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.CARD_BROWSER_WORKER_PROXY_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_WORKER_EGRESS_PROXY_PORT
}

/**
 * Loopback ports a worker browser can never reach, whatever the operator
 * configures: the CC API, the guards themselves, and the app's own PORT.
 */
export function workerForbiddenLoopbackPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const ports = [CC_API_LOOPBACK_PORT, JAIL_BROWSER_GUARD_PORT, DEFAULT_WORKER_EGRESS_PROXY_PORT, workerEgressProxyPort(env)]
  for (const k of ['PORT', 'CARD_BROWSER_PROXY_PORT']) {
    const n = Number(env[k])
    if (Number.isInteger(n) && n > 0 && n < 65536) ports.push(n)
  }
  return [...new Set(ports)].sort((a, b) => a - b)
}

/**
 * Parse CARD_BROWSER_WORKER_LOOPBACK_PORTS (`;`/`,`-separated). Forbidden
 * ports and junk are dropped with a warning; they can never be allowed.
 */
export function parseWorkerLoopbackPorts(env: NodeJS.ProcessEnv = process.env): { ports: number[]; warnings: string[] } {
  const raw = (env.CARD_BROWSER_WORKER_LOOPBACK_PORTS || '').trim()
  const warnings: string[] = []
  if (!raw) return { ports: [], warnings }
  const forbidden = new Set(workerForbiddenLoopbackPorts(env))
  const ports: number[] = []
  for (const part of raw.split(/[;,\s]+/).filter(Boolean)) {
    const n = Number(part)
    if (!/^\d{1,5}$/.test(part) || n < 1 || n > 65535) {
      warnings.push(`CARD_BROWSER_WORKER_LOOPBACK_PORTS: ignoring ${JSON.stringify(part)} (not a port)`)
    } else if (forbidden.has(n)) {
      warnings.push(`CARD_BROWSER_WORKER_LOOPBACK_PORTS: ignoring ${n} — the Command Center API / egress guard port is never reachable from a worker browser`)
    } else if (!ports.includes(n)) {
      ports.push(n)
    }
  }
  if (ports.length) {
    warnings.push(`CARD_BROWSER_WORKER_LOOPBACK_PORTS=${ports.join(',')} — worker browsers may reach loopback on these preview ports only`)
  }
  return { ports, warnings }
}

/**
 * The policy a WORKER card's browser runs under (obj 901051). It is the shared
 * resolveBrowserPolicy() with loopback REFUSED by default, whatever
 * CARD_BROWSER_ALLOW_LOOPBACK says: in a jail 127.0.0.1:3002 is the forwarder
 * to the control-plane API, and in the app container loopback is the app.
 * Only explicit preview ports (CARD_BROWSER_WORKER_LOOPBACK_PORTS) open, and
 * the API / guard ports are blocked even then. The reviewer policy is untouched.
 */
export function resolveWorkerBrowserPolicy(env: NodeJS.ProcessEnv = process.env): BrowserPolicy {
  const base = resolveBrowserPolicy(env)
  const loopbackOrigins = new Set<string>(LOOPBACK_ORIGINS)
  const allowed = base.allowedOrigins.filter((o) => !loopbackOrigins.has(o))
  const { ports, warnings } = parseWorkerLoopbackPorts(env)
  for (const p of ports) allowed.push(`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`)
  const blocked = [...base.blockedOrigins]
  for (const p of workerForbiddenLoopbackPorts(env)) {
    for (const h of ['localhost', '127.0.0.1', '[::1]']) blocked.push(`http://${h}:${p}`, `https://${h}:${p}`)
  }
  return {
    ...base,
    allowedOrigins: [...new Set(allowed)],
    blockedOrigins: [...new Set(blocked)],
    allowLoopback: ports.length > 0,
    loopbackPorts: ports,
    warnings: [...base.warnings, ...warnings],
  }
}

/**
 * tmux mode puts the worker's Chromium in the app container (secrets store, DB,
 * seat logins), so it is refused unless the operator sets
 * CARD_BROWSER_WORKER_IN_APP_CONTAINER=on (logged as a warning at boot).
 */
export function workerBrowserInAppContainerAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|on|yes|true)$/i.test((env.CARD_BROWSER_WORKER_IN_APP_CONTAINER || '').trim())
}

/** Launcher file name (written next to the session's wrapper script). */
export const CARD_BROWSER_LAUNCHER_FILE = 'cc-browser.mjs'

/** Directory (under the jail's script dir) holding the in-jail guard copy. */
export const JAIL_GUARD_DIR = 'browser-guard'

/** Image every worker jail runs when the browser is available. Never the stock jail image (it has no browser). */
export function jailBrowserImage(env: NodeJS.ProcessEnv = process.env): string {
  return (env.SESSION_JAIL_BROWSER_IMAGE || '').trim() || DEFAULT_JAIL_BROWSER_IMAGE
}

/** Absolute path of the seccomp profile browser jails run under. */
export function jailBrowserSeccompProfilePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'jail-browser-seccomp.json')
}

/**
 * The Chromium binary in the app image's shared install: the newest existing
 * `chromium-*` dir (not hardcoded, so a pin bump needs no code change here).
 * Same resolution `writeReviewerPlaywrightMcpConfig` has always done inline.
 */
export function resolveChromiumBinary(root: string = PLAYWRIGHT_BROWSERS_ROOT): string {
  let bin = path.join(root, `chromium-${CHROMIUM_REVISION}`, 'chrome-linux64', 'chrome')
  try {
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('chromium-')).sort().reverse()
    for (const d of dirs) {
      const candidate = path.join(root, d, 'chrome-linux64', 'chrome')
      if (fs.existsSync(candidate)) { bin = candidate; break }
    }
  } catch { /* keep the pinned default */ }
  return bin
}

/** The Chromium binary inside the browser jail image — fixed by the pin. */
export function jailChromiumBinary(): string {
  return `${PLAYWRIGHT_BROWSERS_ROOT}/chromium-${CHROMIUM_REVISION}/chrome-linux64/chrome`
}

/**
 * The `@playwright/mcp` launch contract (obj 900024 lockdown): pinned version,
 * explicit profile + binary, headless, no service workers, sandbox unless the
 * operator opted out, Playwright's origin lists, and Chromium pointed at the
 * egress guard. Shared by the reviewer, the arena and opted-in workers.
 */
export function buildPlaywrightMcpArgs(
  profileDir: string,
  chromiumBin: string,
  policy: BrowserPolicy,
  proxyPort: number | null,
): string[] {
  const args = [
    '-y', `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    '--user-data-dir', profileDir,
    '--executable-path', chromiumBin,
    '--headless',
    // Service workers survive a navigation and can keep fetching after the
    // page the agent was looking at is gone. Nothing the card browser does
    // needs them.
    '--block-service-workers',
  ]
  args.push(policy.sandbox ? '--sandbox' : '--no-sandbox')
  if (policy.allowedOrigins.length > 0) {
    args.push('--allowed-origins', policy.allowedOrigins.join(';'))
  }
  if (policy.blockedOrigins.length > 0) {
    args.push('--blocked-origins', policy.blockedOrigins.join(';'))
  }
  if (proxyPort) {
    args.push('--proxy-server', `http://127.0.0.1:${proxyPort}`)
    // Chromium bypasses the proxy for loopback by default. When the policy
    // does NOT allow loopback we have to force it back through the guard,
    // otherwise "no loopback" would be unenforced for exactly the destination
    // that matters most (this app, on 127.0.0.1:3002).
    // A worker policy (loopbackPorts set, obj 901051) ALWAYS forces loopback
    // through the guard, so the preview-port allowlist is actually enforced.
    if (!policy.allowLoopback || policy.loopbackPorts) args.push('--proxy-bypass', '<-loopback>')
  }
  return args
}

/** PATH the browser processes get (both images install node/npx under /usr/local/bin). */
export const BROWSER_CLEAN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

/**
 * The ONLY environment a worker's browser processes get (obj 901029): a fixed
 * allowlist of non-secret variables. Never a copy of the session env, which
 * carries the card's secrets.
 */
export function browserCleanEnvPairs(home: string): string[] {
  if (!/^\/[A-Za-z0-9_./-]*$/.test(home)) throw new Error(`invalid browser HOME ${JSON.stringify(home)}`)
  return [`PATH=${BROWSER_CLEAN_PATH}`, `HOME=${home}`, 'LANG=C.UTF-8', `PLAYWRIGHT_BROWSERS_PATH=${PLAYWRIGHT_BROWSERS_ROOT}`]
}

/** Variables the launcher copies from its own env into Chromium's (non-secret only). */
export const BROWSER_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'FONTCONFIG_PATH'] as const

/** Write a one-server MCP config registering the locked-down Playwright MCP. */
export function writePlaywrightMcpConfig(opts: {
  outPath: string
  profileDir: string
  chromiumBin: string
  policy: BrowserPolicy
  proxyPort: number | null
  mode?: number
  /**
   * Worker cards (obj 901029): start the MCP server through `env -i` with only
   * these non-secret variables, so neither the MCP server nor the Chromium it
   * launches inherits the session's secrets. The reviewer path omits this and is
   * unchanged.
   */
  cleanEnv?: { home: string }
}): string {
  const mcpArgs = buildPlaywrightMcpArgs(opts.profileDir, opts.chromiumBin, opts.policy, opts.proxyPort)
  const server = opts.cleanEnv
    ? { command: 'env', args: ['-i', ...browserCleanEnvPairs(opts.cleanEnv.home), 'npx', ...mcpArgs] }
    : { command: 'npx', args: mcpArgs }
  const config = {
    mcpServers: {
      playwright: server,
    },
  }
  fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })
  fs.writeFileSync(opts.outPath, JSON.stringify(config, null, 2))
  if (opts.mode !== undefined) fs.chmodSync(opts.outPath, opts.mode)
  return opts.outPath
}

/**
 * Env a marked worker gets. `proxyPort` null means the operator switched the
 * guard off (CARD_BROWSER_EGRESS_GUARD=off — logged at boot); the launcher then
 * needs CC_BROWSER_EGRESS_GUARD=off to launch at all, so the choice is explicit.
 */
export function buildCardBrowserEnv(opts: {
  launcherPath: string
  chromiumBin: string
  proxyPort: number | null
  policy: Pick<BrowserPolicy, 'sandbox' | 'egressGuard'>
}): Record<string, string> {
  const env: Record<string, string> = {
    CC_CARD_BROWSER: '1',
    CC_BROWSER_LAUNCHER: opts.launcherPath,
    CC_BROWSER_EXECUTABLE: opts.chromiumBin,
    CC_BROWSER_SANDBOX: opts.policy.sandbox ? '1' : '0',
    CC_BROWSER_EGRESS_GUARD: opts.policy.egressGuard ? 'on' : 'off',
    CC_PLAYWRIGHT_MODULE: `${GLOBAL_NODE_MODULES}/playwright`,
    CC_PLAYWRIGHT_VERSION: PLAYWRIGHT_VERSION,
    PLAYWRIGHT_BROWSERS_PATH: PLAYWRIGHT_BROWSERS_ROOT,
    // Never let a worker's own `npx playwright install` replace the pinned build.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
  }
  if (opts.proxyPort) env.CC_BROWSER_PROXY = `http://127.0.0.1:${opts.proxyPort}`
  return env
}

/**
 * Chromium switches the launcher refuses to pass through, because each one
 * undoes a lockdown control (sandbox, egress guard, binary pin).
 */
export const FORBIDDEN_BROWSER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-namespace-sandbox',
  '--no-zygote',
  '--single-process',
  '--proxy-server',
  '--proxy-bypass-list',
  '--proxy-pac-url',
  '--no-proxy-server',
  '--proxy-auto-detect',
  '--remote-debugging-address',
] as const

/**
 * Source of the launcher a marked worker imports (`import { launch } from
 * process.env.CC_BROWSER_LAUNCHER`) or runs (`node $CC_BROWSER_LAUNCHER
 * screenshot <url> <out.png>`). Plain ESM, no deps beyond the pinned global
 * playwright, so it runs unchanged in the app container and in the jail.
 */
export function renderCardBrowserLauncher(): string {
  return `#!/usr/bin/env node
// cc-browser.mjs — generated by Command Center (obj 901029). Do not edit; it is
// rewritten at every worker spawn that was given a browser.
//
//   import { launch } from process.env.CC_BROWSER_LAUNCHER
//   const browser = await launch(); const page = await browser.newPage()
//
//   node "$CC_BROWSER_LAUNCHER" check
//   node "$CC_BROWSER_LAUNCHER" screenshot <url> <out.png> [--width 1440] [--height 900] [--full]
//
// The pinned Chromium, its OS sandbox and the egress guard are applied here and
// cannot be switched off through launch() options.
import fs from 'node:fs'
import net from 'node:net'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const FORBIDDEN = ${JSON.stringify(FORBIDDEN_BROWSER_ARGS)}
// Chromium never sees the session env (it carries the card's secrets): only these.
const ENV_ALLOWLIST = ${JSON.stringify(BROWSER_ENV_ALLOWLIST)}

function browserEnv() {
  const env = {}
  for (const k of ENV_ALLOWLIST) if (process.env[k] !== undefined) env[k] = process.env[k]
  return env
}

function refuse(msg) {
  const e = new Error('[cc-browser] ' + msg)
  e.code = 'CC_BROWSER_REFUSED'
  throw e
}

function need(name) {
  const v = process.env[name]
  if (!v) refuse(name + ' is not set: this session was not given a browser (CC_CARD_BROWSER_REFUSED says why). Carry on without one.')
  return v
}

function guardConnects(proxyUrl, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let u
    try { u = new URL(proxyUrl) } catch { return resolve(false) }
    const s = net.connect(Number(u.port), u.hostname)
    const done = (ok) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeoutMs, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

// The guard is started in the background just before the session (jail mode),
// so give it a bounded moment to come up rather than racing it. Still fail closed.
async function guardReachable(proxyUrl) {
  const waitMs = Number(process.env.CC_BROWSER_GUARD_WAIT_MS || 10000)
  const until = Date.now() + waitMs
  for (;;) {
    if (await guardConnects(proxyUrl)) return true
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 250))
  }
}

function loadPlaywright() {
  const mod = need('CC_PLAYWRIGHT_MODULE')
  const req = createRequire(import.meta.url)
  return req(mod)
}

/** Resolved, locked launch options. Exported for tests. */
export async function lockedLaunchOptions(options = {}) {
  if (process.env.CC_CARD_BROWSER !== '1') need('CC_CARD_BROWSER')
  const executablePath = need('CC_BROWSER_EXECUTABLE')
  if (!fs.existsSync(executablePath)) refuse('pinned Chromium not found at ' + executablePath + ' (is this the browser image?)')
  for (const key of ['executablePath', 'proxy', 'chromiumSandbox', 'ignoreDefaultArgs', 'channel', 'env']) {
    if (options[key] !== undefined) refuse('launch option "' + key + '" is fixed by the card browser lockdown and cannot be overridden')
  }
  const args = Array.isArray(options.args) ? options.args : []
  for (const a of args) {
    if (FORBIDDEN.some((f) => String(a) === f || String(a).startsWith(f + '='))) refuse('argument ' + a + ' would undo a card browser control and is refused')
  }
  const sandbox = process.env.CC_BROWSER_SANDBOX !== '0'
  const guardOff = process.env.CC_BROWSER_EGRESS_GUARD === 'off'
  const proxyUrl = process.env.CC_BROWSER_PROXY || ''
  let proxy
  if (proxyUrl) {
    if (!(await guardReachable(proxyUrl))) refuse('the egress guard at ' + proxyUrl + ' is not reachable; refusing to start an unguarded browser')
    // Playwright already forces loopback through the proxy (<-loopback>), so the
    // guard sees every request, including ones to localhost.
    proxy = { server: proxyUrl }
  } else if (!guardOff) {
    refuse('CC_BROWSER_PROXY is not set and the egress guard was not switched off by the operator')
  }
  return {
    ...options,
    headless: true,
    executablePath,
    chromiumSandbox: sandbox,
    env: browserEnv(),
    ...(proxy ? { proxy } : {}),
    // A jail's /dev/shm is docker's 64 MB default; Chromium otherwise crashes on big pages.
    args: ['--disable-dev-shm-usage', ...args],
  }
}

/** Launch the pinned, sandboxed, guarded Chromium. */
export async function launch(options = {}) {
  const opts = await lockedLaunchOptions(options)
  const { chromium } = loadPlaywright()
  return chromium.launch(opts)
}

function nsOf(pid, kind) {
  try { return fs.readlinkSync('/proc/' + pid + '/ns/' + kind) } catch { return null }
}

/** Which namespaces Chromium's renderers do NOT share with us (= the sandbox is on). */
function rendererIsolation() {
  const self = { user: nsOf('self', 'user'), pid: nsOf('self', 'pid'), net: nsOf('self', 'net') }
  const out = { renderers: 0, user: false, pid: false, net: false, unreadable: 0 }
  for (const pid of fs.readdirSync('/proc').filter((d) => /^\\d+$/.test(d))) {
    let cmd = ''
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8') } catch { continue }
    if (!cmd.includes('--type=renderer')) continue
    out.renderers++
    for (const k of ['user', 'pid', 'net']) {
      const ns = nsOf(pid, k)
      if (ns === null) { out.unreadable++; continue }
      if (ns !== self[k]) out[k] = true
    }
  }
  return out
}

async function cli(argv) {
  const [cmd, ...rest] = argv
  const flags = {}
  const positional = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--full') flags.full = true
    else if (a.startsWith('--')) flags[a.slice(2)] = rest[++i]
    else positional.push(a)
  }
  if (cmd === 'check') {
    const browser = await launch()
    const page = await browser.newPage()
    await page.goto('about:blank')
    const iso = rendererIsolation()
    const report = {
      ok: true,
      chromium: browser.version(),
      executable: process.env.CC_BROWSER_EXECUTABLE,
      sandbox_requested: process.env.CC_BROWSER_SANDBOX !== '0',
      renderer_namespaces_isolated: iso,
      egress_guard: process.env.CC_BROWSER_PROXY || 'off (operator opt-out)',
    }
    await browser.close()
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (cmd === 'screenshot') {
    const [url, out] = positional
    if (!url || !out) refuse('usage: screenshot <url> <out.png> [--width N] [--height N] [--full]')
    const browser = await launch()
    try {
      const page = await browser.newPage({ viewport: { width: Number(flags.width || 1440), height: Number(flags.height || 900) } })
      const res = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 })
      await page.screenshot({ path: out, fullPage: !!flags.full })
      console.log(JSON.stringify({ ok: true, url, status: res ? res.status() : null, out }))
    } finally {
      await browser.close()
    }
    return
  }
  refuse('unknown command ' + JSON.stringify(cmd) + ' (use: check | screenshot <url> <out.png>)')
}

let isMain = false
try { isMain = !!process.argv[1] && pathToFileURL(fs.realpathSync(process.argv[1])).href === import.meta.url } catch {}
if (isMain) {
  cli(process.argv.slice(2)).catch((e) => { console.error(e.message || e); process.exit(e.code === 'CC_BROWSER_REFUSED' ? 3 : 1) })
}
`
}

/**
 * Source of the in-jail guard runner. It imports the guard from a COPY of
 * `services/browser-egress-proxy.ts` + `lib/browser-policy.ts` placed beside it
 * (same relative layout, so the guard's own `../lib/browser-policy.js` import
 * resolves under tsx). One implementation of the guard, two places it runs.
 */
export function renderJailGuardRunner(policy: BrowserPolicy, port: number = JAIL_BROWSER_GUARD_PORT): string {
  return `// Generated by Command Center (obj 901029): the card browser egress guard,
// running inside this jail so its loopback is the jail's own.
import { startBrowserEgressProxy } from './services/browser-egress-proxy.js'
const policy = ${JSON.stringify(policy)}
startBrowserEgressProxy(policy, { port: ${Number(port)} })
  .then((h) => console.log('[card-browser] in-jail egress guard on 127.0.0.1:' + h.port))
  .catch((e) => { console.error('[card-browser] in-jail egress guard failed:', e && e.message); process.exit(1) })
`
}

/** Shell prefix (ends with `& `) that starts the in-jail guard before tmux. */
export function buildJailGuardPrefix(guardDirGuest: string): string {
  if (!/^\/[A-Za-z0-9_./-]+$/.test(guardDirGuest)) throw new Error(`invalid guard dir ${JSON.stringify(guardDirGuest)}`)
  // env -i: the guard needs no credential, so it does not inherit the jail env
  // (which carries the card's secrets) — nothing to read in /proc/<pid>/environ.
  return `env -i PATH="$PATH" HOME="$HOME" LANG="\${LANG:-C.UTF-8}" tsx ${guardDirGuest}/run.ts >/tmp/cc-browser-guard.log 2>&1 & `
}

// ── What the worker is told about its browser ───────────────────────────────

export type CardBrowserPromptState = { granted: true } | { granted: false; reason: string }

/**
 * Prompt block for a worker, written from what its spawn ACTUALLY got (obj
 * 901075): how to use the browser when it was granted, or one short paragraph
 * saying it is unavailable and why when it was refused. Either way the card
 * carries on; a refusal is never worked around with a hand-rolled install.
 */
export function buildCardBrowserPromptBlock(state: CardBrowserPromptState): string[] {
  if (!state.granted) {
    return [
      '',
      '## Browser',
      '',
      `No browser is available in this session: ${state.reason.slice(0, 300)}. Carry on with the card without one. ` +
        'Do not install a browser of your own (`npm i playwright`, `npx playwright install`); if a step genuinely needs a browser, say so in your summary.',
    ]
  }
  return [
    '',
    '## Browser',
    '',
    'Your session has a pinned, sandboxed Chromium whose traffic goes through the egress guard. Use it only through the launcher:',
    '```bash',
    'node "$CC_BROWSER_LAUNCHER" check                                  # proves it starts (sandbox + guard)',
    'node "$CC_BROWSER_LAUNCHER" screenshot <url> <out.png> [--width 1440] [--height 900] [--full]',
    '```',
    'or from a script: `const { launch } = await import(process.env.CC_BROWSER_LAUNCHER); const browser = await launch()`.',
    '- Do not `npm i playwright` / `npx playwright install` a browser of your own, and do not pass `--no-sandbox` or a proxy: the launcher refuses them and a hand-installed Chromium has no sandbox or guard.',
    '- The guard allows this install\'s own site only. Localhost, private networks and cloud metadata are refused (the Command Center API port always is); a preview server on localhost works only on a port the operator listed in CARD_BROWSER_WORKER_LOOPBACK_PORTS. A blocked site is policy, not a bug — say which URL was refused.',
    '- If `check` fails (Chromium will not start), carry on with the card without the browser and say which step needed it.',
  ]
}
