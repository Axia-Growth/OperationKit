import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 900838 — regression tests for the CodeQL alerts fixed for public sync PR 85
// (decisions/2026-11-14-codeql-pr85-triage.md). Each ReDoS case used to take
// seconds-to-minutes on these inputs; each now has to finish well inside 1s.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-codeql-900838-'))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.VAULT_PATH = TMP

const { normalizeTitle } = await import('./title-normalize.js')
const { parseFrontmatter, serializeFrontmatter } = await import('../services/contacts.js')
const { parseWhatsShipping } = await import('../services/changelog.js')
const { formatYamlScalar } = await import('../routes/internal-vault.js')
const { kbPagePath } = await import('../services/kb-wiki/paths.js')

function fast<T>(fn: () => T, budgetMs = 1000): T {
  const t0 = Date.now()
  const out = fn()
  expect(Date.now() - t0).toBeLessThan(budgetMs)
  return out
}

describe('js/polynomial-redos fixes', () => {
  it('normalizeTitle: a long whitespace run is linear (POST /api/objectives title)', () => {
    expect(fast(() => normalizeTitle('a' + ' '.repeat(200_000) + 'b'))).toBe('a b')
    expect(fast(() => normalizeTitle('x' + ' '.repeat(200_000) + '- copy'))).toBe('x')
  })

  it('normalizeTitle: copy-suffix semantics are unchanged', () => {
    for (const t of ['Fix login (2)', 'Fix login ( 3 )', 'Fix login (copy)', 'Fix login (Copy 2)', 'Fix login copy', 'Fix login - Copy 3', 'Fix login — copy', 'Fix login (copy) (2)', 'Fix login: copy 4  ']) {
      expect(normalizeTitle(t)).toBe('fix login')
    }
    expect(normalizeTitle('Phase 2')).toBe('phase 2')
    expect(normalizeTitle('Fix photocopy')).toBe('fix photocopy')
    expect(normalizeTitle('(copy)')).toBe('')
  })

  it('parseFrontmatter: unterminated blank-line fence, long padded values and list items', () => {
    expect(fast(() => parseFrontmatter('---' + '\n'.repeat(100_000) + 'x'))).toBeNull()
    const fm = fast(() => parseFrontmatter(`---\nname:${' '.repeat(100_000)}\rAlice\ntags:\n  -${' '.repeat(100_000)}\rvip\n---\nbody`))
    expect(fm?.name).toBe('Alice')
    expect(fm?.tags).toEqual(['vip'])
  })

  it('parseFrontmatter: same results for ordinary notes (incl. CRLF)', () => {
    expect(parseFrontmatter('---\nname: Alice\ncount: 3\ntags:\n  - a\n  - "b"\nempty:\n---\n')).toEqual({ name: 'Alice', count: 3, tags: ['a', 'b'], empty: null })
    expect(parseFrontmatter('---\r\nname: Bob\r\n---\r\n')?.name).toBe('Bob')
  })

  it('parseWhatsShipping: a heading line padded with spaces is linear', () => {
    const body = `## What's shipping\nthe thing\n#${' '.repeat(100_000)}\rnext`
    expect(fast(() => parseWhatsShipping(body))).toBe('the thing')
    expect(parseWhatsShipping("##  What’s Shipping\n- one\n- [ ] todo\n## Notes\nno")).toBe('- one')
  })
})

describe('js/incomplete-sanitization fix (internal-vault frontmatter)', () => {
  it('quotes and escapes backslashes, quotes and newlines; the contacts reader decodes them back', () => {
    for (const v of ['C:\\temp\\', 'say "hi"', 'line1\nnew_key: injected', 'ends with \\', 'plain: colon']) {
      const yaml = formatYamlScalar(v)
      expect(yaml.startsWith('"')).toBe(true)
      expect(yaml).not.toContain('\n')
      expect(parseFrontmatter(`---\nname: ${yaml}\n---\n`)?.name).toBe(v)
    }
    expect(formatYamlScalar('Alice')).toBe('Alice')
    expect(formatYamlScalar(42)).toBe('42')
    // Older hand-written values that are not JSON literals keep the old reading.
    expect(parseFrontmatter('---\nname: "C:\\path \\"x\\""\n---\n')?.name).toBe('C:\\path "x"')
  })
})

describe('js/path-injection hardening (kb-wiki page paths)', () => {
  it('kbPagePath keeps a page inside the KB folder', () => {
    const kb = path.join(TMP, 'kb')
    expect(kbPagePath(kb, 'people/dana.md')).toBe(path.join(kb, 'people', 'dana.md'))
    expect(kbPagePath(kb, 'people/../../escape.md')).toBeNull()
    expect(kbPagePath(kb, '/etc/passwd')).toBeNull()
    expect(kbPagePath(kb, '')).toBeNull()
  })
})

describe('js/incomplete-sanitization: contacts frontmatter writer', () => {
  it('a trailing backslash or a newline cannot inject another key, and round-trips', () => {
    const fm = { name: 'Evil \\', company: 'Acme\nrole: admin', tags: ['a\\', 'b'] }
    const text = serializeFrontmatter(fm) + '\nbody\n'
    const back = parseFrontmatter(text)
    expect(back).not.toBeNull()
    expect(back!.role).toBeUndefined()
    expect(back!.name).toBe('Evil \\')
    expect(back!.company).toBe('Acme\nrole: admin')
  })
})
