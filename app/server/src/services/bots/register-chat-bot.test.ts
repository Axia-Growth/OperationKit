import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { chatBotForDeclared, chatBotIdentity, registerChatBot, registrationOptions, registryBotForChat, suggestedLink } from './register-chat-bot.js'
import { BUILT_IN_BOTS, listBots } from './bot-registry.js'
import { TEMPLATE_PLACEHOLDER } from './install-slugs.js'

// The live install's CTO bot is `your-org-cto`. The OSS name-scrub rewrites
// this org slug to the template placeholder, which IS the shipped CTO bot's own
// slug, so the public tree runs the same flow under a neutral org instead.
const ORG: string = 'your-org'
const CTO_SLUG = ORG === TEMPLATE_PLACEHOLDER ? 'acme-cto' : `${ORG}-cto`

function settingsDb(rows: Record<string, string> = {}): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  for (const [k, v] of Object.entries(rows)) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v)
  return db
}
const value = (db: Database.Database, key: string) =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null

// The public build's registry: no org aliases, so "Example CTO" is unknown.
const SCRUBBED = JSON.stringify(BUILT_IN_BOTS.map(b => ({ ...b, aliases: b.aliases.filter(a => !/example/i.test(a)) })))

describe('register-chat-bot (obj 900862)', () => {
  it('suggests linking an install\'s <org>-<role> slug to the bot owning your-org-<role>', () => {
    expect(suggestedLink(CTO_SLUG, BUILT_IN_BOTS)).toBe('Grok: CTO')
    expect(suggestedLink('acme-general', BUILT_IN_BOTS)).toBe('Grok: General')
    expect(suggestedLink('operation-kit-dev', BUILT_IN_BOTS)).toBeNull()
    expect(suggestedLink('your-org-cto', BUILT_IN_BOTS)).toBeNull()
  })

  it('is unregistered on the scrubbed registry, and the options offer both paths', () => {
    const db = settingsDb({ bot_registry: SCRUBBED })
    const cto = { slug: CTO_SLUG, name: 'Example CTO' }
    expect(registryBotForChat(cto, db)).toBeNull()
    const o = registrationOptions(cto, db)
    expect(o.suggested).toBe('Grok: CTO')
    expect(o.new_bot_id).toBe('Example CTO')
    // De-duplicated by id: the public build carries two shipped bots that share one.
    expect(o.existing.map(b => b.id)).toEqual([...new Set(BUILT_IN_BOTS.map(b => b.id))])
  })

  it('link: writes one additive row; bot_registry and bot_agent_slugs are untouched', () => {
    const db = settingsDb({ bot_registry: SCRUBBED, bot_agent_slugs: '{}' })
    const r = registerChatBot(db, { slug: CTO_SLUG, name: 'Example CTO' }, 'CTO')
    expect(r).toMatchObject({ ok: true, linked: true, bot: { id: 'Grok: CTO' } })
    expect(value(db, 'bot_registry')).toBe(SCRUBBED)
    expect(value(db, 'bot_agent_slugs')).toBe('{}')
    expect(registryBotForChat({ slug: CTO_SLUG, name: 'Example CTO' }, db)?.id).toBe('Grok: CTO')
  })

  it('new: a bot named after the chat bot; a name another bot answers to is refused', () => {
    const db = settingsDb()
    const r = registerChatBot(db, { slug: 'operation-kit-dev', name: 'Operation Kit Dev' })
    expect(r).toMatchObject({ ok: true, linked: false, bot: { id: 'Operation Kit Dev', agent_slugs: ['operation-kit-dev'] } })
    expect(listBots(db).filter(b => b.id === 'Operation Kit Dev')).toHaveLength(1)
    // already registered now
    expect(registerChatBot(db, { slug: 'operation-kit-dev', name: 'Operation Kit Dev' })).toMatchObject({ ok: false, code: 'already_registered' })
  })

  it('refuses an unknown target and a slug another bot owns', () => {
    const db = settingsDb()
    expect(registerChatBot(db, { slug: 'x-new', name: 'X New' }, 'Nobody')).toMatchObject({ ok: false, status: 400, code: 'unknown_bot' })
    // 'general' is a built-in slug, so a chat bot named oddly but slugged 'general' is already registered.
    expect(registerChatBot(db, { slug: 'general', name: 'Zzz' })).toMatchObject({ ok: false, code: 'already_registered' })
    expect(value(db, 'bot_registry_additions')).toBeNull()
  })
})

describe('automatic chat-bot identity (obj 900862: no manual registry step)', () => {
  it('a registered bot keeps its registry identity (auto=false)', () => {
    const db = settingsDb()
    expect(chatBotIdentity({ slug: 'general', name: 'Whatever' }, db)).toMatchObject({ auto: false, linked: false })
  })

  it('Example CTO unknown to the stored registry → linked to the shipped CTO, and nothing is written', () => {
    const db = settingsDb({ bot_registry: SCRUBBED })
    const id = chatBotIdentity({ slug: CTO_SLUG, name: 'Example CTO' }, db)
    expect(id).toMatchObject({ auto: true, linked: true, bot: { id: 'Grok: CTO' } })
    expect(value(db, 'bot_registry_additions')).toBeNull()
    expect(value(db, 'bot_registry')).toBe(SCRUBBED)
  })

  it('a bot with no shipped twin → a new identity named after it, owning its slug', () => {
    const db = settingsDb()
    expect(chatBotIdentity({ slug: 'operation-kit-dev', name: 'Operation Kit Dev' }, db)).toEqual({
      auto: true,
      linked: false,
      bot: { id: 'Operation Kit Dev', name: 'Operation Kit Dev', aliases: [], agent_slugs: ['operation-kit-dev'] },
    })
  })

  it('a name that cannot be a bot id falls back to the slug; null only when both are unusable', () => {
    const db = settingsDb()
    expect(chatBotIdentity({ slug: 'weird-bot', name: '!!! Weird' }, db)?.bot.id).toBe('weird-bot')
    // the name already answers for a registry bot → that IS its identity; an unusable name + a taken slug → null (the register control takes over)
    const taken = settingsDb({ bot_registry: JSON.stringify([{ id: 'Taken', name: 'Taken', aliases: ['taken-slug-alias'] }]) })
    expect(chatBotIdentity({ slug: 'taken-slug-alias', name: 'Taken' }, taken)?.auto).toBe(false)
    expect(chatBotIdentity({ slug: 'taken-slug-alias', name: '!!!' }, taken)).toBeNull()
  })

  it('a declared name resolves through the installed chat bots by slug, name or file name', () => {
    const db = settingsDb({ bot_registry: SCRUBBED })
    const bots = [
      { slug: CTO_SLUG, name: 'Example CTO', file_name: 'cto' },
      { slug: 'operation-kit-dev', name: 'Operation Kit Dev' },
    ]
    expect(chatBotForDeclared('Example CTO', bots, db)?.bot.id).toBe('Grok: CTO')
    expect(chatBotForDeclared(CTO_SLUG, bots, db)?.bot.id).toBe('Grok: CTO')
    expect(chatBotForDeclared('operation kit dev', bots, db)?.bot.id).toBe('Operation Kit Dev')
    expect(chatBotForDeclared('Nobody', bots, db)).toBeNull()
    expect(chatBotForDeclared('', bots, db)).toBeNull()
    expect(chatBotForDeclared(42, bots, db)).toBeNull()
  })
})
