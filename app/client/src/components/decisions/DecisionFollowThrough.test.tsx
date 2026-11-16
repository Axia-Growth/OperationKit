import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { MemoryRouter } from 'react-router-dom'
import type { DecisionView } from '@operationkit/shared'
import { NeedsYouPage } from './NeedsYouPage'
import { CARD_DECISION_SCROLL_CLASS, CardDecisionPanel, DecisionBriefing } from './DecisionBriefing'
import { PageContainer } from '../ui'
import { render, click, cleanup } from '../../test/render'
import { paintTheme } from '../../lib/theme'

/* obj 901139 — Operator's feedback on the Needs you stack and the card decision view:
     1. a decided item was a dead end ("Decided", no way back to the card, links gone)
     2. no way to answer in his own words ("you merge the PRs, not me")
     3. the page / decision view would not scroll: content below the fold unreachable */

const PR1 = 'https://github.com/acme/app/pull/821'
const PR2 = 'https://github.com/acme/app/pull/828'

function decision(id: number, over: Partial<DecisionView> = {}): DecisionView {
  return {
    id,
    objective_id: 900 + id,
    workspace: 'ops',
    agent_slug: 'release',
    source: 'bot',
    state: 'open',
    incomplete: false,
    flags: [],
    briefing: {
      context: `Two PRs are green: ${PR1} and ${PR2}. See card #4242 for the lane bug.`,
      question: `Merge PRs for batch ${id}?`,
      options: [
        { key: 'A', label: 'Merge now', pros: ['Ships today'], cons: ['Needs a click'], next: 'I merge both and check the deploy.' },
        { key: 'B', label: 'Wait', pros: ['Evening window'], cons: ['Later'], next: 'I merge at 6pm.' },
      ],
      recommended: 'A',
      recommended_why: 'Both are green.',
    },
    raw_note: null,
    chosen: null,
    decided_by: null,
    decided_at: null,
    decision_note: null,
    outcome: null,
    outcome_text: null,
    thread: [],
    created_at: '2026-11-16 10:00:00',
    updated_at: '2026-11-16 10:00:00',
    ...over,
  }
}

const card = (id: number) => ({ id: 900 + id, title: `Release ${id}`, status: 'review', workspace: 'ops', project: null, bot: 'release', bot_name: 'Release Bot' })
const decided = (id: number) =>
  decision(id, {
    state: 'decided',
    chosen: 'own',
    decision_note: `You merge the PRs, not me. Start with ${PR1}.`,
    decided_by: 'operator',
    decided_at: '2026-11-16 11:00:00',
    outcome: 'sent',
    outcome_text: `You answered in your own words: “You merge the PRs, not me.”. Card #${900 + id} restarted with your choice.`,
  })

type Req = { url: string; method: string; body: Record<string, unknown> | null }
let requests: Req[] = []
let queue: { decision: DecisionView; card: ReturnType<typeof card>; urgency: 'blocking' | 'running' }[] = []
let history: { decision: DecisionView; card: ReturnType<typeof card> }[] = []
let cardDecisions: DecisionView[] = []

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  requests = []
  queue = [{ decision: decision(1), card: card(1), urgency: 'blocking' }]
  history = [{ decision: decided(7), card: card(7) }]
  cardDecisions = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const r: Req = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null }
    requests.push(r)
    if (r.url.includes('/decisions/queue/history')) return json(200, { items: history, count: history.length })
    if (r.url.endsWith('/decisions/queue/count')) return json(200, { count: queue.length })
    if (r.url.endsWith('/decisions/queue')) return json(200, { items: queue, count: queue.length, cleared: 0 })
    if (r.url.includes('/decisions?objective_id=')) return json(200, { decisions: cardDecisions })
    const m = r.url.match(/\/decisions\/(\d+)\/decide$/)
    if (m && r.method === 'POST') {
      const id = Number(m[1])
      const d = queue.find(i => i.decision.id === id)?.decision ?? cardDecisions.find(x => x.id === id)!
      queue = queue.filter(i => i.decision.id !== id)
      const answer = String(r.body?.answer ?? '')
      const out = { ...d, state: 'decided' as const, chosen: String(r.body?.choice), decision_note: answer || null, outcome: 'sent' as const, outcome_text: `You answered in your own words: “${answer}”. Card #${d.objective_id} restarted with your choice.` }
      history = [{ decision: out, card: card(id) }, ...history]
      return json(200, { decision: out, outcome: 'sent', outcome_text: out.outcome_text, can_reopen: false })
    }
    return json(404, { error: 'not mocked' })
  }))
})

afterEach(async () => {
  await cleanup()
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute('data-theme')
})

const wait = (ms: number) => act(async () => { await new Promise(r => setTimeout(r, ms)) })
const button = (root: ParentNode, label: string | RegExp) =>
  [...root.querySelectorAll('button')].find(b => (typeof label === 'string' ? b.textContent?.trim() === label : label.test(b.textContent ?? ''))) ?? null
async function type(input: HTMLTextAreaElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}
const page = () => render(<MemoryRouter><NeedsYouPage autoAdvanceMs={60_000} pollMs={60_000} /></MemoryRouter>)

describe('1. a decided item leads back to its card, with briefing, choice, outcome and clickable links', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`"Your recent decisions" opens to the full decided briefing and the card thread (${theme})`, async () => {
      paintTheme(theme)
      const { container } = await page()
      await wait(0)
      const list = container.querySelector('[data-testid=recent-decisions]')!
      expect(list).not.toBeNull()
      const row = list.querySelector('[data-testid=recent-decision]')!
      expect(row.textContent).toContain('Merge PRs for batch 7?')
      expect(row.textContent).toContain('Own answer')
      expect(row.textContent).toContain('#907')
      await click(row.querySelector('button'))

      // The card thread, the full briefing, the choice, the outcome line…
      const cardLinks = [...row.querySelectorAll('a[data-testid=decision-card-link]')].map(a => a.getAttribute('href'))
      expect(cardLinks).toContain('/o/907')
      const briefing = row.querySelector('[data-testid=decision-briefing]')!
      expect(briefing.getAttribute('data-state')).toBe('decided')
      expect(briefing.textContent).toContain('Two PRs are green')
      expect(briefing.querySelectorAll('[data-testid=decision-option]')).toHaveLength(2)
      expect(briefing.querySelector('[data-testid=decision-own-answer]')!.textContent).toContain('You merge the PRs, not me.')
      expect(briefing.querySelector('[data-testid=decision-outcome]')!.textContent).toContain('restarted with your choice')

      // …and every link it mentioned, clickable, PRs first, opening in a new tab safely.
      const chips = [...briefing.querySelectorAll<HTMLAnchorElement>('a[data-testid=decision-link]')]
      expect(chips.map(a => [a.getAttribute('href'), a.textContent])).toEqual([[PR1, 'acme/app#821'], [PR2, 'acme/app#828']])
      for (const a of chips) {
        expect(a.getAttribute('target')).toBe('_blank')
        expect(a.getAttribute('rel')).toBe('noopener noreferrer')
      }
      // Links inside the briefing text render as links too (URL and card reference).
      const inline = [...briefing.querySelectorAll('a[data-testid=linked-url]')].map(a => a.getAttribute('href'))
      expect(inline).toContain(PR1)
      expect([...briefing.querySelectorAll('a[data-testid=linked-card]')].map(a => a.getAttribute('href'))).toContain('/o/4242')
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme)
    })
  }

  it('the open decision on the stack renders its links and links its card thread', async () => {
    const { container } = await page()
    await wait(0)
    const stack = container.querySelector('[data-testid=stack-card]')!
    expect([...stack.querySelectorAll('a[data-testid=linked-url]')].map(a => a.getAttribute('href'))).toEqual([PR1, PR2])
    expect(stack.querySelector('[data-testid=stack-card-link]')!.getAttribute('href')).toBe('/o/901')
  })

  it('a decided decision in chat or on a card links its card thread and never renders a javascript: link', async () => {
    const d = decided(9)
    d.briefing.context = 'Try javascript:alert(1) or https://ok.example/x.'
    const { container } = await render(<MemoryRouter><DecisionBriefing decision={d} /></MemoryRouter>)
    expect(container.querySelector('a[data-testid=decision-card-link]')!.getAttribute('href')).toBe('/o/909')
    const hrefs = [...container.querySelectorAll('a')].map(a => a.getAttribute('href') ?? '')
    expect(hrefs).toContain('https://ok.example/x')
    expect(hrefs.some(h => h.startsWith('javascript:'))).toBe(false)
  })
})

describe('2. every decision accepts a free-text answer as the decision', () => {
  it('on the stack: sends {choice: own, answer}, shows the result, clears the ask and lists it under recent decisions', async () => {
    const { container } = await page()
    await wait(0)
    const form = container.querySelector<HTMLFormElement>('[data-testid=stack-card] [data-testid=own-answer-form]')!
    expect(form).not.toBeNull()
    // Alongside Approve / Deny / Skip, not instead of them.
    expect(button(container, /Approve A/)).not.toBeNull()
    expect(button(container, /Deny/)).not.toBeNull()
    expect(button(container, /Skip/)).not.toBeNull()
    await type(form.querySelector('textarea')!, 'You merge the PRs, not me.')
    await submit(form)
    await wait(0)
    const post = requests.find(r => r.method === 'POST' && r.url.endsWith('/decisions/1/decide'))!
    expect(post.body).toEqual({ choice: 'own', answer: 'You merge the PRs, not me.' })
    expect(container.querySelector('[data-testid=stack-result]')!.textContent).toContain('You answered in your own words')
    // The Q&A thread is a separate box: nothing was asked there.
    expect(requests.some(r => r.url.includes('/questions'))).toBe(false)
    // Next: the stack is empty, and the answer shows in the history.
    await click(button(container, /Done/))
    await wait(0)
    expect(container.querySelector('[data-testid=stack-empty]')).not.toBeNull()
    expect(container.querySelector('[data-testid=recent-decision]')!.textContent).toContain('Merge PRs for batch 1?')
  })

  it('an empty answer cannot be sent', async () => {
    const { container } = await page()
    await wait(0)
    const form = container.querySelector<HTMLFormElement>('[data-testid=stack-card] [data-testid=own-answer-form]')!
    expect(button(form, 'Send as my decision')!.disabled).toBe(true)
    await submit(form)
    expect(requests.some(r => r.method === 'POST')).toBe(false)
  })

  it('A focuses the answer box from the keyboard', async () => {
    const { container } = await page()
    await wait(0)
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })) })
    expect(document.activeElement).toBe(container.querySelector('[data-testid=stack-card] [data-testid=own-answer-form] textarea'))
  })

  it('on the card / in chat: the open briefing has the same box and sends the same request', async () => {
    const d = decision(3)
    let changed: DecisionView | null = null
    const { container } = await render(<MemoryRouter><DecisionBriefing decision={d} onChange={x => { changed = x }} /></MemoryRouter>)
    queue = [{ decision: d, card: card(3), urgency: 'blocking' }]
    const form = container.querySelector<HTMLFormElement>('[data-testid=own-answer-form]')!
    await type(form.querySelector('textarea')!, 'Merge 821 only.')
    await submit(form)
    await wait(0)
    expect(requests.find(r => r.url.endsWith('/decisions/3/decide'))!.body).toEqual({ choice: 'own', answer: 'Merge 821 only.' })
    expect(changed!.chosen).toBe('own')
    expect(container.querySelector('[data-testid=decision-own-answer]')!.textContent).toContain('Merge 821 only.')
  })
})

describe('3. scroll: long briefings never push content out of reach', () => {
  it('the page scroller is the containing block, so nothing absolute can make the document outgrow the screen', async () => {
    const { container } = await render(<PageContainer><span className="sr-only">x</span></PageContainer>)
    const scroller = container.querySelector('[data-testid=page-scroller]')!
    expect(scroller.className).toMatch(/\brelative\b/)
    expect(scroller.className).toMatch(/\boverflow-y-auto\b/)
    expect(scroller.className).toMatch(/\bh-full\b/)
  })

  it('on the stack the action bar is pinned to the bottom of the scroller and the Q&A panel contains its own labels', async () => {
    const { container } = await page()
    await wait(0)
    const actions = container.querySelector('[data-testid=stack-actions]')!
    expect(actions.className).toMatch(/\bsticky\b/)
    expect(actions.className).toMatch(/\bbottom-0\b/)
    expect(actions.querySelector('[data-testid=own-answer-form]')).not.toBeNull()
    expect(container.querySelector('[data-testid=stack-qa]')!.className).toMatch(/\brelative\b/)
  })

  it('on a card the decision panel is a bounded scroller with a sticky action bar, and it folds', async () => {
    cardDecisions = [decision(5, { briefing: { ...decision(5).briefing, context: 'Long. '.repeat(400) } })]
    const { container } = await render(<MemoryRouter><CardDecisionPanel objectiveId={905} /></MemoryRouter>)
    await wait(0)
    const panel = container.querySelector('[data-testid=card-decision-panel]')!
    expect(panel.className).toMatch(/\bshrink-0\b/)
    const scroll = container.querySelector('[data-testid=card-decision-scroll]')!
    expect(scroll.className).toBe(CARD_DECISION_SCROLL_CLASS)
    expect(CARD_DECISION_SCROLL_CLASS).toMatch(/max-h-\[/)
    expect(CARD_DECISION_SCROLL_CLASS).toMatch(/\boverflow-y-auto\b/)
    const actions = scroll.querySelector('[data-testid=decision-actions]')!
    expect(actions.className).toMatch(/\bsticky\b/)
    expect(actions.className).toMatch(/\bbottom-0\b/)
    await click(button(container, 'Hide decision'))
    expect(panel.getAttribute('data-expanded')).toBe('0')
    expect(container.querySelector('[data-testid=card-decision-folded]')!.textContent).toContain('Decision needed')
    await click(button(container, 'Show decision'))
    expect(panel.getAttribute('data-expanded')).toBe('1')
  })

  it('a settled decision on a card folds to one line by default and opens to the full briefing', async () => {
    cardDecisions = [decided(6)]
    const { container } = await render(<MemoryRouter><CardDecisionPanel objectiveId={906} /></MemoryRouter>)
    await wait(0)
    const folded = container.querySelector('[data-testid=card-decision-folded]')!
    expect(folded.textContent).toContain('Own answer')
    await click(button(container, 'Show decision'))
    expect(container.querySelector('[data-testid=decision-own-answer]')).not.toBeNull()
    expect(container.querySelector('a[data-testid=decision-card-link]')!.getAttribute('href')).toBe('/o/906')
  })
})
