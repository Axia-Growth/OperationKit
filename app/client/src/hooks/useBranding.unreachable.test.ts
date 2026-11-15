/**
 * obj 900803: when /api/branding cannot be reached, the client must keep what the
 * server already painted into index.html (renderBrandedIndex) — the install's
 * <title> and its inline `<style id="brand-tokens">` accent — instead of
 * re-applying the shipped default name and accent over them.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BRANDING, publish, servedBrandTokens, unreachableBranding } from './useBranding'

function serveIndex(css: string | null, title: string) {
  document.head.querySelector('#brand-tokens')?.remove()
  if (css !== null) {
    const style = document.createElement('style')
    style.id = 'brand-tokens'
    style.textContent = css
    document.head.appendChild(style)
  }
  document.title = title
}

afterEach(() => {
  document.head.querySelector('#brand-tokens')?.remove()
  document.documentElement.removeAttribute('style')
  document.title = ''
})

describe('unreachableBranding (obj 900803)', () => {
  it('keeps the server-injected accent tokens and title', () => {
    serveIndex('html:root{--accent:#0F766E;--accent-hover:#0D6861;--accent-press:#0C5C56;--accent-fg:#FFFFFF}', 'Acme Ops')
    const b = unreachableBranding()
    expect(b.name).toBe('Acme Ops')
    expect(b.tokens.accent).toBe('#0F766E')
    expect(b.tokens.accentHover).toBe('#0D6861')
    expect(b.tokens.accentPress).toBe('#0C5C56')
    expect(b.tokens.accentFg).toBe('#FFFFFF')
    // fields the page did not carry keep the shipped default
    expect(b.tokens.verify).toBe(DEFAULT_BRANDING.tokens.verify)
  })

  it('publishing it does not overwrite the served accent with the default', () => {
    serveIndex('html:root{--accent:#0F766E}', 'Acme Ops')
    publish(unreachableBranding())
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#0F766E')
    expect(document.title).toBe('Acme Ops')
  })

  it('falls back to the shipped defaults when the page carries no brand tokens', () => {
    serveIndex(null, '')
    expect(servedBrandTokens()).toEqual(DEFAULT_BRANDING.tokens)
    expect(unreachableBranding().name).toBe(DEFAULT_BRANDING.name)
  })

  it('ignores non-hex values (e.g. the stylesheet color-mix() defaults)', () => {
    serveIndex('html:root{--accent:#0F766E;--accent-hover:color-mix(in srgb, var(--accent) 88%, black)}', 'Acme Ops')
    const t = servedBrandTokens()
    expect(t.accent).toBe('#0F766E')
    expect(t.accentHover).toBe(DEFAULT_BRANDING.tokens.accentHover)
  })
})
