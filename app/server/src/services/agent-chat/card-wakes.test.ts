import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/*
 * needs_agent card wakes for Operation Kit chat bots — obj 901328.
 *
 * Real database, real enqueue tick (agent-webhooks.ts), real routing, real
 * engine loop and real tool gates; only the AI provider's HTTP call is stubbed
 * (every request body is captured), and the status / message host is a stub so
 * nothing leaves the process. Required cases:
 *
 *   1. ROUTING MATCH   a card whose owner_bot folds to an installed chat bot with
 *                      access to the card's workspace → a scoped own-card turn in
 *                      the bot's pinned "Card wakes" thread, not the main chat, and
 *                      no webhook delivery.
 *   2. WORKSPACE       the same bot, a card in a workspace it may not use → no wake
 *                      (the webhook path runs as before).
 *   3. DEDUPE          a second needs_agent for the same bot + card while the first
 *                      is queued, or within the window after it ran → no new turn.
 *   4. GROK FALLBACK   an owner_bot that is an external Grok bot (no chat bot here)
 *                      → the General webhook, exactly as today.
 *   +  OFF SWITCH      default on; per bot off (and the install kill switch) → no
 *                      in-product wake, the webhook path unchanged.
 */
process.env.JWT_SECRET = 'test-secret-card-wakes-xxxxxxxx'
process.env.SECRETS_MASTER_KEY = Buffer.alloc(32, 31).toString('base64')
const TMP_DB = path.join(os.tmpdir(), `cc-card-wakes-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-wakes-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-wakes-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../../db/index.js')
const wh = await import('../agent-webhooks.js')
const { findAgent, listMessages } = await import('./engine.js')
const { runChatTool, ToolUseError } = await import('./tools.js')
const { resolveConnectors } = await import('./connectors.js')
const { grantBotWorkspace } = await import('./bot-workspaces.js')
const { clearInstalledChatBotCache } = await import('../bots/card-owner.js')
const routing = await import('./card-wake-routing.js')
const { deliverCardWake, drainCardWakes } = await import('./card-wakes.js')

const OPERATOR = 1
const ENV = { ...process.env, ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any
type Seen = { body: Loose }

const textReply = (t: string) => ({ content: [{ type: 'text', text: t }] })
const toolCall = (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_use', id: `tu-${name}-${Math.random()}`, name, input }] })

function scripted(seen: Seen[], replies: unknown[]) {
  let i = 0
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    const r = replies[Math.min(i++, replies.length - 1)]
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

function writeBot(slug: string, name: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You are ${name}.\nknowledge_folders: []\ntools: [board, bot_messages]\nversion: 1.0.0\nauthor: Test\n`)
}

const hostCalls: Array<{ kind: string; id: number; arg: string }> = []
const stubHost = {
  async setStatus(id: number, status: string) { hostCalls.push({ kind: 'status', id, arg: status }); return { ok: true, status } },
  async messageCard(id: number, message: string) { hostCalls.push({ kind: 'message', id, arg: message }); return { ok: true } },
}

const rows = (sql: string, ...params: unknown[]) => getDb().prepare(sql).all(...params) as Loose[]
const one = (sql: string, ...params: unknown[]) => getDb().prepare(sql).get(...params) as Loose

let cosKey: number
let grokKey: number

/** A card filed in the browser (no agent key): the CoS-fallback path today. */
function card(opts: { ownerBot?: string | null; workspace?: string; status?: string; keyId?: number | null; agentContext?: string } = {}): number {
  const r = getDb()
    .prepare(
      `INSERT INTO objectives (title, description, agent_context, workspace, created_by, status, agent_key_id, owner_bot, origin)
       VALUES ('Fix the sitemap', 'desc', ?, ?, ?, ?, ?, ?, 'manual')`,
    )
    .run(opts.agentContext ?? 'general', opts.workspace ?? 'operationkit', OPERATOR, opts.status ?? 'working', opts.keyId ?? null, opts.ownerBot ?? null)
  return Number(r.lastInsertRowid)
}

const setStatus = (id: number, status: string) => getDb().prepare('UPDATE objectives SET status = ? WHERE id = ?').run(status, id)
const enqueue = () => wh.enqueueAgentWebhookEvents(getDb(), new Date())
const wakesFor = (id: number) => rows('SELECT * FROM bot_card_wakes WHERE objective_id = ? ORDER BY id', id)
const deliveriesFor = (id: number) => rows('SELECT key_id, event, payload FROM agent_webhook_deliveries WHERE objective_id = ? ORDER BY id', id)

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(OPERATOR)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('operationkit', 'Operation Kit'), ('your-org', 'Example Growth')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace) VALUES (?, 'operationkit'), (?, 'your-org')`).run(OPERATOR, OPERATOR)
  writeBot('example-cto', 'Example CTO')
  writeBot('example-seo', 'SEO/GEO')
  clearInstalledChatBotCache()
  // As on the live install: the registry's CTO identity (alias "Example CTO") answers
  // to the example-cto chat bot through the install-local slug map (obj 900430).
  db.prepare(`INSERT INTO settings (key, value) VALUES ('bot_agent_slugs', '{"CTO":["example-cto"]}')`).run()
  // Example CTO may work in operationkit only; SEO/GEO in both.
  grantBotWorkspace('example-cto', 'operationkit', 'test')
  grantBotWorkspace('example-seo', 'operationkit', 'test')
  grantBotWorkspace('example-seo', 'your-org', 'test')
  // Today's receivers: the General's needs_agent webhook (the keyless fallback)
  // and an external Grok bot's own webhook.
  const mk = (label: string) => {
    const k = db.prepare(`INSERT INTO agent_api_keys (user_id, label, key_hash, last4, scopes, workspaces) VALUES (?, ?, ?, '0000', '["board:write"]', NULL)`).run(OPERATOR, label, `hash-${label}`)
    const id = Number(k.lastInsertRowid)
    db.prepare(`INSERT INTO agent_key_webhooks (key_id, user_id, url, events, enabled) VALUES (?, ?, 'https://hook.example.com/cc', '["needs_agent"]', 1)`).run(id, OPERATOR)
    return id
  }
  cosKey = mk('Grok: General')
  grokKey = mk('Grok: Shared Connection')
})

afterAll(() => {
  try { getDb().close() } catch { /* noop */ }
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${TMP_DB}${suffix}`
    if (fs.existsSync(f)) fs.unlinkSync(f)
  }
})

beforeEach(() => {
  getDb().exec(
    `DELETE FROM agent_webhook_deliveries;
     DELETE FROM agent_webhook_card_need_state;
     DELETE FROM bot_card_wakes;
     DELETE FROM agent_chat_card_wakes;
     DELETE FROM agent_chat_messages;
     DELETE FROM agent_chat_threads;
     DELETE FROM settings WHERE key IN ('${wh.CURSOR_SETTING}', '${routing.CARD_WAKES_ENABLED_SETTING}');`,
  )
  hostCalls.length = 0
  enqueue() // anchor the cursor at head
})

describe('1. routing match — an owned card wakes its chat bot in the Card wakes lane', () => {
  it('owner_bot "Example CTO" folds to the example-cto chat bot: a wake is queued and NO webhook delivery is made', () => {
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    const w = wakesFor(id)
    expect(w).toHaveLength(1)
    expect(w[0]).toMatchObject({ slug: 'example-cto', workspace: 'operationkit', user_id: OPERATOR, status: 'pending', need_kind: 'review' })
    expect(deliveriesFor(id)).toHaveLength(0)
  })

  it('the same folding as the own-card gate: a slug, a different case, or agent_context with no owner_bot', () => {
    const a = card({ ownerBot: 'example-cto' })
    const b = card({ ownerBot: 'EXAMPLE CTO' })
    const c = card({ ownerBot: null, agentContext: 'example-cto' })
    for (const id of [a, b, c]) setStatus(id, 'review')
    enqueue()
    for (const id of [a, b, c]) expect(wakesFor(id).map(r => r.slug)).toEqual(['example-cto'])
  })

  it('a card an agent KEY filed is routed in-product too: its needs_agent no longer goes to the key', () => {
    const id = card({ ownerBot: 'Example CTO', keyId: grokKey })
    setStatus(id, 'review')
    enqueue()
    expect(wakesFor(id)).toHaveLength(1)
    expect(deliveriesFor(id)).toHaveLength(0)
  })

  it('runs ONE scoped turn in the pinned "Card wakes" thread — own-card tools only, nothing in the main chat', async () => {
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    const wakeId = wakesFor(id)[0].id
    const seen: Seen[] = []
    const outcome = await deliverCardWake(wakeId, {
      env: ENV,
      host: stubHost,
      deps: { fetch: scripted(seen, [toolCall('my_card_read', { id }), toolCall('my_card_message', { id, message: 'Ship the fix.' }), textReply('Steered the worker.')]) },
    })
    expect(outcome).toBe('done')

    // The lane: a pinned side thread named "Card wakes"; the main chat is untouched.
    const thread = one("SELECT * FROM agent_chat_threads WHERE user_id = ? AND agent_slug = 'example-cto'", OPERATOR)
    expect(thread).toMatchObject({ title: 'Card wakes', pinned: 1, archived: 0 })
    expect(listMessages(OPERATOR, 'example-cto')).toHaveLength(0) // main lane
    const lane = listMessages(OPERATOR, 'example-cto', { lane: { kind: 'thread', id: thread.id } })
    expect(lane.map(m => m.tool_name ?? m.role)).toEqual(['card_wake', 'my_card_read', 'my_card_message', 'assistant'])
    expect(lane[3].content).toBe('Steered the worker.')
    expect(one('SELECT status, thread_id, reply_message_id FROM bot_card_wakes WHERE id = ?', wakeId)).toEqual({ status: 'done', thread_id: thread.id, reply_message_id: lane[3].id })

    // The model saw ONLY the own-card tools, and the card-wake rules.
    const toolNames = seen[0].body.tools.map((t: Loose) => t.name).sort()
    expect(toolNames).toEqual(['my_card_message', 'my_card_read', 'my_card_set_status', 'my_cards', 'my_supervisor_flags'])
    expect(seen[0].body.system).toContain('This turn is a CARD WAKE')
    expect(JSON.stringify(seen[0].body.messages)).toContain(`Card #${id} needs you`)
    // The message really went to the card, named as the bot.
    expect(hostCalls).toEqual([{ kind: 'message', id, arg: expect.stringContaining('[From the bot Example CTO (@example-cto)') }])
  })

  it('the scope is the own-card gate: another bot\'s card, another workspace and every non-wake tool are refused', async () => {
    const mine = card({ ownerBot: 'Example CTO' })
    const theirs = card({ ownerBot: 'SEO/GEO' })
    const elsewhere = card({ ownerBot: 'Example CTO', workspace: 'your-org' })
    const ctx: Loose = {
      userId: OPERATOR, username: 'operator', workspace: 'operationkit', agent: findAgent('example-cto', ENV)!, kbRoot: TMP_KB,
      connectors: resolveConnectors({ demo: false }), cardWake: { wakeId: 1, objectiveId: mine, workspace: 'operationkit', host: stubHost },
    }
    const refused = async (fn: string, args: Record<string, unknown>) => {
      try { await runChatTool(ctx, fn, args) } catch (err) { expect(err).toBeInstanceOf(ToolUseError); return (err as Error).message }
      throw new Error(`${fn} was not refused`)
    }
    expect((await runChatTool(ctx, 'my_card_read', { id: mine })).result).toMatchObject({ id: mine })
    expect(await refused('my_card_read', { id: theirs })).toContain('not your card')
    expect(await refused('my_card_set_status', { id: elsewhere, status: 'working' })).toContain('not in the operationkit workspace')
    expect(await refused('list_objectives', {})).toContain('not available in a card wake')
    expect(await refused('card_comment', { id: theirs, message: 'x' })).toContain('not available in a card wake')
    expect(await refused('my_card_set_status', { id: mine, status: 'queue' })).toContain('status must be one of')
    const listed = (await runChatTool(ctx, 'my_cards', {})).result as Loose
    expect(listed.cards.map((c: Loose) => c.id)).toContain(mine)
    expect(listed.cards.map((c: Loose) => c.id)).not.toContain(theirs)
    expect(listed.cards.map((c: Loose) => c.id)).not.toContain(elsewhere)
    expect(hostCalls).toHaveLength(0)
  })
})

describe('2. workspace mismatch — no wake', () => {
  it('Example CTO owns a card in your-org, a workspace it is not granted: no wake, the webhook path runs as before', () => {
    const id = card({ ownerBot: 'Example CTO', workspace: 'your-org' })
    setStatus(id, 'review')
    enqueue()
    expect(wakesFor(id)).toHaveLength(0)
    expect(routing.resolveCardWakeRoute({ id, owner_bot: 'Example CTO', workspace: 'your-org' })).toEqual({ ok: false, reason: 'workspace_denied' })
    const d = deliveriesFor(id)
    expect(d).toHaveLength(1)
    expect(d[0].key_id).toBe(cosKey)
  })

  it('a revoke between queueing and running stops the wake (re-checked at run time)', async () => {
    const id = card({ ownerBot: 'SEO/GEO', workspace: 'your-org' })
    setStatus(id, 'review')
    enqueue()
    const w = wakesFor(id)
    expect(w).toHaveLength(1)
    const { revokeBotWorkspace } = await import('./bot-workspaces.js')
    revokeBotWorkspace('example-seo', 'your-org', 'test')
    try {
      const seen: Seen[] = []
      expect(await deliverCardWake(w[0].id, { env: ENV, host: stubHost, deps: { fetch: scripted(seen, [textReply('x')]) } })).toBe('skipped')
      expect(seen).toHaveLength(0)
      expect(one('SELECT status, skip_reason FROM bot_card_wakes WHERE id = ?', w[0].id)).toEqual({ status: 'skipped', skip_reason: 'no longer routed to this bot: workspace_denied' })
    } finally {
      grantBotWorkspace('example-seo', 'your-org', 'test')
    }
  })
})

describe('3. dedupe and rate limit — a burst never stacks turns', () => {
  it('a second need while the first wake is still queued is coalesced into it', () => {
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    setStatus(id, 'working') // leaves the need → re-arms the ladder
    enqueue()
    setStatus(id, 'review')
    enqueue()
    const w = wakesFor(id)
    expect(w.map(r => r.status)).toEqual(['pending', 'skipped'])
    expect(w[1].skip_reason).toMatch(/^coalesced: wake #\d+/)
  })

  it('a second need within the window after the wake RAN is rate-limited: still one turn', async () => {
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    const seen: Seen[] = []
    const f = scripted(seen, [textReply('Looked at it.')])
    expect(await drainCardWakes({ env: ENV, host: stubHost, deps: { fetch: f } })).toBe(1)
    setStatus(id, 'working')
    enqueue()
    setStatus(id, 'review')
    enqueue()
    expect(await drainCardWakes({ env: ENV, host: stubHost, deps: { fetch: f } })).toBe(0)
    const w = wakesFor(id)
    expect(w.map(r => r.status)).toEqual(['done', 'skipped'])
    expect(w[1].skip_reason).toMatch(/^rate_limited:/)
    expect(seen).toHaveLength(1) // one model call: one turn
  })

  it('a replayed event id never queues twice, and the per-bot hourly cap holds', () => {
    const input = { event_id: 'cc_wake_test_1', slug: 'example-cto', objective_id: 999001, workspace: 'operationkit', user_id: OPERATOR, source_event_id: null, need_kind: 'review', need_why: 'x' }
    expect(routing.enqueueCardWake(getDb(), input)?.status).toBe('pending')
    expect(routing.enqueueCardWake(getDb(), input)).toBeNull()
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(routing.CARD_WAKE_HOURLY_CAP_SETTING)
    try {
      const r = routing.enqueueCardWake(getDb(), { ...input, event_id: 'cc_wake_test_2', objective_id: 999002 })
      expect(r?.status).toBe('skipped')
      expect(r?.skip_reason).toMatch(/^bot_hourly_cap:/)
    } finally {
      getDb().prepare('DELETE FROM settings WHERE key = ?').run(routing.CARD_WAKE_HOURLY_CAP_SETTING)
    }
  })
})

describe('4. Grok-external fallback — the webhook path is unchanged', () => {
  it('an owner_bot that is an external Grok bot (no chat bot here) goes to the General webhook', () => {
    const ext = card({ ownerBot: 'Buy-Side Client Success' })
    const unowned = card({ ownerBot: null })
    for (const id of [ext, unowned]) setStatus(id, 'review')
    enqueue()
    for (const id of [ext, unowned]) {
      expect(wakesFor(id)).toHaveLength(0)
      const d = deliveriesFor(id)
      expect(d).toHaveLength(1)
      expect(d[0].key_id).toBe(cosKey)
      expect(d[0].event).toBe('needs_agent')
    }
    expect(JSON.parse(deliveriesFor(ext)[0].payload).owner_bot).toBe('Buy-Side Client Success')
  })

  it('same folding as the own-card gate: with no install slug map, "Example CTO" is the Grok CTO (no chat slug) and stays on the webhook', async () => {
    const { botMayActOnOwnCard } = await import('../../lib/high-agency-wake-scope.js')
    const saved = one("SELECT value FROM settings WHERE key = 'bot_agent_slugs'").value
    getDb().prepare("DELETE FROM settings WHERE key = 'bot_agent_slugs'").run()
    try {
      const id = card({ ownerBot: 'Example CTO' })
      // The 860 gate would not let example-cto act on it either: routing and scope agree.
      expect(botMayActOnOwnCard({ slug: 'example-cto', workspace: 'operationkit' }, id, getDb())).toEqual({ ok: false, reason: 'not_owned' })
      setStatus(id, 'review')
      enqueue()
      expect(wakesFor(id)).toHaveLength(0)
      expect(deliveriesFor(id).map(d => d.key_id)).toEqual([cosKey])
    } finally {
      getDb().prepare("INSERT INTO settings (key, value) VALUES ('bot_agent_slugs', ?)").run(saved)
    }
  })

  it('a registry bot with no chat bot installed here ("General") keeps its webhook route', () => {
    const id = card({ ownerBot: 'General' })
    setStatus(id, 'review')
    enqueue()
    expect(wakesFor(id)).toHaveLength(0)
    expect(deliveriesFor(id).map(d => d.key_id)).toEqual([cosKey])
  })
})

describe('off switch — default on, per bot and install-wide', () => {
  it('defaults to on with no row and no setting', () => {
    expect(routing.getCardWakeSwitch('example-cto')).toMatchObject({ enabled: true, is_default: true })
    expect(routing.cardWakesGloballyEnabled()).toBe(true)
  })

  it('a bot switched off gets no wake; its card goes down the webhook path exactly as an external bot\'s would', () => {
    routing.setCardWakeSwitch('example-cto', false, OPERATOR)
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    expect(wakesFor(id)).toHaveLength(0)
    expect(deliveriesFor(id).map(d => d.key_id)).toEqual([cosKey])
    // Other bots are unaffected.
    const seo = card({ ownerBot: 'SEO/GEO' })
    setStatus(seo, 'review')
    enqueue()
    expect(wakesFor(seo)).toHaveLength(1)
  })

  it('the install kill switch turns the whole in-product path off', () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES (?, '0')").run(routing.CARD_WAKES_ENABLED_SETTING)
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    expect(wakesFor(id)).toHaveLength(0)
    expect(deliveriesFor(id).map(d => d.key_id)).toEqual([cosKey])
  })

  it('a queued wake whose bot is switched off before it runs is skipped, not run', async () => {
    const id = card({ ownerBot: 'Example CTO' })
    setStatus(id, 'review')
    enqueue()
    routing.setCardWakeSwitch('example-cto', false, OPERATOR)
    const seen: Seen[] = []
    expect(await deliverCardWake(wakesFor(id)[0].id, { env: ENV, host: stubHost, deps: { fetch: scripted(seen, [textReply('x')]) } })).toBe('skipped')
    expect(seen).toHaveLength(0)
  })
})
