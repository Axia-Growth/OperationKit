/**
 * Walk every page (card #901024): each one renders its landmark, in the theme
 * and width the project asks for, without console errors, failed requests or
 * sideways scroll. One full-page screenshot per page per project lands in
 * tests/smoke/app-audit/<project>/.
 */
import { expect } from '@playwright/test'
import { test, login, seed, shot, watch, expectClean, expectNoSidewaysScroll, expectTheme, BOT } from './helpers'

interface Stop { name: string; path: () => string; landmark: (p: import('@playwright/test').Page) => import('@playwright/test').Locator; allow?: Array<string | RegExp>; scrollTo?: boolean }

const h1 = (text: string | RegExp) => (p: import('@playwright/test').Page) => p.getByRole('heading', { level: 1, name: text })

const STOPS: Stop[] = [
  { name: 'board', path: () => '/', landmark: p => p.getByTestId('board-header') },
  { name: 'board-workspace', path: () => `/w/${seed().workspace}`, landmark: p => p.getByTestId('board-header') },
  { name: 'archive', path: () => '/archive', landmark: h1('Archive') },
  { name: 'card-queue', path: () => `/o/${seed().cards.queue}`, landmark: p => p.getByRole('button', { name: 'Edit card' }).first() },
  { name: 'card-parent', path: () => `/o/${seed().cards.parent}`, landmark: p => p.getByRole('heading', { name: 'E2E parent card' }).first() },
  { name: 'card-review-pass', path: () => `/o/${seed().cards.reviewPass}`, landmark: p => p.getByRole('button', { name: 'Approve' }).first() },
  { name: 'card-review-fail', path: () => `/o/${seed().cards.reviewFail}`, landmark: p => p.getByRole('button', { name: 'Rework' }).first() },
  { name: 'bots', path: () => '/chat', landmark: h1('Bots') },
  { name: 'bot-chat', path: () => `/chat/${BOT.slug}`, landmark: p => p.locator(`section[aria-label="Conversation with ${BOT.name}"]`) },
  { name: 'context', path: () => '/knowledge', landmark: p => p.getByRole('button', { name: 'Graph', exact: true }) },
  { name: 'context-setup', path: () => '/knowledge/setup', landmark: h1('Set up your Context') },
  { name: 'workflows', path: () => '/jobs', landmark: h1('Workflows') },
  { name: 'bots-and-skills', path: () => '/agents', landmark: h1('Bot setup') },
  // Fresh install (card #901202): no layer-graph generator -> an empty state, not an error.
  { name: 'bots-and-skills-graph', path: () => '/agents?tab=graph', landmark: p => p.getByText('Skill graph not set up'), scrollTo: true },
  { name: 'system', path: () => '/system', landmark: h1('System') },
  { name: 'setup', path: () => '/setup', landmark: h1('Setup') },
  ...['models', 'api-mcp', 'integrations', 'secrets', 'workspaces', 'branding', 'email', 'knowledge-search'].map(tab => ({
    name: `settings-${tab}`, path: () => `/settings/${tab}`, landmark: (p: import('@playwright/test').Page) => p.getByTestId('settings-content'),
  })),
]

for (const stop of STOPS) {
  test(`page: ${stop.name}`, async ({ page }, info) => {
    await login(page, info)
    const problems = watch(page)
    await page.goto(stop.path())
    await expect(stop.landmark(page)).toBeVisible()
    // The app scrolls an inner container, so a full-page shot is the viewport: bring a low landmark into it.
    if (stop.scrollTo) await stop.landmark(page).scrollIntoViewIfNeeded()
    await expectTheme(page, info)
    await page.waitForLoadState('networkidle').catch(() => { /* pages that keep a live socket never go idle */ })
    await shot(page, info, stop.name)
    await expectNoSidewaysScroll(page)
    expectClean(problems, stop.allow)
  })
}

// Card #901199: index.html used to carry an inline pre-paint theme script that the
// server's own Content-Security-Policy (script-src 'self') blocked on every load.
// It is now a same-origin file (/theme-init.js). This test catches any CSP
// violation on first load, and checks the pre-paint theme was still applied.
test('first load: the page blocks none of its own scripts', async ({ page }, info) => {
  const blocked: string[] = []
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) blocked.push(m.text()) })
  await login(page, info)
  await page.goto('/')
  await expect(page.getByTestId('board-header')).toBeVisible()
  expect(blocked).toEqual([])
})

// Card #901199: the pre-paint theme comes from /theme-init.js alone. With the app
// bundle blocked (so React never runs), the skeleton must still carry the theme.
test('first load: the theme is set before the app bundle runs', async ({ page }, info) => {
  await login(page, info)
  const blocked: string[] = []
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) blocked.push(m.text()) })
  await page.route(/\/assets\/.*\.js(\?.*)?$/, r => r.abort())
  const init = page.waitForResponse(r => new URL(r.url()).pathname === '/theme-init.js')
  await page.goto('/')
  expect((await init).status()).toBe(200)
  await expect(page.locator('#app-shell')).toBeAttached()
  await expectTheme(page, info)
  expect(blocked).toEqual([])
})

// Card #901199: the sign-in page is served before login, so /theme-init.js must load
// there too (no auth gate on it). Signed out, the only 4xx are the two auth probes
// (401 GET /api/auth/me, 404 POST /api/auth/cloudflare-access without Access in front), whose
// "Failed to load resource" lines are the browser noting them; anything else fails.
test('first load, signed out: the sign-in page loads /theme-init.js with no CSP or script error', async ({ page }, info) => {
  const p = watch(page)
  const csp: string[] = []
  page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) csp.push(m.text()) })
  const init = page.waitForResponse(r => new URL(r.url()).pathname === '/theme-init.js')
  await page.goto('/')
  expect((await init).status()).toBe(200)
  await expect(page.locator('input[type="password"]').first()).toBeVisible()
  await page.waitForLoadState('networkidle')
  await expectTheme(page, info)
  expect(csp).toEqual([])
  const PROBES = ['401 GET /api/auth/me', '404 POST /api/auth/cloudflare-access']
  const probes = p.badResponses.filter(l => PROBES.includes(l))
  const loadNotes = p.consoleErrors.filter(l => /^Failed to load resource: the server responded with a status of 40[14] /.test(l))
  expect(loadNotes.length, 'one "Failed to load resource" line per auth probe, no more').toBeLessThanOrEqual(probes.length)
  expect({ ...p, consoleErrors: p.consoleErrors.filter(l => !loadNotes.includes(l)), badResponses: p.badResponses.filter(l => !PROBES.includes(l)) })
    .toEqual({ consoleErrors: [], pageErrors: [], failedRequests: [], badResponses: [] })
})

test('old addresses redirect instead of 404-ing', async ({ page }, info) => {
  await login(page, info)
  for (const [from, to] of [['/dashboard', /\/system$/], ['/settings/seats', /\/settings\/models$/], ['/docs', /\/knowledge$/], ['/feed', /\/$/]] as const) {
    await page.goto(from)
    await expect(page, `${from} should redirect`).toHaveURL(to)
  }
})

// The desktop top bar is hidden on narrow screens; the narrow menu is covered by the page walk.
test('primary navigation links go where they say', { tag: '@desktop' }, async ({ page }, info) => {
  await login(page, info)
  await page.goto('/')
  const nav = page.locator('nav[aria-label="Primary"]')
  for (const [link, heading] of [['Bots', 'Bots'], ['Context', 'Context'], ['Workflows', 'Workflows']] as const) {
    await nav.getByRole('link', { name: link, exact: true }).click()
    await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible()
  }
  await nav.getByRole('link', { name: 'Board', exact: true }).click()
  await expect(page.getByTestId('board-header')).toBeVisible()
})
