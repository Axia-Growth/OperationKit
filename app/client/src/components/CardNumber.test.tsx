// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Objective } from '@operationkit/shared'
import { cleanup, click, render } from '../test/render'
import { CardNumber } from './CardNumber'
import { PreviewCard } from '../preview/PreviewCard'
import { ViewerHeader } from './session-viewer/ViewerHeader'
import { CardChip } from './agent-chat/ChatItems'

/* obj 901080: every card shows its #number (tile, card header, chat card
   reference) and a click copies it without opening the card. */

afterEach(async () => {
  await cleanup()
  delete (navigator as unknown as { clipboard?: unknown }).clipboard
})

const card = {
  id: 901075, title: 'Fix the login page', description: '', status: 'working', workspace: 'demo',
  agent_context: 'general', session_id: null, session_count: 0, total_cost_usd: 0,
  assigned_usernames: [], updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
} as unknown as Objective
const noop = () => {}

describe('CardNumber', () => {
  it('shows #id and copies it on click, without bubbling to the tile', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const outer = vi.fn()
    await render(<div onClick={outer}><CardNumber id={901075} /></div>)
    const btn = document.querySelector('[data-testid="card-number"]') as HTMLButtonElement
    expect(btn.textContent).toContain('#901075')
    expect(btn.title).toMatch(/Click to copy/)
    await click(btn)
    await vi.waitFor(() => expect(btn.getAttribute('data-copy-state')).toBe('copied'))
    expect(writeText).toHaveBeenCalledWith('#901075')
    expect(outer).not.toHaveBeenCalled()
  })
})

describe('the number is on every card surface', () => {
  it('board tile', async () => {
    const onOpen = vi.fn()
    await render(<PreviewCard objective={card} onOpen={onOpen} onChangeStatus={noop} />)
    const num = document.querySelector('[data-testid="card-number"]')!
    expect(num.textContent).toBe('#901075')
    await click(num)
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('card detail header', () => {
    const html = renderToStaticMarkup(
      <ViewerHeader
        objective={card} isActive={false} connState="live" time="" hasActivity={false}
        skillsInvoked={[]} subagentPersonas={[]} subagentWorkers={[]} agentLabel={s => s}
        showBrief={false} setShowBrief={noop} showCorrection={false} setShowCorrection={noop}
        setCorrectionError={noop} correctionSaved={false} onChangeStatus={noop}
        isFull={false} toggleSize={noop} onClose={noop} hideSizeToggle
      />,
    )
    expect(html).toContain('data-testid="card-number"')
    expect(html).toContain('#901075')
  })

  it('chat card reference: number is a copy button outside the in-app link', async () => {
    await render(<CardChip card={{ id: 901075, title: 'Fix the login page', status: 'working', summary: null, pr_url: null, updated_at: '', url: 'https://ops.acme.test/o/901075' }} />)
    const chip = document.querySelector('[data-testid="chat-card-chip"]')!
    const num = chip.querySelector('[data-testid="card-number"]')!
    expect(num.textContent).toBe('#901075')
    expect(num.closest('a')).toBeNull()
    expect(chip.querySelector('a')?.getAttribute('href')).toBe('/o/901075')
  })
})
