/**
 * card-browser-spawn.ts — the browser every WORKER spawn gets (obj 901029;
 * default-on for every card since obj 901075). Pure planning + file writes;
 * spawnInTmux applies the plan.
 *
 * The contract, both modes:
 *   * planner / arena / sub-sessions are never passed here. A REVIEWER is
 *     passed here only in jail mode and only when its review needs a browser
 *     (a UI-change PR — planReviewerBrowser in session-subsessions.ts, obj
 *     901229); a tmux-mode reviewer keeps its own reviewer MCP config, and a
 *     backend-only review never asks;
 *   * a worker gets the pinned Chromium, the OS sandbox on, and Chromium
 *     pointed at the egress guard — or, when any of that cannot be guaranteed
 *     (tmux mode by default, browser image missing, guard down, profile
 *     missing, docker refused the browser jail), a REFUSAL: no browser at all,
 *     the reason in its env and its prompt, and the card carries on. Never a
 *     degraded browser, and never a failed spawn because of the browser.
 *
 * See lib/card-browser.ts for the why, and docs/wiki/Card-Browser-Lockdown.md.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrowserPolicy } from '../lib/browser-policy.js'
import {
  CARD_BROWSER_LAUNCHER_FILE,
  JAIL_BROWSER_GUARD_PORT,
  JAIL_GUARD_DIR,
  buildCardBrowserEnv,
  buildJailGuardPrefix,
  jailBrowserImage,
  jailBrowserSeccompProfilePath,
  jailChromiumBinary,
  renderCardBrowserLauncher,
  renderJailGuardRunner,
  resolveChromiumBinary,
  resolveWorkerBrowserPolicy,
  workerBrowserInAppContainerAllowed,
  writePlaywrightMcpConfig,
} from '../lib/card-browser.js'
import { execFileSync } from 'node:child_process'
import { sharedWorkerBrowserEgressProxy } from './browser-egress-proxy.js'

export interface CardBrowserPlan {
  /** Env merged into the session (CC_CARD_BROWSER=1, launcher, binary, proxy). */
  env: Record<string, string>
  /** The worker policy this browser's MCP config (and in-jail guard) was built from. */
  policy: BrowserPolicy
  /** Host path of the Playwright MCP config to pass as --mcp-config (tmux mode). */
  mcpConfigPath?: string
  /** Jail-only settings. */
  jail?: {
    image: string
    seccompProfile: string
    /** Shell prefix that starts the in-jail guard ('' when the operator turned the guard off). */
    guardPrefix: string
    /** Host path of the Playwright MCP config (jail-visible via the HOME bind). */
    mcpConfigHostPath: string
    /** The same file's path inside the jail. */
    mcpConfigGuestPath: string
  }
}

export type CardBrowserResult = { ok: true; plan: CardBrowserPlan } | { ok: false; reason: string }

export interface CardBrowserFsOps {
  /** Make a jail-visible file/dir readable by the jail uid (applyJailOwnership). */
  ownForJail?: (target: string, kind: 'dir' | 'jail-read') => void
}

const here = path.dirname(fileURLToPath(import.meta.url))
/** The guard's own source files, copied verbatim into a browser jail. */
export const GUARD_SOURCES: Array<{ from: string; to: string }> = [
  { from: path.join(here, 'browser-egress-proxy.ts'), to: 'services/browser-egress-proxy.ts' },
  { from: path.join(here, '..', 'lib', 'browser-policy.ts'), to: 'lib/browser-policy.ts' },
]

/**
 * Is the browser jail image present on the docker host? Every card uses it
 * now, and an install that never built it (or an operator who removed it) must
 * fall back to the stock jail, not fail the spawn. Cached briefly so a burst of
 * spawns costs one `docker image inspect`.
 */
const IMAGE_CHECK_TTL_MS = 60_000
const imageCheckCache = new Map<string, { ok: boolean; at: number }>()
export function jailBrowserImagePresent(image: string, now: number = Date.now()): boolean {
  const hit = imageCheckCache.get(image)
  if (hit && now - hit.at < IMAGE_CHECK_TTL_MS) return hit.ok
  let ok = false
  try {
    execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
    ok = true
  } catch { ok = false }
  imageCheckCache.set(image, { ok, at: now })
  return ok
}
/** Test hook. */
export function resetJailBrowserImageCache(): void { imageCheckCache.clear() }

/** The env a refused worker gets, so its worker can say why instead of guessing. */
export function refusedBrowserEnv(reason: string): Record<string, string> {
  return { CC_CARD_BROWSER: '0', CC_CARD_BROWSER_REFUSED: reason.slice(0, 300) }
}

/** Why a tmux-mode worker is refused a browser by default (obj 901051). */
export const TMUX_BROWSER_REFUSED_REASON =
  'the worker browser is only available in jailed sessions (SESSION_ISOLATION=docker); ' +
  'this session runs in the app container, which holds the secrets store, the DB and seat logins. ' +
  'An operator can allow it with CARD_BROWSER_WORKER_IN_APP_CONTAINER=on'

/**
 * Plan for the tmux path (the worker runs in the app container). REFUSED by
 * default: Chromium belongs in the card sandbox, not next to the secrets store.
 * Only with CARD_BROWSER_WORKER_IN_APP_CONTAINER=on does it get a browser, and
 * then behind the WORKER guard (worker policy: loopback refused, CC API port
 * blocked) — never the reviewer's shared guard.
 */
export function planTmuxCardBrowser(opts: {
  sessionId: string
  homeDir: string
  scriptDir: string
  policy?: BrowserPolicy
  guardPort?: number | null
  chromiumBin?: string
  env?: NodeJS.ProcessEnv
}): CardBrowserResult {
  const env = opts.env ?? process.env
  if (!workerBrowserInAppContainerAllowed(env)) return { ok: false, reason: TMUX_BROWSER_REFUSED_REASON }
  const policy = opts.policy ?? resolveWorkerBrowserPolicy(env)
  let proxyPort: number | null = null
  if (policy.egressGuard) {
    const port = opts.guardPort !== undefined ? opts.guardPort : (sharedWorkerBrowserEgressProxy()?.port ?? null)
    if (!port) {
      return { ok: false, reason: 'the worker browser egress guard is not running on the control plane; no browser was given (fail closed)' }
    }
    proxyPort = port
  }
  const chromiumBin = opts.chromiumBin ?? resolveChromiumBinary()
  try {
    const launcherPath = path.join(opts.scriptDir, CARD_BROWSER_LAUNCHER_FILE)
    fs.mkdirSync(opts.scriptDir, { recursive: true })
    fs.writeFileSync(launcherPath, renderCardBrowserLauncher())
    fs.chmodSync(launcherPath, 0o644)
    const mcpConfigPath = writePlaywrightMcpConfig({
      outPath: path.join(opts.scriptDir, `${opts.sessionId}.mcp.json`),
      profileDir: path.join(opts.homeDir, '.cache', 'playwright-mcp'),
      chromiumBin,
      policy,
      proxyPort,
      mode: 0o666,
      cleanEnv: { home: opts.homeDir },
    })
    return {
      ok: true,
      plan: { env: buildCardBrowserEnv({ launcherPath, chromiumBin, proxyPort, policy }), mcpConfigPath, policy },
    }
  } catch (err) {
    return { ok: false, reason: `could not write the card browser config: ${(err as Error).message}` }
  }
}

/**
 * Plan for the jail path. Writes into the session's jail HOME (`scriptDirHost`
 * on the host = `scriptDirGuest` inside): the launcher, the Playwright MCP
 * config, and — unless the operator turned the guard off — a copy of the guard
 * plus its runner. The jail is then started from the browser image under the
 * browser seccomp profile.
 */
export function planJailCardBrowser(opts: {
  sessionId: string
  scriptDirHost: string
  scriptDirGuest: string
  jailHomeGuest: string
  policy?: BrowserPolicy
  env?: NodeJS.ProcessEnv
  ops?: CardBrowserFsOps
  /** Override the image-presence probe (tests). */
  imagePresent?: (image: string) => boolean
}): CardBrowserResult {
  // A jail has its own network namespace, so its loopback is this card's own
  // sandbox: the worker's dev servers open by default (obj 901145).
  const policy = opts.policy ?? resolveWorkerBrowserPolicy(opts.env, { ownSandboxLoopback: true })
  const own = opts.ops?.ownForJail ?? (() => {})
  const image = jailBrowserImage(opts.env)
  const imagePresent = opts.imagePresent ?? jailBrowserImagePresent
  if (!imagePresent(image)) {
    return { ok: false, reason: `the browser jail image ${image} is not on this host (run install/update.sh to build it); this card runs in the stock jail without a browser` }
  }
  const seccompProfile = jailBrowserSeccompProfilePath()
  if (!fs.existsSync(seccompProfile)) {
    return { ok: false, reason: `browser jail seccomp profile missing at ${seccompProfile}; no browser was given (fail closed)` }
  }
  const chromiumBin = jailChromiumBinary()
  try {
    fs.mkdirSync(opts.scriptDirHost, { recursive: true })
    const launcherHost = path.join(opts.scriptDirHost, CARD_BROWSER_LAUNCHER_FILE)
    fs.writeFileSync(launcherHost, renderCardBrowserLauncher())
    own(launcherHost, 'jail-read')

    let guardPrefix = ''
    let proxyPort: number | null = null
    if (policy.egressGuard) {
      const guardHost = path.join(opts.scriptDirHost, JAIL_GUARD_DIR)
      for (const sub of ['', 'services', 'lib']) {
        const d = path.join(guardHost, sub)
        fs.mkdirSync(d, { recursive: true })
        own(d, 'dir')
      }
      for (const src of GUARD_SOURCES) {
        const dst = path.join(guardHost, src.to)
        fs.copyFileSync(src.from, dst)
        own(dst, 'jail-read')
      }
      const runner = path.join(guardHost, 'run.ts')
      fs.writeFileSync(runner, renderJailGuardRunner(policy, JAIL_BROWSER_GUARD_PORT))
      own(runner, 'jail-read')
      guardPrefix = buildJailGuardPrefix(`${opts.scriptDirGuest}/${JAIL_GUARD_DIR}`)
      proxyPort = JAIL_BROWSER_GUARD_PORT
    }

    const mcpConfigHostPath = path.join(opts.scriptDirHost, `${opts.sessionId}.browser-mcp.json`)
    writePlaywrightMcpConfig({
      outPath: mcpConfigHostPath,
      profileDir: `${opts.jailHomeGuest}/.cache/playwright-mcp`,
      chromiumBin,
      policy,
      proxyPort,
      cleanEnv: { home: opts.jailHomeGuest },
    })
    own(mcpConfigHostPath, 'jail-read')

    return {
      ok: true,
      plan: {
        policy,
        env: buildCardBrowserEnv({
          launcherPath: `${opts.scriptDirGuest}/${CARD_BROWSER_LAUNCHER_FILE}`,
          chromiumBin,
          proxyPort,
          policy,
        }),
        jail: {
          image,
          seccompProfile,
          guardPrefix,
          mcpConfigHostPath,
          mcpConfigGuestPath: `${opts.scriptDirGuest}/${opts.sessionId}.browser-mcp.json`,
        },
      },
    }
  } catch (err) {
    return { ok: false, reason: `could not stage the card browser into the jail: ${(err as Error).message}` }
  }
}
