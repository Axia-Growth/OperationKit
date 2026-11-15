import test from 'node:test'
import assert from 'node:assert/strict'
import { LruCache } from '../src/lru.js'

test('evicts least recently used', () => {
  const c = new LruCache(2)
  c.set('a', 1)
  c.set('b', 2)
  assert.equal(c.get('a'), 1) // a is now most recent
  c.set('c', 3) // evicts b
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('c'), 3)
  assert.equal(c.size, 2)
})
test('set on existing key refreshes and updates', () => {
  const c = new LruCache(2)
  c.set('a', 1)
  c.set('b', 2)
  c.set('a', 10)
  c.set('c', 3) // evicts b
  assert.equal(c.get('a'), 10)
  assert.equal(c.has('b'), false)
})
test('capacity must be a positive integer', () => {
  assert.throws(() => new LruCache(0), RangeError)
})
