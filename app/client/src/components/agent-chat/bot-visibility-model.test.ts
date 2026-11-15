import { describe, it, expect } from 'vitest'
import { needsYouReasons, workGroupOf, botLiveState } from '@operationkit/shared'
import { foldFeedMessages } from './chat-feed-model'
import { approvalMessage, suggestedCeiling, isNeedsYouMessage } from './NeedsYouMessage'
import { avatarFor, buildAvatarIndex } from '../../lib/botAvatars'
import type { ChatMessage } from './types'

// obj 900947 — the pure rules behind the bot visibility screens.

const m = (id: number, meta: ChatMessage['meta'] = null, role: ChatMessage['role'] = 'assistant'): ChatMessage =>
  ({ id, role, content: `m${id}`, provider: null, model: null, tool_name: null, meta, created_at: '2026-11-15 09:00:00' })

describe('folding older High Agency updates', () => {
  it('folds each run of flagged messages into one item and keeps everything else in order', () => {
    const items = foldFeedMessages([m(1), m(2, { activity_feed: true }), m(3, { activity_feed: true }), m(4), m(5, { activity_feed: true })])
    expect(items.map(i => (i.kind === 'feed' ? `feed:${i.messages.map(x => x.id).join(',')}` : `msg:${i.m.id}`))).toEqual(['msg:1', 'feed:2,3', 'msg:4', 'feed:5'])
  })
  it('never folds a person\'s own message', () => {
    expect(foldFeedMessages([m(1, { activity_feed: true }, 'user')])[0].kind).toBe('message')
  })
})

describe('needs-you posts', () => {
  it('recognises only well-formed needs-you posts', () => {
    expect(isNeedsYouMessage(m(1, { kind: 'bot_needs_you', objective_id: 7, reason: 'blocker' }))).toBe(true)
    expect(isNeedsYouMessage(m(1, { kind: 'bot_needs_you', objective_id: 7, reason: 'pr_opened' }))).toBe(false)
    expect(isNeedsYouMessage(m(1, { kind: 'bot_needs_you', reason: 'blocker' }))).toBe(false)
  })
  it('the approval text names the card (and the action, for an approval beyond the grant)', () => {
    expect(approvalMessage('approval_beyond_grant', 9, 'prod_migration')).toBe('Approved: go ahead with the prod migration on card #9.')
    expect(approvalMessage('decision', 9)).toBe('Approved: go ahead with what you proposed on card #9.')
  })
  it('suggests a new ceiling with headroom, rounded up to $5', () => {
    expect(suggestedCeiling(12.5, 10)).toBe(20)
    expect(suggestedCeiling(160, 150)).toBe(240)
  })
})

describe('board avatars', () => {
  const index = buildAvatarIndex([
    { slug: 'your-org-cto', name: 'CTO', avatar: 'CT', colour: 'blue' },
    { slug: 'okit-dev', name: 'Operation Kit Dev', file_name: 'OK Dev', avatar: 'OK', colour: 'green' },
  ])
  it('matches a card\'s bot by name, registry id or chat slug — case and punctuation never matter', () => {
    expect(avatarFor(index, { bot_owner: 'Grok: CTO' })?.avatar).toBe('CT')
    expect(avatarFor(index, { bot_owner_name: 'operation kit dev' })?.avatar).toBe('OK')
    expect(avatarFor(index, { agent_context: 'okit-dev' })?.avatar).toBe('OK')
    expect(avatarFor(index, { agent_context: 'general' })).toBeNull()
    expect(avatarFor(index, { bot_owner: 'Somebody Else' })).toBeNull()
  })
})

describe('shared rules the screens render', () => {
  it('Work-tab groups', () => {
    expect(['planning', 'working', 'ai_review', 'review', 'queue', 'done', 'cancelled'].map(workGroupOf)).toEqual(['running', 'running', 'review', 'review', 'queued', 'done', null])
  })
  it('a parked review card needs a decision; an agent-run one does not', () => {
    expect(needsYouReasons({ status: 'review', session_id: null, spent_usd: 0, ceiling_usd: 10 })).toEqual(['decision'])
    expect(needsYouReasons({ status: 'review', session_id: 's', spent_usd: 0, ceiling_usd: 10 })).toEqual([])
    expect(needsYouReasons({ status: 'done', has_blockers: 1, spent_usd: 99, ceiling_usd: 1 })).toEqual([])
  })
  it('the dot: waiting beats running beats idle', () => {
    expect(botLiveState({ running: 2, needs_you: 1 })).toBe('waiting')
    expect(botLiveState({ running: 2, needs_you: 0 })).toBe('running')
    expect(botLiveState({ running: 0, needs_you: 0 })).toBe('idle')
  })
})
