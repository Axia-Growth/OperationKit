/**
 * obj 901525 — the reviewer prompt must tell the reviewer to read a
 * `workspaces/<ws>/...` deliverable through the docs route, and to treat a
 * 403 / failed call as "could not check" (BLOCKED), never as "the file does
 * not exist" (FAIL). Before this, `buildReviewerPrompt` carried NO knowledge-
 * base instruction at all — only the worker prompt did (`buildKbAccessBlock`,
 * called from `prompt-builder.ts`) — so the reviewer had no way to know the
 * route exists and read a vault miss as a real deliverable gap (#901494,
 * #901499, #901519).
 */
import { describe, it, expect } from 'vitest'
import { buildReviewerPrompt } from './session-manager.js'
import { buildReviewerKbAccessBlock } from './kb-access-prompt.js'
import type { Objective } from '@operationkit/shared'

process.env.CC_PREVIEW_DOMAIN = process.env.CC_PREVIEW_DOMAIN || 'preview.example.test'
process.env.HARNESS_REPO = process.env.HARNESS_REPO || 'your-org/operationkit'

function makeObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 901525,
    workspace: 'operationkit',
    type: 'feature',
    title: 'Test objective',
    description: 'review a vault deliverable',
    completion_goal: 'the doc exists and says the right thing',
    approved_plan: 'Plan: write the doc.',
    ai_review_iteration: 2,
    acceptance_criteria: '[{"id":"vault-runbook","criterion":"the runbook exists in the vault","type":"functional","method":"doc"}]',
    ...overrides,
  } as unknown as Objective
}

describe('buildReviewerKbAccessBlock', () => {
  const lines = buildReviewerKbAccessBlock({ id: 901525, workspace: 'operationkit' })
  const block = lines.join('\n')

  it('points the reviewer at the docs route for its own workspace, authenticated with its session token', () => {
    expect(block).toContain('/api/docs/file')
    expect(block).toContain('/api/docs/search')
    expect(block).toContain('X-CC-Session-Token')
    expect(block).toContain('workspaces/operationkit/')
  })

  it('says a 404 is a genuine miss but a 403 / failed call is NOT evidence the file is missing', () => {
    expect(block).toMatch(/404.*genuinely does not exist/is)
    expect(block).toMatch(/403.*NOT evidence the file is missing/is)
    expect(block).toMatch(/\[BLOCKED\]/)
    expect(block).toMatch(/never `\[FAIL\]` and never "the deliverable does not exist"/)
  })

  it('tells the reviewer an access-only block must set the OVERALL verdict to blocked, not fail', () => {
    expect(block).toMatch(/OVERALL.*blocked.*not.*fail/is)
    expect(block).toMatch(/burns a review iteration/i)
  })

  it('treats a 401 (its own stale token) the same as a 403', () => {
    expect(block).toMatch(/401.*BLOCKED/is)
  })
})

describe('buildReviewerPrompt includes the knowledge-base access block', () => {
  const prompt = buildReviewerPrompt(makeObjective(), ['workspaces/operationkit/runbooks/rollback.md'], null)

  it('carries the docs-route instruction', () => {
    expect(prompt).toContain('Knowledge-base deliverables')
    expect(prompt).toContain('/api/docs/file')
  })

  it('scopes the example path to THIS objective\'s workspace', () => {
    expect(prompt).toContain('workspaces/operationkit/')
  })

  it('is present at every iteration, not just the first pass', () => {
    const laterIteration = buildReviewerPrompt(makeObjective({ ai_review_iteration: 3 }), [], null)
    expect(laterIteration).toContain('Knowledge-base deliverables')
  })
})
