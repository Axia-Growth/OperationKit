import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { renderEnvExports, shellSingleQuote } from './shell-quote.js'

/**
 * Public issue #160: session env values were rendered via `JSON.stringify`
 * (i.e. double-quoted) into `export KEY=<value>` lines. Bash still expands
 * `$…`, backticks and `\…` inside double quotes, so `$3` was lost from a
 * password, a `$(...)`/backtick command actually ran, and a multi-line value
 * arrived as a literal `\n`. These tests run the rendered export lines
 * through a REAL bash and assert every value round-trips byte-for-byte, and
 * that no injected command substitution executed.
 */
describe('renderEnvExports (public issue #160 round-trip)', () => {
  const CASES: Record<string, string> = {
    DOLLAR_SIGIL: 'Tr0ub4dor$3x!',
    DOLLAR_PAREN: 'x$(echo RAN)y',
    BACKTICK: 'x`echo RAN`y',
    SINGLE_QUOTE: "it's",
    DOUBLE_QUOTE: 'say "hi"',
    BACKSLASH: 'a\\b\\n c',
    TWO_LINE: 'line one\nline two',
    EMPTY: '',
    PADDED: '  leading and trailing  ',
  }

  function runThroughBash(env: Record<string, string>): Record<string, string> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-quote-test-'))
    try {
      const markerStart = '---CC-ENV-START---'
      const markerEnd = '---CC-ENV-END---'
      const script = `#!/bin/bash
${renderEnvExports(env)}
for name in ${Object.keys(env).join(' ')}; do
  echo "${markerStart}$name${markerEnd}"
  printf '%s' "\${!name}"
  echo
  echo "${markerStart}END${markerEnd}"
done
`
      const scriptFile = path.join(dir, 'script.sh')
      fs.writeFileSync(scriptFile, script, { mode: 0o700 })
      const out = execFileSync('bash', [scriptFile], { encoding: 'utf8' })
      const result: Record<string, string> = {}
      const re = /---CC-ENV-START---(\S+)---CC-ENV-END---\n([\s\S]*?)\n---CC-ENV-START---END---CC-ENV-END---\n/g
      let m: RegExpExecArray | null
      while ((m = re.exec(out + '\n'))) {
        result[m[1]] = m[2]
      }
      return result
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }

  it('every case round-trips byte-for-byte through real bash', () => {
    const result = runThroughBash(CASES)
    for (const [name, expected] of Object.entries(CASES)) {
      expect(result[name]).toBe(expected)
    }
  })

  it('does NOT run a $(...) command substitution embedded in a value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-quote-test-'))
    try {
      const sentinel = path.join(dir, 'ran.txt')
      const env = { PAYLOAD: `$(touch ${sentinel})` }
      const script = `#!/bin/bash\n${renderEnvExports(env)}\necho "$PAYLOAD"\n`
      const scriptFile = path.join(dir, 'script.sh')
      fs.writeFileSync(scriptFile, script, { mode: 0o700 })
      const out = execFileSync('bash', [scriptFile], { encoding: 'utf8' })
      expect(out.trim()).toBe(`$(touch ${sentinel})`)
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does NOT run a backtick command substitution embedded in a value', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-quote-test-'))
    try {
      const sentinel = path.join(dir, 'ran.txt')
      const env = { PAYLOAD: `\`touch ${sentinel}\`` }
      const script = `#!/bin/bash\n${renderEnvExports(env)}\necho "$PAYLOAD"\n`
      const scriptFile = path.join(dir, 'script.sh')
      fs.writeFileSync(scriptFile, script, { mode: 0o700 })
      const out = execFileSync('bash', [scriptFile], { encoding: 'utf8' })
      expect(out.trim()).toBe(`\`touch ${sentinel}\``)
      expect(fs.existsSync(sentinel)).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shellSingleQuote', () => {
  it('wraps a plain value in single quotes', () => {
    expect(shellSingleQuote('abc')).toBe("'abc'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'")
  })

  it('leaves $, backticks and backslashes untouched inside the quotes', () => {
    expect(shellSingleQuote('$(x) `y` \\z')).toBe("'$(x) `y` \\z'")
  })
})
