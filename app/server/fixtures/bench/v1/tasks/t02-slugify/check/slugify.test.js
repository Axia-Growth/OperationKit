import test from 'node:test'
import assert from 'node:assert/strict'
import { slugify } from '../src/slugify.js'

test('basic', () => {
  assert.equal(slugify('Hello World'), 'hello-world')
  assert.equal(slugify('  Trim  me  '), 'trim-me')
})
test('punctuation and runs collapse', () => {
  assert.equal(slugify('Rock & Roll!!  Forever'), 'rock-roll-forever')
  assert.equal(slugify('a--b__c'), 'a-b-c')
})
test('accents are stripped', () => {
  assert.equal(slugify('Café Déjà Vu'), 'cafe-deja-vu')
})
test('empty', () => {
  assert.equal(slugify('!!!'), '')
})
