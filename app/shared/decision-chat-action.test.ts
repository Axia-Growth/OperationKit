import { describe, expect, it } from 'vitest'
import { chatActionLine, chatActionWordingErrors, nextSaysTypeInChat, optionChatActions } from './decision-chat-action.js'
import { decisionOutcomeText, type DecisionBriefing } from './decision-briefing.js'

// obj 901453 — which decision options need a chat-only operator tool.

describe('optionChatActions', () => {
  it('finds the #901383 deploy option by its label and its promise', () => {
    expect(optionChatActions({ label: 'Deploy the four now', next: 'I run update.sh and report health.' })).toEqual(['deploy'])
    expect(optionChatActions({ label: 'Now', next: 'I deploy the four and report health in 5 minutes.' })).toEqual(['deploy'])
    expect(optionChatActions({ label: 'Now', next: "Dev will then redeploy the server." })).toEqual(['deploy'])
    expect(optionChatActions({ label: 'Go', next: 'I run dev_deploy.' })).toEqual(['deploy'])
  })

  it('finds merges, and keeps merge before deploy', () => {
    expect(optionChatActions({ label: 'Yes, merge #812', next: 'Done in a minute.' })).toEqual(['merge'])
    expect(optionChatActions({ label: 'Ship it', next: "I'll squash-merge PR 812 once CI is green." })).toEqual(['merge'])
    expect(optionChatActions({ label: 'Merge and deploy', next: 'I merge, then I deploy.' })).toEqual(['merge', 'deploy'])
  })

  it('an option that waits, holds or says nothing is deployed is not an action', () => {
    expect(optionChatActions({ label: 'Hold the deploy', next: 'I will not deploy; nothing is deployed until Monday.' })).toEqual([])
    expect(optionChatActions({ label: 'Wait', next: 'I check the merged PRs again tomorrow.' })).toEqual([])
    expect(optionChatActions({ label: 'Send today', next: 'I send the batch.' })).toEqual([])
    expect(optionChatActions(null)).toEqual([])
  })
})

describe('raise-time wording rule', () => {
  it('refuses an option that promises the click will deploy, with the fix', () => {
    const errs = chatActionWordingErrors([
      { key: 'A', label: 'Deploy the four now', next: 'I deploy the four and report health.' },
      { key: 'B', label: 'Wait for Monday', next: 'I hold until Monday.' },
    ])
    expect(errs).toHaveLength(1)
    expect(errs[0]).toMatch(/option A .* promises a deploy, but answering a decision cannot run one/)
    expect(errs[0]).toMatch(/You type deploy in this chat and I run it/)
  })

  it('accepts the same option once its next says the person types it in the chat', () => {
    expect(nextSaysTypeInChat('You type deploy in this chat and I run it.')).toBe(true)
    expect(nextSaysTypeInChat('Type merge here and I merge PR 812.')).toBe(true)
    expect(nextSaysTypeInChat('I deploy the four.')).toBe(false)
    expect(chatActionWordingErrors([
      { label: 'Deploy the four now', next: 'You type deploy in this chat and I run it.' },
      { label: 'Wait', next: 'I hold until Monday.' },
    ])).toEqual([])
  })
})

describe('what the person reads', () => {
  const briefing: DecisionBriefing = {
    context: 'Four PRs are merged.',
    question: 'When should Dev deploy?',
    options: [
      { key: 'A', label: 'Deploy the four now', pros: [], cons: [], next: 'You type deploy in this chat and I run it.' },
      { key: 'B', label: 'Wait', pros: [], cons: [], next: 'I hold.' },
    ],
    recommended: 'A',
    recommended_why: 'Green.',
  }
  it('the chat line says to type the word here', () => {
    const line = chatActionLine({ action: 'deploy', optionKey: 'A', optionLabel: 'Deploy the four now', objectiveId: 901383, decisionId: 44 })
    expect(line).toMatch(/^You chose Deploy \(A: Deploy the four now\) on decision #44, card #901383\. Type deploy here to run it\./)
    expect(line).toMatch(/Nothing has run yet/)
  })
  it('the outcome line says where the answer went and that nothing ran', () => {
    const t = decisionOutcomeText({ objectiveId: 901383, briefing, chosen: 'A', outcome: 'to_chat', bot: 'Operation Kit Dev', action: 'deploy' })
    expect(t).toBe("You chose A: Deploy the four now. A deploy runs only from a message you type in Operation Kit Dev's chat, so your answer went there and card #901383 was not restarted. Type deploy in Operation Kit Dev's chat to run it. Nothing has run yet.")
  })
})
