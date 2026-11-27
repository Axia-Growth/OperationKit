// node --test scripts/codeql-drop-suppressed.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dropSuppressed, isInSourceSuppressed } from './codeql-drop-suppressed.mjs'

const loc = (uri, line) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: line } } }]

// Shapes as CodeQL 2.27 writes them with AlertSuppression.ql in the suite:
// suppressed → [{kind:"inSource"}]; others → [] (or absent when nothing is suppressed).
const fixture = () => ({
  version: '2.1.0',
  runs: [{
    tool: { driver: { name: 'CodeQL' } },
    results: [
      { ruleId: 'js/insufficient-password-hash', locations: loc('app/server/src/lib/api-keys.ts', 39), suppressions: [{ kind: 'inSource' }] },
      { ruleId: 'js/request-forgery', locations: loc('app/server/src/services/x.ts', 10), suppressions: [] },
      { ruleId: 'js/path-injection', locations: loc('app/server/src/routes/y.ts', 5) },
      { ruleId: 'js/redos', locations: loc('app/server/src/lib/z.ts', 7), suppressions: [{ kind: 'external' }] },
      { ruleId: 'js/redos', locations: loc('app/server/src/lib/z.ts', 8), suppressions: [{ kind: 'inSource', status: 'rejected' }] },
    ],
  }],
})

test('drops only results CodeQL marked suppressed in source', () => {
  const input = fixture()
  const { sarif, dropped } = dropSuppressed(input)
  assert.deepEqual(dropped, ['js/insufficient-password-hash app/server/src/lib/api-keys.ts:39'])
  assert.deepEqual(sarif.runs[0].results.map((r) => r.ruleId), [
    'js/request-forgery', 'js/path-injection', 'js/redos', 'js/redos',
  ])
  // input untouched
  assert.equal(input.runs[0].results.length, 5)
})

test('empty, absent, external and rejected suppressions are kept', () => {
  assert.equal(isInSourceSuppressed({}), false)
  assert.equal(isInSourceSuppressed({ suppressions: [] }), false)
  assert.equal(isInSourceSuppressed({ suppressions: [{ kind: 'external' }] }), false)
  assert.equal(isInSourceSuppressed({ suppressions: [{ kind: 'inSource', status: 'rejected' }] }), false)
  assert.equal(isInSourceSuppressed({ suppressions: [{ kind: 'inSource', status: 'underReview' }] }), false)
  assert.equal(isInSourceSuppressed({ suppressions: [{ kind: 'inSource', status: 'accepted' }] }), true)
})

test('CLI rewrites every .sarif under a directory and logs what it dropped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cq-drop-'))
  const f = join(dir, 'javascript.sarif')
  writeFileSync(f, JSON.stringify(fixture()))
  const script = fileURLToPath(new URL('./codeql-drop-suppressed.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [script, dir], { encoding: 'utf8' })
  assert.match(out, /dropped 1 result/)
  assert.match(out, /suppressed {2}js\/insufficient-password-hash app\/server\/src\/lib\/api-keys\.ts:39/)
  const after = JSON.parse(readFileSync(f, 'utf8'))
  assert.equal(after.runs[0].results.length, 4)
})
