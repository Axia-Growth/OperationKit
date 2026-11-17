// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { usesPageScroll } from '../../lib/routes'

/* obj 901252 — the Bots page never scrolls the WINDOW.

   Operator's report (2026-11-17): on a bot's chat page the document scrolled past
   the app into a blank area below the composer. Cause: an absolutely positioned
   descendant inside the message list (the sr-only "Pro:" / "Con:" labels of a
   decision briefing; the needs-you reply label is the same shape) had no
   POSITIONED ancestor, so its containing block was the viewport. It escaped
   every overflow box, sat at its static spot thousands of pixels down the
   thread and stretched the document (measured: 4241px tall at 1280x800).

   jsdom does no layout, so this locks the invariant that makes the window
   unscrollable instead of measuring it:
   1. The chat route uses the fixed-height shell (not page-scroll mode).
   2. The page root is positioned, h-full + min-h-0, and clips with
      overflow-clip, so nothing below it can add to the document's height.
   3. Every absolutely positioned element on the page (sr-only, absolute,
      after:absolute) has its containing block INSIDE every scroll/clip box it
      sits in — so each scroller clips it and it can never stretch the document.
   4. The message list is the conversation's scroller: relative, min-h-0,
      flex-1, overflow-y-auto. The composer sits after it, outside it.
   The real-browser measurement (scrollHeight === innerHeight at 1280x800,
   1440x900, 390x844) is committed in tests/smoke/bot-chat-viewport/. */

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 2, username: 'jordan', role: 'admin' }, loading: false }),
}))

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = false
Element.prototype.scrollTo = function scrollTo() {}

async function until(ok: () => boolean, max = 400) {
  for (let i = 0; i < max && !ok(); i++) await new Promise(r => setTimeout(r, 0))
  expect(ok(), 'rendered').toBe(true)
}

const BOT = {
  slug: 'alpha', name: 'Alpha', description: 'Alpha does things.', avatar: 'AL', colour: 'green',
  knowledge_folders: [], tools: ['search'], model: null, provider: null,
  version: '1.0.0', author: 'Operation Kit', source: 'file', answered_by: { id: 'demo', model: 'scripted' },
}

const msg = (id: number, role: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, role, content, provider: null, model: null, tool_name: null, meta: null, created_at: '2026-11-17 09:00:00', ...extra,
})

/** A long thread with tool-activity rows and a decision briefing early on (Operator's shape). */
function longThread() {
  const messages: ReturnType<typeof msg>[] = []
  let id = 1
  for (let i = 0; i < 30; i++) {
    messages.push(msg(id++, 'user', `Question ${i}: what is stuck on the board?`))
    messages.push(msg(id++, 'tool', `Read card #90120${i}`, { tool_name: 'read_card' }))
    messages.push(msg(id++, 'tool', 'Listed 21 of 21 board cards', { tool_name: 'list_objectives' }))
    if (i === 2) messages.push(msg(id++, 'tool', 'Raised a decision on card #3', { tool_name: 'raise_decision', meta: { decision_id: 1 } }))
    messages.push(msg(id++, 'assistant', `Answer ${i}. ${'Here is the plan. '.repeat(20)}`))
  }
  return { messages, drafts: [], cards: [] }
}

const DECISION = {
  id: 1, objective_id: 3, workspace: 'operationkit', agent_slug: 'alpha', source: 'bot', state: 'open',
  incomplete: false, flags: [],
  briefing: {
    context: 'The batch is drafted. Sending is the last step before replies arrive.',
    question: 'Send the batch today?',
    options: [
      { key: 'A', label: 'Send today', pros: ['Replies before the weekend'], cons: ['No second review'], next: 'I send it.' },
      { key: 'B', label: 'Hold', pros: ['Better open rate'], cons: ['Replies on Monday'], next: 'I draft 2 lines.' },
    ],
    recommended: 'A', recommended_why: 'Lines match the best performer.',
  },
  raw_note: null, chosen: null, decided_by: null, decided_at: null, decision_note: null, outcome: null,
  outcome_text: null, withdrawn_reason: null, delivered_to: null, thread: [],
  created_at: '2026-11-17 09:00:00', updated_at: '2026-11-17 09:00:00',
}

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/agent-chat/agents') return json({ agents: [BOT], demo: false, providers: { demo: true }, default_provider: null })
    if (/^\/api\/agent-chat\/agents\/alpha\/messages/.test(url)) return json(longThread())
    if (/^\/api\/decisions\/1(\?|$)/.test(url)) return json({ decision: DECISION })
    return json({})
  }))
})
afterEach(() => {
  root?.unmount()
  host?.remove()
  vi.unstubAllGlobals()
})

async function mount(path: string) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const { AgentChatPage } = await import('./AgentChatPage')
  root.render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/chat" element={<AgentChatPage />} />
        <Route path="/chat/:slug" element={<AgentChatPage />} />
      </Routes>
    </MemoryRouter>,
  )
  await until(() => !!host.querySelector('[data-testid="chat-page"]') && (host.textContent ?? '').includes('Answer 29'))
  // The decision briefing (with its sr-only Pro/Con labels) is what used to escape.
  await until(() => (host.textContent ?? '').includes('Send the batch today?'))
}

const cls = (el: Element) => (typeof el.className === 'string' ? el.className : el.getAttribute('class') ?? '')
const has = (el: Element, re: RegExp) => re.test(cls(el))
const POSITIONED = /(^|\s)(relative|absolute|fixed|sticky)(\s|$)/
const ABSOLUTE = /(^|\s)(absolute|sr-only)(\s|$)/
const AFTER_ABSOLUTE = /(^|\s)(after|before):absolute(\s|$)/
/** A box that scrolls or clips vertically — an escaping absolute child is not clipped by it. */
const SCROLL_OR_CLIP = /(^|\s)overflow-(y-)?(auto|scroll|hidden|clip)(\s|$)/

describe('Bots page fills the viewport; the window never scrolls (obj 901252)', () => {
  it('the chat route uses the fixed-height shell, not page-scroll mode', () => {
    expect(usesPageScroll('/chat')).toBe(false)
    expect(usesPageScroll('/chat/alpha')).toBe(false)
  })

  it('the page root is positioned, fills its parent and clips', async () => {
    await mount('/chat/alpha')
    const page = host.querySelector('[data-testid="chat-page"]')!
    for (const c of ['relative', 'flex', 'h-full', 'min-h-0', 'overflow-clip']) expect(cls(page).split(/\s+/)).toContain(c)
  })

  it('no absolutely positioned element can escape a scroller and stretch the document', async () => {
    await mount('/chat/alpha')
    const page = host.querySelector('[data-testid="chat-page"]')!
    const absolutes = Array.from(page.querySelectorAll('*')).filter(el => has(el, ABSOLUTE) || has(el, AFTER_ABSOLUTE))
    // The fixture really has the shapes that broke: sr-only labels inside the message list.
    const list = page.querySelector('[data-testid="chat-message-list"]')!
    expect(absolutes.filter(el => list.contains(el) && has(el, /(^|\s)sr-only(\s|$)/)).length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const el of absolutes) {
      // Containing block: the nearest positioned ancestor (for ::after, the element itself if positioned).
      let cb: Element | null = has(el, AFTER_ABSOLUTE) && has(el, POSITIONED) && !has(el, ABSOLUTE) ? el : el.parentElement
      while (cb && cb !== host && !has(cb, POSITIONED)) cb = cb.parentElement
      if (!cb || cb === host || !page.contains(cb) && cb !== page) {
        offenders.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 30)}" has no positioned ancestor inside the page`)
        continue
      }
      // Every scroll/clip box between the element and the page root must contain the containing block.
      for (let a = el.parentElement; a && a !== page.parentElement; a = a.parentElement) {
        if (has(a, SCROLL_OR_CLIP) && !a.contains(cb)) {
          offenders.push(`${el.tagName.toLowerCase()} "${(el.textContent ?? '').slice(0, 30)}" escapes <${a.tagName.toLowerCase()} class="${cls(a)}">`)
          break
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the message list is the one scroller and the composer sits below it, outside it', async () => {
    await mount('/chat/alpha')
    const section = host.querySelector('section[aria-label="Conversation with Alpha"]')!
    for (const c of ['flex', 'h-full', 'min-h-0', 'flex-col']) expect(cls(section).split(/\s+/)).toContain(c)
    const list = section.querySelector('[data-testid="chat-message-list"]')!
    for (const c of ['relative', 'min-h-0', 'flex-1', 'overflow-y-auto']) expect(cls(list).split(/\s+/)).toContain(c)
    const composer = section.querySelector('textarea#agent-chat-input')!
    expect(list.contains(composer)).toBe(false)
    expect(list.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Nothing between the section and the list scrolls on its own.
    for (let a = list.parentElement; a && a !== section; a = a.parentElement) expect(has(a, SCROLL_OR_CLIP)).toBe(false)
  })
})
