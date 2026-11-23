/**
 * A bot can say what the owner chose on its card (obj 901277).
 *
 * The incident: the owner answered a decision on card #901231, then asked the
 * owning bot (Full access) to confirm. Its card read had no decisions, so it
 * said it could not see which option was chosen. Here the seeded Full-access
 * demo bot "E2E Dev" owns a card whose decision was answered "A: Teal, as
 * designed". The demo provider answers this question ONLY from what card_read
 * returned, so this fails if the read (or its context) drops the decision.
 */
import { expect, type Page } from '@playwright/test'
import { test, login, shot, watch, expectClean, seed } from './helpers'

const input = (page: Page) => page.locator('#agent-chat-input')

test('the owning bot names the option the owner chose on #N', async ({ page }, info) => {
  const s = seed()
  const d = s.decision
  expect(d, 'seed made an answered decision').toBeTruthy()
  await login(page, info)
  const problems = watch(page)
  await page.goto(`/chat/${d.bot}`)
  const ask = `what did the owner choose on #${d.card}? (${info.project.name} ${Date.now()})`
  await input(page).fill(ask)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByText(ask, { exact: true })).toHaveCount(1)

  // The reply names the chosen option and its label — never the other one, never "can't see".
  const reply = page.getByText(new RegExp(`On card #${d.card}, .*chose`)).last()
  await expect(reply).toBeVisible({ timeout: 20_000 })
  await expect(reply).toContainText(`chose ${d.chosenKey}: ${d.chosenLabel}`)
  await expect(reply).toContainText(`decision #${d.id}`)
  await expect(reply).toContainText(s.admin)
  await expect(reply).not.toContainText(d.otherLabel)
  await expect(page.getByText(/can't see which option was chosen/)).toHaveCount(0)
  await expect(page.getByText(d.note).last()).toBeVisible()
  await shot(page, info, 'chat-decision-answer')
  expectClean(problems)
})
