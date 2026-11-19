// Bot Full access, per workspace (obj 900972).
//
// Through the real chat tools and a real (temp) SQLite DB, proves:
//   - the switch: needs a granted workspace, optional expiry, exclusions off by
//     default and reset when it goes off, every change audit-logged;
//   - each Full access ability is allowed when on and refused when off, when
//     expired, in a workspace that was not granted, and for a person who is not
//     an admin;
//   - each of the four hard exclusions is refused (and the refusal logged)
//     while its switch is off, and let through once it is on;
//   - merge and deploy still need an "approve on my behalf" grant: Full access
//     with every exclusion on approves nothing;
//   - a bot WITHOUT Full access is untouched by any of it.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-bot-full-access-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-full-access-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-full-access-kb-'))
// The bot list tools read the install's agent files: one bot, "dev".
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-full-access-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
fs.mkdirSync(path.join(TMP_AGENTS, 'dev'), { recursive: true })
fs.writeFileSync(path.join(TMP_AGENTS, 'dev', 'agent.yaml'), 'name: Operation Kit Dev\ndescription: Builds things\ntools: [web_search]\nknowledge_folders: [shared]\nsystem_prompt: You help.\n')

const { initDb, getDb } = await import('../../db/index.js')
const { createAgent } = await import('../agent-registry.js')
const { runChatTool, toolSpecsFor, toolSpecsForContext, ToolUseError } = await import('./tools.js')
const { grantBotWorkspace, revokeBotWorkspace, seedExistingBotsOnce, SEED_MARKER } = await import('./bot-workspaces.js')
const {
  setFullAccess,
  getFullAccess,
  listFullAccess,
  fullAccessActive,
  exclusionAllowed,
  allActiveFullAccess,
  listFullAccessAudit,
  dropFullAccessForRevokedWorkspaces,
  cardSessionFullAccess,
  fullAccessAnywhere,
  isProtectedCard,
  protectedPrInText,
  protectedPrTextMessage,
  FullAccessError,
} = await import('./bot-full-access.js')
const { classifyOutbound, exclusionGate } = await import('./full-access-exclusions.js')
const { runMcpTool } = await import('./mcp-tools.js')
const { fullAccessWorkspaces, fullAccessPromptLine, FULL_ACCESS_FNS, botOwnershipRefusal } = await import('./full-access-tools.js')
const { createGrant, decideDelegatedApproval } = await import('../delegated-approvals.js')
const { createWorkspace } = await import('../workspaces.js')
const { saveFlowVersion } = await import('../flow-engine.js')
const { FULL_ACCESS_EXCLUSIONS, FULL_ACCESS_PERMANENT_EXCLUSIONS, FULL_ACCESS_PROTECTED_PRS, FULL_ACCESS_SWITCHES } = await import('@operationkit/shared')
type Agent = import('./agent-defs.js').ChatAgent
type Exclusion = import('@operationkit/shared').FullAccessExclusion

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const ALICE = 2 // member of growth, not an admin
const GROWTH = 'growth'
const OTHER = 'other-co'
const ADMIN_ACTOR = { id: ADMIN, username: 'jordan' }
const NOW = new Date('2026-11-15T12:00:00Z')
const IN_A_WEEK = new Date(NOW.getTime() + 7 * 86_400_000).toISOString()
const AFTER_EXPIRY = new Date(NOW.getTime() + 8 * 86_400_000)

/** A bot whose own file gives it almost nothing: what it can do below comes from Full access. */
function bot(slug = 'dev', extra: Partial<Agent> = {}): Agent {
  return {
    slug,
    name: 'Operation Kit Dev',
    description: 'Builds things',
    avatar: '',
    colour: 'blue',
    system_prompt: 'You help.',
    knowledge_folders: ['shared'],
    tools: ['web_search'],
    model: null,
    provider: null,
    schedules: [],
    version: null,
    author: null,
    how_to_use: '',
    example_prompts: [],
    source: 'file',
    file: '/dev/null',
    ...extra,
  }
}

const hostCalls: { kind: 'start' | 'message'; id: number; text?: string }[] = []
const host = {
  async startCard(id: number) { hostCalls.push({ kind: 'start', id }); return { ok: true, status: 'working' } },
  async messageCard(id: number, text: string) { hostCalls.push({ kind: 'message', id, text }); return { ok: true, status: 'working' } },
}

function ctx(userId: number, a: Agent, workspace = GROWTH, now: Date = NOW) {
  return { userId, username: userId === ADMIN ? 'jordan' : 'alice', workspace, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => now, fullAccessHost: host }
}

const ids: Record<string, number> = {}
function card(key: string, workspace: string, owner: number, extra: { project?: string; agent?: string } = {}) {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, project, updated_at)
       VALUES (?, ?, ?, 'review', 'task', 'general', ?, ?, ?, ?, datetime('now'))`,
    )
    .run(key, `brief of ${key}`, workspace, owner, owner, extra.agent ?? 'general', extra.project ?? null)
  ids[key] = Number(r.lastInsertRowid)
}
const SEEDED = ['alice-card', 'repo-card', 'other-card']

async function refused(run: () => Promise<unknown>, pattern: RegExp) {
  let err: unknown
  try { await run() } catch (e) { err = e }
  expect(err, 'expected the tool to refuse').toBeInstanceOf(ToolUseError)
  expect((err as Error).message).toMatch(pattern)
}

function audit(slug = 'dev') {
  return listFullAccessAudit(slug, { limit: 200 })
}

/** Grant the workspace and switch Full access on (the admin's two clicks). */
function fullAccessOn(slug = 'dev', workspace = GROWTH, patch: Loose = {}) {
  grantBotWorkspace(slug, workspace, 'jordan')
  return setFullAccess(slug, workspace, { enabled: true, ...patch }, ADMIN_ACTOR, NOW)
}

let flowId = 0
let routineId = 0
let scriptRoutineId = 0
let wakeRoutineId = 0

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'jordan', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'alice', 'x', 'member')`).run(ALICE)
  // A workspace agent pool that does NOT list the bot: filing and owning cards has to pass it through the grant.
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general', 'cto'] })
  createWorkspace({ slug: OTHER, name: 'Other Co', default_agent_pool: ['general'] })
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, ?, 'member', 'own')`).run(ALICE, GROWTH)

  card('alice-card', GROWTH, ALICE)
  card('repo-card', GROWTH, ALICE, { project: 'growth-site' })
  card('other-card', OTHER, ADMIN, { project: 'other-repo' })

  for (const [rel, text] of [
    ['workspaces/growth/plan.md', 'growth plan: launch the pricing page'],
    ['workspaces/other-co/payroll.md', 'other-co payroll SECRET'],
    ['shared/handbook.md', 'handbook: how we launch things'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(TMP_KB, rel)), { recursive: true })
    fs.writeFileSync(path.join(TMP_KB, rel), text)
  }

  const saved = saveFlowVersion(db, {
    workspace: GROWTH,
    author: 'user:1',
    definition: {
      apiVersion: 'okflow/1',
      id: 'weekly-report',
      name: 'Weekly report',
      version: 1,
      goal: { statement: 'send the report', end_condition: { assert: [{ expr: 'steps.fetch.output != null' }] } },
      nodes: [
        { id: 'start', kind: 'trigger', on: 'manual', next: 'fetch' },
        { id: 'fetch', kind: 'tool', tool: 'rows-list', effect: 'read', input: {}, next: 'done' },
        { id: 'done', kind: 'end' },
      ],
    } as Loose,
  })
  if (!saved.ok) throw new Error(`fixture workflow did not save: ${JSON.stringify(saved)}`)
  flowId = (db.prepare('SELECT id FROM flow_definitions WHERE workspace = ? AND slug = ?').get(GROWTH, 'weekly-report') as { id: number }).id

  const routine = (name: string, tpl: Loose, extra = '') => Number(
    db.prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES (?, '0 9 * * 1', ?, 1)`).run(name, JSON.stringify(tpl)).lastInsertRowid,
  ) + (extra ? 0 : 0)
  routineId = routine('weekly-digest', { title: 'Weekly digest', description: 'Summarise the week', workspace: GROWTH, agent_context: 'general' })
  scriptRoutineId = routine('nightly-script', { title: 'Nightly script', workspace: GROWTH })
  db.prepare("UPDATE routines SET kind = 'script', script_command = 'echo hi' WHERE id = ?").run(scriptRoutineId)
  wakeRoutineId = routine('high-agency:dev', { title: 'Wake', workspace: GROWTH, agent_context: 'dev' })
  routine('other-digest', { title: 'Other digest', workspace: OTHER })
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_KB, { recursive: true, force: true })
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['secrets', 'agent_chat_cards', 'agent_chat_bot_access', 'agent_chat_bot_workspaces', 'agent_chat_bot_full_access', 'agent_chat_bot_full_access_audit', 'delegation_grants', 'delegation_audit']) {
    db.prepare(`DELETE FROM ${t}`).run()
  }
  db.prepare('DELETE FROM settings WHERE key = ?').run(SEED_MARKER)
  db.prepare("DELETE FROM settings WHERE key = 'secrets_broker_policy'").run()
  db.prepare(`DELETE FROM objectives WHERE title NOT IN (${SEEDED.map(() => '?').join(',')})`).run(...SEEDED)
  db.prepare("UPDATE objectives SET agent_context = 'general', owner_bot = NULL, assigned_user_id = created_by, pr_number = NULL, pr_url = NULL").run()
  db.prepare("UPDATE routines SET cron_expr = '0 9 * * 1', enabled = 1").run()
  hostCalls.length = 0
  const note = path.join(TMP_KB, 'workspaces/growth/notes.md')
  if (fs.existsSync(note)) fs.unlinkSync(note)
})

// ── the switch ──

describe('the switch', () => {
  it('is off by default, with every exclusion off', () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    const a = getFullAccess('dev', GROWTH, NOW)
    expect(a).toMatchObject({ enabled: false, state: 'off', expires_at: null })
    expect(a.allow).toEqual({ billing: false })
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(false)
    expect(listFullAccess('dev', NOW).map(x => x.workspace)).toEqual([GROWTH])
  })

  it('can only be switched on in a workspace the bot is explicitly granted', () => {
    // No grant at all (a bot added after access lists shipped).
    expect(() => setFullAccess('dev', GROWTH, { enabled: true }, ADMIN_ACTOR, NOW)).toThrow(FullAccessError)
    // A bot that predates access lists ("not restricted yet") has no list either.
    seedExistingBotsOnce(['legacy'])
    try { setFullAccess('legacy', GROWTH, { enabled: true }, ADMIN_ACTOR, NOW); throw new Error('expected a refusal') } catch (e) {
      expect(e).toBeInstanceOf(FullAccessError)
      expect((e as Loose).code).toBe('bot_not_restricted')
    }
    grantBotWorkspace('dev', GROWTH, 'jordan')
    try { setFullAccess('dev', OTHER, { enabled: true }, ADMIN_ACTOR, NOW); throw new Error('expected a refusal') } catch (e) {
      expect((e as Loose).code).toBe('workspace_not_granted')
    }
    expect(fullAccessActive('dev', OTHER, NOW)).toBe(false)
    expect(audit()).toHaveLength(0)
  })

  it('switches on with no expiry, and logs who, when, bot, workspace, on and expiry', () => {
    const r = fullAccessOn()
    expect(r.access).toMatchObject({ enabled: true, state: 'on', expires_at: null, updated_by: 'jordan' })
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(true)
    expect(allActiveFullAccess(NOW).get('dev')).toEqual([{ workspace: GROWTH, expires_at: null }])
    const rows = audit()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ event: 'enabled', slug: 'dev', workspace: GROWTH, actor: 'jordan', enabled: true, expires_at: null })
    expect(rows[0].created_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
  })

  it('takes an optional expiry, stops counting when it passes, and logs the expiry once', () => {
    fullAccessOn('dev', GROWTH, { expires_at: IN_A_WEEK })
    expect(getFullAccess('dev', GROWTH, NOW)).toMatchObject({ state: 'on', expires_at: '2026-11-22 12:00:00' })
    expect(audit()[0]).toMatchObject({ event: 'enabled', expires_at: '2026-11-22 12:00:00' })
    expect(fullAccessActive('dev', GROWTH, AFTER_EXPIRY)).toBe(false)
    expect(fullAccessActive('dev', GROWTH, AFTER_EXPIRY)).toBe(false)
    expect(getFullAccess('dev', GROWTH, AFTER_EXPIRY).state).toBe('expired')
    expect(allActiveFullAccess(AFTER_EXPIRY).has('dev')).toBe(false)
    expect(audit().filter(r => r.event === 'expired')).toHaveLength(1)
  })

  it('rejects an expiry in the past or more than a year ahead', () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    for (const bad of ['2020-01-01T00:00:00Z', 'not a date', new Date(NOW.getTime() + 400 * 86_400_000).toISOString()]) {
      expect(() => setFullAccess('dev', GROWTH, { enabled: true, expires_at: bad }, ADMIN_ACTOR, NOW)).toThrow(FullAccessError)
    }
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(false)
  })

  it('logs an expiry change and a switch-off', () => {
    fullAccessOn()
    setFullAccess('dev', GROWTH, { expires_at: IN_A_WEEK }, ADMIN_ACTOR, NOW)
    setFullAccess('dev', GROWTH, { expires_at: null }, ADMIN_ACTOR, NOW)
    setFullAccess('dev', GROWTH, { enabled: false }, ADMIN_ACTOR, NOW)
    expect(audit().map(r => r.event).reverse()).toEqual(['enabled', 'expiry_changed', 'expiry_changed', 'disabled'])
    expect(audit()[0]).toMatchObject({ event: 'disabled', actor: 'jordan', enabled: false, workspace: GROWTH })
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(false)
  })

  it('has one exclusion switch (billing): logged on change, and reset when Full access goes off', () => {
    fullAccessOn()
    const r = setFullAccess('dev', GROWTH, { allow: { billing: true } }, ADMIN_ACTOR, NOW)
    expect(r.access.allow).toEqual({ billing: true })
    expect(audit()[0]).toMatchObject({ event: 'exclusion_changed', exclusion: 'billing', actor: 'jordan' })
    expect(exclusionAllowed('dev', GROWTH, 'billing', NOW)).toBe(true)
    // Off and on again: billing is back to off.
    setFullAccess('dev', GROWTH, { enabled: false }, ADMIN_ACTOR, NOW)
    expect(exclusionAllowed('dev', GROWTH, 'billing', NOW)).toBe(false)
    const again = setFullAccess('dev', GROWTH, { enabled: true }, ADMIN_ACTOR, NOW)
    expect(again.access.allow.billing).toBe(false)
  })

  it('has NO switch for secret values, keys or DNS / Cloudflare Access: they cannot be turned on, by anyone', () => {
    expect([...FULL_ACCESS_SWITCHES]).toEqual(['billing'])
    expect([...FULL_ACCESS_PERMANENT_EXCLUSIONS]).toEqual(['secret_values', 'keys', 'dns_access'])
    fullAccessOn('dev', GROWTH, { allow: { billing: true } })
    for (const x of FULL_ACCESS_PERMANENT_EXCLUSIONS) {
      let err: Loose
      try { setFullAccess('dev', GROWTH, { allow: { [x]: true } }, ADMIN_ACTOR, NOW) } catch (e) { err = e }
      expect(err).toBeInstanceOf(FullAccessError)
      expect(err).toMatchObject({ status: 400, code: 'exclusion_permanent' })
      expect(err.message).toMatch(/has no switch/)
      expect(exclusionAllowed('dev', GROWTH, x, NOW)).toBe(false)
    }
    // Nothing was stored: the table has no column for them at all.
    const cols = (getDb().prepare("PRAGMA table_info('agent_chat_bot_full_access')").all() as Loose[]).map(c => c.name)
    expect(cols.filter(c => c.startsWith('allow_'))).toEqual(['allow_billing'])
    expect(getFullAccess('dev', GROWTH, NOW).allow).toEqual({ billing: true })
  })

  it('refuses the billing switch while Full access is off or expired, and an unknown switch', () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    expect(() => setFullAccess('dev', GROWTH, { allow: { billing: true } }, ADMIN_ACTOR, NOW)).toThrow(/Switch Full access on first/)
    fullAccessOn('dev', GROWTH, { expires_at: IN_A_WEEK })
    expect(() => setFullAccess('dev', GROWTH, { allow: { billing: true } }, ADMIN_ACTOR, AFTER_EXPIRY)).toThrow(/expired/)
    expect(() => setFullAccess('dev', GROWTH, { allow: { merge: true } }, ADMIN_ACTOR, NOW)).toThrow(/not a switch/)
    expect(() => setFullAccess('dev', GROWTH, { god: true }, ADMIN_ACTOR, NOW)).toThrow(/Unknown field/)
  })

  it('ends when the workspace is revoked, and says so in the log', () => {
    fullAccessOn('dev', GROWTH, { allow: { billing: true } })
    revokeBotWorkspace('dev', GROWTH, 'jordan')
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(false) // already, before the cleanup
    expect(dropFullAccessForRevokedWorkspaces('dev', 'jordan')).toEqual([GROWTH])
    expect(audit()[0]).toMatchObject({ event: 'workspace_revoked', workspace: GROWTH, actor: 'jordan', enabled: false })
    // Granting the workspace again does not bring Full access back.
    grantBotWorkspace('dev', GROWTH, 'jordan')
    expect(fullAccessActive('dev', GROWTH, NOW)).toBe(false)
    expect(getFullAccess('dev', GROWTH, NOW).allow.billing).toBe(false)
  })
})

// ── abilities ──

/** Every Full access ability, as one call the model could make. */
const ABILITIES: { name: string; run: (c: ReturnType<typeof ctx>) => Promise<Loose>; check?: (r: Loose) => void }[] = [
  { name: 'read any card in full', run: c => runChatTool(c, 'card_read', { id: ids['alice-card'] }), check: r => expect(r.result.description).toBe('brief of alice-card') },
  { name: 'take a card over', run: c => runChatTool(c, 'card_take_over', { id: ids['alice-card'], note: 'stuck' }), check: () => {
    const row = getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(ids['alice-card']) as Loose
    expect(row).toEqual({ agent_context: 'dev', owner_bot: 'Operation Kit Dev' })
  } },
  { name: 're-own a card', run: c => runChatTool(c, 'card_reown', { id: ids['alice-card'], agent: 'cto', assign_to: 'jordan' }), check: () => {
    const row = getDb().prepare('SELECT agent_context, assigned_user_id FROM objectives WHERE id = ?').get(ids['alice-card']) as Loose
    expect(row).toEqual({ agent_context: 'cto', assigned_user_id: ADMIN })
    expect(getDb().prepare('SELECT user_id FROM objective_assignees WHERE objective_id = ?').all(ids['alice-card'])).toEqual([{ user_id: ADMIN }])
  } },
  { name: 'comment on a card', run: c => runChatTool(c, 'card_comment', { id: ids['alice-card'], message: 'try the other branch' }), check: () => {
    expect(hostCalls).toHaveLength(1)
    expect(hostCalls[0]).toMatchObject({ kind: 'message', id: ids['alice-card'] })
    expect(hostCalls[0].text).toMatch(/From the bot Operation Kit Dev/)
    expect(hostCalls[0].text).toMatch(/not an approval of any merge, migration or deploy/)
  } },
  { name: 'restart a card', run: c => runChatTool(c, 'card_restart', { id: ids['alice-card'] }), check: () => expect(hostCalls).toEqual([{ kind: 'start', id: ids['alice-card'] }]) },
  { name: 'read the whole workspace knowledge base', run: c => runChatTool(c, 'read_file', { path: 'workspaces/growth/plan.md' }), check: r => expect(r.result.content).toMatch(/pricing page/) },
  { name: 'write the whole workspace knowledge base', run: c => runChatTool(c, 'write_doc', { path: 'workspaces/growth/notes.md', content: 'a note' }), check: () => {
    expect(fs.readFileSync(path.join(TMP_KB, 'workspaces/growth/notes.md'), 'utf8')).toBe('a note')
  } },
  { name: 'list workflows', run: c => runChatTool(c, 'workflow_list', {}), check: r => expect(r.result.workflows.map((w: Loose) => w.slug)).toEqual(['weekly-report']) },
  { name: 'read a workflow', run: c => runChatTool(c, 'workflow_read', { id: flowId }), check: r => expect(r.result.definition.nodes).toHaveLength(3) },
  { name: 'edit a workflow (a draft)', run: async c => {
    const def = (await runChatTool(c, 'workflow_read', { id: flowId })).result as Loose
    return runChatTool(c, 'workflow_save_draft', { id: flowId, definition: { ...def.definition, name: `Weekly report ${Date.now()}-${Math.random()}` } })
  }, check: r => {
    expect(r.result.status).toBe('draft')
    // A draft is never published by the bot.
    const f = getDb().prepare('SELECT published_version FROM flow_definitions WHERE id = ?').get(flowId) as Loose
    expect(f.published_version).toBeNull()
  } },
  { name: 'list scheduled tasks', run: c => runChatTool(c, 'routine_list', {}), check: r => {
    expect(r.result.scheduled_tasks.map((x: Loose) => x.name).sort()).toEqual(['high-agency:dev', 'nightly-script', 'weekly-digest'])
  } },
  { name: 'read a scheduled task', run: c => runChatTool(c, 'routine_read', { id: routineId }), check: r => expect(r.result.description).toBe('Summarise the week') },
  { name: 'edit a scheduled task', run: c => runChatTool(c, 'routine_update', { id: routineId, cron: '0 8 * * 2', enabled: false }), check: () => {
    expect(getDb().prepare('SELECT cron_expr, enabled FROM routines WHERE id = ?').get(routineId)).toEqual({ cron_expr: '0 8 * * 2', enabled: 0 })
  } },
  { name: 'read bot settings', run: c => runChatTool(c, 'bot_read', { slug: 'dev' }), check: r => expect(r.result).toMatchObject({ slug: 'dev', full_access_here: true }) },
  { name: 'list bots', run: c => runChatTool(c, 'bot_list', {}), check: r => expect(r.result.bots.map((b: Loose) => b.slug)).toContain('dev') },
  { name: 'read a bot\'s run history', run: c => runChatTool(c, 'bot_run_history', { slug: 'dev' }), check: r => expect(r.result).toMatchObject({ slug: 'dev', workspace: GROWTH }) },
  { name: 'get a repo checkout by filing a card session', run: c => runChatTool(c, 'repo_session_start', { project: 'growth-site', title: 'Fix the footer', description: 'Footer links 404' }), check: r => {
    const row = getDb().prepare('SELECT workspace, project, agent_context, owner_bot, origin FROM objectives WHERE id = ?').get(r.result.id) as Loose
    expect(row).toEqual({ workspace: GROWTH, project: 'growth-site', agent_context: 'dev', owner_bot: 'Operation Kit Dev', origin: 'agent_chat' })
    expect(hostCalls).toEqual([{ kind: 'start', id: r.result.id }])
  } },
  { name: 'start a repo session with a checkable done and stop conditions (obj 901496)', run: c => runChatTool(c, 'repo_session_start', { project: 'growth-site', title: 'Fix the header', description: 'Header overlaps the logo', done_when: 'One open PR, CI green.', stop_conditions: ['it needs a database migration', 'the fix is already merged'] }), check: r => {
    const row = getDb().prepare('SELECT description, completion_goal FROM objectives WHERE id = ?').get(r.result.id) as Loose
    expect(row.completion_goal).toBe('One open PR, CI green.')
    expect(row.description).toContain('Header overlaps the logo\n\n## Stop and report if\n- it needs a database migration\n- the fix is already merged\n\n— Repo session started from chat')
  } },
  { name: 'file and own a card past the workspace agent pool', run: c => runChatTool(c, 'create_objective', { title: 'Audit the funnel', description: 'find the leak' }), check: r => {
    const row = getDb().prepare('SELECT workspace, agent_context, owner_bot FROM objectives WHERE id = ?').get(r.result.id) as Loose
    expect(row).toEqual({ workspace: GROWTH, agent_context: 'dev', owner_bot: 'Operation Kit Dev' })
  } },
]

/** The same asks aimed at the OTHER workspace, where the bot has no grant at all. */
const OTHER_WORKSPACE: { name: string; run: (c: ReturnType<typeof ctx>) => Promise<Loose> }[] = [
  { name: 'read a card', run: c => runChatTool(c, 'card_read', { id: ids['other-card'] }) },
  { name: 'take a card over', run: c => runChatTool(c, 'card_take_over', { id: ids['other-card'] }) },
  { name: 're-own a card', run: c => runChatTool(c, 'card_reown', { id: ids['other-card'], agent: 'general' }) },
  { name: 'comment on a card', run: c => runChatTool(c, 'card_comment', { id: ids['other-card'], message: 'hi' }) },
  { name: 'restart a card', run: c => runChatTool(c, 'card_restart', { id: ids['other-card'] }) },
  { name: 'read its knowledge base', run: c => runChatTool(c, 'read_file', { path: 'workspaces/other-co/payroll.md' }) },
  { name: 'write its knowledge base', run: c => runChatTool(c, 'write_doc', { path: 'workspaces/other-co/x.md', content: 'x' }) },
  { name: 'list workflows', run: c => runChatTool(c, 'workflow_list', { workspace: OTHER }) },
  { name: 'list scheduled tasks', run: c => runChatTool(c, 'routine_list', { workspace: OTHER }) },
  { name: 'read a scheduled task', run: c => runChatTool(c, 'routine_read', { id: (getDb().prepare("SELECT id FROM routines WHERE name = 'other-digest'").get() as Loose).id }) },
  { name: 'list bots', run: c => runChatTool(c, 'bot_list', { workspace: OTHER }) },
  { name: 'start a repo session', run: c => runChatTool(c, 'repo_session_start', { project: 'other-repo', title: 't', description: 'd', workspace: OTHER }) },
  { name: 'file a card', run: c => runChatTool(c, 'create_objective', { title: 't', description: 'd', workspace: OTHER }) },
]

describe('abilities — allowed when Full access is on', () => {
  for (const a of ABILITIES) {
    it(a.name, async () => {
      fullAccessOn()
      const r = await a.run(ctx(ADMIN, bot()))
      a.check?.(r)
    })
  }

  it('offers the Full access tools (and the knowledge and board tools it implies) only while it is on', () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    const names = (specs: Loose[]) => specs.map(s => s.function.name)
    expect(names(toolSpecsForContext(ctx(ADMIN, bot())))).toEqual(names(toolSpecsFor(bot())))
    fullAccessOn()
    const on = names(toolSpecsForContext(ctx(ADMIN, bot())))
    for (const f of [...FULL_ACCESS_FNS, 'read_file', 'write_doc', 'create_objective', 'list_objectives']) expect(on).toContain(f)
    // Never the secrets tools, and never for a person who is not an admin.
    expect(on).not.toContain('secret_http')
    expect(names(toolSpecsForContext(ctx(ALICE, bot())))).toEqual(names(toolSpecsFor(bot())))
    expect(fullAccessPromptLine(ctx(ADMIN, bot()))).toMatch(/FULL ACCESS in growth/)
    expect(fullAccessPromptLine(ctx(ALICE, bot()))).toBe('')
  })

  it('logs each change a bot makes with Full access', async () => {
    fullAccessOn()
    await runChatTool(ctx(ADMIN, bot()), 'card_take_over', { id: ids['alice-card'] })
    await runChatTool(ctx(ADMIN, bot()), 'card_read', { id: ids['alice-card'] })
    const used = audit().filter(r => r.event === 'ability_used')
    expect(used).toHaveLength(1)
    expect(used[0]).toMatchObject({ ability: 'card_take_over', actor: 'bot:dev', workspace: GROWTH, objective_id: ids['alice-card'] })
  })
})

describe('abilities — refused when Full access is off', () => {
  for (const a of ABILITIES) {
    it(a.name, async () => {
      // The workspace is granted (ordinary access), Full access was never switched on.
      grantBotWorkspace('dev', GROWTH, 'jordan')
      await refused(() => a.run(ctx(ADMIN, bot())), /no Full access|not in a workspace where|not allowed for this agent|outside this agent's knowledge folders/)
      expect(hostCalls).toHaveLength(0)
    })
  }

})

describe('abilities — refused once Full access has expired', () => {
  for (const a of ABILITIES) {
    it(a.name, async () => {
      fullAccessOn('dev', GROWTH, { expires_at: IN_A_WEEK })
      await refused(() => a.run(ctx(ADMIN, bot(), GROWTH, AFTER_EXPIRY)), /no Full access|expired|not in a workspace where|not allowed for this agent|outside this agent's knowledge folders/)
      expect(hostCalls).toHaveLength(0)
    })
  }

  it('says it expired, and logs the refusal', async () => {
    fullAccessOn('dev', GROWTH, { expires_at: IN_A_WEEK })
    await refused(() => runChatTool(ctx(ADMIN, bot(), GROWTH, AFTER_EXPIRY), 'workflow_list', {}), /it expired/)
    expect(audit().some(r => r.event === 'ability_refused' && r.ability === 'workflow_list' && /expired/.test(r.detail ?? ''))).toBe(true)
  })
})

describe('abilities — refused in a workspace that was not granted', () => {
  for (const a of OTHER_WORKSPACE) {
    it(a.name, async () => {
      fullAccessOn() // Full access in growth only
      await refused(() => a.run(ctx(ADMIN, bot())), /no Full access in "other-co"|not in a workspace where|has no access to|outside this agent's knowledge folders|can't file cards in "other-co"/)
      expect(hostCalls).toHaveLength(0)
    })
  }

  it('only hands a card to a real agent or a bot that works in the workspace, or a person in it', async () => {
    fullAccessOn()
    const c = ctx(ADMIN, bot())
    await refused(() => runChatTool(c, 'card_reown', { id: ids['alice-card'], agent: 'nobody-here' }), /not an agent or bot that works in the growth workspace|not in workspace/)
    await refused(() => runChatTool(c, 'card_reown', { id: ids['alice-card'], assign_to: 'stranger' }), /is not a person in the growth workspace/)
    await refused(() => runChatTool(c, 'card_reown', { id: ids['alice-card'] }), /Name the new owner/)
    expect(getDb().prepare('SELECT agent_context FROM objectives WHERE id = ?').get(ids['alice-card'])).toEqual({ agent_context: 'general' })
  })

  it('leaves the other workspace untouched and logs the refusals', async () => {
    fullAccessOn()
    const before = getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(ids['other-card'])
    await refused(() => runChatTool(ctx(ADMIN, bot()), 'card_take_over', { id: ids['other-card'] }), /not in a workspace where/)
    expect(getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(ids['other-card'])).toEqual(before)
    expect(fs.existsSync(path.join(TMP_KB, 'workspaces/other-co/x.md'))).toBe(false)
    expect(audit().some(r => r.event === 'ability_refused' && r.ability === 'card_take_over')).toBe(true)
    // A missing card reads exactly like a card in a workspace out of reach.
    await refused(() => runChatTool(ctx(ADMIN, bot()), 'card_read', { id: 999_999 }), /Card #999999 is not in a workspace where/)
  })

  it('does not reach a repo of another workspace, or a repo the workspace has never used', async () => {
    fullAccessOn()
    await refused(() => runChatTool(ctx(ADMIN, bot()), 'repo_session_start', { project: 'other-repo', title: 't', description: 'd' }), /not a project of the growth workspace/)
    await refused(() => runChatTool(ctx(ADMIN, bot()), 'repo_session_start', { project: '../etc', title: 't', description: 'd' }), /not a project/)
    expect(hostCalls).toHaveLength(0)
  })
})

describe('abilities — only when the bot is working for an admin', () => {
  it('refuses a member, who keeps exactly what they could see before', async () => {
    fullAccessOn()
    expect(fullAccessWorkspaces(ctx(ALICE, bot()))).toEqual([])
    await refused(() => runChatTool(ctx(ALICE, bot()), 'card_take_over', { id: ids['alice-card'] }), /only when it is working for an admin/)
    await refused(() => runChatTool(ctx(ALICE, bot()), 'routine_update', { id: routineId, enabled: false }), /only when it is working for an admin/)
    await refused(() => runChatTool(ctx(ALICE, bot()), 'read_file', { path: 'workspaces/growth/plan.md' }), /not allowed for this agent/)
    expect(audit().filter(r => r.event === 'ability_refused')).toHaveLength(2)
  })

  it('in a bot-to-bot wake, only the conversation\'s workspace counts', async () => {
    fullAccessOn()
    const wake = { ...ctx(ADMIN, bot(), OTHER), botWake: { conversationId: 1, depth: 0 } }
    expect(fullAccessWorkspaces(wake)).toEqual([])
    await refused(() => runChatTool(wake, 'card_read', { id: ids['alice-card'] }), /not in a workspace where/)
  })
})

describe('a bot that shares its slug with a worker agent (obj 901026: a bot and an agent are the same thing)', () => {
  it('owns a card under that name once the workspace is explicitly granted — a genuine (non-default-roster) clash', async () => {
    // The real reported shape: an agents-table row that accidentally shares a
    // chat bot's slug (an admin working around the old refusal, or a stale
    // migration) — never one of the five protected default-roster personas.
    createAgent({ slug: 'ops-clash', label: 'Ops Clash (accidental persona row)' })
    fullAccessOn('ops-clash')
    const c = ctx(ADMIN, bot('ops-clash'))
    const took = await runChatTool(c, 'card_take_over', { id: ids['alice-card'] })
    expect((took.result as Loose).worker_agent).toBe('ops-clash')
    expect(getDb().prepare('SELECT agent_context, owner_bot FROM objectives WHERE id = ?').get(ids['alice-card'])).toEqual({ agent_context: 'ops-clash', owner_bot: 'Operation Kit Dev' })
    // A card session for this card now carries the bot's Full access (card is in growth, assigned to the admin).
    getDb().prepare('UPDATE objectives SET assigned_user_id = ? WHERE id = ?').run(ADMIN, ids['alice-card'])
    getDb().prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, 'ops-clash')").run(ids['alice-card'], ADMIN)
    expect(cardSessionFullAccess(ids['alice-card'], GROWTH, NOW)).toBe('ops-clash')
  })

  it('still refuses in a workspace the bot was never granted', async () => {
    // The pool gate itself still refuses an UNGRANTED workspace — the persona
    // clash check is gone for a non-default persona, but the underlying grant
    // requirement is not.
    expect(botOwnershipRefusal('ops-clash', OTHER)).toMatch(/not in workspace 'other-co' pool/)
    // Full access is off there too, so the chat tools refuse one layer up.
    const c = ctx(ADMIN, bot('ops-clash'), OTHER)
    await refused(() => runChatTool(c, 'card_take_over', { id: ids['other-card'] }), /not in a workspace where .* has Full access/)
    await refused(() => runChatTool(c, 'repo_session_start', { project: 'other-repo', title: 't', description: 'd' }), /has no Full access in/)
  })

  it('REGRESSION: a grant never hands Full access to an EXISTING admin-assigned card of a default-roster persona (review fix)', async () => {
    // GROWTH's pool already includes 'cto' — it is a genuine, always-assignable
    // persona on this card BEFORE this test, same as any install's CTO cards.
    // A bot that also happens to be called "cto" must not inherit this card
    // just because an admin grants it the workspace.
    fullAccessOn('cto')
    getDb().prepare("UPDATE objectives SET agent_context = 'cto', owner_bot = NULL, assigned_user_id = ? WHERE id = ?").run(ADMIN, ids['alice-card'])
    getDb().prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, 'cto')").run(ids['alice-card'], ADMIN)
    // The card's OWN session never carries the bot's Full access — the persona
    // keeps its identity regardless of the grant. (A direct chat with the bot
    // can still reach the card through its own Full access abilities, like any
    // other card in the workspace — that is unrelated to this question.)
    expect(cardSessionFullAccess(ids['alice-card'], GROWTH, NOW)).toBeNull()
  })
})

describe('scheduled tasks — what Full access never edits', () => {
  it('refuses a script command, a High Agency wake schedule, and a task of another workspace', async () => {
    fullAccessOn()
    const c = ctx(ADMIN, bot())
    await refused(() => runChatTool(c, 'routine_update', { id: scriptRoutineId, script_command: 'cat /etc/passwd' }), /cannot be changed from here/)
    await refused(() => runChatTool(c, 'routine_update', { id: wakeRoutineId, cron: '* * * * *' }), /High Agency wake schedule is set by an admin/)
    await refused(() => runChatTool(c, 'routine_update', { id: routineId, cron: 'every minute please' }), /cron|field|expression/i)
    expect(getDb().prepare('SELECT script_command FROM routines WHERE id = ?').get(scriptRoutineId)).toEqual({ script_command: 'echo hi' })
    expect(getDb().prepare('SELECT cron_expr FROM routines WHERE id = ?').get(wakeRoutineId)).toEqual({ cron_expr: '0 9 * * 1' })
    // Pausing a script task is fine: that is a schedule switch, not its command.
    await runChatTool(c, 'routine_update', { id: scriptRoutineId, enabled: false })
    expect(getDb().prepare('SELECT enabled FROM routines WHERE id = ?').get(scriptRoutineId)).toEqual({ enabled: 0 })
  })
})

// ── hard exclusions ──

/** One real path per exclusion, as the bot would call it. Every one of them uses a secret. */
const EXCLUDED: Record<Exclusion, (c: ReturnType<typeof ctx>) => Promise<Loose>> = {
  secret_values: c => runChatTool(c, 'secrets_list', {}),
  keys: c => runChatTool(c, 'secret_http', { method: 'POST', url: 'https://api.github.com/user/keys', headers: { Authorization: 'Bearer {{secret:GITHUB_PAT}}' }, body: '{}' }),
  dns_access: c => runChatTool(c, 'secret_http', { method: 'PATCH', url: 'https://api.cloudflare.com/client/v4/zones/z/dns_records/r', headers: { Authorization: 'Bearer {{secret:CF_TOKEN}}' } }),
  billing: c => runChatTool(c, 'secret_http', { method: 'POST', url: 'https://api.stripe.com/v1/refunds', headers: { Authorization: 'Bearer {{secret:PAYMENTS_KEY}}' } }),
}
const NEVER = /which a bot with Full access can never do in growth\. There is no switch for it\. This refusal was logged\./
const mcpCall = (connector: string, tool: string) =>
  exclusionGate({ slug: 'dev', botName: 'Dev', workspace: GROWTH, call: { what: `${tool} on ${connector}`, connector: { slug: connector, name: connector }, tool }, now: NOW })

describe('hard exclusions — secrets, keys and DNS are permanent; billing is one switch, off by default', () => {
  for (const x of FULL_ACCESS_EXCLUSIONS) {
    it(`${x}: refused and logged, even with Full access, the bot's own secrets tool, and billing switched on`, async () => {
      // Billing on changes nothing for the three permanent kinds; the billing path itself still uses a secret.
      fullAccessOn('dev', GROWTH, { allow: { billing: true } })
      const withSecrets = bot('dev', { tools: ['secrets'] })
      await refused(() => EXCLUDED[x](ctx(ADMIN, withSecrets)), NEVER)
      const rows = audit().filter(r => r.event === 'exclusion_refused')
      expect(rows.length).toBeGreaterThan(0)
      for (const r of rows) expect(r).toMatchObject({ workspace: GROWTH, actor: 'bot:dev' })
      expect(rows.map(r => r.exclusion)).toContain(x === 'billing' ? 'secret_values' : x)
      // A member chatting with the bot hits the same wall: it is the bot's, not the person's.
      await refused(() => EXCLUDED[x](ctx(ALICE, withSecrets)), NEVER)
    })
  }

  it('Full access never hands the bot the secrets tools, with billing on or off', async () => {
    fullAccessOn('dev', GROWTH, { allow: { billing: true } })
    const plain = ctx(ADMIN, bot()) // the bot's own file has no secrets tool
    const names = toolSpecsForContext(plain).map(s => s.function.name)
    expect(names).toContain('card_read')
    expect(names).not.toContain('secrets_list')
    expect(names).not.toContain('secret_http')
    await refused(() => runChatTool(plain, 'secrets_list', {}), NEVER)
    // A bot whose file DOES list secrets is not offered a way through either: every call is refused.
    await refused(() => runChatTool(ctx(ADMIN, bot('dev', { tools: ['secrets'] })), 'secret_http', { method: 'GET', url: 'https://api.example.com/v1/things', headers: { Authorization: 'Bearer {{secret:ANY_KEY}}' } }), NEVER)
  })

  it('a Full access bot never reaches a Shared secret, in any workspace, whatever its file lists', async () => {
    // Full access in growth; the bot is also granted other-co (no Full access there) and its file lists the secrets tool.
    fullAccessOn()
    grantBotWorkspace('dev', OTHER, 'jordan')
    const db = getDb()
    db.prepare("INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted) VALUES ('global', '', 0, 'SHARED_KEY', 'x')").run()
    db.prepare("INSERT INTO secrets (scope_type, workspace, user_id, key, value_encrypted) VALUES ('workspace', ?, 0, 'OTHER_KEY', 'x')").run(OTHER)
    const policy = { SHARED_KEY: { hosts: ['api.example.com'], workspaces: [OTHER] }, OTHER_KEY: { hosts: ['api.example.com'] } }
    db.prepare("INSERT INTO settings (key, value) VALUES ('secrets_broker_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(policy))
    expect(fullAccessAnywhere('dev', NOW)).toBe(true)
    const there = ctx(ADMIN, bot('dev', { tools: ['secrets'] }), OTHER)
    const listed = ((await runChatTool(there, 'secrets_list', {})).result as Loose).secrets.map((x: Loose) => x.name)
    expect(listed).toEqual(['OTHER_KEY']) // the Shared one is not even named
    await refused(
      () => runChatTool(there, 'secret_http', { method: 'GET', url: 'https://api.example.com/v1/things', headers: { Authorization: 'Bearer {{secret:SHARED_KEY}}' } }),
      /Shared secret SHARED_KEY.*can never do in other-co.*This refusal was logged/,
    )
    expect(audit().filter(r => r.event === 'exclusion_refused')[0]).toMatchObject({ exclusion: 'secret_values', workspace: OTHER, actor: 'bot:dev' })
    // Control: with Full access off everywhere, the same bot sees the Shared secret again (nothing else changed).
    setFullAccess('dev', GROWTH, { enabled: false }, ADMIN_ACTOR, NOW)
    expect(fullAccessAnywhere('dev', NOW)).toBe(false)
    expect(((await runChatTool(there, 'secrets_list', {})).result as Loose).secrets.map((x: Loose) => x.name).sort()).toEqual(['OTHER_KEY', 'SHARED_KEY'])
  })

  it('does not touch a bot that has no Full access', async () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    const withSecrets = ctx(ADMIN, bot('dev', { tools: ['secrets'] }))
    const r = await runChatTool(withSecrets, 'secrets_list', {})
    expect(r.summary).toMatch(/no values/)
    expect(exclusionGate({ slug: 'dev', workspace: GROWTH, call: { what: 'x', host: 'api.stripe.com', usesSecret: true }, now: NOW })).toBeNull()
    expect(audit()).toHaveLength(0)
  })

  it('gates a workspace connector (MCP) the same way: only billing can be switched on', () => {
    fullAccessOn()
    expect(mcpCall('cloudflare', 'list_zones')).toMatch(/"DNS and Cloudflare Access", which a bot with Full access can never do/)
    expect(mcpCall('github', 'create_deploy_key')).toMatch(/"Minting or revoking keys", which a bot with Full access can never do/)
    expect(mcpCall('doppler', 'get_secret')).toMatch(/"Secret values", which a bot with Full access can never do/)
    expect(mcpCall('stripe', 'create_refund')).toMatch(/"Billing", which Full access does not include/)
    expect(mcpCall('notion', 'search_pages')).toBeNull()
    setFullAccess('dev', GROWTH, { allow: { billing: true } }, ADMIN_ACTOR, NOW)
    expect(mcpCall('stripe', 'create_refund')).toBeNull() // the one switch
    expect(mcpCall('cloudflare', 'list_zones')).toMatch(/can never do/)
    expect(mcpCall('github', 'create_deploy_key')).toMatch(/can never do/)
    expect(mcpCall('doppler', 'get_secret')).toMatch(/can never do/)
    expect(audit().filter(r => r.event === 'exclusion_refused').map(r => r.exclusion).sort()).toEqual(['billing', 'dns_access', 'dns_access', 'keys', 'keys', 'secret_values', 'secret_values'])
  })

  it('a connector call is refused before it leaves, through the real MCP tool path', async () => {
    fullAccessOn()
    const db = getDb()
    const serverId = Number(db.prepare("INSERT INTO workspace_mcp_servers (workspace, slug, name, url, status) VALUES (?, 'dns', 'Cloudflare', 'https://mcp.cloudflare.com/sse', 'connected')").run(GROWTH).lastInsertRowid)
    const set = { specs: [], targets: new Map([['mcp__dns__records_update', { serverId, serverName: 'Cloudflare', tool: 'records_update' }]]) }
    await refused(() => runMcpTool(GROWTH, set, 'mcp__dns__records_update', {}, { slug: 'dev', botName: 'Operation Kit Dev', userId: ADMIN }), /"DNS and Cloudflare Access", which a bot with Full access can never do/)
    expect(audit().filter(r => r.event === 'exclusion_refused' && r.exclusion === 'dns_access')).toHaveLength(1)
    db.prepare('DELETE FROM workspace_mcp_servers WHERE id = ?').run(serverId)
  })

  it('classifies by what a call is aimed at', () => {
    const kinds = (c: Loose) => classifyOutbound({ what: 'x', ...c }).sort()
    expect(kinds({ host: 'api.cloudflare.com', path: '/client/v4/accounts/a/access/apps' })).toEqual(['dns_access'])
    expect(kinds({ host: 'api.godaddy.com', path: '/v1/domains/x/records', method: 'PUT' })).toEqual(['dns_access'])
    expect(kinds({ host: 'api.digitalocean.com', path: '/v2/domains/x/records' })).toEqual(['dns_access'])
    expect(kinds({ host: 'api.digitalocean.com', path: '/v2/droplets' })).toEqual([])
    expect(kinds({ host: 'api.stripe.com', path: '/v1/customers' })).toEqual(['billing'])
    expect(kinds({ host: 'api.example.com', path: '/v1/billing/usage' })).toEqual(['billing'])
    expect(kinds({ host: 'api.openai.com', path: '/v1/organization/api_keys', method: 'POST' })).toEqual(['keys'])
    expect(kinds({ host: 'api.openai.com', path: '/v1/organization/api_keys', method: 'GET' })).toEqual([])
    expect(kinds({ host: 'auth.example.com', path: '/oauth/token', method: 'POST' })).toEqual([])
    expect(kinds({ host: 'api.example.com', path: '/v1/things', secretNames: ['STRIPE_SECRET_KEY'] })).toEqual(['billing', 'secret_values'])
    expect(kinds({ host: 'api.example.com', path: '/v1/things', secretNames: ['CLOUDFLARE_API_TOKEN'] })).toEqual(['dns_access', 'secret_values'])
    expect(kinds({ host: 'api.example.com', path: '/v1/things' })).toEqual([])
  })
})

// ── release_status: what is merged but not live (obj 901389) ──

describe('release_status — read-only "merged, waiting for deploy" for a Full access bot talking to an admin', () => {
  const STATUS = {
    ok: true, repo: 'acme/app', checked_at: NOW.toISOString(), head: 'a'.repeat(40), origin_main: 'b'.repeat(40),
    checkout_at_origin_main: false, behind: 2, ahead: 0, dirty_served_files: [], migrations_waiting: 1,
    last_merge_at: '2026-11-15T11:00:00Z', server_started_at: '2026-11-15T10:00:00Z', server_started_after_last_merge: false, live: false,
    summary: '2 merged pull requests are waiting for a deploy (1 with a database migration).', note: 'Read-only.',
    waiting: [
      { sha: 'c'.repeat(40), short_sha: 'cccccccc', committed_at: '2026-11-15T11:00:00Z', pr_number: 102, pr_url: null, title: 'Add things table', card_id: 777, card_title: 'Things', merged_by: { kind: 'bot_grant', bot: 'Operation Kit Dev', grant_id: 4 }, merged_by_label: 'Operation Kit Dev (bot) under grant #4', migration: true, migration_paths: ['app/server/src/db/schema/things.ts'] },
      { sha: 'd'.repeat(40), short_sha: 'dddddddd', committed_at: '2026-11-15T10:30:00Z', pr_number: 101, pr_url: null, title: 'Show the thing', card_id: null, card_title: null, merged_by: { kind: 'person', login: 'operator' }, merged_by_label: 'operator', migration: false, migration_paths: [] },
    ],
  } as Loose
  let reads = 0
  const withReader = (c: ReturnType<typeof ctx>) => ({ ...c, deployStatusReader: () => { reads++; return STATUS } })
  beforeEach(() => { reads = 0 })

  it('returns the waiting list and both "merged is not deployed" checks, and writes nothing', async () => {
    fullAccessOn()
    const before = audit().length
    const r = await runChatTool(withReader(ctx(ADMIN, bot())), 'release_status', {})
    expect(reads).toBe(1)
    expect(r.result).toMatchObject({
      ok: true, live: false, checkout_at_origin_main: false, server_started_after_last_merge: false, migrations_waiting: 1,
      waiting_for_deploy: [
        { pr: 102, title: 'Add things table', card: 777, merged_by: 'Operation Kit Dev (bot) under grant #4', migration: true, migration_paths: ['app/server/src/db/schema/things.ts'] },
        { pr: 101, title: 'Show the thing', card: null, merged_by: 'operator', migration: false },
      ],
    })
    expect(r.summary).toMatch(/2 merged pull requests are waiting/)
    expect(audit().length).toBe(before) // a read, not a change: no ability_used row
    expect(hostCalls).toHaveLength(0) // nothing started, messaged, deployed or restarted
  })

  it('is refused for a member, even when the bot has Full access', async () => {
    fullAccessOn()
    await refused(() => runChatTool(withReader(ctx(ALICE, bot())), 'release_status', {}), /only when it is working for an admin/)
    expect(reads).toBe(0)
    expect(audit().some(r => r.event === 'ability_refused' && r.ability === 'release_status')).toBe(true)
  })

  it('is refused for a bot without Full access (workspace granted, switch off), and once it expires', async () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    await refused(() => runChatTool(withReader(ctx(ADMIN, bot())), 'release_status', {}), /no Full access/)
    fullAccessOn('dev', GROWTH, { expires_at: IN_A_WEEK })
    await refused(() => runChatTool(withReader(ctx(ADMIN, bot(), GROWTH, AFTER_EXPIRY)), 'release_status', {}), /it expired/)
    expect(reads).toBe(0)
  })

  it('is refused in a workspace where Full access is not on', async () => {
    fullAccessOn()
    await refused(() => runChatTool(withReader(ctx(ADMIN, bot())), 'release_status', { workspace: OTHER }), /no Full access in "other-co"/)
    expect(reads).toBe(0)
  })

  it('is offered only with Full access, and only to an admin', () => {
    grantBotWorkspace('dev', GROWTH, 'jordan')
    const names = (c: ReturnType<typeof ctx>) => toolSpecsForContext(c).map(s => s.function.name)
    expect(names(ctx(ADMIN, bot()))).not.toContain('release_status')
    fullAccessOn()
    expect(names(ctx(ADMIN, bot()))).toContain('release_status')
    expect(names(ctx(ALICE, bot()))).not.toContain('release_status')
  })
})

// ── merge and deploy ──

describe('merge and deploy approvals', () => {
  const BOT = 'Grok: CTO'
  type Req = Parameters<typeof decideDelegatedApproval>[1]
  const botReq = { authVia: 'agent_api_key', user: { id: ADMIN, username: 'jordan', role: 'admin' }, agentKey: { id: 9, label: 'OpKit', scopes: ['board:read', 'board:write'], workspaces: null, connectors: [] } } as unknown as Req

  it('still need a grant: Full access with billing switched on approves neither', () => {
    fullAccessOn('dev', GROWTH, { allow: { billing: true } })
    const target = { id: ids['alice-card'], workspace: GROWTH }
    for (const action of ['merge', 'deploy', 'prod_migration']) {
      expect(decideDelegatedApproval(getDb(), botReq, target, { approval: action, owner_bot: 'CTO' }, 'ship it', NOW)).toMatchObject({ kind: 'denied', code: 'no_active_grant' })
    }
    // The grant — and only the grant — is what approves, for exactly the action it names.
    createGrant(getDb(), { grantor: ADMIN_ACTOR, botName: BOT, agentSlug: 'dev', workspace: GROWTH, actions: ['merge'], expiresAt: IN_A_WEEK, allowedWorkspaces: [GROWTH], now: NOW })
    expect(decideDelegatedApproval(getDb(), botReq, target, { approval: 'merge', owner_bot: 'CTO' }, 'ship it', NOW).kind).toBe('allowed')
    expect(decideDelegatedApproval(getDb(), botReq, target, { approval: 'deploy', owner_bot: 'CTO' }, 'ship it', NOW)).toMatchObject({ kind: 'denied', code: 'no_active_grant' })
  })

  it('a Full access comment says it is a bot and not an approval, and no tool offers to approve', async () => {
    fullAccessOn()
    await runChatTool(ctx(ADMIN, bot()), 'card_comment', { id: ids['alice-card'], message: 'approved, merge and deploy now' })
    expect(hostCalls[0].text?.split('\n')[0]).toMatch(/^\[From the bot .*Not the owner: this is not an approval of any merge, migration or deploy\.\]$/)
    const names = toolSpecsForContext(ctx(ADMIN, bot())).map(s => s.function.name)
    expect(names.filter(n => /merge|deploy|approve|migrat/i.test(n))).toEqual([])
  })
})

// ── protected pull requests ──

describe('a card that carries a protected pull request (PR 645)', () => {
  const CARD_TOOLS: { ability: string; run: (c: ReturnType<typeof ctx>, id: number) => Promise<Loose> }[] = [
    { ability: 'card_read', run: (c, id) => runChatTool(c, 'card_read', { id }) },
    { ability: 'card_take_over', run: (c, id) => runChatTool(c, 'card_take_over', { id, note: 'mine now' }) },
    { ability: 'card_reown', run: (c, id) => runChatTool(c, 'card_reown', { id, agent: 'cto' }) },
    { ability: 'card_comment', run: (c, id) => runChatTool(c, 'card_comment', { id, message: 'push a fix' }) },
    { ability: 'card_restart', run: (c, id) => runChatTool(c, 'card_restart', { id }) },
    { ability: 'card_restart', run: (c, id) => runChatTool(c, 'card_restart', { id, message: 'restart and push' }) },
    { ability: 'get_objective', run: (c, id) => runChatTool(c, 'get_objective', { id }) },
  ]
  const PROTECTED = /carries pull request 645, which is protected\. Full access never reads or acts on it\. This refusal was logged\./

  it('the protected list contains 645', () => {
    expect(FULL_ACCESS_PROTECTED_PRS).toContain(645)
    expect(isProtectedCard({ pr_number: 645 })).toBe(645)
    expect(isProtectedCard({ pr_number: null, pr_url: 'https://github.com/acme/infra/pull/645' })).toBe(645)
    expect(isProtectedCard({ pr_number: 646, pr_url: 'https://github.com/acme/infra/pull/6451' })).toBeNull()
    expect(isProtectedCard({ pr_number: null, pr_url: null })).toBeNull()
  })

  for (const t of CARD_TOOLS) {
    it(`${t.ability}: refused and logged, and the card is left exactly as it was`, async () => {
      fullAccessOn()
      const id = ids['alice-card']
      getDb().prepare('UPDATE objectives SET pr_number = 645 WHERE id = ?').run(id)
      const before = getDb().prepare('SELECT agent_context, owner_bot, assigned_user_id, status FROM objectives WHERE id = ?').get(id)
      await refused(() => t.run(ctx(ADMIN, bot()), id), PROTECTED)
      expect(getDb().prepare('SELECT agent_context, owner_bot, assigned_user_id, status FROM objectives WHERE id = ?').get(id)).toEqual(before)
      expect(hostCalls).toEqual([]) // nothing was sent to the card, nothing was started
      const rows = audit().filter(r => r.event === 'protected_refused')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ ability: t.ability, objective_id: id, workspace: GROWTH, actor: 'bot:dev' })
      expect(audit().filter(r => r.event === 'ability_used')).toHaveLength(0)
    })
  }

  it('is recognised by its PR link alone, and a card with any other PR still works', async () => {
    fullAccessOn()
    const id = ids['alice-card']
    getDb().prepare("UPDATE objectives SET pr_number = NULL, pr_url = 'https://github.com/acme/infra/pull/645' WHERE id = ?").run(id)
    await refused(() => runChatTool(ctx(ADMIN, bot()), 'card_take_over', { id }), PROTECTED)
    getDb().prepare("UPDATE objectives SET pr_number = 646, pr_url = 'https://github.com/acme/infra/pull/646' WHERE id = ?").run(id)
    const r = await runChatTool(ctx(ADMIN, bot()), 'card_take_over', { id })
    expect((r.result as Loose).worker_agent).toBe('dev')
  })

  // obj 901461: ONE text check, ONE message, on both filing tools.
  const TEXT_REFUSED = /^Refused: card text may not name pull request 645, because it is protected, and this applies even to a mention like "do not touch PR 645"\. To file this card, take the number out of the title and description \(write "the protected pull request" if you must refer to it\) and send it again\. This refusal was logged\.$/
  const NAMING = ['Rebase PR 645 and push', 'see https://github.com/acme/infra/pull/645', 'finish #645', 'fix pull request #645']
  // A negated mention is refused too (the safe default; see protectedPrTextRefusal).
  const NEGATED = ['Do not touch PR 645.', 'Leave pull request #645 alone, it is protected']
  const FILERS: { ability: string; run: (c: ReturnType<typeof ctx>, title: string, description: string) => Promise<Loose> }[] = [
    { ability: 'repo_session_start', run: (c, title, description) => runChatTool(c, 'repo_session_start', { project: 'growth-site', title, description }) },
    { ability: 'create_objective', run: (c, title, description) => runChatTool(c, 'create_objective', { title, description }) },
  ]
  const count = () => (getDb().prepare('SELECT COUNT(*) AS n FROM objectives').get() as Loose).n

  for (const f of FILERS) {
    it(`${f.ability}: card text naming it is refused with the plain message, negated or not, and nothing is filed`, async () => {
      fullAccessOn()
      const before = count()
      for (const description of [...NAMING, ...NEGATED]) {
        await refused(() => f.run(ctx(ADMIN, bot()), 'Help out', description), TEXT_REFUSED)
      }
      await refused(() => f.run(ctx(ADMIN, bot()), 'Push to PR #645', 'd'), TEXT_REFUSED)
      expect(count()).toBe(before)
      expect(hostCalls).toEqual([])
      const rows = audit().filter(r => r.event === 'protected_refused' && r.ability === f.ability)
      expect(rows).toHaveLength(NAMING.length + NEGATED.length + 1)
      expect(rows[0]).toMatchObject({ workspace: GROWTH, actor: 'bot:dev', detail: 'card text names protected PR 645' })
    })

    it(`${f.ability}: the same card filed without the number goes through`, async () => {
      fullAccessOn()
      const before = count()
      const r = await f.run(ctx(ADMIN, bot()), 'Help out', 'Fix the footer. Do not touch the protected pull request.')
      expect(Number((r.result as Loose).id)).toBeGreaterThan(0)
      expect(count()).toBe(before + 1)
      expect(audit().filter(r => r.event === 'protected_refused')).toHaveLength(0)
    })
  }

  it('create_objective applies the same check to a bot WITHOUT Full access', async () => {
    const before = count()
    await refused(() => runChatTool(ctx(ADMIN, bot('dev', { tools: ['create_objective'] })), 'create_objective', { title: 'Help out', description: 'Do not touch PR 645' }), TEXT_REFUSED)
    expect(count()).toBe(before)
    expect(audit().filter(r => r.event === 'protected_refused' && r.ability === 'create_objective')).toHaveLength(1)
  })

  it('the text pattern does not catch other numbers that merely contain 645', () => {
    expect(protectedPrInText('bump timeout to 6450ms, see PR 6451 and #1645')).toBeNull()
    expect(protectedPrTextMessage(645)).toMatch(TEXT_REFUSED)
  })
})

// ── a card session (the High Agency wake path) ──

describe('a card worked by a Full access bot', () => {
  const newCard = (createdBy: number | null, assignee: number | null, extra: { parent?: number; routine?: number } = {}) =>
    Number(getDb().prepare(
      `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, parent_id, routine_id) VALUES ('wake', '', ?, 'working', 'task', 'general', ?, ?, 'dev', ?, ?)`,
    ).run(GROWTH, createdBy, assignee, extra.parent ?? null, extra.routine ?? null).lastInsertRowid)

  it('carries Full access only in its own workspace, only while it is on, and only when it runs for an admin', () => {
    fullAccessOn()
    const wake = newCard(ADMIN, ADMIN)
    expect(cardSessionFullAccess(wake, GROWTH, NOW)).toBe('dev')
    expect(cardSessionFullAccess(wake, OTHER, NOW)).toBeNull()
    expect(cardSessionFullAccess(ids['alice-card'], GROWTH, NOW)).toBeNull() // worked by 'general', not the bot
    getDb().prepare('UPDATE objectives SET assigned_user_id = ? WHERE id = ?').run(ALICE, wake)
    expect(cardSessionFullAccess(wake, GROWTH, NOW)).toBeNull()
    getDb().prepare('UPDATE objectives SET assigned_user_id = ? WHERE id = ?').run(ADMIN, wake)
    setFullAccess('dev', GROWTH, { enabled: false }, ADMIN_ACTOR, NOW)
    expect(cardSessionFullAccess(wake, GROWTH, NOW)).toBeNull()
  })

  it('a member-created card assigned to an admin carries NO Full access', () => {
    fullAccessOn()
    const made = newCard(ALICE, ADMIN) // a member files a card for the bot and assigns it to the admin
    expect(cardSessionFullAccess(made, GROWTH, NOW)).toBeNull()
    // Nor does a card with no recorded creator (the internal create route with no parent).
    expect(cardSessionFullAccess(newCard(null, ADMIN), GROWTH, NOW)).toBeNull()
    // Nor does a child that names an admin's card as its parent: created_by is inherited there, not proof.
    const adminCard = newCard(ADMIN, ADMIN)
    expect(cardSessionFullAccess(newCard(ADMIN, ADMIN, { parent: adminCard }), GROWTH, NOW)).toBeNull()
  })

  it('carries it for the three proven origins: the bot\'s own High Agency wake, a card filed from an admin\'s chat, an admin-created card', () => {
    fullAccessOn()
    const db = getDb()
    // 1. Its own wake: fired by the routine named high-agency:<slug>, whoever is recorded as creator.
    expect(cardSessionFullAccess(newCard(null, ADMIN, { routine: wakeRoutineId }), GROWTH, NOW)).toBe('dev')
    // Another routine, or another bot's wake routine, is not its wake.
    expect(cardSessionFullAccess(newCard(null, ADMIN, { routine: routineId }), GROWTH, NOW)).toBeNull()
    const otherWake = Number(db.prepare(`INSERT INTO routines (name, cron_expr, objective_template, enabled) VALUES ('high-agency:someone-else', '0 9 * * 1', '{}', 1)`).run().lastInsertRowid)
    expect(cardSessionFullAccess(newCard(null, ADMIN, { routine: otherWake }), GROWTH, NOW)).toBeNull()
    db.prepare('DELETE FROM routines WHERE id = ?').run(otherWake)
    // 2. Filed by the bot from an admin's chat.
    const filed = newCard(null, ADMIN)
    db.prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, 'dev')").run(filed, ADMIN)
    expect(cardSessionFullAccess(filed, GROWTH, NOW)).toBe('dev')
    // …from a member's chat, or by a different bot, it is not.
    const byMember = newCard(null, ADMIN)
    db.prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, 'dev')").run(byMember, ALICE)
    expect(cardSessionFullAccess(byMember, GROWTH, NOW)).toBeNull()
    const byOtherBot = newCard(null, ADMIN)
    db.prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (?, ?, 'helper')").run(byOtherBot, ADMIN)
    expect(cardSessionFullAccess(byOtherBot, GROWTH, NOW)).toBeNull()
    // 3. Created directly by an admin.
    expect(cardSessionFullAccess(newCard(ADMIN, ADMIN), GROWTH, NOW)).toBe('dev')
    // Every one of them still needs the admin assignee.
    expect(cardSessionFullAccess(newCard(null, ALICE, { routine: wakeRoutineId }), GROWTH, NOW)).toBeNull()
  })
})
