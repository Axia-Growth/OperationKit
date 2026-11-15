import { describe, it, expect } from 'vitest'
import { chunkMarkdown, splitFrontmatter, windowText, MAX_CHUNKS_PER_DOC } from './chunk.js'

const para = (word: string, n: number) => Array.from({ length: n }, (_, i) => `${word} sentence number ${i} explains one more detail.`).join(' ')

describe('splitFrontmatter', () => {
  it('returns the declared title and where the body starts', () => {
    const r = splitFrontmatter('---\ntitle: "Deploy runbook"\ntags: [ops]\n---\n# Heading\nBody')
    expect(r.title).toBe('Deploy runbook')
    expect(r.body).toBe('# Heading\nBody')
    expect(r.bodyLine).toBe(5)
  })

  it('leaves text without frontmatter alone', () => {
    expect(splitFrontmatter('# Only a heading')).toEqual({ title: '', body: '# Only a heading', bodyLine: 1 })
  })
})

describe('chunkMarkdown', () => {
  it('splits at headings and carries the heading trail', () => {
    const md = [
      '# Deploy runbook',
      para('intro', 6),
      '## Rollback',
      para('rollback', 6),
      '### Database',
      para('database', 6),
      '## Monitoring',
      para('monitor', 6),
    ].join('\n')
    const chunks = chunkMarkdown(md)
    expect(chunks.map(c => c.heading)).toEqual([
      'Deploy runbook',
      'Deploy runbook > Rollback',
      'Deploy runbook > Rollback > Database',
      'Deploy runbook > Monitoring',
    ])
    expect(chunks[1].text).toContain('rollback sentence number 0')
    expect(chunks[1].text).not.toContain('database sentence')
    // The embedded text leads with the trail; the stored text does not.
    expect(chunks[2].embedText.startsWith('Deploy runbook > Rollback > Database\n\n')).toBe(true)
    expect(chunks[2].text.startsWith('database')).toBe(true)
    expect(chunks.map(c => c.index)).toEqual([0, 1, 2, 3])
  })

  it('records the 1-based line of each section in the original file (frontmatter included)', () => {
    const md = '---\ntitle: T\n---\n# T\n' + para('a', 6) + '\n## Second\n' + para('b', 6)
    const chunks = chunkMarkdown(md)
    expect(chunks[0].line).toBe(4)
    expect(chunks[1].line).toBe(6)
  })

  it('uses the frontmatter title, else the first H1, else the fallback', () => {
    expect(chunkMarkdown('---\ntitle: From FM\n---\n## Sub\n' + para('x', 6))[0].heading).toBe('From FM > Sub')
    expect(chunkMarkdown(para('x', 6), 'file name')[0].heading).toBe('file name')
    expect(chunkMarkdown(para('x', 6))[0].heading).toBe('')
  })

  it('does not treat # lines inside code fences as headings', () => {
    const md = '# Doc\n' + para('a', 4) + '\n```bash\n# just a comment\necho hi\n```\n' + para('b', 4)
    const chunks = chunkMarkdown(md)
    expect(chunks).toHaveLength(1)
    expect(chunks[0].text).toContain('# just a comment')
  })

  it('merges tiny sections forward instead of emitting near-empty chunks', () => {
    const md = '# Doc\n## A\nshort a\n## B\nshort b\n## C\n' + para('c', 10)
    const chunks = chunkMarkdown(md, '', { minChars: 200 })
    expect(chunks.length).toBeLessThan(3)
    expect(chunks[0].text).toContain('short a')
    expect(chunks[0].text).toContain('short b')
  })

  it('windows a long section with overlap and never exceeds maxChars', () => {
    const md = '# Long\n' + para('long', 120)
    const chunks = chunkMarkdown(md, '', { maxChars: 600, overlapChars: 120 })
    expect(chunks.length).toBeGreaterThan(5)
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(600)
      expect(c.heading).toBe('Long')
    }
    // Consecutive windows share text (the overlap).
    const tail = chunks[0].text.slice(-60)
    const shared = tail.split(' ').slice(2, 6).join(' ')
    expect(chunks[1].text).toContain(shared)
  })

  it('caps the number of chunks per document', () => {
    const md = Array.from({ length: MAX_CHUNKS_PER_DOC + 50 }, (_, i) => `## S${i}\n${para(`s${i}`, 6)}`).join('\n')
    expect(chunkMarkdown(md)).toHaveLength(MAX_CHUNKS_PER_DOC)
  })

  it('returns nothing for an empty or heading-only document', () => {
    expect(chunkMarkdown('')).toEqual([])
    expect(chunkMarkdown('# Title only\n\n## And a sub')).toEqual([])
  })

  it('is deterministic', () => {
    const md = '# A\n' + para('x', 40) + '\n## B\n' + para('y', 40)
    expect(chunkMarkdown(md)).toEqual(chunkMarkdown(md))
  })
})

describe('windowText', () => {
  it('returns short text unchanged', () => {
    expect(windowText('hello world', 100, 10)).toEqual(['hello world'])
  })

  it('prefers paragraph boundaries', () => {
    const text = `${'a '.repeat(200).trim()}\n\n${'b '.repeat(200).trim()}`
    const parts = windowText(text, 500, 50)
    expect(parts[0].endsWith('a')).toBe(true)
    expect(parts.join(' ')).toContain('b b')
  })

  it('always makes progress on text with no boundaries', () => {
    const parts = windowText('x'.repeat(5000), 1000, 200)
    expect(parts.length).toBeGreaterThanOrEqual(5)
    expect(parts.length).toBeLessThan(20)
  })
})
