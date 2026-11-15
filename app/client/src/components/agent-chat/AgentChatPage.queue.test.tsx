import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* The composer stays usable while the bot is working (obj 900949).
   createRoot idiom (no @testing-library in this client), fetch stubbed per URL.
   The first POST /messages is held open — that IS a running turn, from the
   page's point of view — so every assertion below is made mid-turn. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise(r => setTimeout(r, 0))
}

const AGENT = {
  slug: 'helper', name: 'Operation Kit Dev', description: 'Builds things.', avatar: 'OK', colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'install', answered_by: { id: 'anthropic', model: 'claude-sonnet-5' },
}

type Msg = { id: number; role: string; content: string; meta: Record<string, unknown> | null; created_at: string }
const row = (id: number, role: string, content: string, meta: Record<string, unknown> | null = null): Msg =>
  ({ id, role, content, meta, created_at: '2026-11-15 10:00:00', ...{ provider: null, model: null, tool_name: null, images: [] } })

let calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
let root: Root
let host: HTMLDivElement
/** What GET /messages answers right now — tests move it along. */
let serverThread: { messages: Msg[]; drafts: []; cards: []; turn?: { running: boolean; queued: number } }
/** Releases the held-open first POST with this body. */
let finishFirstTurn: ((body: unknown) => void) | null = null
let nextId = 10
/** obj 900977: when set, a mid-turn POST is stored by the server but its 202 is held until released. */
let holdQueued = false
let releaseQueued: (() => void) | null = null
/** client_msg_id → what the server stores in the row's meta. */
const cid = (body?: Record<string, unknown>) => (typeof body?.client_msg_id === 'string' ? { client_msg_id: body.client_msg_id } : {})

function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  return import('./AgentChatPage').then(({ AgentChatPage }) => {
    root.render(
      <MemoryRouter initialEntries={['/chat/helper']}>
        <Routes>
          <Route path="/chat/:slug" element={<AgentChatPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
}

const box = () => host.querySelector('#agent-chat-input') as HTMLTextAreaElement
const sendButton = () => [...host.querySelectorAll('button')].find(b => b.textContent === 'Send' && b.getAttribute('type') === 'submit') as HTMLButtonElement
const stopButton = () => [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === 'Stop') as HTMLButtonElement | undefined
const queuedBubbles = () => [...host.querySelectorAll('[data-testid="queued-bubble"]')].map(b => (b.textContent ?? '').replace(/(Queued|Sending…)$/, ''))
const posts = (suffix: string) => calls.filter(c => c.method === 'POST' && c.url.endsWith(suffix))
const confirmButton = (label: string) =>
  [...document.body.querySelectorAll('button')].find(b => b.textContent === label && !host.contains(b))

async function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(box(), text)
  box().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
}

async function say(text: string) {
  await type(text)
  sendButton().click()
  await settle()
}

beforeEach(() => {
  calls = []
  nextId = 10
  finishFirstTurn = null
  holdQueued = false
  releaseQueued = null
  serverThread = { messages: [], drafts: [], cards: [], turn: { running: false, queued: 0 } }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    let body: Record<string, unknown> | undefined
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = undefined }
    calls.push({ url, method, body })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [AGENT], demo: false, providers: { anthropic: true }, default_provider: 'anthropic' })
    if (url.endsWith('/messages') && method === 'GET') return json(serverThread)
    if (url.endsWith('/messages') && method === 'POST') {
      const text = String(body?.text ?? '')
      if (!finishFirstTurn && !serverThread.turn?.running) {
        // The first message starts a turn: the request stays open until released.
        const u = row(nextId++, 'user', text, 'client_msg_id' in cid(body) ? cid(body) : null)
        serverThread = { ...serverThread, messages: [...serverThread.messages, u], turn: { running: true, queued: 0 } }
        return new Promise<Response>(resolve => { finishFirstTurn = b => resolve(json(b)) })
      }
      // Mid-turn: the server stores it as queued and answers 202.
      const q = row(nextId++, 'user', text, { queued: true, ...cid(body) })
      const queued = serverThread.messages.filter(m => m.meta?.queued).length + 1
      serverThread = { ...serverThread, messages: [...serverThread.messages, q], turn: { running: true, queued } }
      const answer = json({ messages: [q], drafts: [], cards: [], queued: true, turn: serverThread.turn }, 202)
      if (holdQueued) return new Promise<Response>(resolve => { releaseQueued = () => resolve(answer) })
      return answer
    }
    if (url.endsWith('/stop') && method === 'POST') {
      const drop = body?.drop_queued === true
      if (drop) serverThread = { ...serverThread, messages: serverThread.messages.filter(m => !m.meta?.queued) }
      const queued = serverThread.messages.filter(m => m.meta?.queued).length
      return json({ stopped: true, dropped: drop ? 1 : 0, turn: { running: true, queued } })
    }
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('composer while the bot is working (obj 900949)', () => {
  it('Send and the message box stay usable during a running turn — no spinner, no lock', async () => {
    await mount()
    await settle()
    await say('build the report')
    // A turn is running now.
    expect(host.querySelector('[data-testid="bot-working"]')).toBeTruthy()
    expect(box().disabled).toBe(false)
    expect(sendButton().getAttribute('aria-busy')).toBeNull()
    await type('also add a chart')
    expect(sendButton().disabled).toBe(false)
    sendButton().click()
    await settle()
    // The second message went to the server mid-turn (it was not held back).
    expect(posts('/messages').map(c => c.body?.text)).toEqual(['build the report', 'also add a chart'])
    expect(box().value).toBe('')
  })

  it('shows Stop only while the bot is working, separate from Send', async () => {
    await mount()
    await settle()
    expect(stopButton()).toBeUndefined()
    await say('long job')
    expect(stopButton()).toBeTruthy()
    expect(stopButton()).not.toBe(sendButton())

    finishFirstTurn!({ messages: [row(nextId++, 'assistant', 'done')], drafts: [], cards: [], turn: { running: false, queued: 0 } })
    serverThread = { ...serverThread, turn: { running: false, queued: 0 } }
    await settle()
    expect(host.querySelector('[data-testid="bot-working"]')).toBeNull()
    expect(stopButton()).toBeUndefined()
  })

  it('queued messages render as "Queued" bubbles, in send order, below the turn', async () => {
    await mount()
    await settle()
    await say('first')
    await say('second')
    await say('third')
    expect(queuedBubbles()).toEqual(['second', 'third'])
    expect(host.querySelectorAll('[data-testid="queued-bubble"]')[0].textContent).toContain('Queued')
    expect(host.querySelector('[data-testid="queue-note"]')?.textContent).toContain('Operation Kit Dev is mid-task')
    // The queued bubbles sit after the working indicator, i.e. after the running turn.
    const working = host.querySelector('[data-testid="bot-working"]')!
    const firstQueued = host.querySelector('[data-testid="queued-bubble"]')!
    expect(working.compareDocumentPosition(firstQueued) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('queued bubbles clear once the bot picks them up, and the transcript keeps send order', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      await settle()
      await say('first')
      await say('second')
      await say('third')
      // The first turn ends; the server is now delivering the queue on its own.
      finishFirstTurn!({ messages: [row(1, 'assistant', 'answer one')], drafts: [], cards: [], turn: { running: true, queued: 2 } })
      await settle()
      expect(queuedBubbles()).toEqual(['second', 'third'])
      // The server delivered them (re-filed, no queued flag) and answered.
      serverThread = {
        messages: [row(10, 'user', 'first'), row(11, 'assistant', 'answer one'), row(14, 'user', 'second'), row(15, 'user', 'third'), row(16, 'assistant', 'answer two')],
        drafts: [], cards: [], turn: { running: false, queued: 0 },
      }
      await vi.advanceTimersByTimeAsync(2500)
      await settle()
      expect(queuedBubbles()).toEqual([])
      expect(host.querySelector('[data-testid="queue-note"]')).toBeNull()
      const text = host.textContent ?? ''
      const at = (s: string) => text.indexOf(s)
      expect(at('first')).toBeLessThan(at('answer one'))
      expect(at('answer one')).toBeLessThan(at('second'))
      expect(at('second')).toBeLessThan(at('third'))
      expect(at('third')).toBeLessThan(at('answer two'))
      expect(stopButton()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Stop cancels the turn and keeps the queue — no drop_queued unless confirmed', async () => {
    await mount()
    await settle()
    await say('first')
    await say('keep me')
    stopButton()!.click()
    await settle()
    expect(posts('/stop')).toHaveLength(1)
    expect(posts('/stop')[0].body?.drop_queued).toBeUndefined()
    expect(queuedBubbles()).toEqual(['keep me'])
  })

  it('discarding the queue asks first, and only then sends drop_queued', async () => {
    await mount()
    await settle()
    await say('first')
    await say('drop me')
    const discard = [...host.querySelectorAll('button')].find(b => b.textContent === 'Stop and discard queued')!
    expect(discard).toBeTruthy()
    discard.click()
    await settle()
    // Nothing is sent until the person confirms.
    expect(posts('/stop')).toHaveLength(0)
    confirmButton('Stop and discard')!.click()
    await settle()
    expect(posts('/stop')).toHaveLength(1)
    expect(posts('/stop')[0].body?.drop_queued).toBe(true)
    expect(queuedBubbles()).toEqual([])
  })
})

/* obj 900977 — a message sent while the bot works showed up twice: the server's
   stored row (returned by any re-read of the lane mid-turn) AND the local
   bubble. Each message carries a client_msg_id; the local bubble steps aside
   once the row with that id is in the thread. */
describe('a message is shown once, however the lane is re-read (obj 900977)', () => {
  const count = (needle: string) => (host.textContent ?? '').split(needle).length - 1
  /** Any re-read of the lane: a card refresh, tab focus, the sidebar prefetch, another tab's poll. */
  const reread = async () => {
    const { fetchInto, messagesKey, fetchMessages } = await import('./chat-cache')
    await fetchInto(messagesKey('helper', null), () => fetchMessages('helper', null))
    await settle()
  }

  it('every POST carries its own client_msg_id', async () => {
    await mount()
    await settle()
    await say('first')
    await say('second')
    const ids = posts('/messages').map(c => c.body?.client_msg_id)
    expect(ids).toHaveLength(2)
    for (const id of ids) expect(String(id)).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('the message whose turn is running appears exactly once after a mid-turn reload returns its stored row plus tool rows', async () => {
    await mount()
    await settle()
    await say('Hows this going')
    expect(count('Hows this going')).toBe(1)
    // Mid-turn the server already holds the user row and the bot's tool steps.
    serverThread = {
      ...serverThread,
      messages: [...serverThread.messages, { ...row(nextId++, 'tool', 'Looked at the board'), tool_name: 'list_objectives', meta: { ok: true } } as Msg],
    }
    await reread()
    expect(host.textContent).toContain('Looked at the board')
    expect(count('Hows this going')).toBe(1)
    // …and it reads BEFORE the tool step, where the server filed it — not under it.
    const text = host.textContent ?? ''
    expect(text.indexOf('Hows this going')).toBeLessThan(text.indexOf('Looked at the board'))
    expect(host.querySelector('[data-testid="bot-working"]')).toBeTruthy()

    // The turn ends: still once.
    const done = row(nextId++, 'assistant', 'All good')
    serverThread = { ...serverThread, messages: [...serverThread.messages, done], turn: { running: false, queued: 0 } }
    finishFirstTurn!({ messages: serverThread.messages, drafts: [], cards: [], turn: { running: false, queued: 0 } })
    await settle()
    expect(count('Hows this going')).toBe(1)
    expect(host.textContent).toContain('All good')
  })

  it('a queued message whose stored row arrives before its POST resolves appears exactly once', async () => {
    await mount()
    await settle()
    await say('first')
    holdQueued = true
    await say('also this')
    // Stored on the server, its 202 still in flight: one "Sending…" bubble.
    expect(releaseQueued).toBeTruthy()
    expect(queuedBubbles()).toEqual(['also this'])
    await reread()
    // The stored queued row is on screen now; the local bubble stepped aside.
    expect(count('also this')).toBe(1)
    expect(queuedBubbles()).toEqual(['also this'])
    expect(host.querySelector('[data-testid="queued-bubble"]')?.textContent).toContain('Queued')
    expect(host.querySelector('[data-testid="queue-note"]')?.textContent).toContain('Your message goes')
    releaseQueued!()
    await settle()
    expect(count('also this')).toBe(1)
    expect(queuedBubbles()).toEqual(['also this'])
  })

  it('two queued messages keep send order when only the first has been stored', async () => {
    await mount()
    await settle()
    await say('first')
    holdQueued = true
    await say('second')
    const releaseSecond = releaseQueued!
    await say('third')
    await reread()
    expect(queuedBubbles()).toEqual(['second', 'third'])
    expect(count('second')).toBe(1)
    expect(count('third')).toBe(1)
    releaseSecond()
    releaseQueued!()
    await settle()
    expect(queuedBubbles()).toEqual(['second', 'third'])
  })

  it('a double submit of one draft sends one message', async () => {
    await mount()
    await settle()
    await type('only once')
    // Two submits before the box re-renders empty (double Enter).
    const form = box().closest('form')!
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    await settle()
    expect(posts('/messages')).toHaveLength(1)
    expect(count('only once')).toBe(1)
  })

  it('a 202 that lands after the delivered row is already on screen does not add the queued row back', async () => {
    const { mergeThread } = await import('./AgentChatPage')
    const shown = { messages: [row(10, 'user', 'first'), row(11, 'assistant', 'one'), row(14, 'user', 'late', { client_msg_id: 'abcdefgh-1' })], drafts: [], cards: [] }
    const late = { messages: [row(12, 'user', 'late', { queued: true, client_msg_id: 'abcdefgh-1' })], drafts: [], cards: [], queued: true }
    const merged = mergeThread(shown as never, late as never)
    expect(merged.messages.map(m => m.id)).toEqual([10, 11, 14])
  })
})
