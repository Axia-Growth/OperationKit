import { describe, expect, it } from 'vitest'
import { COMPOSER_MIN_PX, fitComposerHeight } from './composerFit'

describe('fitComposerHeight (obj 901376)', () => {
  it('leaves the box alone while the list has at least half the visible area', () => {
    expect(fitComposerHeight(92, 171, 328)).toBe(92)
    expect(fitComposerHeight(44, 164, 328)).toBe(44)
  })
  it('shrinks the box by exactly what the list is short of half', () => {
    // 328 visible: half is 164. The list has 121 with a 142px box, so the box gives back 43.
    expect(fitComposerHeight(142, 121, 328)).toBe(99)
  })
  it('rounds half up on an odd visible height', () => {
    expect(fitComposerHeight(100, 160, 329)).toBe(95)
  })
  it('never goes under one line, and never grows a box that is already smaller', () => {
    expect(fitComposerHeight(142, 10, 328)).toBe(COMPOSER_MIN_PX)
    expect(fitComposerHeight(30, 10, 328)).toBe(30)
  })
})
