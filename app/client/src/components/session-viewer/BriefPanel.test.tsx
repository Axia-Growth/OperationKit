// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Objective } from '@operationkit/shared'
import { BriefPanel, closedOverReviewLine } from './BriefPanel'
import { cleanup, render } from '../../test/render'

/* obj 900959 — the card says "not reviewed" when the reviewer session failed
   (no verdict badge), and shows one plain line when it was closed over a
   non-pass review. */

vi.mock('./SpendPanel', () => ({ SpendPanel: () => null }))

afterEach(async () => { await cleanup() })

const card = (over: Partial<Objective>): Objective =>
  ({ id: 7, title: 'A card', status: 'done', ai_review_verdict: null, ai_review_findings: null, ...over }) as Objective

const q = (c: HTMLElement, id: string) => c.querySelector(`[data-testid="${id}"]`)

describe('closedOverReviewLine', () => {
  it('names who and why', () => {
    expect(closedOverReviewLine({ verdict: 'fail', by: 'bot:Operation Kit Dev', reason: 'verified by hand', at: 'x' }))
      .toBe('Closed without a passing review by Operation Kit Dev: verified by hand')
  })
  it('names who only when no reason was given', () => {
    expect(closedOverReviewLine({ verdict: 'blocked', by: 'user', reason: null, at: 'x' }))
      .toBe('Closed without a passing review by a person.')
    expect(closedOverReviewLine({ verdict: 'blocked', by: 'state-poller', reason: '  ', at: 'x' }))
      .toBe('Closed without a passing review by the system.')
  })
})

describe('BriefPanel review hygiene', () => {
  it('shows the closed-over-review line when the card carries it', async () => {
    const { container } = await render(
      <BriefPanel
        objective={card({ ai_review_verdict: 'fail', closed_over_review: { verdict: 'fail', by: 'user', reason: 'shipping anyway', at: '2026-11-16 10:00:00' } })}
        reviews={[]}
        prs={[]}
      />,
    )
    expect(q(container, 'closed-over-review')?.textContent).toBe('Closed without a passing review by a person: shipping anyway')
  })

  it('shows neither line on an ordinary card', async () => {
    const { container } = await render(<BriefPanel objective={card({ ai_review_verdict: 'pass', closed_over_review: null, review_runner_failure: null })} reviews={[]} prs={[]} />)
    expect(q(container, 'closed-over-review')).toBeNull()
    expect(q(container, 'review-not-run')).toBeNull()
  })

  it('shows "Not reviewed" with the runner failure and no verdict badge when the reviewer session failed', async () => {
    const { container } = await render(
      <BriefPanel
        objective={card({ status: 'review', review_runner_failure: { cause: 'no_output', reason: 'The reviewer session produced no output.', at: '2026-11-16 10:00:00' } })}
        reviews={[]}
        prs={[]}
      />,
    )
    const block = q(container, 'review-not-run')
    expect(block?.textContent).toContain('Not reviewed')
    expect(block?.textContent).toContain('The reviewer session produced no output.')
    expect(container.textContent).not.toMatch(/blocked/i)
  })
})
