import { describe, expect, it } from 'vitest'
import { normalizeCriteria } from './outcome-intake'

const ids = (raw: unknown) => normalizeCriteria(raw).map((c) => c.id)

// The old `/^-+|-+$/g` trim, kept here only to prove the new code matches it.
const oldSlugId = (raw: string, n: number) =>
  raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || `c${n}`

describe('outcome intake criterion ids (CodeQL polynomial-regex fix)', () => {
  it('keeps the original kebab ids: trims edge dashes, collapses inner runs, falls back to cN', () => {
    expect(ids([
      { criterion: 'a', id: '--Before & After--' },
      { criterion: 'b', id: '  PR is green!! ' },
      { criterion: 'c', id: '---' },
      { criterion: 'd', id: '' },
      { criterion: 'e', id: 'rule-1' },
      { criterion: 'f', id: 'pr-is-green' },
    ])).toEqual(['before-after', 'pr-is-green', 'c3', 'c4', 'c5', 'pr-is-green-6'])
  })

  it('matches the old regex on mixed inputs', () => {
    const samples = ['-a-', 'a--b', '--', '-', 'A_B', '  x  ', '-'.repeat(500) + 'z' + '-'.repeat(500), 'é-é', '']
    for (const s of samples) {
      expect(ids([{ criterion: 'x', id: s }])[0]).toBe(oldSlugId(s, 1))
    }
  })

  it('stays fast and correct on a long run of dashes', () => {
    const evil = '-'.repeat(200_000) + 'x' + '-'.repeat(200_000) + '!'
    const t0 = performance.now()
    expect(ids([{ criterion: 'x', id: evil }])).toEqual(['x'])
    expect(ids([{ criterion: 'y', id: '-'.repeat(200_000) }])).toEqual(['c1'])
    expect(performance.now() - t0).toBeLessThan(1000)
  })
})
