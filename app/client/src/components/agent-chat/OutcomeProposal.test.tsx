// @vitest-environment jsdom
/**
 * obj 901764 — the proposed breakdown a bot's propose_outcome call leaves in the
 * chat. Before work starts the person SEES the outcome card, its "done when",
 * its acceptance criteria, any parts and the standing rules, and can EDIT every
 * line. Approve sends their edited version; nothing is filed before that. A
 * missing definition of done blocks Approve with the gap named. A look-alike
 * card turns Approve into "File anyway and start".
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { act } from 'react'
import { cleanup, click, render } from '../../test/render'
import type { OutcomeProposalView } from './OutcomeProposal'

const { apiMock, ApiErrorRef } = vi.hoisted(() => ({
  apiMock: { get: vi.fn(), post: vi.fn(), put: vi.fn() },
  ApiErrorRef: { current: null as unknown as new (status: number, body: unknown, message: string) => Error },
}))
vi.mock('../../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../../lib/api')>('../../lib/api')
  ApiErrorRef.current = actual.ApiError as never
  return { ...actual, api: apiMock }
})

const { ChatOutcomeProposal } = await import('./OutcomeProposal')

function view(over: Partial<OutcomeProposalView> = {}): OutcomeProposalView {
  return {
    id: 7,
    status: 'pending',
    workspace: 'growth',
    agent_slug: 'operator',
    proposal: {
      outcome: 'A contact form that emails sales, and screenshots on every PR.',
      card: {
        title: 'Contact form emails sales',
        brief: 'Add a contact form to the site.',
        done_when: 'A submission on the preview reaches the sales inbox.',
        criteria: [{ id: 'fields', criterion: 'The form shows name, email and message', type: 'visual', method: 'browser' }],
        stop_conditions: [],
      },
      children: [],
      suggested_rules: [{ text: 'Before-and-after screenshots in the PR', applies_to: 'pr', save: true }],
      skip_rule_ids: [],
    },
    card_id: null,
    child_ids: [],
    start_note: null,
    cards: [],
    rules: [{ id: 3, workspace: 'growth', text: 'Link the card in every PR', applies_to: 'pr', created_by: 1, created_at: '2026-11-20' }],
    can_edit: true,
    ...over,
  }
}

/** Type into a controlled input the way a browser does. */
async function typeInto(el: Element | null, value: string) {
  if (!el) throw new Error('typeInto: no element')
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (root: ParentNode, text: string | RegExp) =>
  Array.from(root.querySelectorAll('button')).find(b => (typeof text === 'string' ? b.textContent?.trim() === text : text.test(b.textContent ?? ''))) ?? null

async function mount(v = view()) {
  apiMock.get.mockResolvedValue(v)
  const r = await render(<ChatOutcomeProposal id={v.id} />)
  await act(async () => { await Promise.resolve() })
  return r
}

beforeEach(() => {
  apiMock.get.mockReset()
  apiMock.post.mockReset()
  apiMock.put.mockReset()
})
afterEach(async () => {
  await cleanup()
})

describe('OutcomeProposal panel', () => {
  it('shows the outcome, the done-bar, the criteria and the standing rules before anything is filed', async () => {
    const r = await mount()
    expect(apiMock.get).toHaveBeenCalledWith('/agent-chat/outcome-proposals/7')
    const panel = r.container.querySelector('[data-testid="outcome-proposal"]')!
    expect(panel.getAttribute('data-status')).toBe('pending')
    expect(panel.textContent).toContain('Waiting for your approval')
    expect(panel.textContent).toContain('A contact form that emails sales')
    expect((panel.querySelector('[aria-label="Outcome card title"]') as HTMLInputElement).value).toBe('Contact form emails sales')
    expect((panel.querySelector('[aria-label="Outcome card done when"]') as HTMLInputElement).value).toMatch(/sales inbox/)
    expect((panel.querySelector('[aria-label="Outcome card criterion 1"]') as HTMLInputElement).value).toMatch(/name, email and message/)
    expect(panel.textContent).toContain('Link the card in every PR')
    expect(panel.textContent).toContain('save as a standing rule')
    expect(panel.textContent).toContain('Nothing is filed until you approve')
    expect(apiMock.post).not.toHaveBeenCalled()
  })

  it('approve sends the person\'s edits, including an added part and an unticked rule', async () => {
    const r = await mount()
    await typeInto(r.container.querySelector('[aria-label="Outcome card title"]'), 'Website contact form emails sales')
    await click(button(r.container, 'Add a part'))
    await typeInto(r.container.querySelector('[aria-label="Part 1 title"]'), 'Email delivery')
    await typeInto(r.container.querySelector('[aria-label="Part 1 brief"]'), 'Send each submission to sales.')
    await typeInto(r.container.querySelector('[aria-label="Part 1 done when"]'), 'One email per submission.')
    await typeInto(r.container.querySelector('[aria-label="Part 1 criterion 1"]'), 'A test submission arrives in the sales inbox')
    // Skip the saved rule for these cards.
    const ruleBox = Array.from(r.container.querySelectorAll('label')).find(l => l.textContent?.includes('Link the card'))!.querySelector('input')!
    await click(ruleBox)
    apiMock.post.mockResolvedValue(view({ status: 'approved', card_id: 40, child_ids: [41], cards: [{ id: 40, title: 'Website contact form emails sales', status: 'working' }, { id: 41, title: 'Email delivery', status: 'queue' }], start_note: 'Card #40 started.', can_edit: false }))
    await click(button(r.container, 'Approve and start'))
    expect(apiMock.post).toHaveBeenCalledTimes(1)
    const [path, body] = apiMock.post.mock.calls[0]
    expect(path).toBe('/agent-chat/outcome-proposals/7/approve')
    expect(body.proposal.card.title).toBe('Website contact form emails sales')
    expect(body.proposal.children).toHaveLength(1)
    expect(body.proposal.children[0].criteria[0].criterion).toBe('A test submission arrives in the sales inbox')
    expect(body.proposal.skip_rule_ids).toEqual([3])
    expect(body.file_anyway).toBeUndefined()
    const filed = r.container.querySelector('[data-testid="outcome-proposal-filed"]')!
    expect(filed.textContent).toContain('#40')
    expect(filed.textContent).toContain('Card #40 started.')
    expect(button(r.container, 'Approve and start')).toBeNull()
  })

  it('a missing definition of done blocks Approve and names the gap', async () => {
    const r = await mount()
    await typeInto(r.container.querySelector('[aria-label="Outcome card done when"]'), '')
    const approve = button(r.container, 'Approve and start') as HTMLButtonElement
    expect(approve.disabled).toBe(true)
    expect(r.container.querySelector('[aria-label="Needs fixing before approval"]')!.textContent).toMatch(/done when/)
  })

  it('a look-alike open card turns Approve into "File anyway and start"', async () => {
    const r = await mount()
    const Err = ApiErrorRef.current
    apiMock.post.mockRejectedValueOnce(new Err(409, { code: 'duplicate', duplicate: { id: 12, title: 'Contact form' } }, 'An open card looks like the same work: #12'))
    await click(button(r.container, 'Approve and start'))
    expect(r.container.querySelector('[role="alert"]')!.textContent).toContain('#12')
    apiMock.post.mockResolvedValueOnce(view({ status: 'approved', card_id: 50, cards: [{ id: 50, title: 'Contact form emails sales', status: 'working' }], can_edit: false }))
    await click(button(r.container, 'File anyway and start'))
    expect(apiMock.post.mock.calls[1][1].file_anyway).toBe(true)
  })

  it('a proposed split starts folded to one line per part and opens to edit', async () => {
    const v = view()
    v.proposal.children = [{ title: 'Email delivery', brief: 'Send it.', done_when: 'One email per submission.', criteria: [{ id: 'one', criterion: 'Exactly one email', type: 'functional', method: 'api' }], stop_conditions: [] }]
    const r = await mount(v)
    expect(r.container.textContent).toContain('One part under the outcome card')
    expect(r.container.textContent).toContain('Done when: One email per submission. · 1 criterion')
    expect(r.container.querySelector('[aria-label="Part 1 title"]')).toBeNull()
    await click(button(r.container, 'Edit part 1'))
    expect((r.container.querySelector('[aria-label="Part 1 title"]') as HTMLInputElement).value).toBe('Email delivery')
  })

  it('an approved or someone-else view is read-only', async () => {
    const r = await mount(view({ status: 'approved', can_edit: false, card_id: 40, cards: [{ id: 40, title: 'Contact form emails sales', status: 'working' }] }))
    expect(r.container.querySelector('input[aria-label="Outcome card title"]')).toBeNull()
    expect(button(r.container, 'Approve and start')).toBeNull()
    expect(r.container.textContent).toContain('Approved')
  })
})
