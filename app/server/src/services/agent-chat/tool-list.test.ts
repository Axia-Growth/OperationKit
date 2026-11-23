// The server's tool wiring against the shared list (obj 900966).
import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-tool-list-xxxx'
process.env.DB_PATH = path.join(os.tmpdir(), `cc-tool-list-${process.pid}-${Date.now()}.db`)

const shared = await import('../../../../shared/bot-tools.js')
const viaOldPath = await import('./tool-names.js')
const { toolSpecsFor } = await import('./tools.js')
const { cardSandboxToolSpecs } = await import('./card-sandbox-tools.js')
const { cardBrowserToolSpecs } = await import('./card-browser-tools.js')
const { followupToolSpecs } = await import('./followups.js')
const { initDb } = await import('../../db/index.js')
const { KNOWN_AGENT_TOOLS, parseAgentFile } = await import('../agent-file.js')
type Agent = import('./agent-defs.js').ChatAgent

// followupToolSpecs reads settings.bot_followups_enabled from the DB (followupsEnabled()).
beforeAll(() => { initDb() })

const agent = (tools: string[]) => ({ slug: 'probe', name: 'Probe', tools, knowledge_folders: [] }) as unknown as Agent
const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('bot tool list: one source', () => {
  it('the old tool-names path re-exports the shared module', () => {
    expect(viaOldPath.KNOWN_TOOL_NAMES).toBe(shared.KNOWN_TOOL_NAMES)
    expect(viaOldPath.TOOL_CATALOG).toBe(shared.TOOL_CATALOG)
    expect(viaOldPath.EXPLICIT_ONLY_TOOLS).toBe(shared.EXPLICIT_ONLY_TOOLS)
  })

  it("the importer's known tools equal the shared list plus all and *", () => {
    expect(sorted(KNOWN_AGENT_TOOLS)).toEqual(sorted([...shared.KNOWN_TOOL_NAMES, 'all', '*']))
  })

  it('every catalogue name has a tool spec, or is mcp', () => {
    for (const { name } of shared.TOOL_CATALOG) {
      if (name === 'mcp') continue // its specs come from the workspace's connected MCP servers at run time
      const a = agent([name])
      const specs = [...toolSpecsFor(a), ...cardSandboxToolSpecs({ agent: a }), ...cardBrowserToolSpecs({ agent: a }), ...followupToolSpecs({ agent: a } as Parameters<typeof followupToolSpecs>[0])]
      expect(specs.length, `${name} has no tool spec`).toBeGreaterThan(0)
    }
    // …and a name that is not in the list gets none.
    const none = agent(['not_a_tool'])
    expect([...toolSpecsFor(none), ...cardSandboxToolSpecs({ agent: none }), ...cardBrowserToolSpecs({ agent: none }), ...followupToolSpecs({ agent: none } as Parameters<typeof followupToolSpecs>[0])]).toEqual([])
  })
})

describe('agent file importer: tool warnings', () => {
  const file = (tools: string[]) => [
    'name: Probe', 'slug: probe', 'description: A test bot.', 'version: 1.0.0', 'author: Test',
    'tools:', ...tools.map(t => `  - "${t}"`),
    'system_prompt: |', '  You are a test bot.', '',
  ].join('\n')
  const toolIssues = (tools: string[]) => {
    const r = parseAgentFile(file(tools))
    return [...(r.ok ? [] : r.errors), ...r.warnings].filter(i => i.field.startsWith('tools'))
  }

  it('accepts every built-in tool with no warning (secrets and bot_messages included)', () => {
    expect(toolIssues([...shared.KNOWN_TOOL_NAMES])).toEqual([])
    expect(toolIssues(['secrets', 'bot_messages'])).toEqual([])
  })

  it('accepts all and *', () => {
    expect(toolIssues(['all', 'secrets'])).toEqual([])
    expect(toolIssues(['*'])).toEqual([])
  })

  it('still warns on a name that is not built in', () => {
    const issues = toolIssues(['acme_crm'])
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toMatch(/not a built-in tool/)
  })
})
