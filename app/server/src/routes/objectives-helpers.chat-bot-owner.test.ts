// obj 900947 — the board resolves a card's owner bot for an installed chat bot
// that is NOT in the bot registry, so its avatar shows on the card and its Work
// tab's "Open on board" link (bot-work.ts owner_token) filters to its cards.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-chat-bot-owner-'))
process.env.DB_PATH = path.join(TMP, 'db.sqlite')
process.env.JWT_SECRET = 'test-secret-chat-bot-owner-xxxx'
const AGENTS = path.join(TMP, 'agents')
process.env.AGENT_FILES_DIR = AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'

const { initDb, getDb } = await import('../db/index.js')
const { resolveBotOwner, clearBotOwnerCache } = await import('./objectives-helpers.js')
const { buildBotWork } = await import('../services/agent-chat/bot-work.js')
const { botIdFromToken } = await import('@operationkit/shared')

function writeBot(slug: string, name: string) {
  fs.mkdirSync(path.join(AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(AGENTS, slug, 'agent.yaml'), `name: ${name}\nsystem_prompt: test\n`)
}

beforeAll(() => {
  initDb()
  writeBot('shipwright', 'Shipwright Dev')
  writeBot('your-org-cto', 'Operation Kit CTO') // a chat bot the default registry lists as "Grok: CTO"
  clearBotOwnerCache()
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('board owner: installed chat bots outside the registry', () => {
  it('agent_context = the chat bot slug resolves to the bot by its display name', () => {
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'shipwright' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev' })
  })

  it('an owner_bot that names the chat bot by slug or name resolves to the same id', () => {
    expect(resolveBotOwner({ owner_bot: 'shipwright', agent_context: 'general' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev' })
    expect(resolveBotOwner({ owner_bot: 'shipwright dev', agent_context: 'general' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev' })
  })

  it('a chat bot that IS in the registry resolves to its registry entry, by slug or by its chat display name', () => {
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'your-org-cto' } as never)).toEqual({ id: 'Grok: CTO', name: 'CTO' })
    expect(resolveBotOwner({ owner_bot: 'Operation Kit CTO', agent_context: 'general' } as never)).toEqual({ id: 'Grok: CTO', name: 'CTO' })
  })

  it('the default agent_context and unknown slugs still resolve to no bot; an unknown owner_bot is shown as itself', () => {
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'general' } as never)).toBeNull()
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'nobody-here' } as never)).toBeNull()
    expect(resolveBotOwner({ owner_bot: 'Someone Else', agent_context: 'general' } as never)).toEqual({ id: 'Someone Else', name: 'Someone Else' })
  })

  it('the Work tab owner_token names the same bot the board resolves', () => {
    const view = buildBotWork(getDb(), { slug: 'shipwright', name: 'Shipwright Dev' }, { viewer: { id: 1, role: 'admin' } })
    const id = botIdFromToken(view.owner_token)
    expect(id).toBe(resolveBotOwner({ owner_bot: null, agent_context: 'shipwright' } as never)!.id)
  })
})
