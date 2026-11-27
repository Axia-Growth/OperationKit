/**
 * obj 901765 — skills are a harness internal, not a required surface. Every
 * worker prompt says where procedure comes from (card → repo docs → knowledge
 * base), so an install with ZERO skill files still gets work done, and an agent
 * that already declares skills keeps them (the block never forbids a named one).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-prompt-procedure-test-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

import { initDb, getDb } from '../db/index.js'
import { seedLegacyWorkspaces } from '../__fixtures__/legacy-workspaces.js'
import { buildPrompt } from './prompt-builder.js'
import { buildProcedureSourcesBlock, PROCEDURE_SOURCES_HEADING } from '../lib/procedure-sources.js'
import type { Objective } from '@operationkit/shared'

beforeAll(async () => {
  initDb()
  await seedLegacyWorkspaces(getDb())
})

function objective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: 999998, title: 'Write the weekly client report', description: 'Summarise this week for the client.',
    status: 'working', agent_context: 'general', workspace: 'acme', project: null, category: 'build',
    parent_id: null, depth: 0, assigned_user_id: null, routine_id: null, created_by: null, session_id: null,
    transcript_path: null, last_session_summary: null, session_count: 0, total_cost_usd: 0, total_tokens: 0,
    has_blockers: false, delegate_mode: false, create_pr: false, branch_name: null, pr_url: null, pr_number: null,
    completion_goal: null, workflow_hint: null, effort: 'medium', model: 'default', type: 'task',
    approved_plan: null, plan_approved_at: null, planning_session_id: null, ai_review_verdict: null,
    ai_review_findings: null, ai_review_session_id: null, skip_ai_review: false, acceptance_criteria: null,
    ai_review_iteration: 0, test_cred_slug: null, created_at: '2026-11-23T00:00:00Z', updated_at: '2026-11-23T00:00:00Z',
    ...overrides,
  } as Objective
}

describe('procedure sources block (obj 901765)', () => {
  const text = buildProcedureSourcesBlock().join('\n')

  it('names the three sources in order: card, living repo docs, knowledge base', () => {
    const card = text.indexOf('1. This card')
    const docs = text.indexOf('2. The living docs of the repo')
    const kb = text.indexOf('3. The workspace knowledge base')
    expect(card).toBeGreaterThan(-1)
    expect(docs).toBeGreaterThan(card)
    expect(kb).toBeGreaterThan(docs)
  })

  it('says no skill file is needed, keeps SKILL.md as an escape hatch, and does not forbid a named skill', () => {
    expect(text).toMatch(/You do not need a skill file/)
    expect(text).toMatch(/optional escape hatch/)
    // An agent that already declares skills keeps working: a named skill is still usable.
    expect(text).toMatch(/Use one only when this card, your agent file or a skill assignment names it/)
    expect(text).not.toMatch(/never use (a )?skill/i)
  })

  it('does not ask the worker to write skill files or curate a library', () => {
    expect(text).toMatch(/do not write a new skill file/)
    expect(text).not.toMatch(/okit new skill/)
  })

  it('is in every worker prompt exactly once, even with no skills anywhere', () => {
    for (const o of [objective(), objective({ project: 'operationkit', create_pr: true })]) {
      const prompt = buildPrompt(o)
      expect(prompt.split(PROCEDURE_SOURCES_HEADING).length - 1).toBe(1)
    }
  })
})
