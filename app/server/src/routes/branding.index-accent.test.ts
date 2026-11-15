/**
 * obj 900803 (white-label F2): index.html is served with the install's resolved
 * accent tokens inline, so the first paint never flashes the shipped default
 * accent while /api/branding is in flight. Plus the web manifest and
 * apple-touch-icon links built from the same branding.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { renderBrandedIndex, brandTokenStyle, brandTokenCssVars, brandManifest } from './branding.js'
import { resolveBrandTokens, DEFAULT_TOKENS } from '../services/branding-config.js'

// The shipped index.html, as Vite leaves it (stylesheet link inside <head>).
const SHELL = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'client', 'index.html'), 'utf8')
  .replace('</head>', '  <link rel="stylesheet" crossorigin href="/assets/index-abc.css">\n  </head>')

const TEAL = { OK_BRAND_ACCENT: '#0F766E', OK_BRAND_NAME: 'Northwind' } as NodeJS.ProcessEnv

function inlineVars(html: string): Record<string, string> {
  const m = /<style id="brand-tokens">html:root\{([^}]*)\}<\/style>/.exec(html)
  if (!m) throw new Error('no brand-tokens style in served html')
  return Object.fromEntries(m[1].split(';').map(kv => kv.split(':') as [string, string]))
}

describe('renderBrandedIndex — accent inline, no default-accent flash', () => {
  it('a custom accent is in the served HTML before any script runs', () => {
    const out = renderBrandedIndex(SHELL, TEAL)
    const vars = inlineVars(out)
    const tokens = resolveBrandTokens(TEAL)
    expect(vars['--accent']).toBe('#0F766E')
    expect(vars['--accent-fg']).toBe(tokens.accentFg)
    expect(vars['--accent-hover']).toBe(tokens.accentHover)
    expect(vars['--accent-press']).toBe(tokens.accentPress)
    expect(vars['--brand-accent-text']).toMatch(/^#/)
    expect(vars['--brand-accent-text-dark']).toMatch(/^#/)
    // The shipped default accent appears nowhere in the token block.
    expect(Object.values(vars)).not.toContain(DEFAULT_TOKENS.accent)
  })

  it('the token style lands AFTER the app stylesheet, so it wins over index.css :root', () => {
    const out = renderBrandedIndex(SHELL, TEAL)
    const css = out.indexOf('/assets/index-abc.css')
    const style = out.indexOf('<style id="brand-tokens">')
    expect(css).toBeGreaterThan(-1)
    expect(style).toBeGreaterThan(css)
    expect(style).toBeLessThan(out.indexOf('</head>'))
    // html:root (0,1,1) beats the :root (0,1,0) default in index.css.
    expect(out).toContain('<style id="brand-tokens">html:root{')
  })

  it('the variable names match what the client applies (useBranding.brandTokenVars)', () => {
    const client = fs.readFileSync(path.resolve(import.meta.dirname, '..', '..', '..', 'client', 'src', 'hooks', 'useBranding.ts'), 'utf8')
    for (const name of Object.keys(brandTokenCssVars(resolveBrandTokens(TEAL)))) {
      expect(client).toContain(`'${name}'`)
    }
  })

  it('is idempotent — rendering twice leaves one token block, one manifest, one touch icon', () => {
    const twice = renderBrandedIndex(renderBrandedIndex(SHELL, TEAL), TEAL)
    expect(twice.match(/id="brand-tokens"/g)).toHaveLength(1)
    expect(twice.match(/rel="manifest"/g)).toHaveLength(1)
    expect(twice.match(/rel="apple-touch-icon"/g)).toHaveLength(1)
  })

  it('links a web manifest and apple-touch-icon from branding', () => {
    const out = renderBrandedIndex(SHELL, TEAL)
    expect(out).toContain('<link rel="manifest" href="/api/branding/manifest.webmanifest" />')
    expect(out).toContain('<link rel="apple-touch-icon" href="/api/branding/apple-touch-icon" />')
    expect(out).toContain('<meta name="apple-mobile-web-app-title" content="Northwind" />')
    expect(out).toContain('<title>Northwind</title>')
  })

  it('only hex values can reach the style block', () => {
    const style = brandTokenStyle({ OK_BRAND_ACCENT: 'red;}</style><script>x()</script>' } as NodeJS.ProcessEnv)
    expect(style).not.toContain('<script>')
    expect(style).toContain(`--accent:${DEFAULT_TOKENS.accent}`)
  })
})

describe('brandManifest', () => {
  it('names the install and uses its accent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mf-'))
    const m = brandManifest(TEAL, dir)
    expect(m.name).toBe('Northwind')
    expect(m.theme_color).toBe('#0F766E')
    expect(m.start_url).toBe('/')
    expect(m.icons[0].src).toBe('/api/branding/apple-touch-icon')
  })
})
