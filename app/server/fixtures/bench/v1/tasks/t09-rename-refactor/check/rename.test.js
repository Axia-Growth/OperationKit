import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as pricing from '../src/pricing.js'
import { cartTotal } from '../src/cart.js'

const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')

test('renamed export exists and old one is gone', () => {
  assert.equal(typeof pricing.computeTotal, 'function')
  assert.equal(pricing.calc, undefined)
})
test('behaviour unchanged', () => {
  assert.equal(cartTotal([{ price: 10, qty: 2 }, { price: 0.5, qty: 3 }], 0.1), 23.65)
})
test('no reference to the old name remains in src/', () => {
  for (const f of fs.readdirSync(src)) {
    assert.doesNotMatch(fs.readFileSync(path.join(src, f), 'utf8'), /\bcalc\b/, f)
  }
})
