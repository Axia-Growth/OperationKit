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
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'shipwright' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev', external: false })
  })

  it('an owner_bot that names the chat bot by slug or name resolves to the same id', () => {
    expect(resolveBotOwner({ owner_bot: 'shipwright', agent_context: 'general' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev', external: false })
    expect(resolveBotOwner({ owner_bot: 'shipwright dev', agent_context: 'general' } as never)).toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev', external: false })
  })

  it('a chat bot that IS in the registry resolves to its registry entry, by slug or by its chat display name', () => {
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'your-org-cto' } as never)).toEqual({ id: 'Grok: CTO', name: 'CTO', external: false })
    expect(resolveBotOwner({ owner_bot: 'Operation Kit CTO', agent_context: 'general' } as never)).toEqual({ id: 'Grok: CTO', name: 'CTO', external: false })
  })

  it('the default agent_context and unknown slugs still resolve to no bot; an unknown owner_bot is shown as itself, and external', () => {
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'general' } as never)).toBeNull()
    expect(resolveBotOwner({ owner_bot: null, agent_context: 'nobody-here' } as never)).toBeNull()
    expect(resolveBotOwner({ owner_bot: 'Someone Else', agent_context: 'general' } as never)).toEqual({ id: 'Someone Else', name: 'Someone Else', external: true })
  })

  // obj 901030 (operator review of PR #812) — the ORIGINAL version of this test
  // only went external by first REPLACING settings.bot_registry, which no real
  // install does. On the DEFAULT built-in registry, "Operation Kit" is
  // BUILT_IN_BOTS[0] — a registry hit regardless of whether this install ever
  // configured a matching chat bot — so a registry match alone must NOT decide
  // `external`. What decides it: no chat agent installed HERE answers to the
  // name/alias/agent_slug, AND the card arrived through a shared agent API key
  // (agent_key_label set). Neither signal alone is enough — a registry hit with
  // no API key (a human typed `owner_bot: 'Operation Kit'`) stays local, and an
  // API-key card naming a bot this install DOES have a chat agent for
  // (Shipwright, Operation Kit CTO, …) stays local too.
  it('a registry hit with no installed chat agent is external only when it arrived via an agent API key (DEFAULT registry)', () => {
    expect(resolveBotOwner({ owner_bot: 'Operation Kit', agent_context: 'general', agent_key_label: null } as never))
      .toEqual({ id: 'Operation Kit', name: 'Operation Kit', external: false })
    expect(resolveBotOwner({ owner_bot: 'Operation Kit', agent_context: 'general', agent_key_label: 'OpKit' } as never))
      .toEqual({ id: 'Operation Kit', name: 'Operation Kit', external: true })
  })

  it('a bot with a chat agent installed here stays local even when filed via the same API key', () => {
    // 'shipwright' is an installed chat agent file (beforeAll above) and is not
    // in the registry at all — purely a chat-installed bot, filed via API key.
    expect(resolveBotOwner({ owner_bot: 'shipwright', agent_context: 'general', agent_key_label: 'OpKit' } as never))
      .toEqual({ id: 'Shipwright Dev', name: 'Shipwright Dev', external: false })
    // 'your-org-cto' IS in the registry (Grok: CTO) AND has an installed chat
    // agent ('Operation Kit CTO') — stays local via an API key too.
    expect(resolveBotOwner({ owner_bot: 'Operation Kit CTO', agent_context: 'general', agent_key_label: 'OpKit' } as never))
      .toEqual({ id: 'Grok: CTO', name: 'CTO', external: false })
  })

  it('the Work tab owner_token names the same bot the board resolves', () => {
    const view = buildBotWork(getDb(), { slug: 'shipwright', name: 'Shipwright Dev' }, { viewer: { id: 1, role: 'admin' } })
    const id = botIdFromToken(view.owner_token)
    expect(id).toBe(resolveBotOwner({ owner_bot: null, agent_context: 'shipwright' } as never)!.id)
  })
})
