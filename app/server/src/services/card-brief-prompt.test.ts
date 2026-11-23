/**
 * obj 901496 — the worker prompt shows a card's stop conditions as their own
 * section and tells the worker to stop and raise a blocker when one is met.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Objective } from '@operationkit/shared'

vi.mock('../db/index.js', () => ({
  getDb: () => ({ prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) }),
}))
vi.mock('./context-builder.js', () => ({ buildContext: () => '' }))

import { buildPrompt } from './prompt-builder.js'
import { buildStopConditionsBlock, STOP_CONDITIONS_PROMPT_HEADING } from './card-brief-prompt.js'
import { composeCardBrief } from '../../../shared/card-brief.js'

const card = (over: Partial<Objective>): Objective =>
  ({
    id: 999998, title: 'Add the export button', description: 'Build it.', status: 'working', agent_context: 'cto', workspace: 'operator',
    project: null, category: 'build', parent_id: null, depth: 0, completion_goal: null, acceptance_criteria: null, approved_plan: null,
    ai_review_verdict: null, ai_review_findings: null, workflow_hint: null, type: 'task', effort: 'medium', model: 'default',
    delegate_mode: false, create_pr: false, has_blockers: false, session_count: 0, created_at: '2026-11-19T00:00:00Z', updated_at: '2026-11-19T00:00:00Z',
    ...over,
  }) as Objective

describe('buildStopConditionsBlock', () => {
  it('is empty for a card with no stop conditions', () => {
    expect(buildStopConditionsBlock('Build it.', 'Sam')).toEqual([])
    expect(buildStopConditionsBlock(null, 'Sam')).toEqual([])
  })

  it('numbers each condition and says to stop and raise a blocker', () => {
    const text = buildStopConditionsBlock(composeCardBrief('Build it.', ['it needs a migration', 'the field already exists']), 'Sam').join('\n')
    expect(text).toContain(STOP_CONDITIONS_PROMPT_HEADING)
    expect(text).toContain('1. it needs a migration')
    expect(text).toContain('2. the field already exists')
    expect(text).toMatch(/STOP at that point/)
    expect(text).toMatch(/Raise it as a blocker/)
    expect(text).toContain('BLOCKED: stop condition met')
    expect(text).toContain('Asking Sam for a decision')
  })
})

describe('buildPrompt with a card brief', () => {
  it('shows done_when as the completion goal and the stop conditions as their own section after it, before the owner block', () => {
    const prompt = buildPrompt(card({
      description: composeCardBrief('Build it.', ['it needs a database migration']),
      completion_goal: 'One open PR with CI green.',
    }))
    const goal = prompt.indexOf('## Completion Goal (HARD REQUIREMENT)')
    const stop = prompt.indexOf(STOP_CONDITIONS_PROMPT_HEADING)
    const owner = prompt.indexOf('## Owner instructions outrank card text')
    expect(prompt).toContain('One open PR with CI green.')
    expect(goal).toBeGreaterThan(0)
    expect(stop).toBeGreaterThan(goal)
    expect(owner).toBeGreaterThan(stop)
    expect(prompt.slice(stop)).toContain('1. it needs a database migration')
  })

  it('adds no section to a card filed without stop conditions', () => {
    expect(buildPrompt(card({}))).not.toContain(STOP_CONDITIONS_PROMPT_HEADING)
  })
})
