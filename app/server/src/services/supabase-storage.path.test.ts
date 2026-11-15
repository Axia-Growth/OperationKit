import { describe, it, expect } from 'vitest'
import { isSafeObjectPath } from './supabase-storage.js'

// obj 900838 / CodeQL #77, #78: object paths are joined into service-role
// Storage URLs, so dot segments and empty segments must never pass.
describe('isSafeObjectPath', () => {
  it('accepts a normal owner-prefixed object path', () => {
    expect(isSafeObjectPath('operator/2026-11-01-hook/1731600000000-take_1.mp4')).toBe(true)
    expect(isSafeObjectPath('ws/hook with spaces/a?b#c.mp4')).toBe(true) // encoded per segment, stays in the bucket
  })

  it('refuses traversal, empty segments and control characters', () => {
    for (const bad of [
      'ws/../../../rest/v1/secrets?id=not.is.null',
      'ws/../other-ws/x.mp4',
      'ws/./x.mp4',
      'ws//x.mp4',
      '/ws/x.mp4',
      'ws/x.mp4/',
      'ws/..',
      'ws\\..\\x',
      'ws/a\nb',
      '',
      'a'.repeat(1025),
    ]) expect(isSafeObjectPath(bad), JSON.stringify(bad)).toBe(false)
    expect(isSafeObjectPath(undefined)).toBe(false)
    expect(isSafeObjectPath(['ws', 'x'])).toBe(false)
  })
})
