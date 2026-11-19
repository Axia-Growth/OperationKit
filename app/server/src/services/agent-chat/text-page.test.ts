/**
 * obj 901494: a long text is read one page at a time, and every page says
 * where the next one starts.
 */
import { describe, it, expect } from 'vitest'
import { offsetArg, pageNote, pageText } from './text-page.js'

const lines = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}. loop line number ${i + 1} with some words on it`).join('\n') + '\n'

describe('pageText', () => {
  it('returns a short text whole, with no next page', () => {
    const p = pageText('hello\nworld\n', 0, 20_000)
    expect(p).toEqual({ content: 'hello\nworld\n', offset: 0, next_offset: null, total_chars: 12, truncated: false })
    expect(pageNote(p, 'a.md')).toBeUndefined()
  })

  it('pages through a long text: the pages join back into the exact original', () => {
    const text = lines(2000)
    const pages: string[] = []
    let offset: number | null = 0
    let calls = 0
    while (offset !== null) {
      const p = pageText(text, offset, 20_000)
      expect(p.offset).toBe(offset)
      expect(p.total_chars).toBe(text.length)
      expect(p.content.length).toBeLessThanOrEqual(20_000)
      expect(p.truncated).toBe(p.next_offset !== null)
      // a page that is not the last ends on a whole line
      if (p.next_offset !== null) expect(p.content.endsWith('\n')).toBe(true)
      pages.push(p.content)
      offset = p.next_offset
      if (++calls > 50) throw new Error('paging did not end')
    }
    expect(pages.length).toBeGreaterThan(3)
    expect(pages.join('')).toBe(text)
  })

  it('still moves forward through text with no line breaks', () => {
    const text = 'x'.repeat(45_000)
    const a = pageText(text, 0, 20_000)
    const b = pageText(text, a.next_offset!, 20_000)
    const c = pageText(text, b.next_offset!, 20_000)
    expect([a.content.length, b.content.length, c.content.length]).toEqual([20_000, 20_000, 5_000])
    expect(c.next_offset).toBeNull()
  })

  it('never cuts an emoji in two', () => {
    const text = 'a' + '😀'.repeat(30)
    const a = pageText(text, 0, 10)
    expect(a.content).toBe('a' + '😀'.repeat(4))
    const b = pageText(text, a.next_offset!, 10)
    expect(b.content).toBe('😀'.repeat(5))
    // an offset that lands inside a pair backs up to its start
    expect(pageText(text, 2, 4).content).toBe('😀😀')
  })

  it('clamps a bad offset instead of failing', () => {
    expect(pageText('abc', -5, 10).content).toBe('abc')
    expect(pageText('abc', 99, 10)).toMatchObject({ content: '', offset: 3, next_offset: null, truncated: false })
    expect(pageText('abc', Number.NaN, 10).content).toBe('abc')
  })
})

describe('offsetArg', () => {
  it('reads a number or digits, and treats anything else as the start', () => {
    expect(offsetArg(20000)).toBe(20000)
    expect(offsetArg('20000')).toBe(20000)
    expect(offsetArg(12.9)).toBe(12)
    for (const bad of [undefined, null, '', 'abc', -1, '-3', {}, Number.POSITIVE_INFINITY]) expect(offsetArg(bad)).toBe(0)
  })
})

describe('pageNote', () => {
  it('names the exact next call, and says when the last page is reached', () => {
    const text = lines(1000)
    const first = pageText(text, 0, 20_000)
    const note = pageNote(first, 'workspaces/ok/open-loops.md')!
    expect(note).toContain(`offset ${first.next_offset}`)
    expect(note).toContain('path "workspaces/ok/open-loops.md"')
    expect(note).toContain('NOT the whole file')
    expect(note).toContain('Do not write this file back until you have read every page')
    let p = first
    while (p.next_offset !== null) p = pageText(text, p.next_offset, 20_000)
    expect(pageNote(p, 'x.md')).toMatch(/^This is the last page/)
  })
})
