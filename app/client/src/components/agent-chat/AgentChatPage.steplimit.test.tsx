import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'

/* obj 901488 — what the person sees:
     A. a turn that hit the step limit shows its summary as a normal answer with
        a small "Stopped at the step limit" note and a Continue button — not the
        red "Couldn't answer" box;
     B. a message sent mid-turn shows "Queued" and can be removed; after a Stop
        it shows "Waiting for you" with a "Send it now" button;
     C. a send that "failed" with a 524 while the server has the message leaves
        the box EMPTY; the same words sent again as a new message ask "This
        already went through. Send again?" and run nothing until the person
        says yes; a retry of the same send (same id) is a quiet note.
   createRoot idiom (no @testing-library in this client), fetch stubbed per URL. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'member' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function settle() {
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 0))
}

const AGENT = {
  slug: 'helper', name: 'Operation Kit Dev', description: 'Builds things.', avatar: 'OK', colour: 'blue',
  knowledge_folders: [], tools: [], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'install', answered_by: { id: 'anthropic', model: 'claude-sonnet-5' },
}

type Msg = { id: number; role: string; content: string; meta: Record<string, unknown> | null; created_at: string; tool_name: string | null }
const row = (id: number, role: string, content: string, meta: Record<string, unknown> | null = null, tool: string | null = null): Msg =>
  ({ id, role, content, meta, created_at: '2026-11-18 23:00:00', tool_name: tool, ...{ provider: 'anthropic', model: 'claude-sonnet-5', images: [] } })

type Thread = { messages: Msg[]; drafts: []; cards: []; turn?: { running: boolean; queued: number; held?: number } }
let calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
let root: Root
let host: HTMLDivElement
/** What GET /messages answers right now. */
let serverThread: Thread
/** What POST /messages does: tests set it per case. */
let onPost: (body: Record<string, unknown>) => Response | Promise<Response>

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
/** What Cloudflare answers when the origin took too long: an HTML page, no JSON of ours. */
const cloudflare524 = () => new Response('<html><body>error code: 524</body></html>', { status: 524, headers: { 'Content-Type': 'text/html' } })

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
const button = (label: string) => [...host.querySelectorAll('button')].find(b => (b.textContent ?? '').trim() === label) as HTMLButtonElement | undefined
const posts = (suffix: string) => calls.filter(c => c.method === 'POST' && c.url.endsWith(suffix))
const alerts = () => [...host.querySelectorAll('[role="alert"]')].map(a => a.textContent ?? '')
/** Any dialog or prompt anywhere on the page (the confirm dialog renders outside the chat). */
const dialogs = () => document.body.querySelectorAll('[role="dialog"], [role="alertdialog"]').length

async function say(text: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(box(), text)
  box().dispatchEvent(new Event('input', { bubbles: true }))
  await settle()
  sendButton().click()
  await settle()
}

beforeEach(() => {
  calls = []
  serverThread = { messages: [], drafts: [], cards: [], turn: { running: false, queued: 0, held: 0 } }
  onPost = () => json({ error: 'not expected' }, 500)
  vi.stubGlobal('confirm', vi.fn(() => { throw new Error('window.confirm must never be used') }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    let body: Record<string, unknown> | undefined
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined } catch { body = undefined }
    calls.push({ url, method, body })
    if (url === '/api/agent-chat/agents') return json({ agents: [AGENT], demo: false, providers: { anthropic: true }, default_provider: 'anthropic' })
    if (url.endsWith('/messages') && method === 'GET') return json(serverThread)
    if (url.endsWith('/messages') && method === 'POST') return onPost(body ?? {})
    if (url.endsWith('/queued/release') && method === 'POST') {
      const released = serverThread.messages.filter(m => m.meta?.held).length
      serverThread = { ...serverThread, messages: serverThread.messages.map(m => (m.meta?.held ? { ...m, meta: { queued: true } } : m)), turn: { running: true, queued: released, held: 0 } }
      return json({ released, turn: serverThread.turn })
    }
    if (/\/queued\/\d+$/.test(url) && method === 'DELETE') {
      const id = Number(url.split('/').pop())
      serverThread = { ...serverThread, messages: serverThread.messages.filter(m => m.id !== id), turn: { running: !!serverThread.turn?.running, queued: 0, held: 0 } }
      return json({ ok: true, removed: id, turn: serverThread.turn })
    }
    if (url.endsWith('/threads')) return json({ threads: [], max_open: 5 })
    return json({})
  }))
})

afterEach(() => {
  root?.unmount()
  host?.remove()
  vi.unstubAllGlobals()
})

describe('A. the step-limit summary (obj 901488)', () => {
  const stopped = (): Thread => ({
    messages: [
      row(1, 'user', 'merge the open PRs and deploy'),
      row(2, 'tool', 'Read decisions/2026-11-18-deploy.md', { ok: true }, 'read_file'),
      row(3, 'tool', 'Created card #901486: Fix the deploy check', { ok: true, objective_id: 901486 }, 'create_objective'),
      row(4, 'assistant', '**Done** – read the deploy decision and filed card #901486.\n\n**Not done** – the merges and the deploy.\n\n**Next step** – merge PR #904.', { kind: 'step_limit', steps: 8, provider_label: 'Claude' }),
    ],
    drafts: [], cards: [], turn: { running: false, queued: 0, held: 0 },
  })

  it('shows the summary as a normal answer with a "stopped at the step limit" note and Continue — not the red box', async () => {
    serverThread = stopped()
    await mount()
    await settle()
    expect(host.textContent).toContain('filed card #901486')
    const note = host.querySelector('[data-testid="step-limit-note"]')
    expect(note?.textContent).toContain('Stopped at the step limit (8 steps)')
    expect(button('Continue')).toBeTruthy()
    // Nothing red.
    expect(alerts()).toEqual([])
    expect(host.textContent).not.toContain("Couldn't answer")
    expect(host.textContent).not.toContain('without a final answer')
  })

  it('a long reply that ran out of its budget (kind turn_limit) gets the same Continue button', async () => {
    const t = stopped()
    t.messages[3] = row(4, 'assistant', "I reached this reply's step limit (60 steps) before I finished.", { kind: 'turn_limit', limit: 'steps', provider_label: 'Claude' })
    serverThread = t
    await mount()
    await settle()
    expect(host.querySelector('[data-testid="step-limit-note"]')?.textContent).toContain('Stopped at the step limit.')
    expect(button('Continue')).toBeTruthy()
    expect(alerts()).toEqual([])
  })

  it('Continue resumes from that answer: one POST with continue_from, the box untouched', async () => {
    serverThread = stopped()
    onPost = body => {
      const u = row(5, 'user', 'Continue from where you stopped.', { kind: 'continue', continue_from: 4, client_msg_id: body.client_msg_id })
      const a = row(6, 'assistant', 'Merged PR #904 and deployed.')
      serverThread = { ...serverThread, messages: [...serverThread.messages, u, a] }
      return json({ messages: [u, a], drafts: [], cards: [], queued: false, turn: serverThread.turn })
    }
    await mount()
    await settle()
    button('Continue')!.click()
    await settle()
    const sent = posts('/messages')
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toMatchObject({ continue_from: 4 })
    expect(sent[0].body).not.toHaveProperty('text')
    expect(host.textContent).toContain('Merged PR #904 and deployed.')
    // The person has moved past that answer: its Continue button is gone.
    expect(button('Continue')).toBeUndefined()
    expect(box().value).toBe('')
  })

  it('offers Continue only on the newest step-limit answer with nothing sent after it', async () => {
    const t = stopped()
    serverThread = { ...t, messages: [...t.messages, row(5, 'user', 'never mind'), row(6, 'assistant', 'OK.')] }
    await mount()
    await settle()
    expect(host.querySelector('[data-testid="step-limit-note"]')).toBeTruthy()
    expect(button('Continue')).toBeUndefined()
  })

  it('a real failure with nothing to report still shows the red box', async () => {
    serverThread = { messages: [row(1, 'user', 'hi'), row(2, 'error', 'The AI provider failed: 400')], drafts: [], cards: [], turn: { running: false, queued: 0, held: 0 } }
    await mount()
    await settle()
    expect(alerts().join(' ')).toContain("Couldn't answer")
  })
})

describe('B. queued messages (obj 901488)', () => {
  it('a message waiting behind a running turn shows "Queued" and can be removed before it runs', async () => {
    serverThread = {
      messages: [row(1, 'user', 'long job'), row(2, 'user', 'also update the docs', { queued: true })],
      drafts: [], cards: [], turn: { running: true, queued: 1, held: 0 },
    }
    await mount()
    await settle()
    const bubble = host.querySelector('[data-testid="queued-bubble"]')!
    expect(bubble.textContent).toContain('also update the docs')
    expect(bubble.textContent).toContain('Queued')
    button('Remove')!.click()
    await settle()
    expect(calls.filter(c => c.method === 'DELETE').map(c => c.url)).toEqual(['/api/agent-chat/agents/helper/queued/2'])
    expect(host.querySelector('[data-testid="queued-bubble"]')).toBeNull()
    expect(host.textContent).not.toContain('also update the docs')
  })

  it('after a Stop, a queued message shows "Waiting for you" and goes only when the person presses "Send it now"', async () => {
    serverThread = {
      messages: [row(1, 'user', 'long job'), row(2, 'error', 'You stopped this reply.', { kind: 'stopped' }), row(3, 'user', 'also deploy it', { queued: true, held: true })],
      drafts: [], cards: [], turn: { running: false, queued: 1, held: 1 },
    }
    await mount()
    await settle()
    const bubble = host.querySelector('[data-testid="queued-bubble"]')!
    expect(bubble.textContent).toContain('Waiting for you')
    expect(host.querySelector('[data-testid="held-note"]')?.textContent).toContain('not sent to Operation Kit Dev')
    expect(posts('/queued/release')).toHaveLength(0)
    button('Send it now')!.click()
    await settle()
    expect(posts('/queued/release')).toHaveLength(1)
    expect(host.querySelector('[data-testid="held-note"]')).toBeNull()
  })
})

describe('C. no double runs, and nothing is asked (obj 901488)', () => {
  it('a 524 on a message the server HAS: the box stays empty, no error, no dialog, and the turn is followed', async () => {
    onPost = body => {
      // The server stored the message and is working on it; the proxy gave up waiting.
      serverThread = { ...serverThread, messages: [row(10, 'user', String(body.text), { client_msg_id: body.client_msg_id })], turn: { running: true, queued: 0, held: 0 } }
      return cloudflare524()
    }
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    expect(posts('/messages')).toHaveLength(1)
    expect(box().value).toBe('')
    expect(alerts()).toEqual([])
    expect(host.textContent).not.toContain('Request failed')
    expect(dialogs()).toBe(0)
    // The message is in the thread once, and the bot is shown as working.
    expect(host.textContent!.split('merge the PRs and deploy').length - 1).toBe(1)
    expect(host.querySelector('[data-testid="bot-working"]')).toBeTruthy()
  })

  it('a send that really did not arrive hands the text back, and sending it again is the SAME send (same id)', async () => {
    let attempt = 0
    onPost = body => {
      attempt++
      if (attempt === 1) return cloudflare524() // never reached the server: nothing stored
      const u = row(10, 'user', String(body.text), { client_msg_id: body.client_msg_id })
      const a = row(11, 'assistant', 'Done.')
      serverThread = { ...serverThread, messages: [u, a] }
      return json({ messages: [u, a], drafts: [], cards: [], queued: false, turn: serverThread.turn })
    }
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    expect(box().value).toBe('merge the PRs and deploy')
    expect(alerts().join(' ')).toContain('Request failed: 524')
    sendButton().click()
    await settle()
    const sent = posts('/messages')
    expect(sent).toHaveLength(2)
    expect(sent[1].body?.client_msg_id).toBe(sent[0].body?.client_msg_id)
    expect(box().value).toBe('')
    expect(host.textContent).toContain('Done.')
  })

  const askPrompt = () => host.querySelector('[data-testid="send-again-prompt"]')
  const askButton = (label: string) => [...(askPrompt()?.querySelectorAll('button') ?? [])].find(x => x.textContent === label) as HTMLButtonElement

  it('the same words sent again while the first is running: asks "This already went through. Send again?" and runs nothing', async () => {
    const first = row(10, 'user', 'merge the PRs and deploy', { client_msg_id: 'first-send-0001' })
    serverThread = { messages: [first], drafts: [], cards: [], turn: { running: true, queued: 0, held: 0 } }
    onPost = () => json({ messages: [first], drafts: [], cards: [], queued: false, duplicate: true, duplicate_state: 'running', duplicate_by: 'text', turn: serverThread.turn })
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    expect(askPrompt()?.textContent).toContain('This already went through. Send again?')
    expect(box().value).toBe('')
    expect(alerts()).toEqual([])
    // One send so far, and it did not carry send_again.
    expect(posts('/messages')).toHaveLength(1)
    expect(posts('/messages')[0].body?.send_again).toBeUndefined()
    // Still one message in the thread.
    expect(host.textContent!.split('merge the PRs and deploy').length - 1).toBe(1)
  })

  it('"No" closes the question and sends nothing more', async () => {
    const first = row(10, 'user', 'merge the PRs and deploy')
    serverThread = { messages: [first], drafts: [], cards: [], turn: { running: true, queued: 0, held: 0 } }
    onPost = () => json({ messages: [first], drafts: [], cards: [], queued: false, duplicate: true, duplicate_state: 'running', duplicate_by: 'text', turn: serverThread.turn })
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    askButton('No').click()
    await settle()
    expect(askPrompt()).toBeNull()
    expect(posts('/messages')).toHaveLength(1)
    expect(host.textContent!.split('merge the PRs and deploy').length - 1).toBe(1)
  })

  it('"Send again" sends the same words once more with send_again and a new id', async () => {
    const first = row(10, 'user', 'merge the PRs and deploy')
    serverThread = { messages: [first], drafts: [], cards: [], turn: { running: true, queued: 0, held: 0 } }
    onPost = body => {
      if (body?.send_again !== true) return json({ messages: [first], drafts: [], cards: [], queued: false, duplicate: true, duplicate_state: 'running', duplicate_by: 'text', turn: serverThread.turn })
      const q = row(12, 'user', 'merge the PRs and deploy', { queued: true, client_msg_id: String(body.client_msg_id) })
      serverThread = { ...serverThread, messages: [first, q], turn: { running: true, queued: 1, held: 0 } }
      return json({ messages: [q], drafts: [], cards: [], queued: true, turn: serverThread.turn }, 202)
    }
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    askButton('Send again').click()
    await settle()
    const sent = posts('/messages')
    expect(sent).toHaveLength(2)
    expect(sent[1].body).toMatchObject({ text: 'merge the PRs and deploy', send_again: true })
    expect(sent[1].body?.client_msg_id).not.toBe(sent[0].body?.client_msg_id)
    expect(askPrompt()).toBeNull()
    expect(host.textContent!.split('merge the PRs and deploy').length - 1).toBe(2)
  })

  it('a repeat of a message that was just answered also asks, and the answer is not shown twice', async () => {
    const u = row(10, 'user', 'status?')
    const a = row(11, 'assistant', 'All green.')
    serverThread = { messages: [u, a], drafts: [], cards: [], turn: { running: false, queued: 0, held: 0 } }
    onPost = () => json({ messages: [u, a], drafts: [], cards: [], queued: false, duplicate: true, duplicate_state: 'answered', duplicate_by: 'text', turn: serverThread.turn })
    await mount()
    await settle()
    await say('status?')
    expect(askPrompt()?.textContent).toContain('This already went through. Send again?')
    expect(host.textContent!.split('All green.').length - 1).toBe(1)
  })

  it('a retry of the SAME send (same id) is one message: a quiet note, no question', async () => {
    const first = row(10, 'user', 'merge the PRs and deploy', { client_msg_id: 'first-send-0001' })
    serverThread = { messages: [first], drafts: [], cards: [], turn: { running: true, queued: 0, held: 0 } }
    onPost = () => json({ messages: [first], drafts: [], cards: [], queued: false, duplicate: true, duplicate_state: 'running', duplicate_by: 'id', turn: serverThread.turn })
    await mount()
    await settle()
    await say('merge the PRs and deploy')
    const note = host.querySelector('[data-testid="duplicate-note"]')
    expect(note?.textContent).toBe('Already sent, still working.')
    expect(note?.getAttribute('role')).toBe('status')
    expect(askPrompt()).toBeNull()
    expect(dialogs()).toBe(0)
  })
})
