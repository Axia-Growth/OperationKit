/**
 * obj 900803 (white-label F2): email buttons use the install's RESOLVED brand
 * accent and its text-on-accent colour (resolveBrandTokens) — not only the
 * OK_BRAND_ACCENT env var with a hardcoded #111827 / #ffffff fallback.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { currentBrand, signInLinkEmail } from './templates.js'
import { resolveBrandTokens, DEFAULT_TOKENS } from '../branding-config.js'

const ENV_KEYS = ['OK_BRAND_ACCENT', 'OK_BRAND_ACCENT_FG', 'OK_BRAND_NAME'] as const
const saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function button(html: string): string {
  const m = /<a href="[^"]*" style="([^"]*)">Sign in<\/a>/.exec(html)
  if (!m) throw new Error('no button in email html')
  return m[1]
}

describe('email brand accent (resolveBrandTokens)', () => {
  it('a custom accent reaches the button with its derived text colour', () => {
    const env = { OK_BRAND_ACCENT: '#0F766E' } as NodeJS.ProcessEnv
    const tokens = resolveBrandTokens(env)
    const brand = currentBrand('https://ops.example.test', env)
    expect(brand.accent).toBe('#0F766E')
    expect(brand.accentFg).toBe(tokens.accentFg)
    const style = button(signInLinkEmail({ brand, to: 'a@b.co', username: 'u', url: 'https://ops.example.test/x', minutes: 15 }).html!)
    expect(style).toContain('background:#0F766E')
    expect(style).toContain(`color:${tokens.accentFg}`)
  })

  it('an explicit text-on-accent override is honoured (no hardcoded #ffffff)', () => {
    const env = { OK_BRAND_ACCENT: '#FACC15', OK_BRAND_ACCENT_FG: '#111111' } as NodeJS.ProcessEnv
    const brand = currentBrand('https://ops.example.test', env)
    const style = button(signInLinkEmail({ brand, to: 'a@b.co', username: 'u', url: 'https://ops.example.test/x', minutes: 15 }).html!)
    expect(style).toContain('background:#FACC15')
    expect(style).toContain('color:#111111')
    expect(style).not.toContain('#ffffff')
  })

  it('no override → the same shipped accent the web UI paints, not a separate #111827', () => {
    const brand = currentBrand('https://ops.example.test', {} as NodeJS.ProcessEnv)
    expect(brand.accent).toBe(resolveBrandTokens({} as NodeJS.ProcessEnv).accent)
    expect(brand.accent).not.toBe('#111827')
    if (brand.accent === DEFAULT_TOKENS.accent) expect(brand.accentFg).toBe(DEFAULT_TOKENS.accentFg)
  })
})
