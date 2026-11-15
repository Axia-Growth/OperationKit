import { describe, it, expect } from 'vitest'
import { countForWorkspace, type WorkspaceTabCountsInput } from './workspaceTabCounts'

// obj 900868 — "All 9" over an empty Workflows list: the count must be the rows the view shows.
const base: Omit<WorkspaceTabCountsInput, 'view' | 'kind'> = {
  jobs: [{ workspace: 'a' }, { workspace: 'b' }, { workspace: null }],
  flowRuns: Array.from({ length: 9 }, (_, i) => ({ workspace: i < 6 ? 'a' : 'b' })),
  flows: [],
}

describe('countForWorkspace', () => {
  it('Workflows view counts workflow definitions, so an empty list is 0 whatever the runs', () => {
    const input = { ...base, view: 'workflows' as const, kind: 'all' as const }
    expect(countForWorkspace(input, null)).toBe(0)
    expect(countForWorkspace(input, 'a')).toBe(0)
    const withFlows = { ...input, flows: [{ workspace: 'a' }, { workspace: 'a' }, { workspace: 'b' }] }
    expect(countForWorkspace(withFlows, null)).toBe(3)
    expect(countForWorkspace(withFlows, 'a')).toBe(2)
  })

  it('Workflows view ignores the run-kind filter', () => {
    const input = { ...base, flows: [{ workspace: 'a' }], view: 'workflows' as const, kind: 'agent' as const }
    expect(countForWorkspace(input, null)).toBe(1)
  })

  it('Runs view: all = jobs + workflow runs; agent = jobs only; flow = workflow runs only', () => {
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'all' }, null)).toBe(12)
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'all' }, 'a')).toBe(7)
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'agent' }, null)).toBe(3)
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'agent' }, 'b')).toBe(1)
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'flow' }, null)).toBe(9)
    expect(countForWorkspace({ ...base, view: 'runs', kind: 'flow' }, 'b')).toBe(3)
  })
})
