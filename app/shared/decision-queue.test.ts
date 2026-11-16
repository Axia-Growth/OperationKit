import { describe, it, expect } from 'vitest'
import {
  NO_BRIEFING_TEXT,
  STACK_SHORTCUTS,
  compareQueueItems,
  hasNoBriefing,
  stackActionForKey,
  stackAfterAnswer,
  stackMove,
  urgencyForCard,
  type DecisionUrgency,
} from './decision-queue'
import type { DecisionView } from './decision-briefing'

// obj 901084 — the pure rules the stack page and the server share.

const item = (id: number, urgency: DecisionUrgency, created_at: string) => ({ urgency, decision: { id, created_at } as DecisionView })

describe('queue order: urgency, then age', () => {
  it('puts work-stopped before still-running, then oldest first, then id', () => {
    const list = [
      item(1, 'running', '2026-11-10 08:00:00'),
      item(2, 'blocking', '2026-11-15 08:00:00'),
      item(3, 'blocking', '2026-11-12 08:00:00'),
      item(4, 'running', '2026-11-09 08:00:00'),
      item(5, 'blocking', '2026-11-12 08:00:00'),
    ]
    expect([...list].sort(compareQueueItems).map(i => i.decision.id)).toEqual([3, 5, 2, 4, 1])
  })

  it('a working card is "running"; parked, queued and finished-by-asking cards are "blocking"', () => {
    expect(urgencyForCard('working')).toBe('running')
    for (const s of ['review', 'queue', 'done', 'blocked']) expect(urgencyForCard(s)).toBe('blocking')
  })
})

describe('stack navigation', () => {
  it('next / prev wrap at both ends; an unknown or missing current goes to the first', () => {
    const ids = [10, 20, 30]
    expect(stackMove(ids, 10, 'next')).toBe(20)
    expect(stackMove(ids, 30, 'next')).toBe(10)
    expect(stackMove(ids, 10, 'prev')).toBe(30)
    expect(stackMove(ids, 20, 'stay')).toBe(20)
    expect(stackMove(ids, 99, 'next')).toBe(10)
    expect(stackMove(ids, null, 'stay')).toBe(10)
    expect(stackMove([], 10, 'next')).toBeNull()
  })

  it('after an answer, the one that was behind it takes its place; the last wraps to the first', () => {
    expect(stackAfterAnswer([10, 20, 30], 20, [10, 30])).toBe(30)
    expect(stackAfterAnswer([10, 20, 30], 30, [10, 20])).toBe(10)
    // The next one also left (answered in another tab): skip to the one after.
    expect(stackAfterAnswer([10, 20, 30, 40], 20, [10, 40])).toBe(40)
    expect(stackAfterAnswer([10], 10, [])).toBeNull()
  })
})

describe('keyboard shortcuts', () => {
  it('maps each key to one action, 1-4 to option A-D', () => {
    expect(stackActionForKey('Enter')).toEqual({ action: 'approve' })
    expect(stackActionForKey('1')).toEqual({ action: 'option', index: 0 })
    expect(stackActionForKey('4')).toEqual({ action: 'option', index: 3 })
    expect(stackActionForKey('d')).toEqual({ action: 'deny' })
    expect(stackActionForKey('D')).toEqual({ action: 'deny' })
    expect(stackActionForKey('s')).toEqual({ action: 'next' })
    expect(stackActionForKey('ArrowRight')).toEqual({ action: 'next' })
    expect(stackActionForKey('ArrowLeft')).toEqual({ action: 'prev' })
    expect(stackActionForKey('q')).toEqual({ action: 'ask' })
    expect(stackActionForKey('?')).toEqual({ action: 'help' })
    expect(stackActionForKey('x')).toBeNull()
    expect(stackActionForKey('5')).toBeNull()
  })

  it('no key is bound twice', () => {
    const keys = STACK_SHORTCUTS.flatMap(s => s.keys)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('legacy decisions', () => {
  it('a flagged or empty briefing reads as "no briefing given — ask the bot"', () => {
    const b = { context: '', question: '', options: [], recommended: '', recommended_why: '' }
    expect(hasNoBriefing({ incomplete: true, briefing: { ...b, question: 'x' } })).toBe(true)
    expect(hasNoBriefing({ incomplete: false, briefing: b })).toBe(true)
    expect(hasNoBriefing({ incomplete: false, briefing: { ...b, question: 'Send?' } })).toBe(false)
    expect(NO_BRIEFING_TEXT).toMatch(/^No briefing given — ask the bot/)
  })
})
