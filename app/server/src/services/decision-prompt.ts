/**
 * How a worker or bot asks the person for a decision (obj 901059).
 *
 * One place for the wording, used by the worker prompt (prompt-builder.ts),
 * the job-disposition block, the High Agency wake brief and the chat bots'
 * `raise_decision` tool, so the required fields never drift apart.
 *
 * The recent questions the person had to ask on earlier decisions are appended
 * (`briefingFeedbackLines`) so the next briefing answers them up front.
 */
import { getDb } from '../db/index.js'
import { briefingFeedbackLines } from './decisions.js'

export const DECISION_BRIEFING_RULES = [
  'Keep the whole briefing under about 200 words. It must stand on its own: the person reads it on the card or in chat with nothing else open.',
  '- context: 2-3 sentences. Where we are, what the decision is for, and where it fits in the system.',
  '- question: the decision as ONE question.',
  '- options: 2-4. Each has a short label, 1-3 pros, 1-3 cons, and next = what happens right after if it is chosen.',
  '- recommended: the option key (A, B, C, D) you recommend, and recommended_why in one sentence.',
  'A request with no question or fewer than two options is refused. Do not also ask in prose: the card renders the briefing, a Q&A thread for questions, and the Approve/Deny buttons.',
]

/** Example payload, as JSON text, for prompts. */
export const DECISION_EXAMPLE = JSON.stringify({
  context: 'The weekly outreach batch is drafted: 40 leads, reviewed against the ICP. Sending is the last step before replies start landing in the inbox.',
  question: 'Should we send the 40-lead batch today?',
  options: [
    { key: 'A', label: 'Send today', pros: ['Replies land before the weekend'], cons: ['No second review of subject lines'], next: 'I send the batch and report the bounce rate in an hour.' },
    { key: 'B', label: 'Hold for a subject-line test', pros: ['Better open rate likely'], cons: ['Pushes replies to Monday'], next: 'I draft 2 subject lines for you to pick tomorrow.' },
  ],
  recommended: 'A',
  recommended_why: 'The lines already match last month’s best performer.',
})

function feedback(workspace: string | null, owner: string): string[] {
  try {
    return briefingFeedbackLines(getDb(), workspace, owner)
  } catch {
    return []
  }
}

/** The worker-prompt block: how to raise a decision from a card session. */
export function buildDecisionRequestBlock(p: { objectiveId: number; workspace: string | null; owner: string; isJob: boolean }): string[] {
  const fb = feedback(p.workspace, p.owner)
  return [
    '',
    `## Asking ${p.owner} for a decision`,
    '',
    `When you need ${p.owner} to choose between options before you can go on, raise ONE decision with a short briefing. It shows at the top of this card and in ${p.owner}'s bot chat; ${p.owner} can ask you questions in its thread before choosing, and the choice comes back to you as a follow-up message naming the option.`,
    ...DECISION_BRIEFING_RULES,
    '',
    '```bash',
    p.isJob
      ? `# This is a job: put the briefing in the needs_review disposition (see Jobs Disposition below).`
      : `curl -s -X POST http://localhost:3002/api/decisions -H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H 'Content-Type: application/json' \\\n  -d '${DECISION_EXAMPLE.replace(/'/g, "’")}'`,
    '```',
    p.isJob ? '' : 'A 400 lists exactly what is missing; fix it and send again. Then stop and wait: do not act on any option until the answer arrives.',
    ...(fb.length ? ['', ...fb] : []),
  ].filter(l => l !== '')
}

/** One-paragraph version for bot system prompts / tool descriptions. */
export function decisionBriefingSummary(): string {
  return 'Raise a decision with raise_decision: context (2-3 sentences), ONE question, 2-4 options each with pros, cons and next, plus recommended + recommended_why. Under about 200 words. Never ask for a decision in prose only.'
}

export function decisionFeedbackForPrompt(workspace: string | null, owner: string): string[] {
  return feedback(workspace, owner)
}
