import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DecisionQueueItem, DecisionView } from '@operationkit/shared'
import { NeedsYouPage } from './NeedsYouPage'
import { NeedsYouBadge, badgeText } from './NeedsYouBadge'
import { notifyNeedsYouChanged } from './DecisionQA'
import { NeedsYouMessage } from '../agent-chat/NeedsYouMessage'
import { render, click, cleanup } from '../../test/render'
import { paintTheme } from '../../lib/theme'
import type { ChatAgentInfo, ChatMessage } from '../agent-chat/types'

/* obj 901084 — the Needs you stack: one decision at a time, most urgent first,
   briefing + Q&A side thread, Approve / option / Deny / Skip with keyboard
   shortcuts, the one-line result then the next decision; the top-nav badge
   count; and stale chat posts collapsing to one line with no dead buttons. */

function decision(id: number, over: Partial<DecisionView> = {}): DecisionView {
  return {
    id,
    objective_id: 900 + id,
    workspace: 'ops',
    agent_slug: 'outreach',
    source: 'bot',
    state: 'open',
    incomplete: false,
    flags: [],
    briefing: {
      context: `Batch ${id} is drafted and checked against the ICP.`,
      question: `Send batch ${id} today?`,
      options: [
        { key: 'A', label: 'Send today', pros: ['Replies before the weekend'], cons: ['No second review'], next: 'I send it and report bounces.' },
        { key: 'B', label: 'Hold a day', pros: ['Test subject lines'], cons: ['Replies slip'], next: 'I draft 2 subject lines.' },
      ],
      recommended: 'A',
      recommended_why: 'The lines match last month’s best performer.',
    },
    raw_note: null,
    chosen: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    outcome: null,
    outcome_text: null,
    thread: [],
    created_at: '2026-11-15 10:00:00',
    updated_at: '2026-11-15 10:00:00',
    ...over,
  }
}

function item(id: number, over: Partial<DecisionView> = {}, urgency: DecisionQueueItem['urgency'] = 'blocking') {
  return {
    decision: decision(id, over),
    card: { id: 900 + id, title: `Outreach ${id}`, status: urgency === 'blocking' ? 'review' : 'working', workspace: 'ops', project: null, bot: 'outreach', bot_name: 'Outreach Bot' },
    urgency,
  }
}

type Req = { url: string; method: string; body: Record<string, unknown> | null }
let requests: Req[] = []
let queue: ReturnType<typeof item>[] = []
let decideReply: (r: Req, id: number) => { status?: number; body: unknown }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  requests = []
  queue = [item(1), item(2), item(3, {}, 'running')]
  decideReply = (r, id) => {
    const d = queue.find(i => i.decision.id === id)!.decision
    const chosen = String(r.body?.choice)
    queue = queue.filter(i => i.decision.id !== id)
    return { body: { decision: { ...d, state: 'decided', chosen, outcome: 'sent' }, outcome: 'sent', outcome_text: `You chose ${chosen}. Card #${d.objective_id} restarted with your choice.`, can_reopen: false } }
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r: Req = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }
    requests.push(r)
    if (r.url.endsWith('/decisions/queue/count')) return json(200, { count: queue.length })
    if (r.url.endsWith('/decisions/queue')) return json(200, { items: queue, count: queue.length, cleared: 0 })
    const m = r.url.match(/\/decisions\/(\d+)\/decide$/)
    if (m && r.method === 'POST') {
      const out = decideReply(r, Number(m[1]))
      return json(out.status ?? 200, out.body)
    }
    const q = r.url.match(/\/decisions\/(\d+)\/questions$/)
    if (q) {
      const d = queue.find(i => i.decision.id === Number(q[1]))!.decision
      return json(201, { decision: { ...d, thread: [{ id: 1, decision_id: d.id, role: 'human', author: 'operator', body: String(r.body?.body), status: 'answered', in_reply_to: null, created_at: '' }, { id: 2, decision_id: d.id, role: 'bot', author: 'Outreach Bot', body: 'About $4.', status: null, in_reply_to: 1, created_at: '' }] } })
    }
    return json(404, { error: 'not mocked' })
  }))
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

const text = (el: ParentNode | null) => (el as HTMLElement | null)?.textContent ?? ''
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const button = (root: ParentNode, label: string | RegExp) =>
  [...root.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''))) ?? null
const key = (k: string, target: EventTarget = window) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  })
const shownId = (c: HTMLElement) => Number(c.querySelector('[data-testid="stack-card"]')?.getAttribute('data-decision-id'))
const decides = () => requests.filter(r => r.url.endsWith('/decide'))
const RAW_COLOUR = /\b(?:bg|text|border|ring)-(?:white|black|gray|slate|zinc|neutral|stone|red|green|blue|yellow|amber|emerald|orange|sky|indigo|violet|purple|pink|rose|lime|teal|cyan)(?:-\d{2,3})?\b/

async function mount(props: { autoAdvanceMs?: number } = {}) {
  const r = await render(<MemoryRouter><NeedsYouPage autoAdvanceMs={props.autoAdvanceMs ?? 20} pollMs={60_000} /></MemoryRouter>)
  await wait(0)
  return r
}

describe('the stack shows one decision at a time, with the full briefing', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`renders where things stand, the question, options, recommendation and the Q&A thread (${theme})`, async () => {
      paintTheme(theme)
      const { container } = await mount()
      expect(shownId(container)).toBe(1)
      expect(text(container.querySelector('[data-testid="stack-position"]'))).toBe('1 of 3')
      const card = container.querySelector('[data-testid="stack-card"]')!
      expect(text(card)).toContain('Work stopped')
      expect(text(card)).toContain('Where things stand')
      expect(text(card)).toContain('Batch 1 is drafted')
      expect(text(container.querySelector('[data-testid="stack-question"]'))).toBe('Send batch 1 today?')
      expect([...card.querySelectorAll('[data-testid="decision-option"]')].map(o => o.getAttribute('data-key'))).toEqual(['A', 'B'])
      expect(text(container.querySelector('[data-testid="stack-recommendation"]'))).toContain('Recommended: A) Send today.')
      expect(text(card.querySelector('[data-testid="stack-card-link"]'))).toContain('#901 Outreach 1')
      expect(button(card, /Approve A/)).toBeTruthy()
      expect(container.querySelector('[data-testid="decision-qa"]')).toBeTruthy()
      const classes = [container, ...container.querySelectorAll('*')].flatMap(el => [...el.classList])
      expect(classes.filter(c => RAW_COLOUR.test(c))).toEqual([])
    })
  }

  it('shows "no briefing given — ask the bot" for a legacy decision instead of empty text', async () => {
    queue = [item(7, { incomplete: true, flags: ['no_question', 'no_options'], raw_note: 'Want me to send the batch?', briefing: { context: 'Want me to send the batch?', question: '', options: [], recommended: '', recommended_why: '' } })]
    const { container } = await mount()
    const note = container.querySelector('[data-testid="stack-no-briefing"]')
    expect(text(note)).toContain('No briefing given — ask the bot what it needs before you choose.')
    expect(text(note)).toContain('What Outreach Bot said: “Want me to send the batch?”')
    expect(text(container.querySelector('[data-testid="stack-question"]'))).toBe('What is being decided was not stated.')
    expect(button(container, /Approve as proposed/)).toBeTruthy()
    // The empty context is not repeated as "Where things stand".
    expect(text(container)).not.toContain('Where things stand')
  })

  it('a High Agency stop the server wrote a briefing for shows a real decision and says who wrote it (obj 901151)', async () => {
    queue = [item(8, { source: 'job_disposition', flags: ['auto_briefing'], raw_note: 'Decision #6 done: two things to check before the next deploy.' })]
    const { container } = await mount()
    expect(container.querySelector('[data-testid="stack-no-briefing"]')).toBeNull()
    expect(text(container.querySelector('[data-testid="stack-auto-briefing"]'))).toBe('Outreach Bot stopped without a briefing, so this one was written automatically from its note and session summary.')
    expect(text(container.querySelector('[data-testid="stack-question"]'))).not.toBe('What is being decided was not stated.')
    expect([...container.querySelectorAll('[data-testid="decision-option"]')].length).toBeGreaterThanOrEqual(2)
  })

  it('says plainly when nothing needs you', async () => {
    queue = []
    const { container } = await mount()
    expect(text(container.querySelector('[data-testid="stack-empty"]'))).toContain('Nothing needs you right now')
  })
})

describe('stack navigation', () => {
  it('Skip / → and Back / ← move through the stack and wrap', async () => {
    const { container } = await mount()
    await key('ArrowRight')
    expect(shownId(container)).toBe(2)
    expect(text(container.querySelector('[data-testid="stack-position"]'))).toBe('2 of 3')
    await key('s')
    expect(shownId(container)).toBe(3)
    await key('j')
    expect(shownId(container)).toBe(1) // wraps
    await key('ArrowLeft')
    expect(shownId(container)).toBe(3)
    await click(button(container, /^Skip/))
    expect(shownId(container)).toBe(1)
    await click(container.querySelector('button[aria-label="Previous decision"]'))
    expect(shownId(container)).toBe(3)
    expect(decides()).toEqual([]) // moving never answers anything
  })

  it('pressing 2 chooses option B, shows the one-line result, then the next decision slides in', async () => {
    const { container } = await mount({ autoAdvanceMs: 300 })
    await key('2')
    expect(decides()).toHaveLength(1)
    expect(decides()[0].url).toMatch(/\/decisions\/1\/decide$/)
    expect(decides()[0].body).toEqual({ choice: 'B' })
    const res = container.querySelector('[data-testid="stack-result"]')
    expect(text(res)).toContain('You chose B. Card #901 restarted with your choice.')
    expect(res?.getAttribute('data-outcome')).toBe('sent')
    await wait(450)
    expect(container.querySelector('[data-testid="stack-result"]')).toBeNull()
    expect(shownId(container)).toBe(2)
    expect(text(container.querySelector('[data-testid="stack-position"]'))).toBe('1 of 2')
  })

  it('Enter approves the recommendation; the answer after the last one wraps to the first still waiting', async () => {
    const { container } = await mount({ autoAdvanceMs: 10_000 })
    await key('ArrowLeft') // to #3, the last one
    expect(shownId(container)).toBe(3)
    await key('Enter')
    expect(decides()[0].body).toEqual({ choice: 'A' })
    // Don't wait for the timer: → goes straight on.
    await key('ArrowRight')
    await wait(0)
    expect(shownId(container)).toBe(1)
  })

  it('d opens Deny with an optional note; Enter in the note denies with it', async () => {
    const { container } = await mount()
    await key('d')
    const input = container.querySelector('[data-testid="stack-deny-form"] input') as HTMLInputElement
    expect(document.activeElement === input || !!input).toBe(true)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'not this week')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    // Typing letters in the box never fires shortcuts.
    await key('s', input)
    expect(shownId(container)).toBe(1)
    await act(async () => {
      ;(container.querySelector('[data-testid="stack-deny-form"]') as HTMLFormElement).requestSubmit()
    })
    expect(decides()[0].body).toEqual({ choice: 'deny', note: 'not this week' })
  })

  it('a job that ended by asking shows Reopen and apply and does not move on by itself', async () => {
    decideReply = (r, id) => {
      const d = queue.find(i => i.decision.id === id)!.decision
      if (r.body?.reopen) {
        queue = queue.filter(i => i.decision.id !== id)
        return { body: { decision: { ...d, state: 'decided', chosen: 'A', outcome: 'reopened' }, outcome: 'reopened', outcome_text: `Card #${d.objective_id} was done, so it was reopened and your choice sent.`, can_reopen: false } }
      }
      return { body: { decision: { ...d, state: 'decided', chosen: 'A', outcome: 'card_done' }, outcome: 'card_done', outcome_text: `Card #${d.objective_id} is already done, so nothing was sent yet. Press Reopen and apply to act on it.`, can_reopen: true } }
    }
    const { container } = await mount({ autoAdvanceMs: 300 })
    await key('1')
    await wait(60)
    expect(container.querySelector('[data-testid="stack-result"]')?.getAttribute('data-outcome')).toBe('card_done')
    expect(shownId(container)).toBe(1) // still here
    await click(button(container, 'Reopen and apply'))
    expect(decides()[1].body).toEqual({ choice: 'A', reopen: true })
    expect(text(container.querySelector('[data-testid="stack-result"]'))).toContain('was done, so it was reopened')
    await wait(450)
    expect(shownId(container)).toBe(2)
  })

  it('an ask that outlived its card says so and moves on (no dead click)', async () => {
    decideReply = (_r, id) => {
      const d = queue.find(i => i.decision.id === id)!.decision
      queue = queue.filter(i => i.decision.id !== id)
      return { status: 409, body: { error: 'This decision is no longer needed (card finished), so nothing was sent and nothing changed.', code: 'decision_stale', decision: { ...d, state: 'withdrawn', withdrawn_reason: 'no longer needed (card finished)' } } }
    }
    const { container } = await mount({ autoAdvanceMs: 300 })
    await click(button(container, /Approve A/))
    const res = container.querySelector('[data-testid="stack-result"]')
    expect(res?.getAttribute('data-outcome')).toBe('stale')
    expect(text(res)).toContain('no longer needed (card finished), so nothing was sent')
    await wait(450)
    expect(shownId(container)).toBe(2)
  })

  it('q focuses the Q&A side thread; the bot answer lands beside the decision', async () => {
    const { container } = await mount()
    await key('q')
    const input = container.querySelector('[data-testid="decision-qa"] input') as HTMLInputElement
    expect(document.activeElement).toBe(input)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'What did it cost last time?')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(input.form as HTMLFormElement).requestSubmit()
    })
    await wait(0)
    const thread = text(container.querySelector('[data-testid="decision-thread"]'))
    expect(thread).toContain('What did it cost last time?')
    expect(thread).toContain('Outreach Bot: About $4.')
    expect(decides()).toEqual([])
  })

  it('? opens the shortcut list', async () => {
    const { container } = await mount()
    await key('?')
    const list = document.querySelector('[data-testid="stack-shortcuts"]')
    expect(text(list)).toContain('Approve the recommendation')
    expect(text(list)).toContain('Skip to the next decision')
    expect(container).toBeTruthy()
  })
})

describe('top-nav badge', () => {
  it('shows the number waiting, refreshes when a decision is answered, and hides the pill at zero', async () => {
    const { container } = await render(<MemoryRouter><NeedsYouBadge /></MemoryRouter>)
    await wait(0)
    const badge = container.querySelector('[data-testid="needs-you-badge"]')!
    expect(badge.getAttribute('href')).toBe('/needs-you')
    expect(text(container.querySelector('[data-testid="needs-you-count"]'))).toBe('3')
    expect(badge.getAttribute('aria-label')).toBe('Needs you: 3 decisions waiting')
    queue = []
    await act(async () => notifyNeedsYouChanged())
    await wait(0)
    expect(container.querySelector('[data-testid="needs-you-count"]')).toBeNull()
    expect(badge.getAttribute('aria-label')).toBe('Needs you: nothing waiting')
    expect(badgeText(12)).toBe('9+')
  })
})

describe('bot chat: a stale needs-you post', () => {
  const agent = { slug: 'outreach', name: 'Outreach Bot', avatar: 'OB', colour: 'blue' } as unknown as ChatAgentInfo
  it('collapses to one resolved line with no Approve / Reply buttons', async () => {
    const m: ChatMessage = {
      id: 5, role: 'assistant', content: 'Outreach Bot needs a decision from you on card #901076.', provider: null, model: null, tool_name: null,
      meta: { kind: 'bot_needs_you', objective_id: 901076, reason: 'decision', title: 'Weekly batch', resolved: { text: 'Resolved: no longer needed (card finished).', reason: 'no longer needed (card finished)' } },
      created_at: '2026-11-15 10:00:00',
    }
    const { container } = await render(<MemoryRouter><NeedsYouMessage m={m} agent={agent} /></MemoryRouter>)
    const row = container.querySelector('[data-testid="needs-you-resolved"]')
    expect(text(row)).toContain('Resolved: no longer needed (card finished).')
    expect(text(row)).toContain('#901076')
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(container.querySelector('[data-testid="needs-you-message"]')).toBeNull()
  })

  it('a live decision post with no decision record says "no briefing given — ask the bot"', async () => {
    const m: ChatMessage = {
      id: 6, role: 'assistant', content: 'Outreach Bot needs a decision from you on card #901077.', provider: null, model: null, tool_name: null,
      meta: { kind: 'bot_needs_you', objective_id: 901077, reason: 'decision', title: 'Weekly batch' },
      created_at: '2026-11-15 10:00:00',
    }
    const { container } = await render(<MemoryRouter><NeedsYouMessage m={m} agent={agent} /></MemoryRouter>)
    expect(text(container.querySelector('[data-testid="needs-you-no-briefing"]'))).toContain('No briefing given — ask the bot')
    expect(button(container, 'Reply')).toBeTruthy()
  })
})
