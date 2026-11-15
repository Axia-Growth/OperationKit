import { describe, it, expect } from 'vitest'
import {
  UNASSIGNED_TOKEN,
  botOwnerToken,
  botRoster,
  matchesAssigneeFilter,
} from './assigneeFilter'

// obj 900869 — the owner filter covers everyone, each person AND each bot.

type Fixture = { assigned_usernames?: string[]; owner_bot?: string | null; bot_owner?: string | null; bot_owner_name?: string | null }
const card = (f: Fixture) => f as any

describe('owner filter — bot tokens', () => {
  const opsBot = card({ bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' })
  const mikesBotCard = card({ assigned_usernames: ['operator'], bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' })
  const avaOnly = card({ assigned_usernames: ['casey'] })

  it('selecting a bot shows every card that bot is on', () => {
    const sel = new Set([botOwnerToken('operation-kit')])
    expect(matchesAssigneeFilter(opsBot, sel)).toBe(true)
    expect(matchesAssigneeFilter(mikesBotCard, sel)).toBe(true)
    expect(matchesAssigneeFilter(avaOnly, sel)).toBe(false)
  })

  it('"Me" still shows my card while a bot works on it', () => {
    expect(matchesAssigneeFilter(mikesBotCard, new Set(['operator']))).toBe(true)
  })

  it('a bot-only card with no person still answers to Unassigned (saved selections lose nothing)', () => {
    expect(matchesAssigneeFilter(opsBot, new Set([UNASSIGNED_TOKEN]))).toBe(true)
  })

  it('a raw owner_bot with no server resolution still counts', () => {
    expect(matchesAssigneeFilter(card({ owner_bot: 'Grok' }), new Set([botOwnerToken('Grok')]))).toBe(true)
  })

  it('an empty selection matches nothing', () => {
    expect(matchesAssigneeFilter(opsBot, new Set())).toBe(false)
  })
})

describe('botRoster', () => {
  it('lists each distinct bot once, by display name', () => {
    const roster = botRoster([
      card({ bot_owner: 'zeta', bot_owner_name: 'Zeta' }),
      card({ bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' }),
      card({ bot_owner: 'operation-kit', bot_owner_name: 'Operation Kit' }),
      card({ owner_bot: 'grok' }),
      card({ assigned_usernames: ['operator'] }),
    ])
    expect(roster).toEqual([
      { token: 'bot:grok', id: 'grok', name: 'grok' },
      { token: 'bot:operation-kit', id: 'operation-kit', name: 'Operation Kit' },
      { token: 'bot:zeta', id: 'zeta', name: 'Zeta' },
    ])
  })
  it('is empty when no card has a bot', () => {
    expect(botRoster([card({ assigned_usernames: ['operator'] })])).toEqual([])
  })
})
