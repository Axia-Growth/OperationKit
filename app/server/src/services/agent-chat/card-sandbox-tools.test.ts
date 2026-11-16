// Card sandbox tools for chat bots (obj 901027).
//
// Through the real chat tools and a real (temp) SQLite DB + objective-memory
// dir, proves:
//   - the tool is opt-in: a bot whose file does not list card_sandbox gets
//     neither the specs nor the ability to call it, even "all tools" does not
//     imply it;
//   - access rules: a bot can read/list/run on a card it owns (worker or
//     owner_bot), or has Full access to the card's workspace — and is refused,
//     logged, on any OTHER bot's card, even in the same workspace;
//   - NOTES.md stays masked (the same mask live-artifacts.ts already applies);
//   - sandbox_run refuses cleanly off a jail-mode install, and redacts a
//     secret-shaped value out of the command/output it logs and returns when
//     jail mode is on;
//   - workspace scoping (obj 901027 security review): a bot restricted away
//     from a card's workspace is refused even if it owns the card, a person
//     who is not a member of the card's workspace is refused even on a card
//     their bot owns, and sandbox_run additionally requires an admin actor;
//   - a protected-PR card and a path-traversal read are both refused;
//   - every call — allowed or refused — is one row in agent_chat_sandbox_audit.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-card-sandbox-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-card-sandbox-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-sandbox-kb-'))
const TMP_MEMORY = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-sandbox-memory-'))
process.env.OBJECTIVE_MEMORY_ROOT = TMP_MEMORY

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool, toolSpecsForContext, ToolUseError } = await import('./tools.js')
const { runCardSandboxTool } = await import('./card-sandbox-tools.js')
const { grantBotWorkspace, seedExistingBotsOnce } = await import('./bot-workspaces.js')
type SandboxRunner = import('./card-sandbox-tools.js').SandboxRunner
const { setFullAccess } = await import('./bot-full-access.js')
const { createWorkspace } = await import('../workspaces.js')
const { listSandboxAudit } = await import('./card-sandbox-tools.js')

type Agent = import('./agent-defs.js').ChatAgent

const ADMIN = 1
/** A member of GROWTH, not an admin — for the sandbox_run admin-only gate. */
const MEMBER = 2
/** Not a member of GROWTH (or anywhere) and not an admin. */
const NONMEMBER = 3
const GROWTH = 'growth'
const ADMIN_ACTOR = { id: ADMIN, username: 'jordan' }
const NOW = new Date('2026-11-16T12:00:00Z')

function bot(slug: string, tools: string[]): Agent {
  return {
    slug,
    name: slug,
    description: '',
    avatar: '',
    colour: 'blue',
    system_prompt: 'You help.',
    knowledge_folders: [],
    tools,
    model: null,
    provider: null,
    schedules: [],
    version: null,
    author: null,
    how_to_use: '',
    example_prompts: [],
    source: 'file',
    file: '/dev/null',
  }
}

function ctx(a: Agent, workspace = GROWTH, userId = ADMIN) {
  return { userId, username: 'jordan', workspace, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => NOW }
}

const ids: Record<string, number> = {}
function card(key: string, opts: { agent?: string; ownerBot?: string | null; sessionId?: string | null; workspace?: string; prNumber?: number | null } = {}) {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, owner_bot, session_id, pr_number, updated_at)
       VALUES (?, ?, ?, 'working', 'task', 'general', ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .run(key, `brief of ${key}`, opts.workspace ?? GROWTH, ADMIN, ADMIN, opts.agent ?? null, opts.ownerBot ?? null, opts.sessionId ?? null, opts.prNumber ?? null)
  ids[key] = Number(r.lastInsertRowid)
  return ids[key]
}

function memDir(id: number): string {
  return path.join(TMP_MEMORY, String(id))
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
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'sam', 'x', 'member')`).run(MEMBER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alex', 'x', 'member')`).run(NONMEMBER)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role) VALUES (?, ?, 'member')`).run(MEMBER, GROWTH)
  // NONMEMBER deliberately gets no user_workspaces row at all.
  // Every bot used in this file EXCEPT 'dev-restricted' is a pre-existing bot
  // that predates workspace access lists — 'unrestricted' (obj 900797's
  // one-time migration), same as most of today's real bots. 'dev-restricted'
  // is deliberately left OUT so its own test can restrict it from scratch.
  seedExistingBotsOnce(['dev', 'other-bot', 'stranger'])

  // Dev's OWN card: worked by its slug.
  const devCard = card('dev-card', { agent: 'dev', sessionId: 'cc-sess-1' })
  fs.mkdirSync(memDir(devCard), { recursive: true })
  fs.writeFileSync(path.join(memDir(devCard), 'ARTIFACT.md'), 'Shipped the thing. Key: AKIAIOSFODNN7EXAMPLE should never leak.')
  fs.writeFileSync(path.join(memDir(devCard), 'NOTES.md'), 'private scratch, never served')

  // A sibling bot's card — dev must never reach this one.
  const sibCard = card('sibling-card', { agent: 'other-bot', sessionId: 'cc-sess-2' })
  fs.mkdirSync(memDir(sibCard), { recursive: true })
  fs.writeFileSync(path.join(memDir(sibCard), 'ARTIFACT.md'), 'sibling bot work')

  // A card dev does not own, in a DIFFERENT workspace Full access could cover.
  createWorkspace({ slug: 'other-co', name: 'Other Co', default_agent_pool: ['general'] })
  card('otherws-card', { agent: 'other-bot', sessionId: 'cc-sess-3', workspace: 'other-co' })
})

afterAll(() => {
  try { fs.unlinkSync(TMP_DB) } catch { /* ignore */ }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_MEMORY, { recursive: true, force: true })
})

describe('card_sandbox is explicit opt-in', () => {
  it('is absent from tool specs and refused to call when not listed, even with "all" tools', () => {
    const allTools = bot('dev', ['all'])
    expect(toolSpecsForContext(ctx(allTools)).some(s => s.function.name === 'sandbox_run')).toBe(false)
  })

  it('appears once the bot file lists card_sandbox', () => {
    const withSandbox = bot('dev', ['card_sandbox'])
    const names = toolSpecsForContext(ctx(withSandbox)).map(s => s.function.name)
    expect(names).toEqual(expect.arrayContaining(['sandbox_list', 'sandbox_list_files', 'sandbox_read_file', 'sandbox_read_log', 'sandbox_run']))
  })

  it('runChatTool refuses the ability for a bot that does not list it', async () => {
    const noSandbox = bot('dev', ['web_search'])
    await refused(() => runChatTool(ctx(noSandbox), 'sandbox_list_files', { id: ids['dev-card'] }), /not allowed for this agent/)
  })
})

describe('ownership and Full access gate every call', () => {
  const dev = bot('dev', ['card_sandbox'])

  it('a bot can list files on a card it owns (agent_context matches its slug)', async () => {
    const out = await runChatTool(ctx(dev), 'sandbox_list_files', { id: ids['dev-card'] })
    expect(out.result).toMatchObject({ id: ids['dev-card'] })
    expect((out.result as { entries: { path: string }[] }).entries.map(e => e.path)).toContain('ARTIFACT.md')
  })

  it('refuses, and logs, a card owned by a SIBLING bot — no Full access', async () => {
    await refused(() => runChatTool(ctx(dev), 'sandbox_list_files', { id: ids['sibling-card'] }), /not a sandbox .* may reach/)
    const rows = listSandboxAudit('dev', 50)
    expect(rows.some(r => r.event === 'ability_refused' && r.objective_id === ids['sibling-card'])).toBe(true)
  })

  it('refuses a card in a workspace with no Full access either', async () => {
    await refused(() => runChatTool(ctx(dev), 'sandbox_list_files', { id: ids['otherws-card'] }), /not a sandbox .* may reach/)
  })

  it('a bot WITHOUT ownership but WITH Full access to the workspace can reach the card', async () => {
    const otherBot = bot('other-bot', ['card_sandbox'])
    // other-bot does not own dev-card, but gets Full access to GROWTH.
    grantBotWorkspace('other-bot', GROWTH, 'jordan')
    setFullAccess('other-bot', GROWTH, { enabled: true }, ADMIN_ACTOR, NOW)
    const out = await runChatTool(ctx(otherBot), 'sandbox_list_files', { id: ids['dev-card'] })
    expect(out.result).toMatchObject({ id: ids['dev-card'] })
  })

  it('a never-owning, never-Full-access bot stays refused on the same card', async () => {
    const stranger = bot('stranger', ['card_sandbox'])
    await refused(() => runChatTool(ctx(stranger), 'sandbox_list_files', { id: ids['dev-card'] }), /not a sandbox .* may reach/)
  })
})

describe('reading a sandbox: masking, redaction, and the audit trail', () => {
  const dev = bot('dev', ['card_sandbox'])

  it('serves ARTIFACT.md with a known secret shape redacted', async () => {
    const out = await runChatTool(ctx(dev), 'sandbox_read_file', { id: ids['dev-card'], path: 'ARTIFACT.md' })
    const content = (out.result as { content: string }).content
    expect(content).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(content).toContain('[REDACTED:AWS_KEY]')
  })

  it('never serves NOTES.md — the worker scratch stays masked', async () => {
    await refused(() => runChatTool(ctx(dev), 'sandbox_read_file', { id: ids['dev-card'], path: 'NOTES.md' }), /private scratch|not served/)
  })

  it('sandbox_list only shows cards this bot owns', async () => {
    const out = await runChatTool(ctx(dev), 'sandbox_list', {})
    const cards = (out.result as { cards: { id: number }[] }).cards
    expect(cards.map(c => c.id)).toContain(ids['dev-card'])
    expect(cards.map(c => c.id)).not.toContain(ids['sibling-card'])
  })

  it('every call above wrote an audit row for "dev"', () => {
    const rows = listSandboxAudit('dev', 200)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(r => r.slug === 'dev')).toBe(true)
  })
})

describe('sandbox_run', () => {
  const dev = bot('dev', ['card_sandbox'])

  it('refuses cleanly off a jail-mode (SESSION_ISOLATION!=docker) install', async () => {
    expect(process.env.SESSION_ISOLATION).not.toBe('docker')
    await refused(() => runChatTool(ctx(dev), 'sandbox_run', { id: ids['dev-card'], command: 'ls' }), /SESSION_ISOLATION=docker/)
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.ability === 'sandbox_run' && r.event === 'ability_refused')).toBe(true)
  })

  it('still gates ownership before the jail-mode check', async () => {
    await refused(() => runChatTool(ctx(dev), 'sandbox_run', { id: ids['sibling-card'], command: 'ls' }), /not a sandbox .* may reach/)
  })

  it('refuses a non-admin actor even on a card the bot owns in a workspace they belong to', async () => {
    await refused(
      () => runChatTool(ctx(dev, GROWTH, MEMBER), 'sandbox_run', { id: ids['dev-card'], command: 'ls' }),
      /only runs for an install admin/,
    )
  })
})

describe('workspace + actor scoping (obj 901027 security review)', () => {
  it('refuses a bot that owns the card but is NOT granted the card\'s workspace, once restricted', async () => {
    const restricted = bot('dev-restricted', ['card_sandbox'])
    const restrictedCard = card('dev-restricted-card', { agent: 'dev-restricted', sessionId: 'cc-sess-20' })
    fs.mkdirSync(memDir(restrictedCard), { recursive: true })
    // Granting ONE workspace restricts the bot to exactly that list — GROWTH (the card's workspace) is not on it.
    grantBotWorkspace('dev-restricted', 'other-co', 'jordan')
    await refused(() => runChatTool(ctx(restricted), 'sandbox_list_files', { id: restrictedCard }), /not a sandbox .* may reach/)
  })

  it('refuses a chatting person who is not a member of the card\'s workspace, even on a card their bot owns', async () => {
    const dev = bot('dev', ['card_sandbox'])
    await refused(
      () => runChatTool(ctx(dev, GROWTH, NONMEMBER), 'sandbox_list_files', { id: ids['dev-card'] }),
      /not a sandbox .* may reach/,
    )
  })

  it('a workspace MEMBER (non-admin) can still read, just not sandbox_run', async () => {
    const dev = bot('dev', ['card_sandbox'])
    const out = await runChatTool(ctx(dev, GROWTH, MEMBER), 'sandbox_list_files', { id: ids['dev-card'] })
    expect(out.result).toMatchObject({ id: ids['dev-card'] })
  })

  it('sandbox_list excludes a candidate card whose workspace the chatting person cannot see', async () => {
    const dev = bot('dev', ['card_sandbox'])
    const outAdmin = await runChatTool(ctx(dev), 'sandbox_list', {})
    expect((outAdmin.result as { cards: { id: number }[] }).cards.map(c => c.id)).toContain(ids['dev-card'])
    const outNonmember = await runChatTool(ctx(dev, GROWTH, NONMEMBER), 'sandbox_list', {})
    expect((outNonmember.result as { cards: { id: number }[] }).cards.map(c => c.id)).not.toContain(ids['dev-card'])
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.ability === 'sandbox_list' && r.event === 'ability_used')).toBe(true)
  })

  it('refuses a card carrying a protected pull request, and logs it', async () => {
    const dev = bot('dev', ['card_sandbox'])
    const protectedCard = card('protected-card', { agent: 'dev', sessionId: 'cc-sess-21', prNumber: 645 })
    fs.mkdirSync(memDir(protectedCard), { recursive: true })
    await refused(() => runChatTool(ctx(dev), 'sandbox_list_files', { id: protectedCard }), /protected/)
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.event === 'ability_refused' && r.objective_id === protectedCard && r.detail?.includes('protected'))).toBe(true)
  })

  it('refuses a path-traversal read outside the card\'s sandbox directory', async () => {
    const dev = bot('dev', ['card_sandbox'])
    await refused(() => runChatTool(ctx(dev), 'sandbox_read_file', { id: ids['dev-card'], path: '../../etc/passwd' }), /invalid path/)
    await refused(() => runChatTool(ctx(dev), 'sandbox_read_file', { id: ids['dev-card'], path: '/etc/passwd' }), /invalid path/)
  })

  it('obj 901027 security review, minor point: a path-traversal refusal is still logged to the audit table', async () => {
    const dev = bot('dev', ['card_sandbox'])
    await refused(() => runChatTool(ctx(dev), 'sandbox_read_file', { id: ids['dev-card'], path: '../../etc/passwd' }), /invalid path/)
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.event === 'ability_refused' && r.ability === 'sandbox_read_file' && r.objective_id === ids['dev-card'] && r.detail === 'invalid path')).toBe(true)
  })
})

describe('Full access reach requires an admin actor (obj 901027 security review, point C)', () => {
  it('a non-admin member chatting with a Full-access bot cannot reach a card it does not own', async () => {
    const faBot = bot('fa-bot', ['card_sandbox'])
    grantBotWorkspace('fa-bot', GROWTH, 'jordan')
    setFullAccess('fa-bot', GROWTH, { enabled: true }, ADMIN_ACTOR, NOW)
    // MEMBER is a real member of GROWTH (so the workspace-membership gate
    // passes) but is not an admin, so Full access must not widen their reach.
    await refused(
      () => runChatTool(ctx(faBot, GROWTH, MEMBER), 'sandbox_list_files', { id: ids['dev-card'] }),
      /not a sandbox .* may reach/,
    )
  })

  it('an admin chatting with the same Full-access bot still reaches the card', async () => {
    const faBot = bot('fa-bot', ['card_sandbox'])
    const out = await runChatTool(ctx(faBot, GROWTH, ADMIN), 'sandbox_list_files', { id: ids['dev-card'] })
    expect(out.result).toMatchObject({ id: ids['dev-card'] })
  })
})

describe('sandbox_run in jail mode: env, timeout and the seat-login refusal', () => {
  const dev = bot('dev', ['card_sandbox'])
  const prevIsolation = process.env.SESSION_ISOLATION

  beforeAll(() => { process.env.SESSION_ISOLATION = 'docker' })
  afterAll(() => {
    if (prevIsolation === undefined) delete process.env.SESSION_ISOLATION
    else process.env.SESSION_ISOLATION = prevIsolation
  })

  it('clamps timeout_ms to the 1s-60s range before it ever reaches the runner', async () => {
    let seenTimeout = 0
    const stubRunner: SandboxRunner = async (_id, _cmd, timeoutMs) => {
      seenTimeout = timeoutMs
      return { code: 0, stdout: 'ok', stderr: '' }
    }
    await runCardSandboxTool(ctx(dev), 'sandbox_run', { id: ids['dev-card'], command: 'ls', timeout_ms: 999_999 }, stubRunner)
    expect(seenTimeout).toBe(60_000)
  })

  it('redacts a secret-shaped value out of both the returned stdout and the logged command', async () => {
    const stubRunner: SandboxRunner = async () => ({ code: 0, stdout: 'key=AKIAIOSFODNN7EXAMPLE', stderr: '' })
    const out = await runCardSandboxTool(ctx(dev), 'sandbox_run', { id: ids['dev-card'], command: 'echo AKIAIOSFODNN7EXAMPLE' }, stubRunner)
    expect((out.result as { stdout: string }).stdout).toContain('[REDACTED:AWS_KEY]')
    expect((out.result as { stdout: string }).stdout).not.toContain('AKIAIOSFODNN7EXAMPLE')
    const rows = listSandboxAudit('dev', 200)
    expect(rows.some(r => r.ability === 'sandbox_run' && r.detail?.includes('[REDACTED:AWS_KEY]'))).toBe(true)
  })

  it('refuses a command that targets the seat-login mount, WITHOUT ever calling the runner', async () => {
    let called = false
    const stubRunner: SandboxRunner = async () => { called = true; return { code: 0, stdout: '', stderr: '' } }
    await refused(
      () => runCardSandboxTool(ctx(dev), 'sandbox_run', { id: ids['dev-card'], command: 'cat ~/.codex/auth.json' }, stubRunner),
      /seat-login/,
    )
    expect(called).toBe(false)
    const grokStubRunner: SandboxRunner = async () => { called = true; return { code: 0, stdout: '', stderr: '' } }
    await refused(
      () => runCardSandboxTool(ctx(dev), 'sandbox_run', { id: ids['dev-card'], command: 'cat ~/.grok/config.json' }, grokStubRunner),
      /seat-login/,
    )
  })
})
