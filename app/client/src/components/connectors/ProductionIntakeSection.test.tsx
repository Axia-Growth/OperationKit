// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { HUMAN_MERGE_LINE, ProductionIntakeSection, intakeOutcomeText } from './ProductionIntakeSection'
import { cleanup, click, render } from '../../test/render'

/* obj 901771 — Settings → Integrations → Production issues: the human-merge
   rule is on the page; anyone in the workspace can paste a report; only an
   admin sees the webhooks and gets a token, shown once. */

const { apiMock } = vi.hoisted(() => ({ apiMock: { get: vi.fn(), post: vi.fn(), del: vi.fn() } }))
vi.mock('../../lib/api', () => ({ api: apiMock, ApiError: class extends Error {} }))

const WS = [{ value: 'acme', label: 'Acme' }]

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label) as HTMLButtonElement

beforeEach(() => {
  apiMock.get.mockReset(); apiMock.post.mockReset(); apiMock.del.mockReset()
})
afterEach(cleanup)

describe('intakeOutcomeText', () => {
  it('says what happened in one line', () => {
    expect(intakeOutcomeText({ outcome: 'filed', objective_id: 12 })).toBe('Filed card #12.')
    expect(intakeOutcomeText({ outcome: 'appended', objective_id: 12 })).toMatch(/Already open as card #12/)
    expect(intakeOutcomeText({ outcome: 'ignored', objective_id: null })).toMatch(/recovery/)
    expect(intakeOutcomeText({ outcome: 'rate_limited', objective_id: null, reason: 'rate limited: 10' })).toBe('rate limited: 10')
  })
})

describe('ProductionIntakeSection', () => {
  it('a member sees the human-merge rule and can paste a report, but no webhooks', async () => {
    apiMock.post.mockResolvedValue({ outcome: 'filed', objective_id: 41 })
    await render(<ProductionIntakeSection isAdmin={false} workspaces={WS} defaultWorkspace="acme" />)
    expect(document.body.textContent).toContain(HUMAN_MERGE_LINE)
    expect(document.body.textContent).not.toContain('Create webhook')
    expect(apiMock.get).not.toHaveBeenCalled()
    await type(document.getElementById('production-intake-report') as HTMLTextAreaElement, 'Checkout blank\nTypeError')
    await click(button('File bug card'))
    expect(apiMock.post).toHaveBeenCalledWith('/production-intake/report', { workspace: 'acme', text: 'Checkout blank\nTypeError' })
    await vi.waitFor(() => expect(document.body.textContent).toContain('Filed card #41.'))
  })

  it('an admin creates a webhook and sees the token once', async () => {
    apiMock.get.mockResolvedValue({ sources: [] })
    apiMock.post.mockResolvedValue({ source: { id: 1, name: 'Sentry - shop' }, token: 'opi_EXAMPLE' })
    await render(<ProductionIntakeSection isAdmin workspaces={WS} defaultWorkspace="acme" />)
    await vi.waitFor(() => expect(apiMock.get).toHaveBeenCalledWith('/production-intake/sources?workspace=acme'))
    await type(document.getElementById('production-intake-name') as HTMLInputElement, 'Sentry - shop')
    await click(button('Create webhook'))
    expect(apiMock.post).toHaveBeenCalledWith('/production-intake/sources', { workspace: 'acme', name: 'Sentry - shop', project: undefined, auto_start: false })
    await vi.waitFor(() => expect(document.body.textContent).toContain('opi_EXAMPLE'))
    expect(document.body.textContent).toContain('it is not shown again')
  })
})
