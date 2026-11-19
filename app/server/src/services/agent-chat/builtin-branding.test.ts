/**
 * White-label: built-in bots carry the install's brand name, never the
 * vendor's (obj 901033). The shipped files use `{brand}` / `{brand_initials}`
 * and loadChatAgents fills them in; the slug never changes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadChatAgents, brandInitials, brandBuiltinAgent, BRAND_TOKEN, BUILTIN_DIR, parseAgentText } from './agent-defs.js'
import { cardOwnerResolver } from '../bots/card-owner.js'

// The product name only: the public mirror rewrites the company name to "Example", which would match "for example".
const VENDOR = /Operation ?Kit|Command[ -]Center/i
const dirs: string[] = []
const emptyAgentsDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-brand-'))
  dirs.push(d)
  return d
}
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

/** Every field of a bot a person sees on the Bots page or chat, or the model reads as its identity. */
function visibleFields(a: ReturnType<typeof loadChatAgents>['agents'][number]): Record<string, string> {
  return {
    name: a.name,
    description: a.description,
    avatar: a.avatar,
    author: a.author ?? '',
    how_to_use: a.how_to_use,
    example_prompts: a.example_prompts.join('\n'),
    system_prompt: a.system_prompt,
    schedules: a.schedules.map(s => `${s.name} ${s.prompt}`).join('\n'),
  }
}

describe('built-in bots under a custom brand (obj 901033)', () => {
  it('shows no vendor name in any user-visible field when OK_BRAND_NAME is set', () => {
    const { agents, problems } = loadChatAgents({ env: { AGENT_FILES_DIR: emptyAgentsDir(), OK_BRAND_NAME: 'Acme Ops' }, includeBuiltins: true })
    expect(problems).toEqual([])
    const builtins = agents.filter(a => a.source === 'builtin')
    expect(builtins.map(a => a.slug).sort()).toEqual(['kb-setup', 'operation-kit-dev'])
    for (const a of builtins) {
      for (const [field, value] of Object.entries(visibleFields(a))) {
        expect(value, `${a.slug}.${field}`).not.toMatch(VENDOR)
        expect(value, `${a.slug}.${field} still holds a token`).not.toMatch(/\{brand(_initials)?\}/)
      }
      expect(a.author).toBe('Acme Ops')
    }
    const dev = builtins.find(a => a.slug === 'operation-kit-dev')!
    expect(dev).toMatchObject({ slug: 'operation-kit-dev', name: 'Acme Ops Dev', avatar: 'AO' })
    expect(dev.description).toMatch(/^Helps you set up and extend Acme Ops — /)
    expect(dev.how_to_use).toMatch(/knows how Acme Ops works/)
    expect(dev.system_prompt).toMatch(/You are \*\*Acme Ops Dev\*\*, the built-in setup and build assistant for Acme Ops\./)
    // The old name still resolves (existing owner_bot values, chat references).
    expect(dev.aliases).toEqual(['Operation Kit Dev'])
  })

  it('keeps today\'s names exactly under the default brand (nothing is renamed on a live install)', () => {
    const { agents } = loadChatAgents({ env: { AGENT_FILES_DIR: emptyAgentsDir() }, includeBuiltins: true })
    const dev = agents.find(a => a.slug === 'operation-kit-dev')!
    expect(dev).toMatchObject({ name: 'Operation Kit Dev', author: 'Operation Kit', avatar: 'OK' })
    expect(dev.aliases).toBeUndefined()
    expect(agents.find(a => a.slug === 'kb-setup')!.author).toBe('Operation Kit')
  })

  it('takes a brand with YAML-special characters safely', () => {
    const { agents, problems } = loadChatAgents({ env: { AGENT_FILES_DIR: emptyAgentsDir(), OK_BRAND_NAME: 'Acme: #1 "Ops"' }, includeBuiltins: true })
    expect(problems).toEqual([])
    expect(agents.find(a => a.slug === 'operation-kit-dev')!.name).toBe('Acme: #1 "Ops" Dev')
  })

  it('leaves an install\'s own agent file exactly as written', () => {
    const dir = emptyAgentsDir()
    fs.mkdirSync(path.join(dir, 'mine'))
    fs.writeFileSync(path.join(dir, 'mine', 'agent.md'), '---\nname: "{brand} helper"\nauthor: Operation Kit\n---\nHi.\n')
    const { agents } = loadChatAgents({ env: { AGENT_FILES_DIR: dir, OK_BRAND_NAME: 'Acme Ops' }, includeBuiltins: true })
    expect(agents.find(a => a.slug === 'mine')).toMatchObject({ name: '{brand} helper', author: 'Operation Kit' })
  })

  it('makes initials from the first two words', () => {
    expect(brandInitials('Operation Kit')).toBe('OK')
    expect(brandInitials('Acme Ops')).toBe('AO')
    expect(brandInitials('acme')).toBe('A')
    expect(brandInitials('Ünited  data co')).toBe('ÜD')
    expect(brandInitials('—')).toBe('B')
  })

  it('fills every occurrence of the token', () => {
    const { agent } = parseAgentText(`---\nname: "${BRAND_TOKEN} x"\n---\n${BRAND_TOKEN} and ${BRAND_TOKEN}.\n`, 'a.md', 'a', 'file')
    expect(agent!.system_prompt).toBe('{brand} and {brand}.')
    expect(brandBuiltinAgent(agent!, 'Z').system_prompt).toBe('Z and Z.')
  })

  it('fills the brand when a built-in file is parsed directly, too', () => {
    const file = path.join(BUILTIN_DIR, 'operation-kit-dev', 'agent.md')
    const text = fs.readFileSync(file, 'utf8')
    expect(parseAgentText(text, file, 'operation-kit-dev', 'builtin').agent).toMatchObject({ name: 'Operation Kit Dev', avatar: 'OK' })
    expect(parseAgentText(text, file, 'operation-kit-dev', 'builtin', 'Acme Ops').agent).toMatchObject({ name: 'Acme Ops Dev', avatar: 'AO' })
  })

  it('a card owned as "Operation Kit Dev" still belongs to the renamed built-in bot', () => {
    const fakeDb = {
      prepare: () => { throw new Error('no tables') },
    } as unknown as Parameters<typeof cardOwnerResolver>[0]
    const owner = cardOwnerResolver(fakeDb, {
      chatBots: [{ slug: 'operation-kit-dev', name: 'Acme Ops Dev', aliases: ['Operation Kit Dev'] }],
    })({ id: 1, owner_bot: 'Operation Kit Dev', agent_context: null })
    expect(owner?.slugs).toEqual(['operation-kit-dev'])
    expect(owner?.name).toBe('Acme Ops Dev')
  })
})
