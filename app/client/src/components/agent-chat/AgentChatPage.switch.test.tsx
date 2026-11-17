import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 900865 — switching bots is immediate and never blank.

   Locked here:
   1. A switch does NOT remount the page: the bot list is fetched once, and the
      sidebar element on screen before the click is the same one after it.
   2. A bot never seen before (its messages still on the wire) shows its header,
      a skeleton and a working composer at once — never an empty pane.
   3. A bot seen before paints its conversation from memory on the click, even
      when the network is not answering at all.
   4. Pointing at a bot in the sidebar warms it, so the click that follows does
      not fetch it again.
   5. Before the bot list has arrived, BOTH panes show a skeleton.

   createRoot idiom (no @testing-library in this client), fetch stubbed per URL,
   and each bot's /messages can be held open to model a slow server. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}
/**
 * Wait (bounded) until a switch has rendered. React Router commits a navigation
 * as a transition, which jsdom works through in several macrotasks. Callers
 * make sure no fetch can answer meanwhile (held, or the network is gone), so
 * whatever paints came from memory, not from the server.
 */
async function until(ok: () => boolean, max = 200) {
  for (let i = 0; i < max && !ok(); i++) await new Promise(r => setTimeout(r, 0))
  expect(ok(), 'switch rendered').toBe(true)
}

const bot = (slug: string, name: string) => ({
  slug, name, description: `${name} does things.`, avatar: name.slice(0, 2).toUpperCase(), colour: 'green',
  knowledge_folders: [], tools: ['search'], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
})
const BOTS = [bot('alpha', 'Alpha'), bot('beta', 'Beta'), bot('gamma', 'Gamma')]
const thread = (slug: string) => ({
  messages: [
    { id: 1, role: 'user', content: `Question for ${slug}`, provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-14 09:00:00' },
    { id: 2, role: 'assistant', content: `Hello from ${slug}`, provider: 'demo', model: 'scripted', tool_name: null, meta: null, created_at: '2026-11-14 09:00:01' },
  ],
  drafts: [],
  cards: [],
})

let calls: { url: string; method: string }[] = []
/** Slugs whose /messages GET is held open until released. */
let hold = new Set<string>()
let held: { slug: string; release: () => void }[] = []
/** When true, every /messages GET hangs forever (the network is gone). */
let offline = false
let rosterHang = false
let root: Root
let host: HTMLDivElement

function mount(path: string) {
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

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })
const msgGets = (slug: string) => calls.filter(c => c.method === 'GET' && c.url === `/api/agent-chat/agents/${slug}/messages`).length
const rosterGets = () => calls.filter(c => c.url === '/api/agent-chat/agents').length
const nav = () => host.querySelector('nav[aria-label="Bots"]') as HTMLElement
const rowButton = (slug: string) => nav().querySelector(`li[data-bot="${slug}"] button`) as HTMLButtonElement
const conversation = (name: string) => host.querySelector(`section[aria-label="Conversation with ${name}"]`)
const main = () => host.querySelector('main') as HTMLElement
const skeleton = () => host.querySelector('[data-testid="messages-skeleton"]')

/** The conversation pane is never blank: it has a bot header and either messages or a skeleton, plus the composer. */
function assertPaneNotBlank(name: string) {
  const c = conversation(name)
  expect(c, `conversation with ${name} on screen`).not.toBeNull()
  expect(c!.querySelector('h2')?.textContent).toBe(name)
  expect(c!.querySelector('textarea#agent-chat-input')).not.toBeNull()
  const hasMessages = (c!.textContent ?? '').includes('Hello from')
  expect(hasMessages || !!skeleton(), 'messages or a skeleton').toBe(true)
}

beforeEach(() => {
  calls = []
  hold = new Set()
  held = []
  offline = false
  rosterHang = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    if (url === '/api/agent-chat/agents') {
      if (rosterHang) return new Promise<Response>(() => {})
      return json({ agents: BOTS, demo: false, providers: { demo: true }, default_provider: null })
    }
    const m = url.match(/^\/api\/agent-chat\/agents\/([^/]+)\/messages$/)
    if (m && method === 'GET') {
      const slug = decodeURIComponent(m[1])
      if (offline) return new Promise<Response>(() => {})
      if (hold.has(slug)) return new Promise<Response>(resolve => held.push({ slug, release: () => resolve(json(thread(slug))) }))
      return json(thread(slug))
    }
    if (url.endsWith('/threads')) return json({ threads: [], max_open: 5 })
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('switching bots (obj 900865)', () => {
  it('does not remount the page: one bot-list fetch, the same sidebar element', async () => {
    await mount('/chat/alpha')
    await settle()
    expect(conversation('Alpha')?.textContent).toContain('Hello from alpha')
    const aside = host.querySelector('aside')

    rowButton('beta').click()
    // A navigation commits as a transition over a variable number of macrotasks
    // (more on a loaded CI runner), so wait for it, bounded, like the tests below.
    await until(() => !!conversation('Beta')?.textContent?.includes('Hello from beta'))
    expect(conversation('Beta')?.textContent).toContain('Hello from beta')
    rowButton('gamma').click()
    // A navigation commits as a transition over a variable number of macrotasks
    // (more on a loaded CI runner), so wait for it, bounded, like the tests below.
    await until(() => !!conversation('Gamma')?.textContent?.includes('Hello from gamma'))
    expect(conversation('Gamma')?.textContent).toContain('Hello from gamma')

    expect(host.querySelector('aside')).toBe(aside)
    expect(rosterGets()).toBe(1)
    // The sidebar marks the bot you are on, and only it.
    expect(rowButton('gamma').getAttribute('aria-current')).toBe('page')
    expect(rowButton('alpha').getAttribute('aria-current')).toBeNull()
    // The picked row lights up at once (no colour fade on the active row); the row you left still fades out.
    expect(rowButton('gamma').className).not.toMatch(/\btransition-colors\b/)
    expect(rowButton('alpha').className).toMatch(/\btransition-colors\b/)
  })

  it('a bot whose messages are still loading shows its header, a skeleton and the composer — never a blank pane', async () => {
    await mount('/chat/alpha')
    await settle()
    hold.add('beta')

    rowButton('beta').click()
    await until(() => !!conversation('Beta'))
    assertPaneNotBlank('Beta')
    expect(skeleton()).not.toBeNull()
    expect(conversation('Alpha')).toBeNull()

    // Nothing changes while the server is slow…
    await settle()
    assertPaneNotBlank('Beta')
    // …and the conversation replaces the skeleton the moment it lands.
    held.filter(h => h.slug === 'beta').forEach(h => h.release())
    await settle()
    expect(conversation('Beta')?.textContent).toContain('Hello from beta')
    expect(skeleton()).toBeNull()
  })

  it('a bot seen before paints from memory on the click, with the network gone', async () => {
    await mount('/chat/alpha')
    await settle()
    rowButton('beta').click()
    await settle()
    expect(conversation('Beta')?.textContent).toContain('Hello from beta')

    offline = true // every refresh from here on hangs forever
    rowButton('alpha').click()
    await until(() => !!conversation('Alpha'))
    expect(conversation('Alpha')?.textContent).toContain('Hello from alpha')
    expect(skeleton()).toBeNull()

    rowButton('beta').click()
    await until(() => !!conversation('Beta'))
    expect(conversation('Beta')?.textContent).toContain('Hello from beta')
    expect(skeleton()).toBeNull()
  })

  it('pointing at a bot in the sidebar warms it, and the click reuses that read', async () => {
    await mount('/chat/alpha')
    await settle()
    const before = msgGets('gamma')

    rowButton('gamma').dispatchEvent(new MouseEvent('pointerover', { bubbles: true }))
    expect(msgGets('gamma')).toBe(before + 1)
    await settle()

    rowButton('gamma').click()
    await until(() => !!conversation('Gamma'))
    // Painted from the warmed read, with no skeleton in between.
    expect(conversation('Gamma')?.textContent).toContain('Hello from gamma')
    expect(skeleton()).toBeNull()
  })

  it('keyboard focus on a bot warms it too', async () => {
    await mount('/chat/alpha')
    await settle()
    const before = msgGets('beta')
    rowButton('beta').focus()
    expect(msgGets('beta')).toBe(before + 1)
  })

  it('before the bot list arrives, both panes show a skeleton (no empty conversation pane)', async () => {
    rosterHang = true
    await mount('/chat/alpha')
    await settle()
    expect(host.querySelector('[aria-label="Loading bots"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="conversation-skeleton"]')).not.toBeNull()
    expect(main()).toBeNull()
  })

  it('a reply that lands after you switched away stays with the bot it belongs to', async () => {
    await mount('/chat/alpha')
    await settle()
    // Send to alpha, holding the server's answer.
    let answer!: (r: Response) => void
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>
    const inner = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/agent-chat/agents/alpha/messages' && init?.method === 'POST') {
        calls.push({ url, method: 'POST' })
        return new Promise<Response>(r => { answer = r })
      }
      return inner(url, init)
    })
    const box = host.querySelector('textarea#agent-chat-input') as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(box, 'ping')
    box.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(4)
    ;(host.querySelector('form button[type="submit"]') as HTMLButtonElement).click()
    await settle()

    rowButton('beta').click()
    await settle()
    answer(json({
      messages: [{ id: 9, role: 'assistant', content: 'Late reply for alpha', provider: 'demo', model: 'scripted', tool_name: null, meta: null, created_at: '2026-11-14 09:01:00' }],
      drafts: [],
      cards: [],
    }))
    await settle()
    expect(conversation('Beta')?.textContent).not.toContain('Late reply for alpha')

    offline = true
    rowButton('alpha').click()
    await until(() => !!conversation('Alpha'))
    expect(conversation('Alpha')?.textContent).toContain('Late reply for alpha')
  })
})
