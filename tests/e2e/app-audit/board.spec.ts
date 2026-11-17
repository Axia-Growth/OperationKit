/**
 * Board, cards and reviews (card #901024): columns show the seeded cards in the
 * right state, a card opens, the edit dialog keeps a draft, the model picker and
 * status buttons are present, sub-cards are listed, and review states read
 * correctly. Status changes are intercepted: they would start a real session.
 */
import { expect } from '@playwright/test'
import { test, login, seed, shot, watch, expectClean, blockStatusChanges } from './helpers'

test('board shows each seeded card in its column', async ({ page }, info) => {
  await login(page, info)
  const problems = watch(page)
  await page.goto(`/w/${seed().workspace}`)
  await expect(page.getByTestId('board-header')).toBeVisible()
  for (const [status, title] of [
    ['queue', 'E2E queue card'], ['working', 'E2E working card'], ['ai_review', 'E2E card in AI review'],
    ['review', 'E2E card needing you (review passed)'], ['review', 'E2E card needing you (review failed)'],
  ] as const) {
    await expect(page.locator(`section[data-status="${status}"]`).getByText(title, { exact: true }), `${title} in ${status}`).toBeVisible()
  }
  await shot(page, info, 'board-columns')
  expectClean(problems)
})

test('a long card title does not push the board sideways', async ({ page }, info) => {
  await login(page, info)
  await page.goto(`/w/${seed().workspace}`)
  const card = page.locator('article.cc-ws-card').filter({ hasText: 'E2E card with a very long title' }).first()
  await expect(card).toBeVisible()
  const box = await card.boundingBox()
  const column = await page.locator('section[data-status="queue"]').boundingBox()
  expect(box && column && box.width <= column.width + 1, 'card is no wider than its column').toBeTruthy()
})

// Uses the card in the second workspace; the main one, where the seed enables a
// starter pack, is covered by the #901196 test below.
test('open a card from the board, edit it, and the edit is still there after a reload', async ({ page }, info) => {
  await login(page, info)
  const problems = watch(page)
  await page.goto(`/w/${seed().privateWorkspace}`)
  await page.locator('article.cc-ws-card').filter({ hasText: 'E2E private card' }).first().getByRole('button', { name: 'E2E private card' }).click()
  // The card opens in an overlay on top of the board; the address stays the board's.
  const overlay = page.getByRole('dialog', { name: 'E2E private card' })
  await expect(overlay).toBeVisible()
  await expect(overlay.getByRole('button', { name: 'Open in new tab' })).toBeVisible()
  await shot(page, info, 'card-overlay')
  await overlay.getByRole('button', { name: 'Edit card' }).click()
  const dialogTitle = page.locator('#objective-modal-title')
  await expect(dialogTitle).toHaveText('Edit card')
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('E2E private card')
  await expect(page.getByLabel('Model', { exact: true }), 'model picker is shown in the edit dialog').toBeVisible()
  await shot(page, info, 'card-edit-dialog')
  // Save a real edit and read it back after a reload.
  await page.getByLabel('Description / instructions').fill('Edited by the e2e suite.')
  await page.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(dialogTitle).toBeHidden()
  await page.reload()
  const saved = await (await page.request.get(`/api/objectives/${seed().cards.private}`)).json()
  expect(saved.description, 'the edit was stored').toBe('Edited by the e2e suite.')
  await page.goto(`/o/${seed().cards.private}`)
  await page.getByRole('button', { name: 'Edit card' }).first().click()
  await expect(page.getByLabel('Description / instructions')).toHaveValue('Edited by the e2e suite.')
  expectClean(problems)
})

// Fixed by card #901196 (was audit finding PA-1): enabling a starter pack on a
// workspace whose bot pool is open ("any bot") used to narrow the pool to the pack's
// bot, so cards already there, run by the default bot, failed to save with a 400 and
// the dialog only said "Something went wrong". The pool now stays open, and the
// dialog shows the server's reason for a 400.
test('a card still saves after a starter pack is enabled in its workspace', async ({ page }, info) => {
  expect(seed().graphPack, 'seed.mjs enabled the knowledge-import pack in the main workspace').toBe(true)
  await login(page, info)
  await page.goto(`/o/${seed().cards.longTitle}`)
  await page.getByRole('button', { name: 'Edit card' }).first().click()
  const dialogTitle = page.locator('#objective-modal-title')
  await expect(dialogTitle).toHaveText('Edit card')
  const text = `Saved after the pack was enabled (${info.project.name}).`
  await page.getByLabel('Description / instructions').fill(text)
  await page.getByRole('button', { name: 'Update', exact: true }).click()
  await expect(dialogTitle).toBeHidden()
  await shot(page, info, 'card-edit-saved-after-pack')
  const saved = await (await page.request.get(`/api/objectives/${seed().cards.longTitle}`)).json()
  expect(saved.description, 'the edit was stored').toBe(text)
})

// A double click sends the request twice (the button has no busy state). The server
// ignores the repeat (objectives-status.ts: working -> working is a no-op), so this is
// recorded in the audit report as a low observation, not asserted here.
test('queue card offers Start; the click sends one status request', async ({ page }, info) => {
  await login(page, info)
  const calls = await blockStatusChanges(page)
  await page.goto(`/o/${seed().cards.queue}`)
  const start = page.getByRole('button', { name: 'Start', exact: true }).first()
  await expect(start).toBeVisible()
  await start.click()
  await expect.poll(() => calls.length).toBeGreaterThan(0)
  await page.waitForTimeout(500)
  expect(calls, 'status calls after one click').toEqual([`PATCH /api/objectives/${seed().cards.queue}/status`])
})

test('parent card lists its sub-cards and they open', { tag: '@desktop' }, async ({ page }, info) => {
  await login(page, info)
  await page.goto(`/o/${seed().cards.parent}`)
  await expect(page.getByText('Sub-cards').first()).toBeVisible()
  await expect(page.getByText('E2E sub-card one').first()).toBeVisible()
  await expect(page.getByText('E2E sub-card two').first()).toBeVisible()
  await shot(page, info, 'card-sub-cards')
  // A sub-card opens in place: the row is marked current and the panel shows that card.
  const row = page.getByTestId(`sub-card-row-${seed().cards.child1}`)
  await expect(row).toHaveAttribute('href', `/o/${seed().cards.child1}`)
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'true')
  await expect(page.getByRole('heading', { name: 'E2E sub-card one' }).first()).toBeVisible()
  await shot(page, info, 'card-sub-card-open')
})

test('review states: passed, failed and blocked cards say so and offer Approve and Rework', async ({ page }, info) => {
  await login(page, info)
  await blockStatusChanges(page)
  for (const [key, findings] of [
    ['reviewPass', 'All acceptance criteria met. Tests pass.'],
    ['reviewFail', 'Criterion 2 is not met: the empty state is missing.'],
    ['reviewBlocked', 'The reviewer could not reach the preview.'],
  ] as const) {
    await page.goto(`/o/${seed().cards[key]}`)
    await expect(page.getByRole('button', { name: 'Approve', exact: true }).first(), `${key}: Approve`).toBeVisible()
    await expect(page.getByRole('button', { name: 'Rework', exact: true }).first(), `${key}: Rework`).toBeVisible()
    await page.getByRole('button', { name: 'Brief', exact: true }).first().click()
    await expect(page.getByText('AI review findings').first(), `${key}: findings card`).toBeVisible()
    await expect(page.getByText(findings).first()).toBeVisible()
    await shot(page, info, `card-${key}`)
  }
})

test('card in AI review offers Force done, not Approve', async ({ page }, info) => {
  await login(page, info)
  await page.goto(`/o/${seed().cards.aiReview}`)
  await expect(page.getByRole('button', { name: 'Force done', exact: true }).first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
})

// Fixed by card #901200 (was audit finding PA-5): Escape used to close the new-card dialog and throw the typed
// text away without asking. The dialog now keeps the draft until the card is created or the draft is discarded.
test('new card dialog: a typed draft survives closing and reopening the dialog', async ({ page }, info) => {
  await login(page, info)
  await page.goto(`/w/${seed().workspace}`)
  await page.getByRole('button', { name: 'New', exact: true }).first().click()
  await expect(page.locator('#objective-modal-title')).toHaveText('New card')
  await page.getByLabel('Title', { exact: true }).fill('Draft title that should not be lost')
  await shot(page, info, 'card-new-dialog')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'New', exact: true }).first().click()
  await expect(page.getByLabel('Title', { exact: true })).toHaveValue('Draft title that should not be lost')
})

// Card #901198 (was audit finding PA-3): below the desktop breakpoint the Sub-cards side rail is hidden, so the card
// page shows a collapsible "Sub-cards (n)" section above the chat instead. It must list the sub-cards, open one, and
// not make the page scroll sideways.
test('narrow screens: a parent card still shows its sub-cards', { tag: '@narrow' }, async ({ page }, info) => {
  await login(page, info)
  await page.goto(`/o/${seed().cards.parent}`)
  await expect(page.getByRole('heading', { name: 'E2E parent card' }).first()).toBeVisible()
  const toggle = page.getByRole('button', { name: /^Sub-cards \(\d+\)$/ }).filter({ visible: true })
  // Runs only in the narrow projects, where the side rail is hidden: the toggle must be there.
  await expect(toggle).toHaveCount(1)
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await shot(page, info, 'card-sub-cards')
  const sub = page.getByText('E2E sub-card one').filter({ visible: true }).first()
  await expect(sub).toBeVisible()
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(sideways, 'no sideways scroll').toBeLessThanOrEqual(0)
  await sub.click()
  await expect(page.getByTestId('sub-card-popup')).toBeVisible()
  await shot(page, info, 'card-sub-card-open')
})
