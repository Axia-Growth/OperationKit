import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION } from '../src/index.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

test('version bumped everywhere', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.version, '1.1.0')
  assert.equal(VERSION, '1.1.0')
})
test('CHANGELOG has a 1.1.0 section naming the feature', () => {
  const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8')
  assert.match(log, /^## \[?1\.1\.0\]?/m)
  assert.match(log, /--verbose/)
})
