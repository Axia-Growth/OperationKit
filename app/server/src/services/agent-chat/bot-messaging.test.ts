import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/*
 * Bot-to-bot messaging — obj 900859.
 *
 * Asserted against the REAL engine, the real tool gates and the real database;
 * only the AI provider's HTTP call is stubbed (and every request body it gets is
 * captured, so "the recipient was woken with the message" is checked on what
 * actually left the process). Four properties:
 *
 *   SEND     a bot's chat turn calls message_bot → a conversation in ONE
 *            workspace + a pending outbox row that remembers the chat lane.
 *   WAKE     the drain wakes the recipient with the message, stores its answer as
 *            the REPLY on the same thread, and posts it back into the sender's lane.
 *   REPLY    follow-ups (either side) stay on the same conversation, and each
 *            wake sees the whole thread.
 *   AUTHZ    nothing crosses a workspace: recipient / sender / person must all be
 *            in it; reads outside scope are "not found"; a revoke between send
 *            and wake stops the wake; chains are depth-capped.
 */
process.env.JWT_SECRET = 'test-secret-bot-messaging-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-bot-messaging-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-messaging-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-bot-messaging-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, runTurn } = await import('./engine.js')
const { runChatTool, ToolUseError } = await import('./tools.js')
const { resolveConnectors } = await import('./connectors.js')
const { createThread } = await import('./threads.js')
const { grantBotWorkspace, revokeBotWorkspace } = await import('./bot-workspaces.js')
const { resetRateLimits } = await import('../file-access.js')
const bm = await import('./bot-messaging.js')
const { drainBotMessages, deliverBotMessage, MAX_DELIVERY_ATTEMPTS } = await import('./bot-wake.js')

const ADMIN = 1
const ALICE = 2 // member of ops + sales
const BOB = 3 // member of finance only
const ENV = { ...process.env, ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any
type Seen = { body: Loose }

const textReply = (t: string) => ({ content: [{ type: 'text', text: t }] })
const toolCall = (name: string, input: Record<string, unknown>) => ({ content: [{ type: 'tool_use', id: `tu-${name}-${Math.random()}`, name, input }] })

/** Answers each provider call with the next scripted reply, recording every request body. */
function scripted(seen: Seen[], replies: unknown[], status = 200) {
  let i = 0
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    const r = replies[Math.min(i++, replies.length - 1)]
    return new Response(JSON.stringify(r), { status, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}

/** Every provider call refused with a 500 — a provider error, retried by the outbox. */
function failingFetch(seen: Seen[]) {
  return scripted(seen, [{ error: { message: 'upstream exploded' } }], 500)
}

function writeBot(slug: string, name: string, tools: string) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: You are ${name}.\nknowledge_folders: []\ntools: ${tools}\nversion: 1.0.0\nauthor: Test\n`)
}

const agent = (slug: string) => ({ ...findAgent(slug, ENV)!, provider: 'anthropic' as const })

function ctxFor(slug: string, userId: number, workspace: string, extra: Loose = {}) {
  return {
    userId,
    username: `user${userId}`,
    workspace,
    agent: agent(slug),
    kbRoot: TMP_KB,
    connectors: resolveConnectors({ demo: false }),
    ...extra,
  }
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(ToolUseError)
    return (err as Error).message
  }
  throw new Error('expected the tool to refuse')
}

const rows = (sql: string, ...params: unknown[]) => getDb().prepare(sql).all(...params) as Loose[]
const one = (sql: string, ...params: unknown[]) => getDb().prepare(sql).get(...params) as Loose
const count = (table: string) => (one(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number }).n

/** The system prompt + every message the provider was handed, as one string. */
const sent = (s: Seen) => JSON.stringify({ system: s.body.system, messages: s.body.messages })

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user1', 'x', 'admin')`).run(ADMIN)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(ALICE)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(BOB)
  db.prepare(`INSERT OR IGNORE INTO workspaces (slug, name) VALUES ('ops', 'Ops'), ('sales', 'Sales'), ('finance', 'Finance')`).run()
  db.prepare(`INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ops', 'member', 'all'), (?, 'sales', 'member', 'all'), (?, 'finance', 'member', 'all')`).run(ALICE, ALICE, BOB)
  writeBot('alpha', 'Alpha', '[bot_messages]')
  writeBot('beta', 'Beta', '[bot_messages]')
  writeBot('gamma', 'Gamma', '[bot_messages]')
  writeBot('delta', 'Delta', '[bot_messages]')
  writeBot('plain', 'Plain', '[]')
})

beforeEach(() => {
  const db = getDb()
  for (const t of ['bot_messages', 'bot_conversations', 'agent_chat_messages', 'agent_chat_threads', 'agent_chat_bot_workspaces', 'agent_chat_bot_access']) db.prepare(`DELETE FROM ${t}`).run()
  db.prepare("DELETE FROM settings WHERE key LIKE 'bot_messaging_%'").run()
  db.prepare('DELETE FROM activity_log').run()
  resetRateLimits()
  // alpha: ops + sales · beta: ops · gamma: finance · delta: sales · plain: ops
  for (const [slug, ws] of [['alpha', 'ops'], ['alpha', 'sales'], ['beta', 'ops'], ['gamma', 'finance'], ['delta', 'sales'], ['plain', 'ops']]) grantBotWorkspace(slug, ws, 'test')
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

/** Alpha (acting for Alice) messages Beta in ops through the tool, as a chat turn would. */
function alphaToBeta(text = 'Can you check the ops runbook?', extra: Loose = {}) {
  return runChatTool(ctxFor('alpha', ALICE, 'ops', extra), 'message_bot', { to: 'beta', text, workspace: 'ops' })
}

// ── send ──

describe('send: a bot messages another bot from a chat turn', () => {
  it('a chat turn that calls message_bot opens a conversation and queues one pending message', async () => {
    const seen: Seen[] = []
    const { messages } = await runTurn({
      userId: ALICE,
      username: 'user2',
      agent: agent('alpha'),
      text: 'Ask Beta about the ops runbook',
      env: ENV,
      deps: { fetch: scripted(seen, [toolCall('message_bot', { to: 'beta', text: 'What does the ops runbook say about deploys?', workspace: 'ops' }), textReply('I asked Beta.')]) },
    })
    // The model was offered the tool, and the tool line points at the thread.
    expect(seen[0].body.tools.map((t: Loose) => t.name)).toEqual(expect.arrayContaining(['message_bot', 'list_bot_conversations', 'read_bot_conversation']))
    const tool = messages.find(m => m.role === 'tool')!
    expect(tool.meta?.ok).toBe(true)
    expect(tool.content).toContain('Messaged Beta in ops')
    const conversationId = tool.meta?.bot_conversation_id as number
    expect(conversationId).toBeGreaterThan(0)

    const c = one('SELECT * FROM bot_conversations WHERE id = ?', conversationId)
    expect(c).toMatchObject({ workspace: 'ops', initiator_slug: 'alpha', recipient_slug: 'beta', started_by_user_id: ALICE, message_count: 1 })
    const m = one('SELECT * FROM bot_messages WHERE conversation_id = ?', conversationId)
    expect(m).toMatchObject({ kind: 'message', from_slug: 'alpha', to_slug: 'beta', status: 'pending', depth: 0, sent_by_user_id: ALICE, origin_user_id: ALICE, origin_agent_slug: 'alpha', origin_thread_id: null, workspace: 'ops' })
    expect(m.body).toBe('What does the ops runbook say about deploys?')
    // Audit: one feed line for the send.
    expect(rows("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = 'bot_message_sent'")).toHaveLength(1)
  })

  it('addresses by display name as well as slug', async () => {
    const r = await runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { to: 'BETA', text: 'hi' })
    expect((r.result as Loose).to.slug).toBe('beta')
  })

  it('refuses a bot that does not list the bot_messages tool', async () => {
    expect(await refusal(runChatTool(ctxFor('plain', ALICE, 'ops'), 'message_bot', { to: 'beta', text: 'hi' }))).toMatch(/not allowed/)
    expect(count('bot_messages')).toBe(0)
  })

  it('refuses itself, an unknown bot and an empty message', async () => {
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { to: 'alpha', text: 'hi' }))).toMatch(/cannot message itself/)
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { to: 'nobody', text: 'hi' }))).toMatch(/No bot "nobody"/)
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { to: 'beta', text: '  ' }))).toMatch(/text is required/)
    expect(count('bot_messages')).toBe(0)
    expect(count('bot_conversations')).toBe(0)
  })

  it('the kill switch refuses every send', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('bot_messaging_enabled', '0')").run()
    expect(await refusal(alphaToBeta())).toMatch(/switched off/)
    expect(count('bot_messages')).toBe(0)
  })

  it('rate-limits one sending bot', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('bot_messaging_rate_per_minute', '1')").run()
    await alphaToBeta('one')
    expect(await refusal(alphaToBeta('two'))).toMatch(/Too many bot messages/)
    expect(count('bot_messages')).toBe(1)
  })
})

// ── wake ──

describe('wakeup: the recipient is woken with the message and its answer is the reply', () => {
  it('drains the outbox: wakes Beta, stores the reply on the thread, posts it into Alice’s chat with Alpha', async () => {
    const sentR = await alphaToBeta('What does the ops runbook say about deploys?')
    const conversationId = sentR.bot_conversation_id!
    const seen: Seen[] = []
    const r = await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('Deploys go out on Tuesdays.')]) } })
    expect(r).toMatchObject({ delivered: 1, retried: 0, failed: 0 })

    // Beta was woken WITH the message, told who sent it and that its answer is the reply.
    expect(seen).toHaveLength(1)
    expect(sent(seen[0])).toContain('What does the ops runbook say about deploys?')
    expect(sent(seen[0])).toContain('BOT-TO-BOT MESSAGE')
    expect(sent(seen[0])).toContain('Alpha (@alpha)')
    expect(sent(seen[0])).toContain(`Bot conversation #${conversationId}`)
    expect(seen[0].body.system).toContain('You are Beta.')

    const entries = rows('SELECT * FROM bot_messages WHERE conversation_id = ? ORDER BY id', conversationId)
    expect(entries.map((e: Loose) => [e.kind, e.from_slug, e.status])).toEqual([
      ['message', 'alpha', 'delivered'],
      ['reply', 'beta', 'none'],
    ])
    expect(entries[1]).toMatchObject({ body: 'Deploys go out on Tuesdays.', in_reply_to: entries[0].id, to_slug: 'alpha', workspace: 'ops' })
    expect(entries[0].delivered_at).toBeTruthy()

    // The reply lands where Alice asked: her MAIN conversation with Alpha.
    const lane = listMessages(ALICE, 'alpha')
    const notice = lane.at(-1)!
    expect(notice.role).toBe('assistant')
    expect(notice.content).toContain('**Beta** replied')
    expect(notice.content).toContain('Deploys go out on Tuesdays.')
    expect(notice.meta).toMatchObject({ kind: 'bot_reply', bot_conversation_id: conversationId })
    // ...and nowhere else: Beta's own chat with Alice is untouched.
    expect(listMessages(ALICE, 'beta')).toHaveLength(0)
    expect(rows("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = 'bot_message_delivered'")).toHaveLength(1)
  })

  it('a reply never wakes anybody: one message = one wake', async () => {
    await alphaToBeta()
    const seen: Seen[] = []
    const f = scripted(seen, [textReply('done')])
    await drainBotMessages({ env: ENV, deps: { fetch: f } })
    await drainBotMessages({ env: ENV, deps: { fetch: f } })
    expect(seen).toHaveLength(1)
  })

  it('a reply to a message sent from a SIDE THREAD goes back to that side thread, not the main conversation', async () => {
    const t = createThread(ALICE, 'alpha', 'Runbook lane')
    await alphaToBeta('from the side thread', { lane: { kind: 'thread', id: t.id } })
    expect(one('SELECT origin_thread_id FROM bot_messages').origin_thread_id).toBe(t.id)
    await drainBotMessages({ env: ENV, deps: { fetch: scripted([], [textReply('side answer')]) } })
    expect(listMessages(ALICE, 'alpha', { lane: { kind: 'thread', id: t.id } }).at(-1)!.content).toContain('side answer')
    expect(listMessages(ALICE, 'alpha')).toHaveLength(0)
  })

  it('stores the tools the recipient used on the thread', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    // Beta lists its own conversations during the wake, then answers.
    await drainBotMessages({ env: ENV, deps: { fetch: scripted([], [toolCall('list_bot_conversations', {}), textReply('checked')]) } })
    const kinds = rows('SELECT kind, tool_name FROM bot_messages WHERE conversation_id = ? ORDER BY id', id).map((e: Loose) => `${e.kind}:${e.tool_name ?? ''}`)
    expect(kinds).toEqual(['message:', 'tool:list_bot_conversations', 'reply:'])
  })
})

// ── reply on the same thread ──

describe('replies stay on the same thread', () => {
  it('a follow-up by conversation_id reuses the conversation and the wake sees the whole thread', async () => {
    const { bot_conversation_id: id } = await alphaToBeta('first question')
    await drainBotMessages({ env: ENV, deps: { fetch: scripted([], [textReply('first answer')]) } })

    const r = await runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { conversation_id: id, text: 'second question' })
    expect(r.bot_conversation_id).toBe(id)
    expect(r.summary).toContain('Followed up with Beta')
    expect(count('bot_conversations')).toBe(1)

    const seen: Seen[] = []
    await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('second answer')]) } })
    const msgs = seen[0].body.messages as Loose[]
    // Beta's earlier reply is ITS turn (assistant); Alpha's messages are incoming (user).
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(JSON.stringify(msgs)).toContain('first question')
    expect(JSON.stringify(msgs)).toContain('first answer')
    expect(JSON.stringify(msgs)).toContain('second question')
    expect(one('SELECT message_count FROM bot_conversations WHERE id = ?', id).message_count).toBe(2)
  })

  it('the RECIPIENT can answer back on the same thread from its own chat, which wakes the first bot', async () => {
    const { bot_conversation_id: id } = await alphaToBeta('ping')
    await drainBotMessages({ env: ENV, deps: { fetch: scripted([], [textReply('pong')]) } })
    // Later, in Alice's chat with Beta, Beta follows up on the same conversation.
    const r = await runChatTool(ctxFor('beta', ALICE, 'ops'), 'message_bot', { conversation_id: id, text: 'one more thing' })
    expect(r.bot_conversation_id).toBe(id)
    expect((r.result as Loose).to.slug).toBe('alpha')
    const seen: Seen[] = []
    await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('noted')]) } })
    expect(seen[0].body.system).toContain('You are Alpha.')
    // The answer goes back into Alice's chat with BETA (where this message came from).
    expect(listMessages(ALICE, 'beta').at(-1)!.content).toContain('**Alpha** replied')
    expect(rows('SELECT DISTINCT conversation_id FROM bot_messages')).toHaveLength(1)
  })

  it('"to" naming a bot that is not on the conversation is refused', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'sales'), 'message_bot', { conversation_id: id, to: 'delta', text: 'x' }))).toMatch(/is with Beta/)
  })
})

// ── authz ──

describe('authz: no message crosses a workspace', () => {
  it('refuses a recipient that is not granted the workspace', async () => {
    // gamma is granted finance only.
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { to: 'gamma', text: 'hi', workspace: 'ops' }))).toMatch(/Gamma is not granted the ops workspace/)
    expect(count('bot_conversations')).toBe(0)
    expect(rows("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = 'bot_message_refused'")).toHaveLength(1)
  })

  it('refuses a workspace the SENDING bot is not granted, even when the person belongs to it', async () => {
    // Alice is in sales; beta is not granted sales.
    expect(await refusal(runChatTool(ctxFor('beta', ALICE, 'ops'), 'message_bot', { to: 'alpha', text: 'hi', workspace: 'sales' }))).toMatch(/can't message bots in "sales"/)
    expect(count('bot_conversations')).toBe(0)
  })

  it('refuses a workspace the PERSON does not belong to, even when both bots are granted it', async () => {
    // Bob is finance-only; alpha and beta share ops.
    expect(await refusal(runChatTool(ctxFor('alpha', BOB, 'ops'), 'message_bot', { to: 'beta', text: 'hi', workspace: 'ops' }))).toMatch(/can't message bots in "ops"/)
    expect(count('bot_conversations')).toBe(0)
  })

  it('a bot cannot read another workspace’s conversation, or one it is not on — both answer "not found"', async () => {
    const { bot_conversation_id: opsId } = await alphaToBeta('ops secret: launch code 42')
    const salesSend = await runChatTool(ctxFor('alpha', ALICE, 'sales'), 'message_bot', { to: 'delta', text: 'sales secret', workspace: 'sales' })
    const salesId = salesSend.bot_conversation_id!

    // gamma (finance) is on neither.
    expect(await refusal(runChatTool(ctxFor('gamma', BOB, 'finance'), 'read_bot_conversation', { conversation_id: opsId }))).toBe(`Bot conversation #${opsId} not found.`)
    // delta is in sales and cannot read the ops thread it is not on.
    expect(await refusal(runChatTool(ctxFor('delta', ALICE, 'sales'), 'read_bot_conversation', { conversation_id: opsId }))).toBe(`Bot conversation #${opsId} not found.`)
    // A conversation that does not exist reads the same.
    expect(await refusal(runChatTool(ctxFor('delta', ALICE, 'sales'), 'read_bot_conversation', { conversation_id: 999999 }))).toBe('Bot conversation #999999 not found.')
    // alpha acting for Bob (finance only) sees neither of its own threads.
    expect(await refusal(runChatTool(ctxFor('alpha', BOB, 'finance'), 'read_bot_conversation', { conversation_id: opsId }))).toMatch(/not found/)
    const bobList = await runChatTool(ctxFor('alpha', BOB, 'finance'), 'list_bot_conversations', {})
    expect((bobList.result as Loose).conversations).toHaveLength(0)

    // alpha for Alice sees both; beta for Alice sees only the ops one.
    const aList = await runChatTool(ctxFor('alpha', ALICE, 'ops'), 'list_bot_conversations', {})
    expect((aList.result as Loose).conversations.map((c: Loose) => c.conversation_id).sort()).toEqual([opsId, salesId].sort())
    const bList = await runChatTool(ctxFor('beta', ALICE, 'ops'), 'list_bot_conversations', {})
    expect((bList.result as Loose).conversations.map((c: Loose) => c.conversation_id)).toEqual([opsId])
    const read = await runChatTool(ctxFor('beta', ALICE, 'ops'), 'read_bot_conversation', { conversation_id: opsId })
    expect(JSON.stringify(read.result)).toContain('launch code 42')
    expect(JSON.stringify(read.result)).not.toContain('sales secret')
  })

  it('a revoked workspace grant takes effect on reads and on the next send', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    revokeBotWorkspace('alpha', 'ops', 'test')
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'sales'), 'read_bot_conversation', { conversation_id: id }))).toMatch(/not found/)
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'sales'), 'message_bot', { conversation_id: id, text: 'again' }))).toMatch(/not found/)
  })

  it('a revoke between send and delivery stops the wake: no model call, failed row, the sender is told', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    revokeBotWorkspace('beta', 'ops', 'test')
    const seen: Seen[] = []
    const r = await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('should never run')]) } })
    expect(r.failed).toBe(1)
    expect(seen).toHaveLength(0)
    const m = one("SELECT * FROM bot_messages WHERE kind = 'message'")
    expect(m.status).toBe('failed')
    expect(m.last_error).toMatch(/Beta may no longer work in the ops workspace/)
    expect(rows("SELECT * FROM bot_messages WHERE kind = 'notice' AND conversation_id = ?", id)).toHaveLength(1)
    expect(listMessages(ALICE, 'alpha').at(-1)!.content).toMatch(/was not delivered/)
  })

  it('a removed membership between send and delivery stops the wake too', async () => {
    await alphaToBeta()
    getDb().prepare("DELETE FROM user_workspaces WHERE user_id = ? AND workspace = 'ops'").run(ALICE)
    try {
      const seen: Seen[] = []
      const r = await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('no')]) } })
      expect(r.failed).toBe(1)
      expect(seen).toHaveLength(0)
    } finally {
      getDb().prepare("INSERT INTO user_workspaces (user_id, workspace, role, objective_visibility) VALUES (?, 'ops', 'member', 'all')").run(ALICE)
    }
  })

  it('inside a wake: the bot is held to that conversation’s workspace, cannot re-message the sender on it, and chains are depth-capped', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    const wake = (depth: number) => ({ botWake: { conversationId: id, depth } })
    // Answering by message_bot on the conversation that woke it.
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops', wake(0)), 'message_bot', { conversation_id: id, text: 'x' }))).toMatch(/your final answer IS your reply/)
    // Starting a thread in ANOTHER workspace from a wake.
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops', wake(0)), 'message_bot', { to: 'delta', text: 'x', workspace: 'sales' }))).toMatch(/only message bots in that conversation's workspace \(ops\)/)
    // Depth: default max 2, so a wake at depth 2 cannot send.
    expect(await refusal(runChatTool(ctxFor('beta', ALICE, 'ops', wake(2)), 'message_bot', { to: 'plain', text: 'x' }))).toMatch(/hops deep/)
    // A wake at depth 0 may start a new thread in the same workspace, one level deeper, with no chat lane.
    getDb().prepare("UPDATE agent_chat_bot_access SET mode = 'restricted'").run()
    const ok = await runChatTool(ctxFor('beta', ALICE, 'ops', wake(0)), 'message_bot', { to: 'alpha', text: 'side question' })
    const row = one('SELECT * FROM bot_messages WHERE id = ?', (ok.result as Loose).message_id)
    expect(row).toMatchObject({ depth: 1, origin_user_id: null, workspace: 'ops' })
  })

  it('a conversation that is full refuses more messages', async () => {
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('bot_messaging_max_per_conversation', '1')").run()
    const { bot_conversation_id: id } = await alphaToBeta()
    expect(await refusal(runChatTool(ctxFor('alpha', ALICE, 'ops'), 'message_bot', { conversation_id: id, text: 'more' }))).toMatch(/is full/)
  })
})

// ── delivery + retry ──

describe('delivery and retry', () => {
  it('a provider error is retried with backoff, then given up on and reported to the sender', async () => {
    const { bot_conversation_id: id } = await alphaToBeta()
    const seen: Seen[] = []
    // A clock ahead of the real one: the message is queued with real now, so a fixed past date stops it ever being due.
    let now = new Date('2099-01-01T12:00:00Z')
    const opts = () => ({ env: ENV, deps: { fetch: failingFetch(seen) }, now: () => now })

    expect((await drainBotMessages(opts())).retried).toBe(1)
    let m = one("SELECT * FROM bot_messages WHERE kind = 'message'")
    expect(m).toMatchObject({ status: 'pending', attempts: 1 })
    expect(m.next_attempt_at).toBe('2099-01-01 12:00:30')
    // Not due yet: nothing happens.
    expect(await drainBotMessages(opts())).toMatchObject({ retried: 0, delivered: 0, failed: 0 })

    now = new Date('2099-01-01T12:00:31Z')
    expect((await drainBotMessages(opts())).retried).toBe(1)
    m = one("SELECT * FROM bot_messages WHERE kind = 'message'")
    expect(m).toMatchObject({ status: 'pending', attempts: 2, next_attempt_at: '2099-01-01 12:02:31' })

    now = new Date('2099-01-01T12:03:00Z')
    expect((await drainBotMessages(opts())).failed).toBe(1)
    m = one("SELECT * FROM bot_messages WHERE kind = 'message'")
    expect(m.status).toBe('failed')
    expect(m.attempts).toBe(MAX_DELIVERY_ATTEMPTS)
    expect(m.last_error).toMatch(/gave up after 3 attempts/)
    expect(seen).toHaveLength(MAX_DELIVERY_ATTEMPTS)
    expect(rows("SELECT * FROM bot_messages WHERE kind = 'notice' AND conversation_id = ?", id)).toHaveLength(1)
    expect(listMessages(ALICE, 'alpha').at(-1)!.content).toMatch(/was not delivered/)
    expect(rows("SELECT * FROM activity_log WHERE json_extract(metadata, '$.kind') = 'bot_message_failed'")).toHaveLength(1)
  })

  it('a row left "delivering" by a crash is reclaimed after its lease and delivered once', async () => {
    await alphaToBeta()
    getDb().prepare("UPDATE bot_messages SET status = 'delivering', lease_until = '2000-01-01 00:00:00' WHERE kind = 'message'").run()
    const seen: Seen[] = []
    const r = await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('recovered')]) } })
    expect(r.delivered).toBe(1)
    expect(seen).toHaveLength(1)
  })

  it('a message already claimed by another drain is not delivered twice', async () => {
    const sentR = await alphaToBeta()
    const id = (sentR.result as Loose).message_id
    const seen: Seen[] = []
    const f = scripted(seen, [textReply('once')])
    const [a, b] = await Promise.all([deliverBotMessage(id, { env: ENV, deps: { fetch: f } }), deliverBotMessage(id, { env: ENV, deps: { fetch: f } })])
    expect([a, b].sort()).toEqual(['delivered', 'skipped'])
    expect(seen).toHaveLength(1)
  })

  it('the kill switch parks delivery', async () => {
    await alphaToBeta()
    getDb().prepare("INSERT INTO settings (key, value) VALUES ('bot_messaging_enabled', '0')").run()
    const seen: Seen[] = []
    expect(await drainBotMessages({ env: ENV, deps: { fetch: scripted(seen, [textReply('x')]) } })).toMatchObject({ delivered: 0 })
    expect(seen).toHaveLength(0)
    expect(one("SELECT status FROM bot_messages WHERE kind = 'message'").status).toBe('pending')
  })
})

describe('store helpers', () => {
  it('an empty workspace scope matches nothing, never everything', async () => {
    await alphaToBeta()
    expect(bm.listConversations({ workspaces: [] })).toHaveLength(0)
    expect(bm.listConversations({ workspaces: null })).toHaveLength(1)
  })
})
