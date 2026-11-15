import test from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver } from '../src/semver.js'

test('core', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0'), 0)
  assert.equal(compareSemver('1.2.0', '1.10.0'), -1)
  assert.equal(compareSemver('2.0.0', '1.99.99'), 1)
})
test('prerelease ordering from semver.org', () => {
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0']
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.equal(compareSemver(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`)
    assert.equal(compareSemver(ordered[i + 1], ordered[i]), 1)
  }
})
