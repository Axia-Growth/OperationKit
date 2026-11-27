/**
 * Every in-source CodeQL suppression in server code must say WHY, and the
 * insufficient-password-hash suppression must stay on the one API-key lookup
 * hash it was justified for (obj 901854). A bare `// codeql[rule]` would hide a
 * finding with no reason; a second password-hash suppression elsewhere would
 * hide a real fast hash of a password. Either one fails here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash } from 'crypto'
import { hashApiKey, mintApiKey } from './api-keys.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_FILE = /\.(test|spec)\.(ts|tsx|mts|mjs|js)$|\.testkit\.ts$/
const MARK = /\/\/\s*codeql\[([^\]]+)\]/

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'fixtures' || e.name === '__fixtures__') continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(e.name) && !TEST_FILE.test(e.name)) out.push(p)
  }
  return out
}

interface Mark { file: string; line: number; rule: string; text: string; next: string }

function marks(): Mark[] {
  const found: Mark[] = []
  for (const file of sourceFiles(SRC)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    lines.forEach((text, i) => {
      const m = MARK.exec(text)
      if (m) found.push({ file: path.relative(SRC, file), line: i + 1, rule: m[1].trim(), text, next: lines[i + 1] ?? '' })
    })
  }
  return found
}

describe('CodeQL in-source suppressions (server code)', () => {
  const all = marks()

  it('finds the known suppressions (the scan is looking in the right place)', () => {
    expect(all.length).toBeGreaterThanOrEqual(2)
    expect(all.some((m) => m.file === 'index.ts' && m.rule === 'js/missing-token-validation')).toBe(true)
  })

  it('every suppression names a rule and gives a reason after "--"', () => {
    for (const m of all) {
      expect(m.rule, `${m.file}:${m.line}`).toMatch(/^[a-z]+\/[a-z0-9-]+(\s*,\s*[a-z]+\/[a-z0-9-]+)*$/)
      const reason = m.text.split(/\]\s+--\s+/)[1] ?? ''
      expect(reason.trim().length, `${m.file}:${m.line} needs "-- <reason>"`).toBeGreaterThanOrEqual(20)
    }
  })

  it('js/insufficient-password-hash is suppressed only on the API-key lookup hash', () => {
    const pw = all.filter((m) => m.rule.includes('js/insufficient-password-hash'))
    expect(pw.map((m) => m.file)).toEqual([path.join('lib', 'api-keys.ts')])
    // The suppression covers the next line only; it must be the SHA-256 inside hashApiKey.
    expect(pw[0].next.trim()).toBe("return createHash('sha256').update(plaintext).digest('hex')")
    const src = fs.readFileSync(path.join(SRC, 'lib', 'api-keys.ts'), 'utf8').split('\n')
    const fnLine = src.findIndex((l) => l.startsWith('export function hashApiKey('))
    expect(fnLine).toBeGreaterThan(-1)
    expect(pw[0].line).toBe(fnLine + 2)
  })
})

describe('hashApiKey: what the suppression relies on', () => {
  it('minted keys carry 256 bits of randomness (not a person-chosen secret)', () => {
    const key = mintApiKey()
    const body = key.slice('cc_live_'.length)
    expect(Buffer.from(body, 'base64url')).toHaveLength(32)
    expect(mintApiKey()).not.toBe(key)
  })

  it('is a deterministic SHA-256 hex digest, so a presented key is found by one indexed lookup', () => {
    const key = mintApiKey()
    expect(hashApiKey(key)).toBe(createHash('sha256').update(key).digest('hex'))
    expect(hashApiKey(key)).toBe(hashApiKey(key))
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/)
  })
})
