// @vitest-environment jsdom
/**
 * obj 901202 — on a fresh install the skill graph has no generator. The server
 * now answers 200 with an empty graph, `status: 'not_set_up'` and a reason; the
 * tab must show that as an empty state, not an error and not an empty canvas.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { SkillGraphTab } from './SkillGraph'

async function flush() {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
    await new Promise(r => setTimeout(r, 0))
    flushSync(() => {})
  }
}

const EMPTY = {
  source: 'frontmatter-layer-graph',
  generated_at: '2026-11-17T00:00:00.000Z',
  counts: { agents: 0, skills: 0, skills_top_level: 0, subskills: 0, tools: 0, agent_skill_edges: 0, skill_tool_edges: 0 },
  agents: {}, skills: {}, tools: {}, orphans: { tools: [], skills: [] },
  status: 'not_set_up',
  reason: 'The skill graph is not set up on this install yet.',
}

let root: Root | null = null
let host: HTMLElement | null = null
afterEach(() => {
  root?.unmount(); host?.remove(); root = null; host = null
  vi.unstubAllGlobals()
})

describe('SkillGraphTab on a fresh install', () => {
  it('shows a "not set up" empty state with the server reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EMPTY), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    flushSync(() => root!.render(<SkillGraphTab />))
    await flush()
    const text = host.textContent || ''
    expect(text).toContain('Skill graph not set up')
    expect(text).toContain('not set up on this install yet')
    expect(text).not.toContain('unavailable')
  })
})
