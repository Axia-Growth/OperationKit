import { describe, expect, it } from 'vitest'
import { notePathFor, slugify } from './notes.js'

describe('Unicode note slugs', () => {
  it('keeps non-Latin letters and numbers and adds a stable short SHA-1 suffix', () => {
    const japanese = slugify('東京 2026')
    const cyrillic = slugify('Москва')
    expect(japanese).toMatch(/^東京-2026-[0-9a-f]{6}$/)
    expect(cyrillic).toMatch(/^москва-[0-9a-f]{6}$/)
    expect(slugify('東京 2026')).toBe(japanese)
    expect(notePathFor('topic', '東京 2026')).toBe(`topics/${japanese}.md`)
  })

  it('does not collapse distinct non-Latin names to the same path', () => {
    expect(slugify('東京')).not.toBe(slugify('京都'))
    expect(notePathFor('person', 'Иван')).not.toBe(notePathFor('person', 'Пётр'))
  })

  it('preserves existing readable Latin slugs and hashes names with no letters', () => {
    expect(slugify('Acme & Sons, LLC')).toBe('acme-and-sons-llc')
    expect(slugify('Café & Co')).toBe('cafe-and-co')
    expect(slugify('😀')).toMatch(/^untitled-[0-9a-f]{6}$/)
  })
})
