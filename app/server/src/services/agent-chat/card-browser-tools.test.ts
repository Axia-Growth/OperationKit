// Card browser tool for chat bots (obj 901027).
//
// A stub CardBrowserHost stands in for a real Chromium launch (no network, no
// binary needed) — proves:
//   - opt-in: card_browser is explicit-only, like card_sandbox — a bot without
//     it listed (even with "all tools") gets neither the spec nor the ability;
//   - only http(s) URLs are accepted;
//   - with no `id`, it is a plain screenshot tool (still gated by the tool list);
//   - with an `id`, the same ownership/Full-access gate card-sandbox-tools.ts
//     enforces applies — a bot cannot screenshot "for" a card it does not own
//     and has no Full access to;
//   - the screenshot is stored (agent_chat_sandbox_screenshots) and only a
//     reference comes back — never an inline base64 data URL;
//   - loopback / private-network / cloud-metadata destinations are always
//     refused, by a dedicated DNS-based check this tool makes itself, BEFORE
//     the host (Chromium) is ever reached — and the real host refuses to
//     launch at all when the egress guard is switched off;
//   - every call, success or refusal, is one row in agent_chat_sandbox_audit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-card-browser-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-card-browser-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-browser-kb-'))

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool, toolSpecsForContext, ToolUseError } = await import('./tools.js')
const { createWorkspace } = await import('../workspaces.js')
const { seedExistingBotsOnce } = await import('./bot-workspaces.js')
const { listSandboxAudit } = await import('./card-sandbox-tools.js')
const { runCardBrowserTool, hostCardBrowser, assertPublicDestination, strictChatBrowserPolicy } = await import('./card-browser-tools.js')
const { getSandboxScreenshot } = await import('./sandbox-screenshots.js')
const { decideEgress, resolveBrowserPolicy } = await import('../../lib/browser-policy.js')

type Agent = import('./agent-defs.js').ChatAgent
type BrowserScreenshot = import('./card-browser-tools.js').BrowserScreenshot

const ADMIN = 1
const GROWTH = 'growth'
const NOW = new Date('2026-11-16T12:00:00Z')

function bot(slug: string, tools: string[]): Agent {
  return {
    slug, name: slug, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.',
    knowledge_folders: [], tools, model: null, provider: null, schedules: [], version: null, author: null,
    how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}

function ctx(a: Agent, workspace = GROWTH) {
  return { userId: ADMIN, username: 'jordan', workspace, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => NOW }
}

const stubShot = { finalUrl: 'https://example.com/', pngBase64: Buffer.from('fake-png').toString('base64'), widthPx: 1280, heightPx: 800, bytes: 9 }
const stubHost = async () => stubShot
/** No real DNS: every test target here is public-looking by construction. */
const stubGuard = async () => {}

const ids: Record<string, number> = {}
function card(key: string, opts: { agent?: string | null; workspace?: string } = {}) {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, updated_at)
       VALUES (?, ?, ?, 'working', 'task', 'general', ?, ?, ?, datetime('now'))`,
    )
    .run(key, `brief of ${key}`, opts.workspace ?? GROWTH, ADMIN, ADMIN, opts.agent ?? null)
  ids[key] = Number(r.lastInsertRowid)
  return ids[key]
}

async function refused(run: () => Promise<unknown>, pattern: RegExp) {
  let err: unknown
  try { await run() } catch (e) { err = e }
  expect(err, 'expected the tool to refuse').toBeInstanceOf(ToolUseError)
  expect((err as Error).message).toMatch(pattern)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'jordan', 'x', 'admin')`).run(ADMIN)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
  // A pre-existing bot (obj 900797 one-time migration) — unrestricted, same as
  // most of today's real bots; this test is about card ownership, not workspace grants.
  seedExistingBotsOnce(['dev', 'other-bot'])
  card('dev-card', { agent: 'dev' })
  card('sibling-card', { agent: 'other-bot' })
})

afterAll(() => {
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('card_browser is explicit opt-in', () => {
  it('is absent from specs for a bot that does not list it', () => {
    const noBrowser = bot('dev', ['web_search'])
    expect(toolSpecsForContext(ctx(noBrowser)).some(s => s.function.name === 'browser_screenshot')).toBe(false)
  })

  it('appears once listed', () => {
    const withBrowser = bot('dev', ['card_browser'])
    const names = toolSpecsForContext(ctx(withBrowser)).map(s => s.function.name)
    expect(names).toContain('browser_screenshot')
  })

  it('"all tools" does NOT grant it — explicit opt-in only (security review, obj 901027)', () => {
    const allTools = bot('dev', ['all'])
    expect(toolSpecsForContext(ctx(allTools)).some(s => s.function.name === 'browser_screenshot')).toBe(false)
  })
})

describe('browser_screenshot', () => {
  const dev = bot('dev', ['card_browser'])

  it('refuses a non-http(s) url', async () => {
    await refused(() => runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'file:///etc/passwd' }, stubHost, stubGuard), /http\(s\) URL/)
  })

  it('takes a screenshot with no id (plain web use), stores it, and returns a reference (never inline base64)', async () => {
    const out = await runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'https://example.com' }, stubHost, stubGuard)
    const result = out.result as { screenshot_id: number; screenshot_url: string; final_url: string }
    expect(result.final_url).toBe('https://example.com/')
    expect(result.screenshot_url).toBe(`/api/agent-chat/sandbox-screenshots/${result.screenshot_id}`)
    expect(JSON.stringify(out.result)).not.toContain('base64')
    const stored = getSandboxScreenshot(result.screenshot_id)
    expect(stored?.user_id).toBe(ADMIN)
    expect(stored?.bytes.toString()).toBe('fake-png')
    expect(out.objective_id).toBeUndefined()
  })

  it('with an id for a card this bot owns, succeeds and tags objective_id', async () => {
    const out = await runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'https://example.com', id: ids['dev-card'] }, stubHost, stubGuard)
    expect(out.objective_id).toBe(ids['dev-card'])
  })

  it('with an id for a SIBLING bot\'s card, refuses — same gate as sandbox tools', async () => {
    await refused(
      () => runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'https://example.com', id: ids['sibling-card'] }, stubHost, stubGuard),
      /not a sandbox .* may reach/,
    )
  })

  it('runChatTool refuses the ability outright for a bot that does not list card_browser', async () => {
    const noBrowser = bot('dev', ['web_search'])
    await refused(() => runChatTool(ctx(noBrowser), 'browser_screenshot', { url: 'https://example.com' }), /not allowed for this agent/)
  })

  it('every call above wrote an audit row', () => {
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.ability === 'browser_screenshot' && r.event === 'ability_used')).toBe(true)
    expect(rows.some(r => r.ability === 'browser_screenshot' && r.event === 'ability_refused' && r.objective_id === ids['sibling-card'])).toBe(true)
  })

  it('propagates a host failure as a refusal and still logs it', async () => {
    const failingHost = async (): Promise<BrowserScreenshot> => { throw new Error('net::ERR_CONNECTION_REFUSED') }
    await refused(() => runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'https://example.com' }, failingHost, stubGuard), /ERR_CONNECTION_REFUSED/)
  })
})

describe('the chat browser always refuses loopback, private and metadata destinations', () => {
  const dev = bot('dev', ['card_browser'])

  it('assertPublicDestination refuses a loopback IP literal, with no DNS needed', async () => {
    await expect(assertPublicDestination(new URL('http://127.0.0.1:3002/api/internal/objectives'))).rejects.toThrow(/loopback/)
  })

  it('assertPublicDestination refuses a private RFC1918 address', async () => {
    await expect(assertPublicDestination(new URL('http://10.1.2.3/'))).rejects.toThrow(/private-network/)
  })

  it('assertPublicDestination refuses the cloud metadata address', async () => {
    await expect(assertPublicDestination(new URL('http://169.254.169.254/latest/meta-data/'))).rejects.toThrow(/metadata/)
  })

  it('the real guard refuses the loopback destination BEFORE the host ever launches, and logs it', async () => {
    const neverCalled = async (): Promise<BrowserScreenshot> => { throw new Error('host should never be reached') }
    await refused(
      () => runCardBrowserTool(ctx(dev), 'browser_screenshot', { url: 'http://127.0.0.1:3002/api/internal/objectives' }, neverCalled),
      /loopback/,
    )
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.ability === 'browser_screenshot' && r.event === 'ability_refused' && r.detail?.includes('loopback'))).toBe(true)
  })

  it('refuses to launch at all when the egress guard is switched off, before importing Chromium', async () => {
    const prev = process.env.CARD_BROWSER_EGRESS_GUARD
    process.env.CARD_BROWSER_EGRESS_GUARD = 'off'
    try {
      await expect(hostCardBrowser('https://example.com', { widthPx: 1280, heightPx: 800, waitMs: 0, timeoutMs: 1000 })).rejects.toThrow(/egress guard is disabled/)
    } finally {
      if (prev === undefined) delete process.env.CARD_BROWSER_EGRESS_GUARD
      else process.env.CARD_BROWSER_EGRESS_GUARD = prev
    }
  })

  it('obj 901027 security review, point B.1: refuses to launch when CARD_BROWSER_SANDBOX=off, rather than adding --no-sandbox', async () => {
    const prev = process.env.CARD_BROWSER_SANDBOX
    process.env.CARD_BROWSER_SANDBOX = 'off'
    try {
      await expect(hostCardBrowser('https://example.com', { widthPx: 1280, heightPx: 800, waitMs: 0, timeoutMs: 1000 })).rejects.toThrow(/OS sandbox/)
    } finally {
      if (prev === undefined) delete process.env.CARD_BROWSER_SANDBOX
      else process.env.CARD_BROWSER_SANDBOX = prev
    }
  })

  it('obj 901027 security review, point B.2: the chat browser\'s own policy refuses loopback even when this install\'s reviewer-browser policy allows it', () => {
    const permissive = resolveBrowserPolicy({ CARD_BROWSER_ALLOW_LOOPBACK: 'on', CARD_BROWSER_ALLOWED_ORIGINS: '*' } as NodeJS.ProcessEnv)
    expect(permissive.allowLoopback).toBe(true)
    const strict = strictChatBrowserPolicy(permissive)
    expect(strict.allowLoopback).toBe(false)
    expect(strict.allowPrivateNetwork).toBe(false)
    expect(strict.allowMetadata).toBe(false)
    const decision = decideEgress(strict, { scheme: 'http', host: 'localhost', port: 3002 }, ['127.0.0.1'])
    expect(decision.allow).toBe(false)
    // Control: the SAME permissive policy, unmodified, would have allowed it —
    // proving the strict override is what makes the difference, not something
    // already true of the install's policy.
    expect(decideEgress(permissive, { scheme: 'http', host: 'localhost', port: 3002 }, ['127.0.0.1']).allow).toBe(true)
  })
})
