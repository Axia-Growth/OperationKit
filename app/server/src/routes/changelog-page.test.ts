import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChangelogEntry } from '@operationkit/shared'

// Public changelog page (polish F3 #900804, obj 900819): install brand name and
// accent, favicon, a dark scheme, and no fixed blue gradient.

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

const entry = (p: Partial<ChangelogEntry> = {}) => ({
  id: 1, repo: 'r', pr_number: 7, pr_url: 'https://example.com/pr/7', merge_commit_sha: null, platform: 'Web',
  author: null, merged_at: '2026-11-10T10:00:00Z', category: 'feature', status: 'published', title_eng: 't',
  headline: 'Faster search', body_stakeholder: 'Search is quicker.', overview: '', feature_brief: '', screenshots: [],
  ...p,
}) as unknown as ChangelogEntry

async function page(entries: ChangelogEntry[] = [entry()]) {
  const { renderPage } = await import('./changelog.js')
  return renderPage(entries)
}

describe('public changelog page', () => {
  it('uses the install brand name, accent and favicon', async () => {
    vi.stubEnv('OK_BRAND_NAME', 'Northwind Ops')
    vi.stubEnv('OK_BRAND_ACCENT', '#0a7d55')
    const html = await page()
    expect(html).toContain("<title>What's shipping · Northwind Ops</title>")
    expect(html).toContain('--accent: #0a7d55')
    expect(html).toContain('<link rel="icon" href="/api/branding/favicon" />')
    expect(html).toContain('>Northwind Ops</div>')
  })

  it('has light and dark schemes and no hardcoded blue hero', async () => {
    const html = await page()
    expect(html).toContain('<meta name="color-scheme" content="light dark" />')
    expect(html).toContain('@media (prefers-color-scheme: dark)')
    expect(html).not.toContain('#2563eb')
    expect(html).not.toContain('linear-gradient')
  })

  it('tints category badges by tone instead of inline colours', async () => {
    const html = await page([entry({ category: 'fix' as ChangelogEntry['category'] })])
    expect(html).toContain('class="badge cat tone-warning">Fix</span>')
    expect(html).not.toMatch(/class="badge cat" style=/)
  })
})
