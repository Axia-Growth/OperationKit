import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDuration } from '../src/duration.js'

test('valid', () => {
  assert.equal(parseDuration('45s'), 45)
  assert.equal(parseDuration('1h30m'), 5400)
  assert.equal(parseDuration('2d'), 172800)
  assert.equal(parseDuration('1d2h3m4s'), 93784)
})
test('invalid throws RangeError', () => {
  for (const bad of ['', '1x', '1m1h', '1h1h', '1.5h', ' 1h', '1 h', 'h']) {
    assert.throws(() => parseDuration(bad), RangeError, bad)
  }
})
