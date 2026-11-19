// One shared list of bot tools (obj 900966). These checks keep the list, the
// catalogue, the plain-language lines and the docs from drifting apart again.
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  AGENT_FILE_TOOL_NAMES, ALL_TOOLS_GRANT, ALL_TOOLS_TOKENS, EXPLICIT_ONLY_TOOLS,
  KNOWN_TOOL_NAMES, TOOL_CATALOG, TOOL_REACH, toolReachFor,
} from './bot-tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..')
const sorted = (xs: Iterable<string>) => [...xs].sort()

describe('shared bot tool list', () => {
  it('the catalogue has exactly one row for every known tool', () => {
    expect(sorted(TOOL_CATALOG.map(t => t.name))).toEqual(sorted(KNOWN_TOOL_NAMES))
  })

  it('the catalogue marks exactly the explicit-only tools, and "all" leaves them out', () => {
    expect(sorted(TOOL_CATALOG.filter(t => t.explicit_only).map(t => t.name))).toEqual(sorted(EXPLICIT_ONLY_TOOLS))
    expect(EXPLICIT_ONLY_TOOLS.has('secrets')).toBe(true)
    expect(ALL_TOOLS_GRANT.has('secrets')).toBe(false)
    expect(sorted([...ALL_TOOLS_GRANT, ...EXPLICIT_ONLY_TOOLS])).toEqual(sorted(KNOWN_TOOL_NAMES))
  })

  it('agent files may name every known tool, plus all and *', () => {
    expect(sorted(AGENT_FILE_TOOL_NAMES)).toEqual(sorted([...KNOWN_TOOL_NAMES, 'all', '*']))
    expect(sorted(ALL_TOOLS_TOKENS)).toEqual(['*', 'all'])
  })

  it('every known tool has a plain-language line, and no line names an unknown tool', () => {
    const covered = new Set(TOOL_REACH.flatMap(r => [...r.tools]))
    expect(sorted(covered)).toEqual(sorted(KNOWN_TOOL_NAMES))
    for (const name of KNOWN_TOOL_NAMES) {
      const [line] = toolReachFor([name])
      expect(line.reach('notes').trim(), name).not.toBe('')
      expect(line.about('notes').trim(), name).not.toBe('')
    }
    expect(toolReachFor([])).toEqual([])
  })
})

describe('docs/agents/agent-file-format.md tool table', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'agents', 'agent-file-format.md'), 'utf8')
  const start = doc.indexOf('### Tool names')
  const end = doc.indexOf('\n### ', start + 1)
  const rows = doc.slice(start, end === -1 ? undefined : end).split('\n').filter(l => l.startsWith('| `'))
  // First column of each row: the tool names that row documents.
  const documented = new Set(rows.flatMap(r => [...r.split('|')[1].matchAll(/`([^`]+)`/g)].map(m => m[1])))

  it('lists every tool name, plus all and *, and nothing else', () => {
    expect(sorted(documented)).toEqual(sorted(AGENT_FILE_TOOL_NAMES))
  })

  it('says that all does not include each explicit-only tool', () => {
    const allRow = rows.find(r => r.startsWith('| `all`'))!
    expect(allRow).toMatch(/except/i)
    for (const name of EXPLICIT_ONLY_TOOLS) {
      expect(allRow, name).toContain(`\`${name}\``)
      expect(rows.find(r => r.split('|')[1].includes(`\`${name}\``)), name).toMatch(/Not included in `all`/)
    }
  })
})

describe('built-in Operation Kit Dev file', () => {
  const file = fs.readFileSync(path.join(REPO, 'app', 'server', 'src', 'services', 'agent-chat', 'builtin', 'operation-kit-dev', 'agent.md'), 'utf8')
  const line = file.split('\n').find(l => l.includes('`tools` come only from:'))!

  it('names every tool it may put in a bot file, and that all leaves out the explicit-only ones', () => {
    const part = line.slice(line.indexOf('`tools` come only from:'))
    for (const name of KNOWN_TOOL_NAMES) expect(part, name).toContain(`\`${name}\``)
    expect(part).toContain('`all`')
    expect(part).toMatch(/`all` does not include `secrets`/)
  })
})
