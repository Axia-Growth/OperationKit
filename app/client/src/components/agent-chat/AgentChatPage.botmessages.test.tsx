import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 900859 — bot-to-bot threads, on the screen.

   The server proves send / wake / reply / authz (app/server/src/services/
   agent-chat/bot-messaging.test.ts and routes/agent-chat-bot-messages.test.ts).
   What only the page can get wrong, asserted here:
     - the "Bot messages" button opens a panel listing THIS bot's threads (the
       request carries ?bot=<slug>), and a thread opens with every entry;
     - a chat row that started or relays a thread links to it;
     - a relayed reply says it came from a bot thread, not "Answered by unknown";
     - /chat/<slug>?bot_thread=<id> opens that thread directly;
     - the panel is read-only: it never POSTs. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'operator', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle(n = 12) {
  for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0))
}

const bot = (slug: string, name: string) => ({
  slug, name, description: `${name} bot.`, avatar: name.slice(0, 2).toUpperCase(), colour: 'blue',
  knowledge_folders: [], tools: ['bot_messages'], model: null, provider: null,
  version: null, author: 'Test', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
})

const MESSAGES = [
  { id: 1, role: 'user', content: 'Ask Beta about deploys', provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-15 09:00:00' },
  { id: 2, role: 'tool', content: 'Messaged Beta in ops (bot conversation #41)', provider: 'anthropic', model: 'm', tool_name: 'message_bot', meta: { ok: true, bot_conversation_id: 41 }, created_at: '2026-11-15 09:00:01' },
  { id: 3, role: 'assistant', content: 'I asked Beta.', provider: 'anthropic', model: 'm', tool_name: null, meta: { provider_label: 'Anthropic API' }, created_at: '2026-11-15 09:00:02' },
  { id: 4, role: 'assistant', content: '**Beta** replied (bot conversation #41):\n\nDeploys go out on Tuesdays.', provider: null, model: null, tool_name: null, meta: { kind: 'bot_reply', bot_conversation_id: 41, bot_message_id: 9 }, created_at: '2026-11-15 09:00:30' },
]

const CONVERSATION = {
  id: 41, workspace: 'ops', initiator_slug: 'alpha', recipient_slug: 'beta', subject: 'Deploy days',
  message_count: 1, last_message_at: '2026-11-15 09:00:30', created_at: '2026-11-15 09:00:01', updated_at: '2026-11-15 09:00:30',
}

const ENTRY = (over: Record<string, unknown>) => ({
  id: 1, kind: 'message', from_slug: 'alpha', to_slug: 'beta', body: '', tool_name: null, depth: 0, in_reply_to: null,
  sent_for: 'operator', status: 'none', attempts: 0, next_attempt_at: null, last_error: null, provider: null, model: null,
  created_at: '2026-11-15 09:00:01', delivered_at: null, ...over,
})

let calls: { url: string; method: string }[] = []
let root: Root
let host: HTMLDivElement

function mount(path = '/chat/alpha') {
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

const buttons = () => [...host.querySelectorAll('button')]
const byText = (t: string) => buttons().find(b => (b.textContent ?? '').trim() === t)
const panel = () => host.querySelector('#bot-messages-panel')

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [bot('alpha', 'Alpha'), bot('beta', 'Beta')], demo: false, providers: { demo: true }, default_provider: null })
    if (url.includes('/threads')) return json({ threads: [], max_open: 10 })
    if (url.includes('/messages')) return json({ messages: MESSAGES, drafts: [], cards: [] })
    if (url.startsWith('/api/agent-chat/bot-conversations/41')) {
      return json({
        conversation: CONVERSATION,
        messages: [
          ENTRY({ id: 7, body: 'What day do deploys go out?', status: 'delivered', delivered_at: '2026-11-15 09:00:30' }),
          ENTRY({ id: 8, kind: 'tool', from_slug: 'beta', to_slug: null, body: 'Searched knowledge for "deploy" (2 found)', tool_name: 'search', ok: true }),
          ENTRY({ id: 9, kind: 'reply', from_slug: 'beta', to_slug: 'alpha', body: 'Deploys go out on Tuesdays.', in_reply_to: 7 }),
        ],
      })
    }
    if (url.startsWith('/api/agent-chat/bot-conversations')) {
      return json({ conversations: [{ ...CONVERSATION, last_preview: 'Deploys go out on Tuesdays.', last_kind: 'reply', pending: 0, failed: 0 }] })
    }
    return json({})
  }))
})

afterEach(() => {
  root.unmount()
  host.remove()
  vi.unstubAllGlobals()
})

describe('Bot messages panel', () => {
  it('is closed until the header button opens it, then lists this bot’s threads', async () => {
    await mount()
    await settle()
    expect(panel()).toBeNull()
    const open = byText('Bot messages')!
    expect(open.getAttribute('aria-expanded')).toBe('false')
    open.click()
    await settle()
    expect(open.getAttribute('aria-expanded')).toBe('true')
    expect(calls.some(c => c.url === '/api/agent-chat/bot-conversations?bot=alpha')).toBe(true)
    expect(panel()?.textContent).toContain('To Beta')
    expect(panel()?.textContent).toContain('Deploys go out on Tuesdays.')
    expect(panel()?.textContent).toContain('#41 · ops')
  })

  it('opens one thread with the message, the tools the other bot used, its reply and the delivery status', async () => {
    await mount()
    await settle()
    byText('Bot messages')!.click()
    await settle()
    ;[...panel()!.querySelectorAll('button')].find(b => (b.textContent ?? '').includes('To Beta'))!.click()
    await settle()
    const text = panel()!.textContent ?? ''
    expect(text).toMatch(/Alpha\s*and\s*Beta/)
    expect(text).toContain('Bot conversation #41 · ops · Deploy days')
    expect(text).toContain('What day do deploys go out?')
    expect(text).toContain('Answered')
    expect(text).toContain('for operator')
    expect(panel()!.querySelector('[data-testid="bot-thread-tool"]')?.textContent).toContain('Beta used search')
    expect(text).toContain('Deploys go out on Tuesdays.')
    // Back to the list.
    buttons().find(b => b.getAttribute('aria-label') === 'Back to all bot messages')!.click()
    await settle()
    expect(panel()?.textContent).toContain('To Beta')
    // Read-only: the panel never writes.
    expect(calls.filter(c => c.url.includes('bot-conversations') && c.method !== 'GET')).toHaveLength(0)
  })

  it('chat rows link to their thread, and a relayed reply says where it came from', async () => {
    await mount()
    await settle()
    const links = buttons().filter(b => (b.textContent ?? '').trim() === 'Open bot thread #41')
    // The message_bot tool line AND the relayed reply each link to the thread.
    expect(links).toHaveLength(2)
    const answeredBy = [...host.querySelectorAll('[data-testid="answered-by"]')].map(n => n.textContent ?? '')
    expect(answeredBy.some(t => t.includes('From a bot thread'))).toBe(true)
    expect(answeredBy.some(t => t.includes('Answered by unknown'))).toBe(false)
    links[0].click()
    await settle()
    expect(panel()?.textContent).toMatch(/Alpha\s*and\s*Beta/)
    expect(calls.some(c => c.url === '/api/agent-chat/bot-conversations/41')).toBe(true)
  })

  it('?bot_thread=<id> opens that thread directly', async () => {
    await mount('/chat/alpha?bot_thread=41')
    await settle()
    expect(panel()?.textContent).toMatch(/Alpha\s*and\s*Beta/)
  })
})
