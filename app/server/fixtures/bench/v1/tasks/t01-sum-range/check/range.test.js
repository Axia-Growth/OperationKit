import test from 'node:test'
import assert from 'node:assert/strict'
import { sumRange } from '../src/range.js'

test('inclusive on both ends', () => {
  assert.equal(sumRange(1, 3), 6)
  assert.equal(sumRange(5, 5), 5)
  assert.equal(sumRange(-2, 2), 0)
})
test('from > to sums nothing', () => {
  assert.equal(sumRange(4, 1), 0)
})
