import { describe, it, expect } from 'vitest'
import { countExact, exactTokens, fuseRankings, RRF_K } from './fusion.js'

describe('fuseRankings (reciprocal rank fusion)', () => {
  it('scores Σ 1/(k + rank) per list', () => {
    const [top] = fuseRankings({ keyword: ['a', 'b'], semantic: ['a'] })
    expect(top.key).toBe('a')
    expect(top.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1), 10)
    expect(top.match).toBe('both')
    expect(top.keywordRank).toBe(1)
    expect(top.semanticRank).toBe(1)
  })

  it('a doc found by both rankers beats one ranked first by only one', () => {
    const fused = fuseRankings({ keyword: ['k1', 'both'], semantic: ['s1', 'both'] })
    expect(fused[0].key).toBe('both')
    expect(fused.map(f => f.match)).toEqual(['both', 'keyword', 'semantic'])
  })

  it('keeps semantic-only hits (the paraphrase case)', () => {
    const fused = fuseRankings({ keyword: [], semantic: ['para'] })
    expect(fused).toHaveLength(1)
    expect(fused[0]).toMatchObject({ key: 'para', match: 'semantic', keywordRank: null, semanticRank: 1 })
  })

  it('pins exact matches above every fused result, whatever their ranks', () => {
    const fused = fuseRankings({
      keyword: ['a', 'b', 'c'],
      semantic: ['a', 'b', 'c'],
      exact: new Map([['c', 1]]),
    })
    expect(fused[0]).toMatchObject({ key: 'c', exact: true, match: 'exact' })
    expect(fused[0].score).toBeGreaterThan(1)
    expect(fused.slice(1).every(f => !f.exact && f.score < 1)).toBe(true)
  })

  it('orders the exact tier by how many tokens matched, then keyword rank', () => {
    const fused = fuseRankings({
      keyword: ['one', 'two-a', 'two-b'],
      semantic: [],
      exact: new Map([['one', 1], ['two-b', 2], ['two-a', 2]]),
    })
    expect(fused.map(f => f.key)).toEqual(['two-a', 'two-b', 'one'])
  })

  it('an exact doc that neither ranker returned still makes the list', () => {
    const fused = fuseRankings({ keyword: ['x'], semantic: ['y'], exact: new Map([['id-doc', 1]]) })
    expect(fused[0].key).toBe('id-doc')
  })

  it('honours weights and is stable on ties', () => {
    const w = fuseRankings({ keyword: ['k'], semantic: ['s'], keywordWeight: 2 })
    expect(w[0].key).toBe('k')
    const tie = fuseRankings({ keyword: ['b'], semantic: ['a'] })
    expect(tie.map(t => t.key)).toEqual(['a', 'b'])
  })

  it('ignores duplicates within a list (first rank wins)', () => {
    const [top] = fuseRankings({ keyword: ['a', 'a'], semantic: [] })
    expect(top.keywordRank).toBe(1)
  })
})

describe('exactTokens', () => {
  it('extracts card numbers and IDs', () => {
    expect(exactTokens('what happened on #900816')).toContain('900816')
    expect(exactTokens('obj 900510 root cause')).toContain('900510')
    expect(exactTokens('obj-900816 notes')).toContain('obj-900816')
    expect(exactTokens('obj719092')).toEqual(['obj719092'])
  })

  it('extracts identifiers with separators, camelCase and ALLCAPS names', () => {
    const t = exactTokens('sqlite-vec vs kb_embed_provider in self-deploy.sh, sweepStaleWorkingSessions and GHL')
    expect(t).toEqual(expect.arrayContaining(['sqlite-vec', 'kb_embed_provider', 'self-deploy.sh', 'sweepstaleworkingsessions', 'ghl']))
  })

  it('extracts quoted phrases and multi-word proper names, minus question words', () => {
    const t = exactTokens('What did Dana Ruiz say about "reciprocal rank fusion"?')
    expect(t).toEqual(expect.arrayContaining(['reciprocal rank fusion', 'dana ruiz']))
    expect(t.some(x => x.startsWith('what'))).toBe(false)
  })

  it('returns nothing for a plain natural-language question', () => {
    expect(exactTokens('how do we roll back a bad deploy')).toEqual([])
  })

  it('returns longest first', () => {
    const t = exactTokens('"a long quoted phrase" ab-c')
    expect(t[0]).toBe('a long quoted phrase')
  })
})

describe('countExact', () => {
  it('counts distinct tokens present, case-insensitively', () => {
    expect(countExact('Notes for OBJ-900816 and sqlite-vec', ['obj-900816', 'sqlite-vec', 'missing'])).toBe(2)
    expect(countExact('anything', [])).toBe(0)
  })
})

describe('countExact word boundaries', () => {
  it('matches whole tokens only', () => {
    expect(countExact('the factor and the director', ['cto'])).toBe(0)
    expect(countExact('our CTO said', ['cto'])).toBe(1)
    expect(countExact('ids 14421 and 4420', ['442'])).toBe(0)
    expect(countExact('PR #442 merged', ['442'])).toBe(1)
    expect(countExact('decisions/2026-11-11-obj900510-root.md', ['900510'])).toBe(1)
    expect(countExact('uses sqlite-vec here', ['sqlite-vec'])).toBe(1)
    expect(countExact('uses sqlite-vector here', ['sqlite-vec'])).toBe(0)
    expect(countExact('reciprocal  rank\nfusion', ['reciprocal rank fusion'])).toBe(1)
  })

  it('ignores 2-letter all-caps words like PR or OK', () => {
    expect(exactTokens('PR OK')).toEqual([])
  })
})
