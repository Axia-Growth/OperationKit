/**
 * obj 901764 — a standing outcome rule ("before-and-after screenshots on every
 * PR") is a workspace preference, not a skill file. Every card in the workspace
 * gets it: the worker prompt states it as part of the definition of done and the
 * independent reviewer grades it. A rule already frozen into the card's
 * acceptance criteria (an intake card) is not repeated. No rules = the prompts
 * are exactly what they were before.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Objective } from '@operationkit/shared'

process.env.JWT_SECRET = 'test-secret-outcome-intake-prompt-x'
const TMP_DB = path.join(os.tmpdir(), `cc-outcome-intake-prompt-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('./context-builder.js', () => ({ buildContext: () => '' }))

const { initDb, getDb } = await import('../db/index.js')
const { buildPrompt } = await import('./prompt-builder.js')
const { buildReviewerPrompt } = await import('./session-manager.js')
const { addRule, removeRule, standingRulesPromptLines } = await import('./outcome-intake.js')

type Db = Parameters<typeof addRule>[0]
const db = () => getDb() as unknown as Db

const card = (over: Partial<Objective> = {}): Objective =>
  ({
    id: 999997, title: 'Add the export button', description: 'Build it.', status: 'working', agent_context: 'general', workspace: 'growth',
    project: null, category: 'build', parent_id: null, depth: 0, completion_goal: 'One open PR with CI green.', acceptance_criteria: null, approved_plan: null,
    ai_review_verdict: null, ai_review_findings: null, workflow_hint: null, type: 'task', effort: 'medium', model: 'default',
    delegate_mode: false, create_pr: false, has_blockers: false, session_count: 0, created_at: '2026-11-23T00:00:00Z', updated_at: '2026-11-23T00:00:00Z',
    ...over,
  }) as Objective

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

describe('standing outcome rules reach every card in the workspace', () => {
  it('adds nothing while the workspace has no rule', () => {
    expect(standingRulesPromptLines(db(), card(), 'worker')).toEqual([])
    expect(standingRulesPromptLines(db(), card(), 'reviewer')).toEqual([])
    expect(buildPrompt(card())).not.toContain('Standing outcome rules')
    expect(buildReviewerPrompt(card(), [], null)).not.toContain('Standing outcome rules')
  })

  it('states a rule to the worker after the acceptance criteria and to the reviewer as something to grade', () => {
    const r = addRule(db(), { workspace: 'growth', text: 'Before-and-after screenshots in the pull request', appliesTo: 'pr', userId: 1 })
    expect(r.ok).toBe(true)
    const worker = buildPrompt(card({ acceptance_criteria: [{ id: 'export', criterion: 'The export button downloads a CSV', type: 'functional', method: 'browser' }] }))
    const rules = worker.indexOf('## Standing outcome rules for this workspace')
    expect(rules).toBeGreaterThan(worker.indexOf('## The bar you are graded against'))
    expect(rules).toBeLessThan(worker.indexOf('## Owner instructions outrank card text'))
    expect(worker.slice(rules)).toContain('- Every pull request: Before-and-after screenshots in the pull request')

    const reviewer = buildReviewerPrompt(card(), [], null)
    expect(reviewer).toContain('## Standing outcome rules (set for every card in this workspace)')
    expect(reviewer).toContain('A rule that applies and is not met is a FAIL')
    expect(reviewer).toContain('- Every pull request: Before-and-after screenshots in the pull request')

    // Another workspace never sees it.
    expect(standingRulesPromptLines(db(), card({ workspace: 'other' }), 'worker')).toEqual([])
  })

  it('does not repeat a rule the card already carries as a criterion, and drops a removed rule', () => {
    const rule = addRule(db(), { workspace: 'growth', text: 'Before-and-after screenshots in the pull request', userId: 1 })
    if (!rule.ok) throw new Error('rule not saved')
    const frozen = card({ acceptance_criteria: JSON.stringify([{ id: `rule-${rule.rule.id}`, criterion: 'Standing rule…', type: 'functional', method: 'doc' }]) as never })
    expect(standingRulesPromptLines(db(), frozen, 'worker')).toEqual([])
    removeRule(db(), { id: rule.rule.id, userId: 1 })
    expect(buildPrompt(card())).not.toContain('Standing outcome rules')
  })
})
