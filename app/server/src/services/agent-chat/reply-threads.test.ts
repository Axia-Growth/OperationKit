import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

/*
 * Reply in thread on bot chats — obj 901373.
 *
 * A reply thread is a side-thread row anchored to one parent message. Asserted
 * here against the real engine and database:
 *   1. one thread per parent, found again on a second open, never in the lane strip or the cap;
 *   2. the bot's answer to a thread reply lands IN the thread and the parent's lane is unchanged;
 *   3. the model is handed the parent message, then the thread's earlier replies
 *      (read from the captured request body), and nothing else from the parent's lane;
 *   4. unread thread replies count toward the bot's unread badge;
 *   5. clearing the parent's lane removes its reply threads; clearing a thread leaves the parent alone.
 */
process.env.JWT_SECRET = 'test-secret-reply-threads-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-reply-threads-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reply-threads-agents-'))
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reply-threads-kb-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.KNOWLEDGE_BASE_DIR = TMP_KB

const { initDb, getDb } = await import('../../db/index.js')
const { findAgent, listMessages, clearChat, runTurn, addMessage } = await import('./engine.js')
const { createThread, listThreads, countOpenThreads, openReplyThread, replyThreadsForLane, replyParentOf, updateThread, ThreadRejected, MAIN_LANE } = await import('./threads.js')
const { unreadCounts, markRead } = await import('./sidebar.js')

const OWNER = 2
const OTHER = 3
const ENV = { ANTHROPIC_API_KEY: 'k', AGENT_CHAT_PROVIDER: 'anthropic' } as NodeJS.ProcessEnv
type Seen = { body: Record<string, unknown> }
type Lane = NonNullable<Parameters<typeof runTurn>[0]['lane']>

function captureFetch(seen: Seen[], text: string) {
  return (async (_url: string, init: RequestInit) => {
    seen.push({ body: JSON.parse(String(init.body)) })
    return new Response(JSON.stringify({ content: [{ type: 'text', text }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as unknown as typeof fetch
}
const agent = () => ({ ...findAgent('helper')!, provider: 'anthropic' as const })
const modelMessages = (s: Seen) => (s.body.messages ?? []) as { role: string; content: unknown }[]

function say(lane: Lane, text: string, seen: Seen[] = [], userId = OWNER) {
  return runTurn({ userId, username: `user${userId}`, agent: agent(), text, lane, env: ENV, deps: { fetch: captureFetch(seen, `ack: ${text}`) } })
}
const main = (userId = OWNER) => listMessages(userId, 'helper', { lane: MAIN_LANE })
const lane = (id: number): Lane => ({ kind: 'thread', id })

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user2', 'x', 'member')`).run(OWNER)
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'user3', 'x', 'member')`).run(OTHER)
  for (const slug of ['helper', 'second-bot']) {
    fs.mkdirSync(path.join(TMP_AGENTS, slug))
    fs.writeFileSync(
      path.join(TMP_AGENTS, slug, 'agent.yaml'),
      'name: Helper\nsystem_prompt: You help.\nknowledge_folders: []\ntools: []\ncolour: blue\nversion: 1.0.0\nauthor: Test\n',
    )
  }
})

beforeEach(() => {
  const db = getDb()
  db.prepare('DELETE FROM agent_chat_messages').run()
  db.prepare('DELETE FROM agent_chat_threads').run()
  db.prepare('DELETE FROM agent_chat_sidebar_bots').run()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  fs.rmSync(TMP_AGENTS, { recursive: true, force: true })
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('opening a reply thread', () => {
  it('is one thread per parent message, found again on a second open', async () => {
    await say(MAIN_LANE, 'status please')
    const bot = main().find(m => m.role === 'assistant')!
    const a = openReplyThread(OWNER, 'helper', bot.id)
    expect(a.created).toBe(true)
    expect(a.thread.parent_message_id).toBe(bot.id)
    expect(a.parent.content).toBe('ack: status please')
    const b = openReplyThread(OWNER, 'helper', bot.id)
    expect(b.created).toBe(false)
    expect(b.thread.id).toBe(a.thread.id)
  })

  it('works on the person’s own message and on a message in a named side thread', async () => {
    await say(MAIN_LANE, 'mine')
    const mine = main().find(m => m.role === 'user')!
    expect(openReplyThread(OWNER, 'helper', mine.id).parent.role).toBe('user')
    const side = createThread(OWNER, 'helper', 'Card wakes')
    await say(lane(side.id), 'a wake')
    const wake = listMessages(OWNER, 'helper', { lane: lane(side.id) }).find(m => m.role === 'assistant')!
    const t = openReplyThread(OWNER, 'helper', wake.id)
    expect(t.parent.thread_id).toBe(side.id)
  })

  it('never shows in the lane strip and never counts toward the side-thread cap', async () => {
    await say(MAIN_LANE, 'one')
    for (const m of main()) openReplyThread(OWNER, 'helper', m.id)
    expect(listThreads(OWNER, 'helper', { includeArchived: true })).toEqual([])
    expect(countOpenThreads(OWNER, 'helper')).toBe(0)
  })

  it('refuses someone else’s message, another bot’s message, a missing one, and a message inside a thread', async () => {
    await say(MAIN_LANE, 'private')
    const bot = main().find(m => m.role === 'assistant')!
    const status = (fn: () => unknown) => { try { fn(); return 0 } catch (e) { return e instanceof ThreadRejected ? e.status : -1 } }
    expect(status(() => openReplyThread(OTHER, 'helper', bot.id))).toBe(404)
    expect(status(() => openReplyThread(OWNER, 'second-bot', bot.id))).toBe(404)
    expect(status(() => openReplyThread(OWNER, 'helper', 999999))).toBe(404)
    const t = openReplyThread(OWNER, 'helper', bot.id)
    await say(lane(t.thread.id), 'in thread')
    const inner = listMessages(OWNER, 'helper', { lane: lane(t.thread.id) })[0]
    expect(status(() => openReplyThread(OWNER, 'helper', inner.id))).toBe(400)
  })

  it('refuses a queued message (it is re-filed under a new id on delivery)', () => {
    const q = addMessage(OWNER, 'helper', { role: 'user', content: 'waiting', provider: null, model: null, tool_name: null, meta: { queued: true } })
    expect(() => openReplyThread(OWNER, 'helper', q.id)).toThrow(/not reached the bot/)
  })

  it('cannot be renamed, pinned or archived like a named side thread', async () => {
    await say(MAIN_LANE, 'x')
    const t = openReplyThread(OWNER, 'helper', main()[0].id)
    expect(() => updateThread(OWNER, 'helper', t.thread.id, { archived: true })).toThrow(ThreadRejected)
  })
})

describe('replying in a thread', () => {
  it('puts the bot’s answer in the thread and leaves the main conversation unchanged', async () => {
    await say(MAIN_LANE, 'first item')
    await say(MAIN_LANE, 'second item')
    const before = JSON.stringify(main())
    const parent = main().filter(m => m.role === 'assistant')[0]
    const t = openReplyThread(OWNER, 'helper', parent.id)
    const r = await say(lane(t.thread.id), 'about the first one')
    expect(r.messages.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(listMessages(OWNER, 'helper', { lane: lane(t.thread.id) }).map(m => m.content)).toEqual(['about the first one', 'ack: about the first one'])
    expect(JSON.stringify(main())).toBe(before)
  })

  it('hands the model the parent message, then the thread’s earlier replies — and nothing else from main', async () => {
    await say(MAIN_LANE, 'UNRELATED-MAIN-TOPIC')
    await say(MAIN_LANE, 'the decision')
    const parent = main().find(m => m.content === 'ack: the decision')!
    const t = openReplyThread(OWNER, 'helper', parent.id)
    await say(lane(t.thread.id), 'reply one')
    const seen: Seen[] = []
    await say(lane(t.thread.id), 'reply two', seen)
    // The provider folds adjacent user turns into one message of text blocks, so
    // order is asserted on the flattened text that left the process.
    const msgs = modelMessages(seen[0])
    const flat = JSON.stringify(msgs)
    expect(msgs[0].role).toBe('user')
    const order = ['[Thread context, not a new request]', 'you (the bot) wrote', 'ack: the decision', 'reply one', 'ack: reply one', 'reply two'].map(x => flat.indexOf(x))
    expect(order.every(i => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(msgs[msgs.length - 1].role).toBe('user')
    expect(JSON.stringify(msgs)).not.toContain('UNRELATED-MAIN-TOPIC')
  })

  it('says the person wrote the parent when it is their own message', async () => {
    await say(MAIN_LANE, 'my own note')
    const t = openReplyThread(OWNER, 'helper', main().find(m => m.role === 'user')!.id)
    const seen: Seen[] = []
    await say(lane(t.thread.id), 'more on this', seen)
    const first = JSON.stringify(modelMessages(seen[0])[0])
    expect(first).toContain('I wrote')
    expect(first).toContain('my own note')
  })

  it('a named side thread gets no thread context', async () => {
    const side = createThread(OWNER, 'helper', 'Side')
    const seen: Seen[] = []
    await say(lane(side.id), 'hello', seen)
    expect(replyParentOf(OWNER, 'helper', lane(side.id))).toBeNull()
    expect(JSON.stringify(modelMessages(seen[0]))).not.toContain('Thread context')
  })
})

describe('the parent’s "N replies"', () => {
  it('reports count and last reply time for the parent’s own lane only, and only once there is a reply', async () => {
    await say(MAIN_LANE, 'item')
    const parent = main().find(m => m.role === 'assistant')!
    const t = openReplyThread(OWNER, 'helper', parent.id)
    expect(replyThreadsForLane(OWNER, 'helper', MAIN_LANE)).toEqual({})
    await say(lane(t.thread.id), 'r1')
    const s = replyThreadsForLane(OWNER, 'helper', MAIN_LANE)
    expect(Object.keys(s)).toEqual([String(parent.id)])
    expect(s[parent.id].thread_id).toBe(t.thread.id)
    expect(s[parent.id].reply_count).toBe(2)
    expect(s[parent.id].last_reply_at).toBeTruthy()
    expect(replyThreadsForLane(OWNER, 'helper', lane(t.thread.id))).toEqual({})
    expect(replyThreadsForLane(OTHER, 'helper', MAIN_LANE)).toEqual({})
  })
})

describe('unread', () => {
  it('a bot reply in a thread counts toward the bot’s unread badge until the bot is read', async () => {
    await say(MAIN_LANE, 'item')
    const parent = main().find(m => m.role === 'assistant')!
    markRead(OWNER, 'helper')
    expect(unreadCounts(OWNER).get('helper') ?? 0).toBe(0)
    const t = openReplyThread(OWNER, 'helper', parent.id)
    // A reply the bot posts into the thread on its own (after the person's last message there).
    addMessage(OWNER, 'helper', { role: 'assistant', content: 'late answer', provider: null, model: null, tool_name: null, meta: null }, [], lane(t.thread.id))
    expect(unreadCounts(OWNER).get('helper')).toBe(1)
    markRead(OWNER, 'helper')
    expect(unreadCounts(OWNER).get('helper') ?? 0).toBe(0)
  })
})

describe('clearing', () => {
  it('clearing the main conversation removes its reply threads and their messages', async () => {
    await say(MAIN_LANE, 'item')
    const t = openReplyThread(OWNER, 'helper', main()[1].id)
    await say(lane(t.thread.id), 'r1')
    const side = createThread(OWNER, 'helper', 'Kept')
    await say(lane(side.id), 'side stays')
    clearChat(OWNER, 'helper', MAIN_LANE)
    const db = getDb()
    expect(main()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_threads WHERE parent_message_id IS NOT NULL').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_chat_messages WHERE thread_id = ?').get(t.thread.id)).toEqual({ n: 0 })
    // A named side thread is not a reply thread: it is untouched.
    expect(listMessages(OWNER, 'helper', { lane: lane(side.id) })).toHaveLength(2)
  })

  it('clearing a side thread removes the reply threads on ITS messages only', async () => {
    await say(MAIN_LANE, 'main item')
    const mainThread = openReplyThread(OWNER, 'helper', main()[1].id)
    await say(lane(mainThread.thread.id), 'main reply')
    const side = createThread(OWNER, 'helper', 'Card wakes')
    await say(lane(side.id), 'wake')
    const wakeThread = openReplyThread(OWNER, 'helper', listMessages(OWNER, 'helper', { lane: lane(side.id) })[1].id)
    await say(lane(wakeThread.thread.id), 'wake reply')
    clearChat(OWNER, 'helper', lane(side.id))
    expect(listMessages(OWNER, 'helper', { lane: lane(wakeThread.thread.id) })).toEqual([])
    expect(listMessages(OWNER, 'helper', { lane: lane(mainThread.thread.id) })).toHaveLength(2)
    expect(Object.keys(replyThreadsForLane(OWNER, 'helper', MAIN_LANE))).toHaveLength(1)
  })

  it('clearing a reply thread leaves the parent and the main conversation as they were', async () => {
    await say(MAIN_LANE, 'item')
    const before = JSON.stringify(main())
    const t = openReplyThread(OWNER, 'helper', main()[1].id)
    await say(lane(t.thread.id), 'r1')
    clearChat(OWNER, 'helper', lane(t.thread.id))
    expect(JSON.stringify(main())).toBe(before)
    expect(replyThreadsForLane(OWNER, 'helper', MAIN_LANE)).toEqual({})
  })
})
