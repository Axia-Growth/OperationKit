import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const wc = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'wc.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-'))
const f = path.join(dir, 'in.txt')
fs.writeFileSync(f, 'one two\nthree\n\nfour five six\n')
const run = (...args) => execFileSync(process.execPath, [wc, ...args], { encoding: 'utf8' }).trim()

test('default still counts words', () => {
  assert.equal(run(f), '6')
})
test('--lines counts newline characters, before or after the file', () => {
  assert.equal(run('--lines', f), '4')
  assert.equal(run(f, '--lines'), '4')
})
test('unknown flag exits non-zero', () => {
  assert.throws(() => execFileSync(process.execPath, [wc, '--nope', f], { stdio: 'pipe' }))
})
