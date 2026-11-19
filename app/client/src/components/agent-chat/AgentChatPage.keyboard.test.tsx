// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 901376 — typing in a bot chat on a phone.

   jsdom does no layout, so this locks the behaviour the layout hangs on:
   1. Touch device (pointer: coarse): Return in the composer is a new line and
      does NOT send; the Send button sends. Desktop: Enter sends.
   2. Phone width + keyboard open: the header detail, the action row, the view
      tabs and the lane tabs are hidden; they come back when the box loses focus.
   3. A narrow DESKTOP window (fine pointer) never folds and still sends on Enter.
   The real-browser measurements and screenshots are in tests/smoke/bot-chat-mobile-keyboard/. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function until(ok: () => boolean, max = 400) {
  for (let i = 0; i < max && !ok(); i++) await new Promise(r => setTimeout(r, 0))
  expect(ok(), 'condition reached').toBe(true)
}
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

const BOT = {
  slug: 'alpha', name: 'Alpha', description: 'Alpha does things.', avatar: 'AL', colour: 'green',
  knowledge_folders: [], tools: ['search'], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
}
const THREAD = {
  messages: [
    { id: 1, role: 'user', content: 'Hello there', provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-17 09:00:00' },
    { id: 2, role: 'assistant', content: 'Hello back', provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-17 09:00:01' },
  ],
  drafts: [], cards: [],
}

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement
let posts: string[]

/** Pretend to be a device: which media queries match. */
function device({ coarse, narrow }: { coarse: boolean; narrow: boolean }) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    media: q,
    matches: q === '(pointer: coarse)' ? coarse : /max-width:\s*639px/.test(q) ? narrow : false,
    addEventListener() {}, removeEventListener() {},
  }))
}

beforeEach(() => {
  posts = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST' && /\/messages/.test(url)) { posts.push(String(init.body)); return json(THREAD) }
    if (url === '/api/agent-chat/agents') return json({ agents: [BOT], demo: false, providers: { demo: true }, default_provider: null })
    if (/^\/api\/agent-chat\/agents\/alpha\/messages/.test(url)) return json(THREAD)
    return json({})
  }))
})
afterEach(() => {
  root?.unmount()
  host?.remove()
  vi.unstubAllGlobals()
})

async function mount() {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { AgentChatPage } = await import('./AgentChatPage')
  root.render(
    <MemoryRouter initialEntries={['/chat/alpha']}>
      <Routes>
        <Route path="/chat/:slug" element={<AgentChatPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await until(() => (host.textContent ?? '').includes('Hello back'))
  return host.querySelector<HTMLTextAreaElement>('textarea#agent-chat-input')!
}

function type(box: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, value)
  box.dispatchEvent(new Event('input', { bubbles: true }))
}
/** Press Enter; returns true when the page cancelled the key (so no new line is typed). */
function pressEnter(box: HTMLTextAreaElement, shiftKey = false): boolean {
  const e = new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true })
  box.dispatchEvent(e)
  return e.defaultPrevented
}

const hidden = (el: Element | null) => !!el && /(^|\s)hidden(\s|$)/.test(el.getAttribute('class') ?? '')
const chrome = () => ({
  actions: host.querySelector('[data-testid="bot-header-actions"]'),
  views: host.querySelector('[data-testid="bot-view-tabs"]'),
  lanes: host.querySelector('[data-testid="lane-strip"]'),
  header: host.querySelector('section[aria-label="Conversation with Alpha"] > header'),
})

describe('Enter in the bot chat composer (obj 901376)', () => {
  it('desktop: Enter sends, Shift+Enter does not', async () => {
    device({ coarse: false, narrow: false })
    const box = await mount()
    expect(box.getAttribute('enterkeyhint')).toBe('send')
    type(box, 'first line')
    await until(() => box.value === 'first line')
    expect(pressEnter(box, true)).toBe(false)
    await wait(20)
    expect(posts).toHaveLength(0)
    expect(pressEnter(box)).toBe(true)
    await until(() => posts.length === 1)
    expect(posts[0]).toContain('first line')
  })

  it('a narrow desktop window (fine pointer) still sends on Enter', async () => {
    device({ coarse: false, narrow: true })
    const box = await mount()
    type(box, 'narrow window')
    await until(() => box.value === 'narrow window')
    expect(pressEnter(box)).toBe(true)
    await until(() => posts.length === 1)
  })

  it('touch device: Return is left alone (a new line) and nothing is sent; the Send button sends', async () => {
    device({ coarse: true, narrow: true })
    const box = await mount()
    expect(box.getAttribute('enterkeyhint')).toBe('enter')
    type(box, 'line one')
    await until(() => box.value === 'line one')
    expect(pressEnter(box)).toBe(false)
    await wait(30)
    expect(posts).toHaveLength(0)
    expect(box.value).toBe('line one')

    const send = Array.from(host.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Send')!
    send.click()
    await until(() => posts.length === 1)
    expect(posts[0]).toContain('line one')
  })
})

describe('chat chrome folds while the phone keyboard is open (obj 901376)', () => {
  it('phone: focusing the box hides the header detail, actions, view tabs and lane tabs; blur brings them back', async () => {
    device({ coarse: true, narrow: true })
    const box = await mount()
    const c = chrome()
    expect(hidden(c.actions)).toBe(false)
    expect(hidden(c.views)).toBe(false)
    expect(hidden(c.lanes)).toBe(false)
    expect(host.textContent).toContain('Answers with')

    box.focus()
    await until(() => chrome().header?.getAttribute('data-compact') === 'true')
    expect(hidden(chrome().actions)).toBe(true)
    expect(hidden(chrome().views)).toBe(true)
    expect(hidden(chrome().lanes)).toBe(true)
    const detail = Array.from(host.querySelectorAll('header p')).find(p => p.textContent?.includes('Answers with'))!
    expect(hidden(detail)).toBe(true)
    // The bot's name, the back button, the list and the composer all stay.
    expect(chrome().header?.textContent).toContain('Alpha')
    expect(host.querySelector('[data-testid="chat-message-list"]')).toBeTruthy()
    expect(Array.from(host.querySelectorAll('button')).some(b => b.textContent?.trim() === 'Send')).toBe(true)

    box.blur()
    await until(() => chrome().header?.getAttribute('data-compact') === null)
    expect(hidden(chrome().actions)).toBe(false)
    expect(hidden(chrome().views)).toBe(false)
    expect(hidden(chrome().lanes)).toBe(false)
    expect(hidden(detail)).toBe(false)
  })

  it('desktop, narrow window: focusing the box folds nothing', async () => {
    device({ coarse: false, narrow: true })
    const box = await mount()
    box.focus()
    await wait(30)
    const c = chrome()
    expect(c.header?.getAttribute('data-compact')).toBeNull()
    expect(hidden(c.actions)).toBe(false)
    expect(hidden(c.views)).toBe(false)
    expect(hidden(c.lanes)).toBe(false)
  })

  it('touch tablet (wide screen): Return is a new line but the chrome stays', async () => {
    device({ coarse: true, narrow: false })
    const box = await mount()
    box.focus()
    await wait(30)
    expect(chrome().header?.getAttribute('data-compact')).toBeNull()
    type(box, 'tablet')
    await until(() => box.value === 'tablet')
    expect(pressEnter(box)).toBe(false)
    await wait(20)
    expect(posts).toHaveLength(0)
  })
})
