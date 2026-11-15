import test from 'node:test'
import assert from 'node:assert/strict'
import { toRoman, fromRoman } from '../src/roman.js'

test('toRoman', () => {
  assert.equal(toRoman(1), 'I')
  assert.equal(toRoman(4), 'IV')
  assert.equal(toRoman(1994), 'MCMXCIV')
  assert.equal(toRoman(3999), 'MMMCMXCIX')
})
test('fromRoman', () => {
  assert.equal(fromRoman('IX'), 9)
  assert.equal(fromRoman('MCMXCIV'), 1994)
})
test('round trip 1..3999', () => {
  for (let i = 1; i <= 3999; i++) assert.equal(fromRoman(toRoman(i)), i)
})
test('out of range throws', () => {
  assert.throws(() => toRoman(0), RangeError)
  assert.throws(() => toRoman(4000), RangeError)
})
