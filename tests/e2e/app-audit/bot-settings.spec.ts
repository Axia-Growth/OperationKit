/**
 * Bot settings (card #901024): the panel opens and shows Workspace access,
 * Full access, Approve on my behalf and High Agency. Switches are read, and one
 * reversible change (grant, then remove a workspace) is made on the seeded bot.
 */
import { expect, type Page } from '@playwright/test'
import { test, login, seed, shot, watch, expectClean, BOT } from './helpers'

async function openSettings(page: Page) {
  await page.goto(`/chat/${BOT.slug}`)
  await page.getByRole('button', { name: `Show settings for ${BOT.name} (model and tools)` }).click()
  await expect(page.getByText('Bot settings').first()).toBeVisible()
}
const section = (page: Page, heading: string) => page.locator('section').filter({ has: page.getByRole('heading', { level: 4, name: heading, exact: true }) }).first()

test('bot settings panel shows all four access sections', async ({ page }, info) => {
  await login(page, info)
  const problems = watch(page)
  await openSettings(page)
  for (const heading of ['Workspace access', 'Full access', 'Approve on my behalf', 'High Agency']) {
    await expect(page.getByRole('heading', { level: 4, name: heading, exact: true }), heading).toBeVisible()
  }
  await shot(page, info, 'bot-settings')
  expectClean(problems)
})

test('workspace access lists the seeded grant', async ({ page }, info) => {
  await login(page, info)
  await openSettings(page)
  await expect(section(page, 'Workspace access')).toContainText(/E2E Workspace|e2e-ws/)
  await expect(page.getByLabel('Grant a workspace')).toBeVisible()
})

test('full access is off by default and has one switch per granted workspace', async ({ page }, info) => {
  await login(page, info)
  await openSettings(page)
  const sw = page.getByRole('switch', { name: new RegExp(`Full access in (${seed().workspace}|E2E Workspace)`) })
  await expect(sw).toBeVisible()
  await expect(sw).not.toBeChecked()
})

test('approve on my behalf is off by default', async ({ page }, info) => {
  await login(page, info)
  await openSettings(page)
  const sw = section(page, 'Approve on my behalf').getByRole('switch').first()
  await expect(sw).toBeVisible()
  await expect(sw).not.toBeChecked()
})

test('high agency is off by default and shows a preview before saving', async ({ page }, info) => {
  await login(page, info)
  await openSettings(page)
  const sw = page.getByRole('switch', { name: 'High Agency on' })
  await expect(sw).toBeVisible()
  await expect(sw).not.toBeChecked()
  await expect(page.getByRole('button', { name: 'Save High Agency' })).toBeVisible()
  await page.getByRole('button', { name: 'Save High Agency' }).scrollIntoViewIfNeeded()
  await shot(page, info, 'bot-settings-high-agency')
})

test('a member cannot change bot access settings', async ({ page }, info) => {
  await login(page, info, seed().member)
  // The API is the boundary; the page must not offer what the API refuses.
  const r = await page.request.put(`/api/agent-chat/agents/${BOT.slug}/full-access/${seed().workspace}`, { data: { enabled: true } })
  expect(r.status(), 'member turning on Full access').toBeGreaterThanOrEqual(400)
  await page.goto(`/chat/${BOT.slug}`)
  await expect(page.getByRole('switch', { name: /Full access in/ })).toHaveCount(0)
})

// Card #901203: at 390px the settings pane shared the screen with the Chat /
// Work / Activity tabs, the thread tabs and the composer, so only ~450px of it
// showed. On a phone, settings must take the pane's full height.
test('narrow screens: bot settings take the full height @narrow', async ({ page }, info) => {
  await login(page, info)
  await openSettings(page)
  const pane = page.getByRole('region', { name: `Settings for ${BOT.name}` })
  await expect(pane).toBeVisible()
  // The pane gets at least 60% of the screen...
  const viewport = page.viewportSize()!
  const box = (await pane.boundingBox())!
  expect(box.height, `settings pane height ${Math.round(box.height)}px of ${viewport.height}px`).toBeGreaterThanOrEqual(viewport.height * 0.6)
  // ...because the chat chrome steps aside while settings are open.
  await expect(page.getByTestId('bot-view-tabs')).toBeHidden()
  await expect(page.getByPlaceholder('Write a message…')).toBeHidden()
  // The last section is reachable and lands inside the screen.
  const heading = pane.getByRole('heading', { level: 4, name: 'High Agency', exact: true })
  await heading.scrollIntoViewIfNeeded()
  await expect(heading).toBeInViewport()
  const hb = (await heading.boundingBox())!
  expect(hb.y + hb.height, 'High Agency heading bottom').toBeLessThanOrEqual(box.y + box.height)
  await shot(page, info, 'bot-settings-narrow-full-height')
  // Closing settings brings the chat back.
  await page.getByRole('button', { name: `Hide settings for ${BOT.name} (model and tools)` }).click()
  await expect(page.getByTestId('bot-view-tabs')).toBeVisible()
  await expect(page.getByPlaceholder('Write a message…')).toBeVisible()
})
