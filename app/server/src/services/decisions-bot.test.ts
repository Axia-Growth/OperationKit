import { describe, expect, it } from 'vitest'
import { BOT_NEEDS_YOU_KIND, needsYouReasons, type BotNeedsYouMeta } from '@operationkit/shared'
import { effectiveTools, toolSpecsFor } from './agent-chat/tools.js'
import { attentionText } from './agent-chat/bot-attention.js'
import { buildDecisionRequestBlock, DECISION_BRIEFING_RULES, DECISION_EXAMPLE } from './decision-prompt.js'
import type { ChatAgent } from './agent-chat/agent-defs.js'

// obj 901059 — the bot side of decision briefings.

const agent = (tools: string[]) => ({ slug: 'outreach', name: 'Outreach Bot', tools } as unknown as ChatAgent)

describe('raise_decision tool schema', () => {
  it('a bot that can file cards can raise a decision; the schema requires every briefing field', () => {
    expect(effectiveTools(agent(['create_objective']))).toContain('raise_decision')
    const spec = toolSpecsFor(agent(['create_objective'])).find(s => s.function.name === 'raise_decision')
    expect(spec).toBeTruthy()
    const params = spec!.function.parameters as { required: string[]; properties: Record<string, any> }
    expect(params.required).toEqual(['card_id', 'context', 'question', 'options', 'recommended', 'recommended_why'])
    expect(params.properties.options).toMatchObject({ type: 'array', minItems: 2, maxItems: 4 })
    expect(params.properties.options.items.required).toEqual(['label', 'pros', 'cons', 'next'])
  })

  it('a read-only bot does not get it', () => {
    expect(effectiveTools(agent(['list_objectives']))).not.toContain('raise_decision')
  })
})

describe('needs-you signal', () => {
  const base = { spent_usd: 0, ceiling_usd: null }
  it('an open decision needs the person even on a finished card (the case Operator could not see)', () => {
    expect(needsYouReasons({ ...base, status: 'done', open_decision: true })).toEqual(['decision'])
    expect(needsYouReasons({ ...base, status: 'done' })).toEqual([])
    expect(needsYouReasons({ ...base, status: 'working', session_id: 'x', open_decision: true })).toEqual(['decision'])
  })

  it('the chat post names WHAT is being decided, or says plainly that no briefing was given', () => {
    const meta: BotNeedsYouMeta = { kind: BOT_NEEDS_YOU_KIND, objective_id: 12, reason: 'decision', title: 'Outreach batch' }
    expect(attentionText('Outreach Bot', { ...meta, decision_id: 3, question: 'Send the batch today?' }))
      .toBe('Outreach Bot needs a decision from you on card #12 "Outreach batch": Send the batch today?')
    expect(attentionText('Outreach Bot', meta)).toMatch(/did not give a briefing, so ask it what it needs/)
  })
})

describe('worker prompt', () => {
  it('names every required field and the size budget', () => {
    const block = buildDecisionRequestBlock({ objectiveId: 5, workspace: null, owner: 'Operator', isJob: false }).join('\n')
    for (const f of ['context', 'question', 'options', 'pros', 'cons', 'next', 'recommended', 'recommended_why']) expect(block).toContain(f)
    expect(block).toMatch(/under about 200 words/)
    expect(block).toMatch(/fewer than two options is refused/)
    expect(DECISION_BRIEFING_RULES.length).toBeGreaterThan(3)
    expect(() => JSON.parse(DECISION_EXAMPLE)).not.toThrow()
  })
})
