import { describe, it, expect } from 'vitest'
import { composerEnterKeyHint, enterSends } from './composerKeys'

const key = (over: Partial<{ key: string; shiftKey: boolean; isComposing: boolean }> = {}) => ({ key: 'Enter', shiftKey: false, ...over })

describe('what Enter does in a chat composer (obj 901376)', () => {
  it('desktop: Enter sends, Shift+Enter is a new line', () => {
    expect(enterSends(key(), false)).toBe(true)
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false)
    expect(enterSends(key({ key: 'a' }), false)).toBe(false)
  })

  it('touch device: Return never sends', () => {
    expect(enterSends(key(), true)).toBe(false)
    expect(enterSends(key({ shiftKey: true }), true)).toBe(false)
  })

  it('never sends while an IME is composing', () => {
    expect(enterSends(key({ isComposing: true }), false)).toBe(false)
    expect(enterSends({ ...key(), nativeEvent: { isComposing: true } }, false)).toBe(false)
  })

  it('jsdom has no matchMedia, so the default is the desktop rule', () => {
    expect(enterSends(key())).toBe(true)
  })

  it('labels the Return key: a new line on touch, Send on a desktop', () => {
    expect(composerEnterKeyHint(true)).toBe('enter')
    expect(composerEnterKeyHint(false)).toBe('send')
  })
})
