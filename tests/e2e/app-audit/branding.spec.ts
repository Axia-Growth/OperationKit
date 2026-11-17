/**
 * Settings → Branding, "Logos & favicon" (card #901204). Each logo row holds a
 * preview tile, a label + description, Upload and Clear. On a 390px phone the
 * four used to sit side by side, which squeezed the description to about 40px
 * and printed it one word per line down the page. On a narrow screen the text
 * must get its own line: no description column narrower than 160px.
 */
import { expect } from '@playwright/test'
import { test, login, shot, expectNoSidewaysScroll, expectTheme } from './helpers'

// The help line under each logo slot (LOGO_SLOTS in BrandingPanel.tsx).
const LOGO_HELP = [
  'Full logo with product name, shown on light surfaces.',
  'Optional — falls back to the light-bg wordmark if unset.',
  'Square mark used for the sign-in page and collapsed nav; also generates app icons.',
  'Browser tab icon (.ico, .svg or .png). Falls back to the icon above if unset.',
]
const MIN_TEXT_WIDTH = 160

test('narrow screens: branding logo rows keep their descriptions readable', { tag: '@narrow' }, async ({ page }, info) => {
  await login(page, info)
  await page.goto('/settings/branding')
  await expectTheme(page, info)
  const first = page.getByText(LOGO_HELP[0], { exact: true })
  await expect(first, 'the Logos & favicon card rendered').toBeVisible()
  await first.scrollIntoViewIfNeeded()
  await shot(page, info, 'settings-branding-logos')

  for (const help of LOGO_HELP) {
    const box = await page.getByText(help, { exact: true }).boundingBox()
    expect(box, `"${help}" is on the page`).not.toBeNull()
    expect(box!.width, `"${help}" column is at least ${MIN_TEXT_WIDTH}px wide`).toBeGreaterThanOrEqual(MIN_TEXT_WIDTH)
  }
  // Upload and Clear stay on screen for every row.
  await expect(page.getByRole('button', { name: 'Clear' })).toHaveCount(LOGO_HELP.length)
  for (const clear of await page.getByRole('button', { name: 'Clear' }).all()) {
    const b = (await clear.boundingBox())!
    expect(b.x + b.width, 'Clear fits the screen width').toBeLessThanOrEqual(page.viewportSize()!.width + 1)
  }
  await expectNoSidewaysScroll(page)
})
