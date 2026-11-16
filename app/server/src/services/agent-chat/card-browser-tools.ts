// ── A browser tool for chat (obj 901027) ──
//
// Phase 1 of the browser-tooling recommendation (decisions/2026-11-15-agent-
// browser-tooling.md, obj 901022): Playwright MCP stays the one browser
// driver, but chat bots (any model — Grok, OpenAI, Claude — through
// agent-chat/engine.ts's ChatProvider tool-calling loop) have no browser tool
// at all today, because MCP's stdio-subprocess model only maps onto a Claude
// Code CLI spawn. This is the Node-side tool wrapper that gap calls for: it
// drives the SAME pinned Chromium (lib/browser-pins.ts) and the SAME egress
// guard / sandbox policy (lib/browser-policy.ts, services/browser-egress-
// proxy.ts) the reviewer's Playwright MCP config uses — just in-process via
// `playwright-core`, one disposable browser per call, never a persistent
// profile (that is phase 2 of the recommendation, not built here).
//
// Isolation (obj 901027 security review, round 2 — this is the still-current
// design after that pass; it still runs as a child of the main app process,
// in the same container as the secrets store and the AI logins, same as the
// reviewer's own Playwright MCP browser does today. Moving it into a jail or a
// separate container is the real fix for that and is tracked as a fast-follow,
// not done here):
//   - OS sandbox: ALWAYS on. `CARD_BROWSER_SANDBOX=off` used to just add
//     `--no-sandbox` and keep going; it now REFUSES to launch instead (fail
//     closed) — see `hostCardBrowser` below. A renderer that can escape its own
//     process sandbox in a container with no further isolation is a much worse
//     outcome than a chat tool being briefly unavailable.
//   - Egress: this tool gets its OWN egress-proxy instance
//     (`chatBrowserEgressProxy`, NOT `sharedBrowserEgressProxy`), forced to
//     `allowLoopback: false, allowPrivateNetwork: false, allowMetadata: false`
//     no matter what this install's reviewer-browser policy says — the
//     reviewer's own proxy is shared across every reviewer run and may
//     legitimately need `allowLoopback=true` to preview the install's own
//     site; the chat browser never does, so it never inherits that. On top
//     of that, `assertPublicDestination` below independently resolves and
//     refuses loopback/private/metadata destinations before Chromium ever
//     opens the page, for the FIRST request only (see its own doc comment for
//     why a redirect still needs the proxy's per-hop check, not just this).
//     Fails CLOSED: refuses to launch at all if the egress guard is not
//     running (`CARD_BROWSER_EGRESS_GUARD=off`), rather than falling back to
//     unrestricted egress.
//
// Reach: `id` is optional. Named, it must be a card this bot owns or has Full
// access to (sandboxCardAccess, card-sandbox-tools.ts — which itself now also
// requires the bot to be allowed to use that workspace and the chatting
// person to be a member of it) — so a bot cannot use the browser to peek at a
// sibling bot's work, or at a card in a workspace the chatting person cannot
// see, either. Omitted, it is a plain public-web screenshot tool, still fenced
// by the egress guard (so it can never reach the private network or cloud
// metadata regardless).
//
// The screenshot itself is never inlined to the model as a multi-megabyte
// base64 data URL. It is stored in `agent_chat_sandbox_screenshots` (same
// per-person-ownership shape as `agent_chat_attachments`) and served through
// one authenticated route, `GET /api/agent-chat/sandbox-screenshots/:id`; the
// tool result carries only a reference (id + url + metadata).
//
// `card_browser` is explicit opt-in (EXPLICIT_ONLY_TOOLS, tool-names.ts) —
// "all tools" does NOT grant it, matching `card_sandbox`: a browser that can
// reach arbitrary URLs and whose output used to be an unbounded data URL is
// not something a bot should gain just because an admin ticked "all".
//
// Every call — allowed, refused, or failed — is one row in
// agent_chat_sandbox_audit (ability `browser_screenshot`), same table and
// shape card-sandbox-tools.ts writes.
import { getDb } from '../../db/index.js'
import type { Objective } from '@operationkit/shared'
import { isLoopbackAddress, isMetadataAddress, isPrivateAddress, resolveBrowserPolicy, type BrowserPolicy } from '../../lib/browser-policy.js'
import { resolveChromiumBinary } from '../../lib/browser-pins.js'
import { resolveTarget, startBrowserEgressProxy, type EgressProxyHandle } from '../browser-egress-proxy.js'
import { saveSandboxScreenshot } from './sandbox-screenshots.js'
import { sandboxCardAccess, writeSandboxAudit } from './card-sandbox-tools.js'
import { agentHasTool, ToolUseError, type ToolContext, type ToolOutcome, type ToolSpec } from './tools.js'

// ── the chat browser's OWN egress guard (obj 901027 security review, point B.2) ──
//
// The reviewer's shared guard (services/browser-egress-proxy.ts's
// `sharedBrowserEgressProxy`) is started once at boot with THIS install's
// configured policy, which may well have `allowLoopback: true` (the default).
// The chat browser used to force loopback destinations through that SAME
// shared instance via Chromium's proxy-bypass-list — which meant a redirect
// (or any subresource fetch) to `http://127.0.0.1:3002/api/internal/...` was
// evaluated against the REVIEWER's loopback policy, not a chat-browser-
// specific one, and with `CARD_BROWSER_ALLOWED_ORIGINS='*'` any public page
// could 302 there and get screenshotted. This tool now starts and owns a
// SEPARATE proxy instance, always strict, independent of whatever the
// reviewer's env says.
let chatGuard: EgressProxyHandle | null = null
let chatGuardStarting: Promise<EgressProxyHandle> | null = null

/**
 * The chat browser's policy is the install's own (for which public origins it
 * may reach) with loopback/private/metadata ALWAYS stripped back to refused —
 * exported so a test can prove this independent of starting a real proxy.
 */
export function strictChatBrowserPolicy(policy: BrowserPolicy): BrowserPolicy {
  return { ...policy, allowLoopback: false, allowPrivateNetwork: false, allowMetadata: false }
}

/** Lazily start (once) this tool's own strict egress guard. Never shared with the reviewer's. */
async function chatBrowserEgressProxy(policy: BrowserPolicy): Promise<EgressProxyHandle> {
  if (chatGuard) return chatGuard
  if (!chatGuardStarting) {
    chatGuardStarting = startBrowserEgressProxy(strictChatBrowserPolicy(policy), { port: 0 })
      .then(h => { chatGuard = h; return h })
      .catch(err => { chatGuardStarting = null; throw err })
  }
  return chatGuardStarting
}

/** Test-only: drop the cached guard so each test gets a fresh instance/port. */
export function resetChatBrowserEgressProxyForTests(): void {
  chatGuard = null
  chatGuardStarting = null
}

function obj(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false }
}
function fn(name: string, description: string, parameters: Record<string, unknown>): ToolSpec {
  return { type: 'function', function: { name, description, parameters } }
}

const BROWSER_SPECS: ToolSpec[] = [
  fn(
    'browser_screenshot',
    'Open a web page in a disposable headless browser and take a screenshot. Use it to check what a page actually looks like, verify a deploy, or look at a card\'s live preview — you have no browser otherwise. This tool has its OWN strict network guard: loopback, private-network and cloud-metadata addresses are ALWAYS refused, on every redirect hop, regardless of this install\'s other browser settings. It can only reach addresses on this install\'s allowed-origins list (its own domain plus any configured CORS/allowed origins) — by default that is a short list, not the whole public web, and an address outside it is refused.',
    obj(
      {
        url: { type: 'string', description: 'Full http(s) URL to open' },
        id: { type: 'integer', description: 'Optional: the card number this check is for. If given, you must own that card or have Full access to its workspace.' },
        width: { type: 'integer', minimum: 320, maximum: 1920, description: 'Viewport width in px. Default 1280' },
        height: { type: 'integer', minimum: 240, maximum: 1920, description: 'Viewport height in px. Default 800' },
        wait_ms: { type: 'integer', minimum: 0, maximum: 5000, description: 'Extra wait after the page loads before the screenshot, ms. Default 0' },
      },
      ['url'],
    ),
  ),
]

export const CARD_BROWSER_FNS: ReadonlySet<string> = new Set(BROWSER_SPECS.map(s => s.function.name))

export function cardBrowserToolSpecs(ctx: Pick<ToolContext, 'agent'>): ToolSpec[] {
  return agentHasTool(ctx.agent, 'card_browser') ? BROWSER_SPECS : []
}

export interface BrowserScreenshot {
  finalUrl: string
  pngBase64: string
  widthPx: number
  heightPx: number
  bytes: number
}

/** Injectable so tests never need a real Chromium or network. */
export type CardBrowserHost = (
  url: string,
  opts: { widthPx: number; heightPx: number; waitMs: number; timeoutMs: number },
) => Promise<BrowserScreenshot>

/**
 * Independent of whatever this install's reviewer-browser policy allows
 * (`CARD_BROWSER_ALLOW_LOOPBACK`/`_ALLOW_PRIVATE_NETWORK` can both default
 * on), the CHAT browser always refuses a destination that resolves to
 * loopback, a private/CGNAT/link-local address, or cloud metadata. This is a
 * check the tool makes ITSELF — ahead of, and independent from, whatever the
 * shared egress guard's own policy would have allowed — so a loose reviewer
 * policy can never let a chat bot screenshot `localhost:3002/api/internal/...`
 * or another loopback/private service.
 */
export async function assertPublicDestination(url: URL): Promise<void> {
  const host = url.hostname
  let ips: string[]
  try {
    ips = await resolveTarget(host)
  } catch (err) {
    throw new ToolUseError(`Could not resolve ${host}: ${(err as Error).message}`)
  }
  if (ips.length === 0) throw new ToolUseError(`${host} resolved to no addresses.`)
  for (const ip of ips) {
    if (isLoopbackAddress(ip) || isPrivateAddress(ip) || isMetadataAddress(ip)) {
      throw new ToolUseError(
        `The chat browser may not open ${host} (resolves to ${ip}): loopback, private-network and cloud-metadata destinations are always refused, whatever this install's reviewer-browser loopback setting is.`,
      )
    }
  }
}

/** The real host: a one-shot headless Chromium launch through playwright-core, reusing the pinned binary. Fails closed if the OS sandbox or the egress guard is off/unavailable. */
export const hostCardBrowser: CardBrowserHost = async (url, opts) => {
  const policy = resolveBrowserPolicy()
  if (!policy.sandbox) {
    // obj 901027 security review, point B.1: this used to add --no-sandbox
    // and launch anyway. The chat browser runs in the SAME container as the
    // secrets store and AI logins with no further isolation, so a renderer
    // escape with no OS sandbox on top is the worst case this tool can cause
    // — refuse rather than take that risk.
    throw new ToolUseError('CARD_BROWSER_SANDBOX=off on this install disables the Chromium OS sandbox. The chat browser tool refuses to launch rather than run an unsandboxed renderer in the app container.')
  }
  if (!policy.egressGuard) {
    throw new ToolUseError('The browser egress guard is disabled on this install (CARD_BROWSER_EGRESS_GUARD=off), so the chat browser tool is refused rather than launching with unrestricted network access.')
  }
  let guard: EgressProxyHandle
  try {
    guard = await chatBrowserEgressProxy(policy)
  } catch (err) {
    throw new ToolUseError(`The chat browser's own egress guard could not start, so the tool is refused rather than launching with unrestricted network access: ${(err as Error).message}`)
  }
  const proxyPort = guard.port
  const { chromium } = await import('playwright-core')
  const launchArgs = ['--block-service-workers']
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveChromiumBinary(),
    args: launchArgs,
    // Always force loopback destinations THROUGH the guard for this tool —
    // never let Chromium's own "loopback bypasses any configured proxy"
    // default apply, whatever policy.allowLoopback says for the reviewer's
    // browser. '<-loopback>' is the Chromium proxy-bypass-list syntax that
    // cancels that default.
    proxy: { server: `http://127.0.0.1:${proxyPort}`, bypass: '<-loopback>' },
  })
  try {
    const page = await browser.newPage({ viewport: { width: opts.widthPx, height: opts.heightPx } })
    try {
      await page.goto(url, { timeout: opts.timeoutMs, waitUntil: 'load' })
      if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs)
      const buf = await page.screenshot({ type: 'png' })
      return { finalUrl: page.url(), pngBase64: buf.toString('base64'), widthPx: opts.widthPx, heightPx: opts.heightPx, bytes: buf.length }
    } finally {
      await page.close()
    }
  } finally {
    await browser.close()
  }
}

const MAX_SCREENSHOT_BYTES = 3 * 1024 * 1024

/** Injectable so tests never need real DNS/network to prove the refusal rules. */
export type DestinationGuard = (url: URL) => Promise<void>

export async function runCardBrowserTool(
  ctx: ToolContext,
  fnName: string,
  args: Record<string, unknown>,
  host: CardBrowserHost = hostCardBrowser,
  guard: DestinationGuard = assertPublicDestination,
): Promise<ToolOutcome> {
  if (!CARD_BROWSER_FNS.has(fnName)) throw new ToolUseError(`Unknown tool "${fnName}".`)
  if (!agentHasTool(ctx.agent, 'card_browser')) throw new ToolUseError(`Tool "${fnName}" is not allowed for this agent.`)

  const rawUrl = typeof args.url === 'string' ? args.url.trim() : ''
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ToolUseError('"url" must be a full http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ToolUseError('Only http(s) URLs can be opened.')

  let workspace: string | null = null
  let objectiveId: number | undefined
  if (args.id !== undefined && args.id !== null) {
    const id = Math.trunc(Number(args.id))
    if (!Number.isInteger(id) || id <= 0) throw new ToolUseError('id must be a card number.')
    const row = getDb().prepare('SELECT * FROM objectives WHERE id = ? AND deleted_at IS NULL').get(id) as (Objective & { owner_bot?: string | null }) | undefined
    if (!row || !sandboxCardAccess(ctx, row)) {
      writeSandboxAudit({
        event: 'ability_refused', slug: ctx.agent.slug, workspace: row?.workspace ?? null, actor_user_id: ctx.userId, ability: fnName, objective_id: id,
        detail: row ? 'bot does not own this card and has no Full access to its workspace' : 'card not found',
      })
      throw new ToolUseError(`Card #${id} is not a sandbox ${ctx.agent.name || ctx.agent.slug} may reach. It must own the card (be its worker or owner_bot) or have Full access to its workspace.`)
    }
    workspace = row.workspace
    objectiveId = row.id
  }

  const widthPx = Math.min(1920, Math.max(320, Math.trunc(Number(args.width)) || 1280))
  const heightPx = Math.min(1920, Math.max(240, Math.trunc(Number(args.height)) || 800))
  const waitMs = Math.min(5000, Math.max(0, Math.trunc(Number(args.wait_ms)) || 0))

  try {
    await guard(url)
    const shot = await host(url.toString(), { widthPx, heightPx, waitMs, timeoutMs: 20_000 })
    if (shot.bytes > MAX_SCREENSHOT_BYTES) {
      throw new ToolUseError(`The screenshot is ${Math.round(shot.bytes / 1024)} KB, too large to return. Try a smaller width/height.`)
    }
    const stored = saveSandboxScreenshot({
      userId: ctx.userId,
      slug: ctx.agent.slug,
      objectiveId: objectiveId ?? null,
      finalUrl: shot.finalUrl,
      bytes: Buffer.from(shot.pngBase64, 'base64'),
    })
    writeSandboxAudit({ event: 'ability_used', slug: ctx.agent.slug, workspace, actor_user_id: ctx.userId, ability: fnName, objective_id: objectiveId ?? null, detail: `screenshot of ${url.hostname}${url.pathname}` })
    return {
      result: {
        url: rawUrl,
        final_url: shot.finalUrl,
        width: shot.widthPx,
        height: shot.heightPx,
        bytes: shot.bytes,
        screenshot_id: stored.id,
        screenshot_url: stored.url,
      },
      summary: `Screenshotted ${url.hostname}${url.pathname}`,
      ...(objectiveId ? { objective_id: objectiveId } : {}),
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    writeSandboxAudit({ event: 'ability_refused', slug: ctx.agent.slug, workspace, actor_user_id: ctx.userId, ability: fnName, objective_id: objectiveId ?? null, detail: message.slice(0, 300) })
    if (err instanceof ToolUseError) throw err
    throw new ToolUseError(`The browser could not open that page: ${message.slice(0, 300)}`)
  }
}
