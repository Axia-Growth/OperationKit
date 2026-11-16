import { describe, expect, it } from 'vitest'
import {
  DENY_CHOICE,
  briefingWordCount,
  chosenLabel,
  decisionFollowUpText,
  decisionOutcomeText,
  validateDecisionBriefing,
} from './decision-briefing'

// obj 901059 — a decision request must say WHAT is being decided.

const good = {
  context: 'The weekly outreach batch is drafted and checked against the ICP. Sending is the last step before replies land.',
  question: 'Should we send the 40-lead batch today?',
  options: [
    { label: 'Send today', pros: ['Replies before the weekend'], cons: ['No second review'], next: 'I send it and report bounces in an hour.' },
    { label: 'Hold a day', pros: ['Time to test subject lines'], cons: ['Replies slip to Monday'], next: 'I draft 2 subject lines for you to pick.' },
  ],
  recommended: 'A',
  recommended_why: 'The lines match last month’s best performer.',
}

describe('validateDecisionBriefing', () => {
  it('accepts a complete briefing and assigns option keys A, B', () => {
    const v = validateDecisionBriefing(good)
    expect(v.ok).toBe(true)
    if (!v.ok) return
    expect(v.briefing.options.map(o => o.key)).toEqual(['A', 'B'])
    expect(v.briefing.recommended).toBe('A')
    expect(v.flags).toEqual([])
    expect(v.words).toBeLessThan(200)
  })

  it('refuses a request with no question', () => {
    const v = validateDecisionBriefing({ ...good, question: '  ' })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.errors.join(' ')).toMatch(/question is required/)
  })

  it('refuses a request with no options, or only one', () => {
    for (const options of [undefined, [], [good.options[0]]]) {
      const v = validateDecisionBriefing({ ...good, options })
      expect(v.ok).toBe(false)
      if (v.ok) continue
      expect(v.errors.join(' ')).toMatch(/options is required/)
    }
  })

  it('refuses more than four options', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...good.options[0], label: `Option ${i}` }))
    const v = validateDecisionBriefing({ ...good, options: many })
    expect(v.ok).toBe(false)
  })

  it('requires pros, cons and next on every option, and a recommendation that names an option', () => {
    const v = validateDecisionBriefing({
      ...good,
      options: [{ label: 'Send', pros: [], cons: ['x'], next: '' }, good.options[1]],
      recommended: 'Z',
      recommended_why: '',
    })
    expect(v.ok).toBe(false)
    if (v.ok) return
    const all = v.errors.join(' | ')
    expect(all).toMatch(/at least one pro/)
    expect(all).toMatch(/next is required/)
    expect(all).toMatch(/recommended must name one of the options/)
    expect(all).toMatch(/recommended_why is required/)
  })

  it('accepts a recommendation by label', () => {
    const v = validateDecisionBriefing({ ...good, recommended: 'hold a day' })
    expect(v.ok && v.briefing.recommended).toBe('B')
  })

  it('flags (does not refuse) a long briefing', () => {
    const long = 'word '.repeat(240).trim()
    const v = validateDecisionBriefing({ ...good, context: long.slice(0, 690) })
    expect(v.ok).toBe(true)
    if (!v.ok) return
    const bigger = validateDecisionBriefing({
      ...good,
      context: long.slice(0, 690),
      options: good.options.map(o => ({ ...o, pros: [long.slice(0, 190), long.slice(0, 190)], cons: [long.slice(0, 190)] })),
    })
    expect(bigger.ok && bigger.flags).toEqual(['long'])
    if (bigger.ok) expect(briefingWordCount(bigger.briefing)).toBeGreaterThan(220)
  })
})

describe('outcome text — always says what was chosen and what happens next', () => {
  const v = validateDecisionBriefing(good)
  if (!v.ok) throw new Error('fixture')
  const briefing = v.briefing

  it('sent: names the option and the next step', () => {
    const t = decisionOutcomeText({ objectiveId: 7, briefing, chosen: 'B', outcome: 'sent' })
    expect(t).toBe('You chose B: Hold a day. Card #7 restarted with your choice. Next: I draft 2 subject lines for you to pick.')
  })

  it('card_done: says nothing was sent and offers Reopen and apply', () => {
    const t = decisionOutcomeText({ objectiveId: 7, briefing, chosen: 'A', outcome: 'card_done' })
    expect(t).toMatch(/^You chose A: Send today\. Card #7 is already done, so nothing was sent yet\. Press Reopen and apply/)
  })

  it('reopened, queued, failed and a deny read plainly', () => {
    expect(decisionOutcomeText({ objectiveId: 7, briefing, chosen: 'A', outcome: 'reopened' })).toMatch(/was done, so it was reopened and your choice sent/)
    expect(decisionOutcomeText({ objectiveId: 7, briefing, chosen: 'A', outcome: 'queued' })).toMatch(/mid-run, so your choice is queued/)
    expect(decisionOutcomeText({ objectiveId: 7, briefing, chosen: 'A', outcome: 'failed', error: 'over ceiling' })).toMatch(/could not be restarted: over ceiling/)
    expect(decisionOutcomeText({ objectiveId: 7, briefing, chosen: DENY_CHOICE, outcome: 'sent' })).toMatch(/^You said no to all the options\./)
  })

  it('follow-up text tells the worker the question, the answer and the next step', () => {
    const t = decisionFollowUpText({ decisionId: 3, briefing, chosen: 'A', note: 'go' })
    expect(t).toContain('Decision #3: Should we send the 40-lead batch today?')
    expect(t).toContain('Answer: option A — Send today.')
    expect(t).toContain('Do this next: I send it and report bounces in an hour.')
    expect(t).toContain('Note from the owner: go')
    expect(decisionFollowUpText({ decisionId: 3, briefing, chosen: DENY_CHOICE })).toMatch(/NO to all the options/)
  })

  it('chosenLabel', () => {
    expect(chosenLabel(briefing, 'A')).toBe('Chose A: Send today')
    expect(chosenLabel(briefing, DENY_CHOICE)).toBe('Denied')
    expect(chosenLabel(briefing, null)).toBeNull()
  })
})
