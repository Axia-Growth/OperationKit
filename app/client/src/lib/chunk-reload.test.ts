// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isChunkLoadError, reloadOnceForChunkError, clearChunkReloadGuard } from './chunk-reload'

describe('isChunkLoadError', () => {
  it('matches the vite/browser dynamic-import failure messages', () => {
    expect(isChunkLoadError(new Error('Failed to fetch dynamically imported module: https://x/assets/JobsBoard-DiBVbAZO.js'))).toBe(true)
    expect(isChunkLoadError(new Error('Loading chunk 42 failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Loading CSS chunk 7 failed.'))).toBe(true)
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true)
  })

  it('does not match an unrelated render error', () => {
    expect(isChunkLoadError(new Error('widget exploded'))).toBe(false)
    expect(isChunkLoadError(null)).toBe(false)
  })
})

describe('reloadOnceForChunkError', () => {
  let reloadSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    sessionStorage.clear()
    reloadSpy = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload: reloadSpy },
    })
  })
  afterEach(() => {
    sessionStorage.clear()
  })

  it('reloads once and sets the guard', () => {
    const triggered = reloadOnceForChunkError()
    expect(triggered).toBe(true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
    expect(sessionStorage.getItem('cc-chunk-reload-attempted')).toBe('1')
  })

  it('does not reload a second time in the same session — this is the anti-loop guard', () => {
    reloadOnceForChunkError()
    reloadSpy.mockClear()
    const triggered = reloadOnceForChunkError()
    expect(triggered).toBe(false)
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('clearing the guard allows a reload again', () => {
    reloadOnceForChunkError()
    clearChunkReloadGuard()
    reloadSpy.mockClear()
    const triggered = reloadOnceForChunkError()
    expect(triggered).toBe(true)
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })
})
