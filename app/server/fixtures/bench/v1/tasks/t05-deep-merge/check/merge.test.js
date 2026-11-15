import test from 'node:test'
import assert from 'node:assert/strict'
import { deepMerge } from '../src/merge.js'

test('recursive merge', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } }), { a: { b: 1, c: 3, d: 4 } })
})
test('arrays replace', () => {
  assert.deepEqual(deepMerge({ a: [1, 2] }, { a: [3] }), { a: [3] })
})
test('undefined keeps target', () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 })
})
test('inputs are not mutated', () => {
  const t = { a: { b: 1 } }
  const s = { a: { c: 2 } }
  deepMerge(t, s)
  assert.deepEqual(t, { a: { b: 1 } })
  assert.deepEqual(s, { a: { c: 2 } })
})
