import test from 'node:test'
import assert from 'node:assert/strict'
import { retry } from '../src/retry.js'

test('succeeds after failures', async () => {
  let n = 0
  const v = await retry(async () => { if (++n < 3) throw new Error('e' + n); return 'ok' }, { attempts: 3, delayMs: 1 })
  assert.equal(v, 'ok')
  assert.equal(n, 3)
})
test('rejects with the last error after the attempt budget', async () => {
  let n = 0
  await assert.rejects(retry(async () => { throw new Error('e' + ++n) }, { attempts: 2, delayMs: 1 }), /e2/)
  assert.equal(n, 2)
})
test('exponential backoff', async () => {
  const t0 = Date.now()
  let n = 0
  await retry(async () => { if (++n < 3) throw new Error('x'); return 1 }, { attempts: 3, delayMs: 40 })
  assert.ok(Date.now() - t0 >= 110, 'waited ~40 + 80 ms')
})
