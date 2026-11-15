// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import type { Objective } from '@operationkit/shared'
import { cleanup, click, press, render } from '../test/render'

/* PlanningPanel on ui/Modal (UI SDK Dialog): a full-screen modal dialog named
   by the objective title; Escape closes it and focus returns to the opener.
   "Cancel Planning" asks through useConfirm (an in-app alertdialog), not the
   native confirm(). */

const posts: string[] = []
vi.mock('../lib/api', () => ({
  api: {
    get: () => Promise.resolve({ messages: [], total: 0 }),
    post: (url: string) => { posts.push(url); return Promise.resolve({}) },
    patch: () => Promise.resolve({}),
  },
}))
vi.mock('./SessionMessages', () => ({ GroupedMessages: () => null }))
vi.mock('./FileEditorOverlay', () => ({ FileEditorOverlay: () => null }))

const { PlanningPanel } = await import('./PlanningPanel')

const settle = () => new Promise((r) => setTimeout(r, 0))
const objective = (extra: Partial<Objective> = {}) =>
  ({ id: 7, title: 'Plan the launch', status: 'planning', planning_session_id: 'plan-1', ...extra }) as unknown as Objective

function opener() {
  const b = document.createElement('button')
  b.textContent = 'Plan'
  document.body.appendChild(b)
  b.focus()
  return b
}

describe('PlanningPanel — modal dialog', () => {
  beforeEach(() => { posts.length = 0 })
  afterEach(async () => {
    vi.restoreAllMocks()
    await cleanup()
  })

  it('is a named modal dialog; Escape closes it and focus returns to the opener', async () => {
    const trigger = opener()
    const onClose = vi.fn()
    const view = await render(<PlanningPanel objective={objective()} onClose={onClose} onApproved={() => {}} />)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Plan the launch')
    // Focus starts in the reply box, not on "Approve Plan".
    expect(document.activeElement?.tagName).toBe('TEXTAREA')
    expect(dialog.querySelector('button[aria-label="Close planning"]')).toBeTruthy()

    await press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)
    await view.unmount()
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it('Cancel Planning asks in an in-app confirm, never window.confirm', async () => {
    opener()
    const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const onClose = vi.fn()
    await render(<PlanningPanel objective={objective()} onClose={onClose} onApproved={() => {}} />)
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Cancel Planning')!
    await click(cancel)
    const alert = document.querySelector<HTMLElement>('[role="alertdialog"]')!
    expect(alert).toBeTruthy()
    expect(alert.textContent).toContain('Cancel planning?')

    // Escape answers the confirm only: the panel stays open, nothing posted.
    await press('Escape')
    await settle()
    expect(onClose).not.toHaveBeenCalled()
    expect(posts).toEqual([])
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()

    // Ask again and confirm.
    await click(cancel)
    const confirmBtn = [...document.querySelectorAll<HTMLElement>('[role="alertdialog"] button')].find((b) => b.textContent === 'Cancel planning')!
    await click(confirmBtn)
    await settle()
    expect(posts).toEqual(['/objectives/7/planning/cancel'])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(nativeConfirm).not.toHaveBeenCalled()
  })
})
