// app_routes (obj 901493): chat bots look click paths up in the generated app
// map instead of quoting old notes. The map itself is kept current by the
// client test app-map.staleness.test.ts; these tests cover the search, who gets
// the tool, and that the built-in Dev bot's own instructions agree with the map.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

process.env.JWT_SECRET = 'test-secret-app-routes-xxxx'
const TMP_DB = path.join(os.tmpdir(), `cc-app-routes-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-routes-kb-'))

const { initDb } = await import('../../db/index.js')
const { toolSpecsFor, runChatTool, effectiveTools, ToolUseError } = await import('./tools.js')
const { systemPromptFor } = await import('./engine.js')
const { ALL_TOOLS_GRANT, KNOWN_TOOL_NAMES, TOOL_CATALOG, EXPLICIT_ONLY_TOOLS } = await import('./tool-names.js')
const { searchAppMap, loadAppMap, APP_ROUTES_PROMPT_LINE } = await import('./app-routes-tool.js')
const APP_MAP = loadAppMap()
type Agent = import('./agent-defs.js').ChatAgent
type Result = import('./app-routes-tool.js').AppRoutesResult

const agent = (slug: string, tools: string[]): Agent => ({ slug, name: slug, description: '', tools, knowledge_folders: [], system_prompt: 'You help.' } as unknown as Agent)
const ctx = (a: Agent) => ({ userId: 1, username: 'user1', workspace: 'ws', agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null } })

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})
afterAll(() => {
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f)
  fs.rmSync(TMP_KB, { recursive: true, force: true })
})

describe('app_routes: search', () => {
  it('finds Queue auto-start under Workflows > Runs, with its address, audience and field', () => {
    const top = searchAppMap('queue auto-start').matches[0]
    expect(top).toMatchObject({ path: 'Workflows > Runs > Queue auto-start', kind: 'panel', url: '/jobs?view=runs', who: 'admins only' })
    expect(top.fields).toContain('Job time limit (minutes)')
  })

  it('finds a setting by the label of its field', () => {
    expect(searchAppMap('job time limit').matches[0].path).toBe('Workflows > Runs > Queue auto-start')
  })

  it('answers the stale path "Settings > Platform" with where it went, never as a page', () => {
    const r = searchAppMap('Settings > Platform')
    expect(r.matches[0]).toMatchObject({ kind: 'moved', path: 'Workflows', url: '/jobs#host-cron' })
    expect(r.matches[0].about).toMatch(/\/settings\/platform no longer has a page/)
    expect(r.note).toMatch(/OLD address/)
    for (const m of r.matches) if (m.kind !== 'moved') expect(m.path).not.toMatch(/Platform/)
  })

  it('gives Settings pages their avatar-menu path', () => {
    const m = searchAppMap('secrets').matches.find(x => x.kind === 'page')!
    expect(m).toMatchObject({ path: 'Avatar menu (top right) > Settings > Secrets', url: '/settings/secrets', who: 'everyone signed in' })
    expect(searchAppMap('branding').matches[0]).toMatchObject({ url: '/settings/branding', who: 'admins only' })
  })

  it('lists every page when there is no query', () => {
    const r = searchAppMap(undefined)
    expect(r.query).toBeNull()
    expect(r.matches.map(m => m.url)).toEqual(APP_MAP.pages.filter(p => !p.same_as).map(p => p.path))
    expect(r.matches.every(m => m.kind === 'page')).toBe(true)
  })

  it('says so when nothing matches, instead of returning a near miss', () => {
    const r = searchAppMap('quantum billing ledger')
    expect(r.matches).toEqual([])
    expect(r.note).toMatch(/Do not guess/)
  })

  it('stays small: a search is a few hundred tokens, the page list under a thousand', () => {
    expect(JSON.stringify(searchAppMap('queue auto-start')).length).toBeLessThan(3000)
    expect(JSON.stringify(searchAppMap('')).length).toBeLessThan(4000)
  })
})

describe('app_routes: who has the tool', () => {
  const names = (a: Agent) => toolSpecsFor(a).map(s => s.function.name)

  it('is a known tool any bot can be given, and "All tools" includes it', () => {
    expect(KNOWN_TOOL_NAMES.has('app_routes')).toBe(true)
    expect(ALL_TOOLS_GRANT.has('app_routes')).toBe(true)
    expect(EXPLICIT_ONLY_TOOLS.has('app_routes')).toBe(false)
    expect(TOOL_CATALOG.find(t => t.name === 'app_routes')).toMatchObject({ group: 'app' })
    expect(names(agent('sales', ['search', 'app_routes']))).toContain('app_routes')
    expect(names(agent('everything', ['all']))).toContain('app_routes')
  })

  it('a bot that does not list it does not get it', async () => {
    const a = agent('sales', ['search', 'list_objectives'])
    expect(names(a)).not.toContain('app_routes')
    await expect(runChatTool(ctx(a), 'app_routes', { query: 'secrets' })).rejects.toBeInstanceOf(ToolUseError)
    expect(systemPromptFor(a, { username: 'u', now: new Date(), connectors: [] })).not.toContain('app_routes')
  })

  it('Operation Kit Dev always has it, even when its file was written before the tool existed', async () => {
    const dev = agent('operation-kit-dev', ['search', 'create_objective'])
    expect(effectiveTools(dev)).toContain('app_routes')
    expect(names(dev)).toContain('app_routes')
    const out = await runChatTool(ctx(dev), 'app_routes', { query: 'queue auto-start' })
    expect((out.result as Result).matches[0].path).toBe('Workflows > Runs > Queue auto-start')
    expect(out.summary).toBe('Looked up "queue auto-start" in the app (Workflows > Runs > Queue auto-start)')
    expect(systemPromptFor(dev, { username: 'u', now: new Date(), connectors: [] })).toContain(APP_ROUTES_PROMPT_LINE)
  })
})

describe('the built-in Dev bot instructions agree with the app map', () => {
  const file = fs.readFileSync(fileURLToPath(new URL('./builtin/operation-kit-dev/agent.md', import.meta.url)), 'utf8')

  it('lists the tool and tells the bot to look every click path up', () => {
    expect(file).toMatch(/^ {2}- app_routes$/m)
    expect(file).toMatch(/call `app_routes`/)
    expect(file).not.toMatch(/Settings (→|>|->) Platform →/)
  })

  it('every row of "Where things live in the app" names a real page by its current menu path', () => {
    const table = file.slice(file.indexOf('## Where things live in the app'), file.indexOf('## Integrations'))
    const rows = [...table.matchAll(/\| \*\*(.+?)\*\* \(([^)]+)\)/g)]
    expect(rows.length).toBeGreaterThanOrEqual(10)
    for (const [, label, urls] of rows) {
      for (const url of [...urls.matchAll(/`([^`]+)`/g)].map(m => m[1])) {
        const [bare, query] = url.split('?')
        const page = APP_MAP.pages.find(p => p.path === bare)
        expect(page, `${url} is not a page in the app map`).toBeDefined()
        const owner = page!.same_as ? APP_MAP.pages.find(p => p.path === page!.same_as)! : page!
        const tab = query ? owner.tabs.find(t => t.url === `?${query}`) : undefined
        if (query) expect(tab, `${url}: no such tab`).toBeDefined()
        const menu = page!.click_path.filter(s => !s.startsWith('Avatar menu'))
        const expected = [...(menu.length ? menu : [page!.title]), ...(tab ? [...tab.trail, tab.label] : [])].join(' → ')
        expect(label, `the table calls ${url} "${label}", the app calls it "${expected}"`).toBe(expected)
      }
    }
  })
})
