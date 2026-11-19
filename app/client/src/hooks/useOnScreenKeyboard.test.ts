// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { deriveKeyboard, isTouchPrimary, summonsKeyboard, KEYBOARD_MIN_PX, type KeyboardFacts } from './useOnScreenKeyboard'

const facts = (over: Partial<KeyboardFacts> = {}): KeyboardFacts => ({
  touch: true, focused: false, dismissed: false, layoutHeight: 844, visibleHeight: 844, ...over,
})

describe('on-screen keyboard state (obj 901376)', () => {
  it('a desktop never has an on-screen keyboard, whatever is focused or however narrow', () => {
    expect(deriveKeyboard(facts({ touch: false, focused: true, visibleHeight: 400 }))).toEqual({ touch: false, open: false, height: null })
  })

  it('touch, nothing focused, full viewport: closed', () => {
    expect(deriveKeyboard(facts())).toEqual({ touch: true, open: false, height: null })
  })

  it('touch, keyboard covering the layout viewport: open, with the visible height', () => {
    expect(deriveKeyboard(facts({ focused: true, visibleHeight: 508 }))).toEqual({ touch: true, open: true, height: 508 })
  })

  it('touch, field focused but the keyboard has not animated in yet: open, no height override', () => {
    expect(deriveKeyboard(facts({ focused: true }))).toEqual({ touch: true, open: true, height: null })
  })

  it('a URL bar sliding away is not a keyboard', () => {
    expect(deriveKeyboard(facts({ visibleHeight: 844 - (KEYBOARD_MIN_PX - 1) }))).toEqual({ touch: true, open: false, height: null })
  })

  it('keyboard dismissed while the field keeps focus (Android back): closed', () => {
    expect(deriveKeyboard(facts({ focused: true, dismissed: true }))).toEqual({ touch: true, open: false, height: null })
  })

  it('no visualViewport API: focus alone decides', () => {
    expect(deriveKeyboard(facts({ focused: true, visibleHeight: null })).open).toBe(true)
    expect(deriveKeyboard(facts({ visibleHeight: null })).open).toBe(false)
  })

  it('only text fields summon the keyboard', () => {
    const el = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild }
    expect(summonsKeyboard(el('<textarea></textarea>'))).toBe(true)
    expect(summonsKeyboard(el('<input>'))).toBe(true)
    expect(summonsKeyboard(el('<input type="search">'))).toBe(true)
    expect(summonsKeyboard(el('<input type="checkbox">'))).toBe(false)
    expect(summonsKeyboard(el('<input type="file">'))).toBe(false)
    expect(summonsKeyboard(el('<textarea readonly></textarea>'))).toBe(false)
    expect(summonsKeyboard(el('<button></button>'))).toBe(false)
    expect(summonsKeyboard(null)).toBe(false)
  })

  it('touch is decided by pointer type, not by width', () => {
    const win = (coarse: boolean) => ({ matchMedia: (q: string) => ({ matches: q === '(pointer: coarse)' && coarse }) }) as unknown as Window
    expect(isTouchPrimary(win(true))).toBe(true)
    expect(isTouchPrimary(win(false))).toBe(false)
    expect(isTouchPrimary({} as Window)).toBe(false)
  })
})
