import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 901373 — reply in thread, on the screen.

   The server suites prove the storage, the model context and "main unchanged".
   What only the page can get wrong is asserted here: the action opens the
   thread on the RIGHT message, a reply is posted with the THREAD's id (never to
   the bare /messages URL, which is the main conversation), the bot's answer is
   drawn in the panel and not in the conversation, and the parent shows its
   "N replies" link, which reopens the thread. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 14) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const BOT = {
  slug: 'librarian', name: 'Librarian', description: 'Keeps the notes.', avatar: 'LI', colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null,
  version: null, author: 'Test', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
}
const THREAD_ID = 41
const msg = (id: number, role: 'user' | 'assistant', content: string, meta: unknown = null) => ({
  id, role, content, provider: role === 'assistant' ? 'demo' : null, model: null, tool_name: null, meta, created_at: '2026-11-17 09:00:00',
})

type Lane = { messages: ReturnType<typeof msg>[]; drafts: unknown[]; cards: unknown[]; reply_threads?: Record<string, unknown> }
let lanes: Record<string, Lane>
let calls: { url: string; method: string; body: string | null }[] = []
let root: Root
let host: HTMLDivElement
let nextId = 100

function mount(path = '/chat/librarian') {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return import('./AgentChatPage').then(({ AgentChatPage }) => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/chat" element={<AgentChatPage />} />
          <Route path="/chat/:slug" element={<AgentChatPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const panel = () => host.querySelector('[data-testid="reply-thread-panel"]') as HTMLElement | null
const mainList = () => host.querySelector('[data-testid="chat-message-list"]') as HTMLElement
const rowFor = (id: number) => host.querySelector(`[data-testid="threadable-message"][data-message-id="${id}"]`) as HTMLElement
const replyAction = (id: number) => [...rowFor(id).querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Reply in thread')!
function type(box: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(box, value)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}

beforeEach(async () => {
  calls = []
  nextId = 100
  lanes = {
    main: { messages: [msg(1, 'user', 'what is the status?'), msg(2, 'assistant', 'Decision: ship on Friday.'), msg(3, 'assistant', 'Status report: all green.')], drafts: [], cards: [], reply_threads: {} },
    [THREAD_ID]: { messages: [], drafts: [], cards: [], reply_threads: {} },
  }
  const { setChatCacheScope } = await import('./chat-cache')
  setChatCacheScope(`test-${Math.random()}`)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : null })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [BOT], demo: false, providers: { demo: true }, default_provider: null })
    const open = url.match(/\/messages\/(\d+)\/thread$/)
    if (open && method === 'POST') {
      const parent = lanes.main.messages.find(m => m.id === Number(open[1]))
      if (!parent) return json({ error: 'Message not found' }, 404)
      return json({ thread: { id: THREAD_ID, title: 'Thread', pinned: false, archived: false, last_active_at: null, created_at: '', updated_at: '', message_count: lanes[THREAD_ID].messages.length, parent_message_id: parent.id }, parent, drafts: [], cards: [] }, 201)
    }
    if (url.includes('/threads')) return json({ threads: [], max_open: 10 })
    if (url.includes('/messages')) {
      if (method === 'DELETE') { lanes.main = { messages: [], drafts: [], cards: [], reply_threads: {} }; return json({ ok: true, removed: 3 }) }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { text: string; thread_id?: number; client_msg_id?: string }
        const lane = lanes[String(body.thread_id ?? 'main')]
        const mine = msg(nextId++, 'user', body.text, { client_msg_id: body.client_msg_id })
        const answer = msg(nextId++, 'assistant', `thread-answer to: ${body.text}`)
        lane.messages.push(mine, answer)
        if (body.thread_id === THREAD_ID) lanes.main.reply_threads = { 2: { thread_id: THREAD_ID, reply_count: lane.messages.length, last_reply_at: '2026-11-17 09:05:00' } }
        return json({ messages: [mine, answer], drafts: [], cards: [], turn: { running: false, queued: 0 }, reply_threads: {} })
      }
      const lane = new URL(url, 'http://x').searchParams.get('thread_id') ?? 'main'
      return json({ ...(lanes[lane] ?? { messages: [], drafts: [], cards: [] }), turn: { running: false, queued: 0 } })
    }
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('reply in thread', () => {
  it('every person and bot message offers "Reply in thread"', async () => {
    await mount()
    await settle()
    expect(panel()).toBeNull()
    for (const id of [1, 2, 3]) expect(replyAction(id)).toBeDefined()
  })

  it('opens the thread on THAT message, with the parent shown and its own composer', async () => {
    await mount()
    await settle()
    replyAction(2).click()
    await settle()
    expect(calls.some(c => c.method === 'POST' && c.url === '/api/agent-chat/agents/librarian/messages/2/thread')).toBe(true)
    expect(panel()).not.toBeNull()
    expect(panel()!.querySelector('[data-testid="reply-thread-parent"]')!.textContent).toContain('Decision: ship on Friday.')
    expect(panel()!.querySelector('[data-testid="reply-thread-count"]')!.textContent).toContain('No replies yet')
    expect(panel()!.querySelector('textarea#reply-thread-input')).not.toBeNull()
    // The thread's lane is read by its id; the conversation is still on screen behind it.
    expect(calls.some(c => c.method === 'GET' && c.url === `/api/agent-chat/agents/librarian/messages?thread_id=${THREAD_ID}`)).toBe(true)
    expect(mainList().textContent).toContain('Status report: all green.')
  })

  it('a reply is posted with the thread id; the answer lands in the thread, not in Main; the parent shows "2 replies"', async () => {
    await mount()
    await settle()
    replyAction(2).click()
    await settle()
    const box = panel()!.querySelector('textarea') as HTMLTextAreaElement
    type(box, 'why Friday?')
    await settle()
    // Enter sends, as in the main composer.
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle(30)
    const post = calls.find(c => c.method === 'POST' && c.url.endsWith('/messages'))!
    expect(JSON.parse(post.body!)).toMatchObject({ text: 'why Friday?', thread_id: THREAD_ID })
    expect(panel()!.textContent).toContain('why Friday?')
    expect(panel()!.textContent).toContain('thread-answer to: why Friday?')
    expect(panel()!.querySelector('[data-testid="reply-thread-count"]')!.textContent).toContain('2 replies')
    // Main holds exactly what it held: neither the reply nor the bot's answer.
    expect(mainList().textContent).not.toContain('why Friday?')
    expect(mainList().textContent).not.toContain('thread-answer')
    expect(mainList().querySelectorAll('[data-testid="threadable-message"]')).toHaveLength(3)
    const link = rowFor(2).querySelector('[data-testid="thread-replies-link"]')!
    expect(link.textContent).toContain('2 replies')
    expect(link.textContent).toContain('last reply')
    expect(rowFor(3).querySelector('[data-testid="thread-replies-link"]')).toBeNull()
  })

  it('closing the panel and clicking "N replies" reopens the same thread', async () => {
    lanes.main.reply_threads = { 2: { thread_id: THREAD_ID, reply_count: 2, last_reply_at: '2026-11-17 09:05:00' } }
    lanes[THREAD_ID].messages = [msg(50, 'user', 'earlier reply'), msg(51, 'assistant', 'earlier answer')]
    await mount()
    await settle()
    const link = rowFor(2).querySelector('[data-testid="thread-replies-link"]') as HTMLButtonElement
    link.click()
    await settle()
    expect(panel()!.textContent).toContain('earlier reply')
    expect(panel()!.textContent).toContain('earlier answer')
    ;(panel()!.querySelector('button[aria-label="Close thread"]') as HTMLButtonElement).click()
    await settle()
    expect(panel()).toBeNull()
    ;(rowFor(2).querySelector('[data-testid="thread-replies-link"]') as HTMLButtonElement).click()
    await settle()
    expect(panel()!.textContent).toContain('earlier answer')
  })

  it('a message inside the thread panel offers no nested "Reply in thread"', async () => {
    lanes.main.reply_threads = { 2: { thread_id: THREAD_ID, reply_count: 2, last_reply_at: '2026-11-17 09:05:00' } }
    lanes[THREAD_ID].messages = [msg(50, 'user', 'earlier reply'), msg(51, 'assistant', 'earlier answer')]
    await mount()
    await settle()
    ;(rowFor(2).querySelector('[data-testid="thread-replies-link"]') as HTMLButtonElement).click()
    await settle()
    expect([...panel()!.querySelectorAll('button')].some(b => (b.textContent ?? '').includes('Reply in thread'))).toBe(false)
    expect(panel()!.querySelectorAll('[data-testid="threadable-message"]')).toHaveLength(0)
  })

  it('a thread that cannot be opened says so and opens no panel', async () => {
    await mount()
    await settle()
    lanes.main.messages = lanes.main.messages.filter(m => m.id !== 3)
    replyAction(3).click()
    await settle()
    expect(panel()).toBeNull()
    expect(host.querySelector('[role="alert"]')?.textContent).toBeTruthy()
  })
})
