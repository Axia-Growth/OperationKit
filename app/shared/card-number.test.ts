import { describe, it, expect } from 'vitest'
import { parseCardNumberQuery, formatCardNumber, MAX_QUERY_LENGTH } from './card-number'

describe('parseCardNumberQuery (obj 901080)', () => {
  it.each([
    ['901075', 901075],
    ['  #901075 ', 901075],
    ['# 901075', 901075],
    ['card 901075', 901075],
    ['Card #901075', 901075],
    ['obj 901075', 901075],
    ['objective #901075', 901075],
    ['https://ops.acme.test/o/901075', 901075],
    ['https://ops.acme.test/o/901075/', 901075],
    ['https://ops.acme.test/o/901075?tab=chat#x', 901075],
    ['https://ops.acme.test/preview/o/901075', 901075],
    ['http://localhost:3002/o/7', 7],
    ['/o/901075', 901075],
    ['ops.acme.test/o/901075', 901075],
  ])('%s → %s', (q, id) => {
    expect(parseCardNumberQuery(q)).toBe(id)
  })

  it.each([
    '', '   ', null, undefined, '#', '0', '#0', '12.5', 'kubernetes', 'fix 901075 later',
    'https://ops.acme.test/w/901075', 'https://ops.acme.test/o/abc', 'https://x.test/foo/901075',
    '99999999999999999999',
  ])('%s is not a card number', q => {
    expect(parseCardNumberQuery(q as string)).toBeNull()
  })

  it('a long adversarial query returns null fast (no polynomial backtracking, obj 901089)', () => {
    const evil = 'card' + ' '.repeat(50_000) + 'x'
    const t0 = performance.now()
    expect(parseCardNumberQuery(evil)).toBeNull()
    expect(performance.now() - t0).toBeLessThan(50)
  })

  it('a query over the length cap is not a card number, even if it ends in digits', () => {
    expect(parseCardNumberQuery('card' + ' '.repeat(MAX_QUERY_LENGTH) + '901075')).toBeNull()
    expect(parseCardNumberQuery('card' + ' '.repeat(10) + '901075')).toBe(901075)
  })

  it('formats as #<id>', () => {
    expect(formatCardNumber(901075)).toBe('#901075')
  })
})
