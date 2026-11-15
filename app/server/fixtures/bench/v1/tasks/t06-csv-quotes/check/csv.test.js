import test from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv } from '../src/csv.js'

test('plain', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n'), [['a', 'b'], ['1', '2']])
})
test('quoted comma and escaped quote', () => {
  assert.deepEqual(parseCsv('name,quote\n"Smith, J","say ""hi"""'), [['name', 'quote'], ['Smith, J', 'say "hi"']])
})
test('CRLF and empty fields', () => {
  assert.deepEqual(parseCsv('a,,c\r\n,,\r\n'), [['a', '', 'c'], ['', '', '']])
})
test('newline inside quotes', () => {
  assert.deepEqual(parseCsv('"line1\nline2",x'), [['line1\nline2', 'x']])
})
