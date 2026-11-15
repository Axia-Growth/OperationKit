// @vitest-environment jsdom
/** obj 900867 — Context's client cache: per-user, persisted, wiped on sign-out, never throws. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  KB_CACHE_MAX_ENTRY_CHARS, KB_CACHE_PREFIX, __resetKbCacheMemory, clearKbCache, deleteKbCache, readKbCache,
  setKbCacheScope, writeKbCache,
} from './kbCache'

beforeEach(() => {
  __resetKbCacheMemory()
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('kbCache', () => {
  it('survives a reload: written to localStorage under the signed-in user and read back', () => {
    setKbCacheScope(7)
    writeKbCache('docs-tree', { tree: [1, 2, 3] })
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}7:docs-tree`)).toContain('tree')
    __resetKbCacheMemory() // a new page load: memory gone, storage kept
    setKbCacheScope(7)
    expect(readKbCache<{ tree: number[] }>('docs-tree')?.value).toEqual({ tree: [1, 2, 3] })
  })

  it('never shows one person another person\'s cached pages', () => {
    setKbCacheScope(1)
    writeKbCache('docs-tree', { owner: 'alice' })
    setKbCacheScope(2)
    expect(readKbCache('docs-tree')).toBeNull()
    writeKbCache('docs-tree', { owner: 'bob' })
    setKbCacheScope(1)
    expect(readKbCache<{ owner: string }>('docs-tree')?.value.owner).toBe('alice')
  })

  it('persists nothing while nobody is signed in', () => {
    setKbCacheScope(null)
    writeKbCache('docs-tree', { x: 1 })
    expect(localStorage.length).toBe(0)
  })

  it('sign-out wipes every user\'s Context cache and nothing else', () => {
    localStorage.setItem('unrelated', 'keep')
    setKbCacheScope(1); writeKbCache('a', 1)
    setKbCacheScope(2); writeKbCache('b', 2)
    clearKbCache()
    expect(readKbCache('b')).toBeNull()
    expect(Object.keys(localStorage).filter(k => k.startsWith(KB_CACHE_PREFIX))).toEqual([])
    expect(localStorage.getItem('unrelated')).toBe('keep')
  })

  it('keeps an oversized entry in memory only', () => {
    setKbCacheScope(3)
    const big = 'x'.repeat(KB_CACHE_MAX_ENTRY_CHARS + 10)
    writeKbCache('graph:big', big)
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}3:graph:big`)).toBeNull()
    expect(readKbCache('graph:big')?.value).toBe(big)
  })

  it('on a full storage quota, evicts this user\'s oldest entries and still stores the new one', () => {
    setKbCacheScope(4)
    writeKbCache('old', 'o', { at: 1 })
    writeKbCache('newer', 'n', { at: 2 })
    const real = Storage.prototype.setItem
    let fail = true
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (fail && k.endsWith(':fresh')) { fail = false; throw new DOMException('full', 'QuotaExceededError') }
      return real.call(this, k, v)
    })
    writeKbCache('fresh', 'f')
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}4:old`)).toBeNull()
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}4:newer`)).not.toBeNull()
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}4:fresh`)).not.toBeNull()
  })

  it('degrades to memory when storage throws, and drops a corrupt stored entry', () => {
    setKbCacheScope(5)
    localStorage.setItem(`${KB_CACHE_PREFIX}5:bad`, '{not json')
    expect(readKbCache('bad')).toBeNull()
    expect(localStorage.getItem(`${KB_CACHE_PREFIX}5:bad`)).toBeNull()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled') })
    expect(() => writeKbCache('k', { v: 1 })).not.toThrow()
    expect(readKbCache<{ v: number }>('k')?.value.v).toBe(1)
    deleteKbCache('k')
    expect(readKbCache('k')).toBeNull()
  })
})
