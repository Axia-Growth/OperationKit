// obj 901387 — "in review" is a stage; "needs you" is an ask. The pure rule.
import { describe, it, expect } from 'vitest'
import { needsYouReasons, reviewStageOf, reviewStageNeedsPerson, reviewWaitsOnPerson, botLiveLine } from './bot-work'

const base = { spent_usd: 0, ceiling_usd: null as number | null }
const PR = { has_pr: true }

describe('reviewStageOf', () => {
  it('a review card with a pull request and no AI review yet is waiting on the AI review, not the person', () => {
    expect(reviewStageOf({ status: 'review', ...PR, ai_review_verdict: null })).toBe('awaiting_ai_review')
    expect(reviewStageOf({ status: 'review', create_pr: 1, ai_review_verdict: null })).toBe('awaiting_ai_review')
    expect(reviewStageOf({ status: 'ai_review', session_id: 'rev', ...PR })).toBe('awaiting_ai_review')
    expect(reviewWaitsOnPerson({ status: 'review', ...PR })).toBe(false)
  })

  it('a passed AI review waits for the person to sign off', () => {
    expect(reviewStageOf({ status: 'review', ...PR, ai_review_verdict: 'pass' })).toBe('sign_off')
    expect(reviewWaitsOnPerson({ status: 'review', ...PR, ai_review_verdict: 'pass' })).toBe(true)
  })

  it('a failed review that went back to the worker is the worker\'s; parked with nobody on it, it is the person\'s call', () => {
    expect(reviewStageOf({ status: 'working', session_id: 's', ...PR, ai_review_verdict: 'fail' })).toBe('not_review')
    expect(reviewStageOf({ status: 'review', session_id: 's', ...PR, ai_review_verdict: 'fail' })).toBe('agent_running')
    expect(reviewStageOf({ status: 'review', ...PR, ai_review_verdict: 'fail' })).toBe('review_escalated')
    expect(reviewStageOf({ status: 'review', ...PR, ai_review_verdict: 'blocked' })).toBe('review_escalated')
  })

  it('an agent still on a review card (acting on a bounce) keeps it off the person, even after a pass', () => {
    expect(reviewWaitsOnPerson({ status: 'review', session_id: 'live', ...PR, ai_review_verdict: 'pass' })).toBe(false)
  })

  it('where no AI review applies (no pull request, or opted out) the person is the only gate', () => {
    expect(reviewStageOf({ status: 'review' })).toBe('no_ai_review')
    expect(reviewStageOf({ status: 'review', ...PR, skip_ai_review: 1 })).toBe('no_ai_review')
    expect(reviewStageNeedsPerson('no_ai_review')).toBe(true)
  })
})

describe('needsYouReasons (obj 901387)', () => {
  it('does not count a review card that has had no AI review yet', () => {
    expect(needsYouReasons({ ...base, status: 'review', session_id: null, ...PR })).toEqual([])
  })

  it('counts a review card whose AI review passed', () => {
    expect(needsYouReasons({ ...base, status: 'review', session_id: null, ...PR, ai_review_verdict: 'pass' })).toEqual(['decision'])
  })

  it('counts an open decision wherever the card is, and stops once it is answered', () => {
    const waitingOnAi = { ...base, status: 'review', session_id: null, ...PR }
    expect(needsYouReasons({ ...waitingOnAi, open_decision: true })).toEqual(['decision'])
    expect(needsYouReasons({ ...waitingOnAi, open_decision: false })).toEqual([])
    expect(needsYouReasons({ ...base, status: 'working', session_id: 's', open_decision: true })).toEqual(['decision'])
  })

  it('counts a blocker, a secret a worker waits for, and a job that ended asking', () => {
    expect(needsYouReasons({ ...base, status: 'working', session_id: 's', has_blockers: 1 })).toEqual(['blocker'])
    expect(needsYouReasons({ ...base, status: 'review', ...PR, needs_secret_count: 1 })).toEqual(['blocker'])
    expect(needsYouReasons({ ...base, status: 'review', ...PR, job_disposition: 'needs_review' })).toEqual(['decision'])
  })

  it('the sidebar line keeps "in review" as its own number', () => {
    expect(botLiveLine({ running: 0, review: 47, queued: 0, done: 0, needs_you: 3 }, null)).toBe('3 need you · 47 in review')
    expect(botLiveLine({ running: 0, review: 9, queued: 0, done: 0, needs_you: 0 }, null)).toBe('Idle · 9 in review')
  })
})
