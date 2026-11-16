// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Objective } from '@operationkit/shared'
import { OwnerTag, ownerOf, ownerSentence } from './OwnerTag'

// obj 900869 — the owner tag: a bot while it works, the person once it needs one.

const base = (o: Partial<Objective>): Objective => ({
  id: 1, title: 't', status: 'working', session_id: 'sess-1', assigned_usernames: ['operator'],
  owner_bot: null, bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit', created_by_username: 'operator',
  ...o,
}) as Objective

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => { root?.unmount(); host?.remove(); root = null; host = null })

function render(o: Objective, showHandoff = false): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  flushSync(() => root!.render(<OwnerTag objective={o} showHandoff={showHandoff} />))
  return host.querySelector('[data-testid="owner-tag"]') as HTMLElement
}

describe('OwnerTag', () => {
  it('shows the bot while the bot works the card', () => {
    const tag = render(base({ status: 'working' }))
    expect(tag.dataset.ownerKind).toBe('bot')
    expect(tag.dataset.needsHuman).toBe('0')
    expect(tag.textContent).toContain('Operation Kit')
  })

  it('shifts to the person when the card lands in Needs You, and names the bot that handed it off', () => {
    const tag = render(base({ status: 'review', session_id: null }), true)
    expect(tag.dataset.ownerKind).toBe('human')
    expect(tag.dataset.needsHuman).toBe('1')
    expect(tag.textContent).toContain('operator')
    expect(tag.querySelector('[data-testid="owner-handoff"]')?.textContent).toBe('from Operation Kit')
    expect(tag.getAttribute('title')).toBe('Owner: operator — needs you (handed off by Operation Kit)')
  })

  it('a review card with an agent still running stays the bot\'s', () => {
    expect(render(base({ status: 'review', session_id: 'sess-2' })).dataset.ownerKind).toBe('bot')
  })

  it('falls back to the filer when nobody is assigned in Needs You', () => {
    const o = ownerOf(base({ status: 'review', session_id: null, assigned_usernames: [], created_by_username: 'casey' }))
    expect(o).toMatchObject({ kind: 'human', label: 'casey', needs_human: true })
  })

  it('reads Unassigned when there is no bot and no person', () => {
    const tag = render(base({ bot_owner: null, bot_owner_name: null, assigned_usernames: [], status: 'queue', session_id: null }))
    expect(tag.dataset.ownerKind).toBe('unassigned')
    expect(tag.textContent).toContain('Unassigned')
  })

  it('prefers the server-shipped current_owner when present', () => {
    const tag = render(base({
      current_owner: { kind: 'bot', label: 'Server Bot', tokens: ['bot:s'], bot: 's', humans: [], needs_human: false, handed_off_from_bot: null, external_detail: null },
    }))
    expect(tag.textContent).toContain('Server Bot')
  })

  it('ownerSentence wording', () => {
    expect(ownerSentence(ownerOf(base({})))).toBe('Owner: Operation Kit (bot) — working on it')
  })

  it('shows an external owner distinctly, with its tooltip (obj 901030)', () => {
    const tag = render(base({
      bot_owner_is_external: true,
      bot_owner_detail: 'Filed by an outside assistant via API key OpKit.',
    }))
    expect(tag.dataset.ownerKind).toBe('external')
    expect(tag.getAttribute('title')).toBe('Filed by an outside assistant via API key OpKit.')
    expect(tag.textContent).toContain('Operation Kit')
  })
})
