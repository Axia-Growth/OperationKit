import { describe, it, expect } from 'vitest'
import { TABS, resolveAgentsTab } from './AgentsHub'

describe('one Agents page — tab resolution (obj 900495)', () => {
  it('defaults to the registry', () => {
    expect(resolveAgentsTab(new URLSearchParams(''))).toBe('registry')
  })
  it('honours ?tab=', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=templates'))).toBe('templates')
    expect(resolveAgentsTab(new URLSearchParams('tab=board'))).toBe('board')
  })
  it('old /agents?project=… links keep landing on the board-layer view', () => {
    expect(resolveAgentsTab(new URLSearchParams('project=12'))).toBe('board')
  })
  it('the old inner registry tabs are top-level tabs now (obj 900807)', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=assignments'))).toBe('assignments')
    expect(resolveAgentsTab(new URLSearchParams('tab=graph'))).toBe('graph')
  })
  it('ignores an unknown tab', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=nope'))).toBe('registry')
  })
})

describe('skills are an advanced escape hatch, not the primary surface (obj 901765)', () => {
  it('the roster tab is "Bots" and comes first; skills are the LAST tab, labelled advanced', () => {
    expect(TABS[0]).toEqual({ key: 'registry', label: 'Bots' })
    expect(TABS[TABS.length - 1]).toEqual({ key: 'graph', label: 'Skills (advanced)' })
    // No other tab label sells skills.
    expect(TABS.slice(0, -1).some(t => /skill/i.test(t.label))).toBe(false)
  })
  it('the old skill-graph link still opens it — existing installs keep their skills', () => {
    expect(resolveAgentsTab(new URLSearchParams('tab=graph'))).toBe('graph')
  })
})
