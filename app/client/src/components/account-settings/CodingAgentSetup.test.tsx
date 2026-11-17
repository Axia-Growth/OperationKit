// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { CodingAgentSetup, buildSetupPrompt, CODING_AGENTS, mcpServerName, FALLBACK_SERVER_NAME } from './CodingAgentSetup'

const ORIGIN = 'https://cc.example.com'

describe('buildSetupPrompt (obj 900681)', () => {
  it('Claude Code: one claude mcp add over Streamable HTTP, key from the env', () => {
    const p = buildSetupPrompt('claude-code', ORIGIN, 'Acme Ops')
    expect(p).toContain(`claude mcp add --transport http --scope user acme-ops ${ORIGIN}/api/mcp`)
    expect(p).toContain('Authorization: Bearer $CC_AGENT_KEY')
  })

  it('Cursor and Codex get their own config formats', () => {
    expect(buildSetupPrompt('cursor', ORIGIN, 'Acme Ops')).toContain('"Authorization": "Bearer ${env:CC_AGENT_KEY}"')
    const codex = buildSetupPrompt('codex', ORIGIN, 'Acme Ops')
    expect(codex).toContain('[mcp_servers.acme-ops]')
    expect(codex).toContain('bearer_token_env_var = "CC_AGENT_KEY"')
    expect(buildSetupPrompt('other', ORIGIN, 'Acme Ops')).toContain('mcp-remote')
  })

  it('every variant verifies with whoami, points at the key page, and never carries a key value', () => {
    for (const { key } of CODING_AGENTS) {
      const p = buildSetupPrompt(key, ORIGIN, 'Acme Ops')
      expect(p).toContain('my Acme Ops (')
      expect(p).toContain('"whoami"')
      expect(p).toContain(`${ORIGIN}/settings/api-mcp`)
      expect(p).toContain('Never ask me to paste the key into chat')
      expect(p).not.toMatch(/cc_live_[A-Za-z0-9]/)
    }
  })
})

describe('MCP server name comes from the brand (obj 901205)', () => {
  it('slugs the brand name', () => {
    expect(mcpServerName('Acme Ops')).toBe('acme-ops')
    expect(mcpServerName('  Café & Co.  ')).toBe('cafe-co')
    expect(mcpServerName('Operation Kit')).toBe('operation-kit')
    expect(mcpServerName('a'.repeat(39) + ' b')).toBe('a'.repeat(39))
  })

  it('falls back to a neutral name when the brand has no usable characters', () => {
    for (const b of ['', '   ', '!!!', '日本', null, undefined]) expect(mcpServerName(b)).toBe(FALLBACK_SERVER_NAME)
    expect(FALLBACK_SERVER_NAME).toBe('board')
  })

  it('no variant names the server after the vendor product, and every variant uses the brand slug', () => {
    for (const { key } of CODING_AGENTS) {
      const p = buildSetupPrompt(key, ORIGIN, 'Acme Ops')
      expect(p).not.toMatch(/command[ -]center/i)
      expect(p).toContain('acme-ops')
    }
    expect(buildSetupPrompt('cursor', ORIGIN, 'Acme Ops')).toContain('"acme-ops": {')
    expect(buildSetupPrompt('other', ORIGIN, 'Acme Ops')).toContain('- name: acme-ops')
    expect(buildSetupPrompt('claude-code', ORIGIN, 'Acme Ops')).toContain('"whoami" tool on the acme-ops server')
  })
})

describe('<CodingAgentSetup />', () => {
  let root: Root
  let container: HTMLDivElement
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('switches the prompt when another agent is picked', () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    flushSync(() => root.render(<CodingAgentSetup />))
    const prompt = () => container.querySelector('[data-testid="coding-agent-prompt"]')?.textContent ?? ''
    expect(prompt()).toContain('claude mcp add')
    const cursorOption = Array.from(container.querySelectorAll('[role="radio"]')).find(t => t.textContent === 'Cursor') as HTMLElement
    flushSync(() => cursorOption.click())
    expect(prompt()).toContain('~/.cursor/mcp.json')
    expect(prompt()).not.toContain('claude mcp add')
  })
})
