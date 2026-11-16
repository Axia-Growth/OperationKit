import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DecisionView } from '@operationkit/shared'
import { DecisionBriefing } from './DecisionBriefing'
import { NeedsYouMessage } from '../agent-chat/NeedsYouMessage'
import { render, click, cleanup } from '../../test/render'
import { paintTheme } from '../../lib/theme'
import type { ChatMessage, ChatAgentInfo } from '../agent-chat/types'

/* obj 901059 — Operator opened a card a bot wanted a decision on, could not see
   what the decision was, approved anyway and nothing visibly happened. These
   tests pin the fix in the UI: the briefing renders (light and dark), the Q&A
   thread round-trips, a choice shows exactly what was approved and what
   happens next, and approving on a DONE card says so and offers Reopen. */

function decision(over: Partial<DecisionView> = {}): DecisionView {
  return {
    id: 41,
    objective_id: 900,
    workspace: 'ops',
    agent_slug: 'outreach',
    source: 'bot',
    state: 'open',
    incomplete: false,
    flags: [],
    briefing: {
      context: 'The weekly outreach batch is drafted and checked against the ICP.',
      question: 'Should we send the 40-lead batch today?',
      options: [
        { key: 'A', label: 'Send today', pros: ['Replies before the weekend'], cons: ['No second review'], next: 'I send it and report bounces in an hour.' },
        { key: 'B', label: 'Hold a day', pros: ['Test subject lines'], cons: ['Replies slip to Monday'], next: 'I draft 2 subject lines for you.' },
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

type Req = { url: string; method: string; body: Record<string, unknown> | null }
let requests: Req[] = []
let handler: (r: Req) => { status?: number; body: unknown }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  requests = []
  handler = () => ({ body: {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r: Req = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }
    requests.push(r)
    const out = handler(r)
    return json(out.status ?? 200, out.body)
  }))
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

const text = (el: ParentNode) => (el as HTMLElement).textContent ?? ''
const button = (root: ParentNode, label: string) => [...root.querySelectorAll('button')].find(b => b.textContent?.trim() === label) ?? null
const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

// Raw palette colours would ignore the theme; the briefing must use tokens only.
const RAW_COLOUR = /\b(?:bg|text|border|ring)-(?:white|black|gray|slate|zinc|neutral|stone|red|green|blue|yellow|amber|emerald|orange|sky|indigo|violet|purple|pink|rose|lime|teal|cyan)(?:-\d{2,3})?\b/

describe('DecisionBriefing renders the decision itself', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`shows context, the one question, each option with pros/cons/next and the recommendation (${theme} mode)`, async () => {
      paintTheme(theme)
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
      const { container } = await render(<DecisionBriefing decision={decision()} />)
      const section = container.querySelector('[data-testid="decision-briefing"]')!
      expect(section.getAttribute('aria-label')).toBe('Decision: Should we send the 40-lead batch today?')
      expect(text(section)).toContain('Decision needed')
      expect(text(section)).toContain('The weekly outreach batch is drafted')
      expect(container.querySelector('h3')!.textContent).toBe('Should we send the 40-lead batch today?')
      const opts = [...container.querySelectorAll('[data-testid="decision-option"]')]
      expect(opts.map(o => o.getAttribute('data-key'))).toEqual(['A', 'B'])
      expect(text(opts[0])).toContain('Recommended')
      expect(text(opts[1])).not.toContain('Recommended')
      expect(text(opts[0].querySelector('[aria-label="Pros of Send today"]')!)).toContain('Replies before the weekend')
      expect(text(opts[0].querySelector('[aria-label="Cons of Send today"]')!)).toContain('No second review')
      expect(text(opts[0])).toContain('Next: I send it and report bounces in an hour.')
      expect(text(section)).toContain('Why A: The lines match last month’s best performer.')
      expect(button(section, 'Choose A')).toBeTruthy()
      expect(button(section, 'None of these (deny)')).toBeTruthy()
      // Theme-safe: every class is a design token, never a raw palette colour.
      const classes = [section, ...section.querySelectorAll('*')].flatMap(el => [...el.classList])
      expect(classes.filter(c => RAW_COLOUR.test(c))).toEqual([])
    })
  }

  it('flags a decision raised without a briefing instead of showing nothing', async () => {
    const d = decision({ incomplete: true, flags: ['no_question', 'no_options'], raw_note: 'Want me to send?', briefing: { context: 'Want me to send?', question: '', options: [], recommended: '', recommended_why: '' } })
    const { container } = await render(<DecisionBriefing decision={d} botName="Outreach Bot" />)
    expect(text(container.querySelector('[data-testid="decision-flag"]')!)).toMatch(/No briefing given — ask Outreach Bot below what it needs before you choose\. It does not say what is being decided\./)
    expect(button(container, 'Approve as proposed')).toBeTruthy()
    expect(button(container, 'Deny')).toBeTruthy()
  })
})

describe('Q&A thread', () => {
  it('asks the bot, shows it answering, then shows its answer — and Choose stays available', async () => {
    let answered = false
    handler = r => {
      if (r.method === 'POST' && r.url.endsWith('/decisions/41/questions')) {
        return { status: 201, body: { decision: decision({ thread: [{ id: 1, decision_id: 41, role: 'human', author: 'operator', body: String(r.body?.body), status: 'pending', in_reply_to: null, created_at: '' }] }) } }
      }
      if (r.method === 'GET' && r.url.endsWith('/decisions/41')) {
        answered = true
        return { body: { decision: decision({ thread: [
          { id: 1, decision_id: 41, role: 'human', author: 'operator', body: 'What did it cost last time?', status: 'answered', in_reply_to: null, created_at: '' },
          { id: 2, decision_id: 41, role: 'bot', author: 'Outreach Bot', body: '$4 in sends.', status: null, in_reply_to: 1, created_at: '' },
        ] }) } }
      }
      return { body: {} }
    }
    const { container } = await render(<DecisionBriefing decision={decision()} botName="Outreach Bot" pollMs={10} />)
    await type(container.querySelector<HTMLInputElement>('#decision-q-41')!, 'What did it cost last time?')
    await click(button(container, 'Ask'))
    expect(requests.find(r => r.method === 'POST')).toMatchObject({ url: '/api/decisions/41/questions', body: { body: 'What did it cost last time?' } })
    expect(text(container.querySelector('[data-testid="decision-thread"]')!)).toContain('(Outreach Bot is answering…)')
    await wait(60)
    expect(answered).toBe(true)
    const thread = container.querySelector('[data-testid="decision-thread"]')!
    expect([...thread.querySelectorAll('li')].map(li => li.getAttribute('data-role'))).toEqual(['human', 'bot'])
    expect(text(thread)).toContain('Outreach Bot: $4 in sends.')
    expect(text(thread)).not.toContain('is answering')
    expect(button(container, 'Choose A')).toBeTruthy()
  })
})

describe('approve / deny show a clear outcome', () => {
  it('choosing an option shows what was approved and what happens next', async () => {
    const outcomeText = 'You chose A: Send today. Card #900 restarted with your choice. Next: I send it and report bounces in an hour.'
    handler = r => r.url.endsWith('/decide')
      ? { body: { decision: decision({ state: 'decided', chosen: 'A', decided_by: 'operator', outcome: 'sent', outcome_text: outcomeText }), outcome: 'sent', outcome_text: outcomeText, can_reopen: false } }
      : { body: {} }
    const { container } = await render(<DecisionBriefing decision={decision()} />)
    await click(button(container, 'Choose A'))
    expect(requests.at(-1)).toMatchObject({ url: '/api/decisions/41/decide', method: 'POST', body: { choice: 'A' } })
    const outcome = container.querySelector('[data-testid="decision-outcome"]')!
    expect(outcome.getAttribute('role')).toBe('status')
    expect(text(outcome)).toContain('Chose A: Send today · operator')
    expect(text(outcome)).toContain(outcomeText)
    expect(button(container, 'Choose A')).toBeNull()
    expect(button(container, 'Reopen and apply')).toBeNull()
  })

  it('approving on a DONE card says nothing was sent and offers Reopen and apply, which applies it', async () => {
    const doneText = 'You chose A: Send today. Card #900 is already done, so nothing was sent yet. Press Reopen and apply to act on it.'
    const reopenedText = 'You chose A: Send today. Card #900 was done, so it was reopened and your choice sent. Next: I send it and report bounces in an hour.'
    handler = r => {
      if (!r.url.endsWith('/decide')) return { body: {} }
      if (r.body?.reopen) return { body: { decision: decision({ state: 'decided', chosen: 'A', outcome: 'reopened', outcome_text: reopenedText }), outcome: 'reopened', outcome_text: reopenedText, can_reopen: false } }
      return { body: { decision: decision({ state: 'decided', chosen: 'A', outcome: 'card_done', outcome_text: doneText }), outcome: 'card_done', outcome_text: doneText, can_reopen: true } }
    }
    const { container } = await render(<DecisionBriefing decision={decision()} />)
    await click(button(container, 'Choose A'))
    let outcome = container.querySelector('[data-testid="decision-outcome"]')!
    expect(outcome.getAttribute('data-outcome')).toBe('card_done')
    expect(text(outcome)).toContain(doneText)
    await click(button(container, 'Reopen and apply'))
    expect(requests.at(-1)).toMatchObject({ url: '/api/decisions/41/decide', body: { choice: 'A', reopen: true } })
    outcome = container.querySelector('[data-testid="decision-outcome"]')!
    expect(outcome.getAttribute('data-outcome')).toBe('reopened')
    expect(text(outcome)).toContain(reopenedText)
    expect(button(container, 'Reopen and apply')).toBeNull()
  })

  it('deny sends the optional reason', async () => {
    handler = r => r.url.endsWith('/decide')
      ? { body: { decision: decision({ state: 'decided', chosen: 'deny', outcome: 'sent', outcome_text: 'You said no to all the options.' }), outcome: 'sent', outcome_text: 'You said no to all the options.', can_reopen: false } }
      : { body: {} }
    const { container } = await render(<DecisionBriefing decision={decision()} />)
    await click(button(container, 'None of these (deny)'))
    await type(container.querySelector<HTMLInputElement>('#decision-note-41')!, 'not this week')
    await click(button(container, 'Deny'))
    expect(requests.at(-1)).toMatchObject({ body: { choice: 'deny', note: 'not this week' } })
    expect(text(container.querySelector('[data-testid="decision-outcome"]')!)).toContain('Denied')
  })

  it('a refused choice shows the server reason, not a dead click', async () => {
    handler = () => ({ status: 409, body: { error: 'This decision was already answered: Chose B: Hold a day' } })
    const { container } = await render(<DecisionBriefing decision={decision()} />)
    await click(button(container, 'Choose A'))
    expect(text(container.querySelector('[role="alert"]')!)).toBe('This decision was already answered: Chose B: Hold a day')
  })
})

describe('stale asks (obj 901084)', () => {
  it('an answered card_done decision whose ask went stale no longer offers Reopen and apply', async () => {
    const d = decision({ state: 'decided', chosen: 'A', outcome: 'card_done', outcome_text: 'Card #900 is already done.', can_reopen: false })
    const { container } = await render(<DecisionBriefing decision={d} />)
    expect(button(container, 'Reopen and apply')).toBeNull()
    const live = await render(<DecisionBriefing decision={{ ...d, id: 42, can_reopen: true }} />)
    expect(button(live.container, 'Reopen and apply')).toBeTruthy()
  })

  it('a cleared decision says why it no longer needs an answer', async () => {
    const d = decision({ state: 'withdrawn', withdrawn_reason: 'no longer needed (card finished)' })
    const { container } = await render(<DecisionBriefing decision={d} />)
    expect(text(container.querySelector('[data-testid="decision-withdrawn"]')!)).toBe('This decision no longer needs an answer: no longer needed (card finished).')
    expect(button(container, 'Choose A')).toBeNull()
  })
})

describe('bot chat "needs you" post', () => {
  const agent = { slug: 'outreach', name: 'Outreach Bot', avatar: 'OB', colour: 'blue' } as unknown as ChatAgentInfo
  const post = (meta: Record<string, unknown>): ChatMessage => ({
    id: 5, role: 'assistant', content: 'Outreach Bot needs a decision from you on card #900.', provider: null, model: null, tool_name: null,
    meta: { kind: 'bot_needs_you', objective_id: 900, reason: 'decision', title: 'Outreach batch', ...meta },
    created_at: '2026-11-15 10:00:00',
  } as unknown as ChatMessage)

  it('renders the briefing (not a blind Approve) when the decision has one', async () => {
    handler = r => r.url.endsWith('/decisions/41') ? { body: { decision: decision() } } : { body: {} }
    const { container } = await render(<MemoryRouter><NeedsYouMessage m={post({ decision_id: 41 })} agent={agent} /></MemoryRouter>)
    await wait(0)
    expect(container.querySelector('[data-testid="decision-briefing"]')).toBeTruthy()
    expect(text(container)).toContain('Should we send the 40-lead batch today?')
    expect(button(container, 'Approve')).toBeNull()
  })

  it('Approve on a finished card explains it was not sent and offers Reopen and send', async () => {
    handler = r => {
      if (r.method === 'POST' && r.url.endsWith('/objectives/900/message') && !requests.some(q => q.method === 'PATCH')) {
        return { status: 409, body: { error: 'Card #900 is already finished, so your message was not sent and nothing changed.', code: 'card_done', can_reopen: true } }
      }
      return { body: {} }
    }
    const { container } = await render(<MemoryRouter><NeedsYouMessage m={post({})} agent={agent} /></MemoryRouter>)
    await click(button(container, 'Approve'))
    const box = container.querySelector('[data-testid="needs-you-card-done"]')!
    expect(text(box)).toContain('Card #900 is already finished, so this was not sent and nothing changed.')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    await click(button(box, 'Reopen and send'))
    const tail = requests.slice(-2)
    expect(tail[0]).toMatchObject({ url: '/api/objectives/900/status', method: 'PATCH', body: { status: 'working' } })
    expect(tail[1]).toMatchObject({ url: '/api/objectives/900/message', method: 'POST', body: { message: 'Approved: go ahead with what you proposed on card #900.' } })
    expect(text(container.querySelector('[role="status"]')!)).toBe('Card #900 reopened and your message sent.')
  })
})
