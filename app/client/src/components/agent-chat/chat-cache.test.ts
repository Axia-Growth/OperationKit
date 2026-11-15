import { describe, it, expect, beforeEach } from 'vitest'
import { cacheAge, clearChatCache, fetchInto, prefetch, readCache, setChatCacheScope, writeCache } from './chat-cache'

/* obj 900865 — the Bots page cache's guarantees, without React. */

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

beforeEach(() => clearChatCache())

describe('chat-cache', () => {
  it('shares one in-flight read between callers of the same key', async () => {
    let n = 0
    const d = deferred<string>()
    const f = () => { n++; return d.promise }
    const a = fetchInto('k', f)
    const b = fetchInto('k', f)
    prefetch('k', f)
    expect(n).toBe(1)
    d.resolve('v')
    expect(await a).toBe('v')
    expect(await b).toBe('v')
    expect(readCache('k')).toBe('v')
  })

  it('a write made while a read is in flight is not overwritten by the older answer', async () => {
    writeCache('k', 'old')
    const d = deferred<string>()
    const p = fetchInto('k', () => d.promise)
    writeCache('k', 'just sent')
    d.resolve('stale from the server')
    expect(await p).toBe('just sent')
    expect(readCache('k')).toBe('just sent')
  })

  it('prefetch skips a fresh key and never throws on failure', async () => {
    writeCache('fresh', 1)
    let n = 0
    prefetch('fresh', async () => { n++; return 2 })
    expect(n).toBe(0)
    prefetch('broken', async () => { throw new Error('down') })
    await new Promise(r => setTimeout(r, 0))
    expect(readCache('broken')).toBeUndefined()
    expect(cacheAge('broken')).toBe(Infinity)
  })

  it('a different signed-in person starts from an empty cache, and a late read for the old one is dropped', async () => {
    setChatCacheScope('1')
    writeCache('messages:alpha:main', 'person 1 history')
    const d = deferred<string>()
    const p = fetchInto('messages:beta:main', () => d.promise)
    setChatCacheScope('2')
    expect(readCache('messages:alpha:main')).toBeUndefined()
    d.resolve('person 1 beta history')
    await p
    expect(readCache('messages:beta:main')).toBeUndefined()
    // Same person again: nothing is cleared.
    writeCache('x', 1)
    setChatCacheScope('2')
    expect(readCache('x')).toBe(1)
  })
})
