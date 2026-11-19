// @vitest-environment jsdom
/**
 * obj 901392 — the "Follow-up scheduled for HH:MM: <note>" line a bot's
 * schedule_followup call leaves in the chat. While the follow-up waits the
 * person sees when it fires, what for, and a Cancel control; once it ran, was
 * cancelled or was dropped, the line says so and there is nothing to press.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, click, render } from '../../test/render'
import { FollowupLine } from './ChatItems'
import { mergeThread } from './AgentChatPage'
import type { ChatFollowup, ThreadResponse } from './types'

afterEach(async () => {
  await cleanup()
})

const base: ChatFollowup = {
  id: 12,
  status: 'pending',
  note: 'Check card #901391 and tell Operator whether the PR is green.',
  card_id: null,
  when_card_changes: false,
  due_at: '2026-11-18T12:10:00Z',
  hop: 1,
  thread_id: null,
  fire_reason: null,
  end_reason: null,
  created_at: '2026-11-18T12:00:00Z',
  fired_at: null,
  finished_at: null,
}
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

describe('FollowupLine', () => {
  it('a waiting follow-up shows when it fires, the note, and Cancel', async () => {
    const onCancel = vi.fn(async () => undefined)
    const view = await render(<FollowupLine followup={base} onCancel={onCancel} />)
    const line = view.container.querySelector('[data-testid="followup-line"]')!
    expect(line.getAttribute('data-status')).toBe('pending')
    expect(line.textContent).toContain(`Follow-up scheduled for ${hhmm(base.due_at)}:`)
    expect(line.textContent).toContain('Check card #901391 and tell Operator whether the PR is green.')
    const button = line.querySelector('button')!
    expect(button.textContent).toContain('Cancel')
    await click(button)
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledWith(base)
  })

  it('says so when it also fires early on a card change', async () => {
    const view = await render(<FollowupLine followup={{ ...base, card_id: 901391, when_card_changes: true }} onCancel={async () => undefined} />)
    expect(view.container.textContent).toContain('(or sooner if card #901391 changes)')
  })

  it.each([
    [{ status: 'fired', fired_at: '2026-11-18T12:10:05Z', fire_reason: 'due' }, `Follow-up ran at ${hhmm('2026-11-18T12:10:05Z')}:`],
    [{ status: 'fired', fired_at: '2026-11-18T12:04:00Z', fire_reason: 'card_changed' }, '(the card changed)'],
    [{ status: 'cancelled', end_reason: 'person' }, 'Follow-up cancelled by you:'],
    [{ status: 'cancelled', end_reason: 'bot' }, 'Follow-up cancelled by the bot:'],
    [{ status: 'dropped', end_reason: 'the chat it was set in was cleared or deleted' }, 'Follow-up dropped (the chat it was set in was cleared or deleted):'],
    [{ status: 'failed', end_reason: 'no AI seat' }, 'Follow-up could not run (no AI seat):'],
  ] as [Partial<ChatFollowup>, string][])('a finished follow-up (%j) has no Cancel', async (over, text) => {
    const view = await render(<FollowupLine followup={{ ...base, ...over }} onCancel={async () => undefined} />)
    expect(view.container.textContent).toContain(text)
    expect(view.container.querySelector('button')).toBeNull()
  })
})

describe('mergeThread keeps the newest state of a follow-up', () => {
  it('a re-read that reports it fired replaces the waiting copy', () => {
    const before: ThreadResponse = { messages: [], drafts: [], cards: [], followups: [base] }
    const after = mergeThread(before, { messages: [], drafts: [], cards: [], followups: [{ ...base, status: 'fired', fired_at: '2026-11-18T12:10:05Z' }] })
    expect(after.followups).toEqual([expect.objectContaining({ id: 12, status: 'fired' })])
    // An older server that sends no follow-ups leaves what is known in place.
    expect(mergeThread(before, { messages: [], drafts: [], cards: [] }).followups).toEqual([base])
  })
})
