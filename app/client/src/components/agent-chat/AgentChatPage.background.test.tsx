import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* A long reply carries on in the background (obj 901491).
   The server answers the send with 202 { background: true } while the reply is
   still working. The page must: show no error, leave the box empty, say the
   reply is working in the background, and pick up each tool line and then the
   answer by re-reading the lane. createRoot idiom, fetch stubbed per URL. */

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

type Msg = { id: number; role: string; content: string; meta: Record<string, unknown> | null; created_at: string; tool_name: string | null }
const row = (id: number, role: string, content: string, tool_name: string | null = null, meta: Record<string, unknown> | null = null): Msg =>
  ({ id, role, content, meta, tool_name, created_at: '2026-11-19 10:00:00', ...{ provider: null, model: null, images: [] } })
const job = (steps: number) => ({ id: 5, background: true, steps, tool_calls: steps, max_steps: 60, max_minutes: 30, started_at: '2026-11-19 10:00:00' })

let calls: { url: string; method: string }[] = []
let root: Root
let host: HTMLDivElement
let serverThread: { messages: Msg[]; drafts: []; cards: []; turn: { running: boolean; queued: number }; turn_job: ReturnType<typeof job> | null }

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
const note = () => host.querySelector('[data-testid="background-note"]')?.textContent ?? null

beforeEach(() => {
  calls = []
  serverThread = { messages: [], drafts: [], cards: [], turn: { running: false, queued: 0 }, turn_job: null }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
    if (url === '/api/agent-chat/agents') return json({ agents: [AGENT], demo: false, providers: { anthropic: true }, default_provider: 'anthropic' })
    if (url.includes('/messages') && method === 'GET') return json(serverThread)
    if (url.endsWith('/messages') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { text: string; client_msg_id?: string }
      const u = row(10, 'user', body.text, null, body.client_msg_id ? { client_msg_id: body.client_msg_id } : null)
      // The reply is still working when the foreground wait ends: 202, background.
      serverThread = { ...serverThread, messages: [u], turn: { running: true, queued: 0 }, turn_job: job(0) }
      return json({ messages: [u], drafts: [], cards: [], queued: false, background: true, turn: serverThread.turn, turn_job: serverThread.turn_job }, 202)
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

describe('a long reply carries on in the background (obj 901491)', () => {
  it('202 background: no error, empty box, a "working in the background" note; tool lines and the answer arrive by re-reading the lane', async () => {
    await mount()
    await settle()
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(box(), 'merge the ten open PRs')
    box().dispatchEvent(new Event('input', { bubbles: true }))
    await settle()
    sendButton().click()
    await settle()

    // Accepted, still working: this is not a failed send.
    expect(host.textContent).not.toContain('Request failed')
    expect(host.textContent).not.toContain('Message not sent')
    expect(box().value).toBe('')
    expect(host.textContent).toContain('merge the ten open PRs')
    expect(host.querySelector('[data-testid="bot-working"]')).toBeTruthy()
    expect(note()).toContain('Working in the background: step 1 of up to 60, 30 minutes at most.')
    expect(note()).toContain('You can leave this page.')

    // Progress: the server has run three tool actions; the page's own re-read shows them.
    serverThread = {
      ...serverThread,
      messages: [...serverThread.messages, row(11, 'tool', 'Merged PR 901', 'dev_merge_pr', { ok: true }), row(12, 'tool', 'Merged PR 902', 'dev_merge_pr', { ok: true }), row(13, 'tool', 'Merged PR 903', 'dev_merge_pr', { ok: true })],
      turn_job: job(3),
    }
    await new Promise(r => setTimeout(r, 2300))
    await settle()
    expect(host.textContent).toContain('Merged PR 903')
    expect(note()).toContain('step 4 of up to 60')

    // Done: the answer is a normal bot message in the same chat, and the lane goes idle.
    serverThread = { ...serverThread, messages: [...serverThread.messages, row(14, 'assistant', 'All ten pull requests are merged.')], turn: { running: false, queued: 0 }, turn_job: null }
    await new Promise(r => setTimeout(r, 2300))
    await settle()
    expect(host.textContent).toContain('All ten pull requests are merged.')
    expect(host.querySelector('[data-testid="bot-working"]')).toBeNull()
    expect(note()).toBeNull()
    // One send, ever: nothing re-posted the message while it ran.
    expect(calls.filter(c => c.method === 'POST' && c.url.endsWith('/messages'))).toHaveLength(1)
  }, 15_000)
})
