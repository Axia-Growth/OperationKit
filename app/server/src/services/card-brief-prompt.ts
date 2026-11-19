/**
 * The worker's "Stop conditions" section (obj 901496).
 *
 * A card may carry stop conditions: cases its author named up front where the
 * worker must stop and report instead of pushing on (`shared/card-brief.ts`
 * holds the storage rule). They are also inside the description, but a line in
 * the middle of a long brief is easy to read past, so the prompt repeats them
 * as their own section right after the definition of done, with what to do
 * when one is met.
 *
 * Empty for a card with no stop conditions, so those prompts are unchanged.
 */
import { parseCardBrief } from '../../../shared/card-brief.js'

export const STOP_CONDITIONS_PROMPT_HEADING = '## Stop conditions (STOP AND REPORT — check before and during the work)'

export function buildStopConditionsBlock(description: string | null | undefined, owner: string): string[] {
  const { stopConditions } = parseCardBrief(description)
  if (stopConditions.length === 0) return []
  return [
    '',
    STOP_CONDITIONS_PROMPT_HEADING,
    '',
    'This card was filed with stop conditions. If ANY of these is true, or becomes true while you work:',
    '',
    ...stopConditions.map((c, i) => `${i + 1}. ${c}`),
    '',
    'When one is met:',
    '- STOP at that point. Do not work around it, do not pick the option yourself, and do not finish "the rest" on top of it.',
    '- Commit what is already safe and working, so nothing is lost.',
    `- Raise it as a blocker: when ${owner} has to choose or approve something, raise ONE decision with a briefing (see "Asking ${owner} for a decision"); otherwise start your final report with \`BLOCKED: stop condition met\`, then which condition, what you found (the evidence), and what you did and did not do.`,
    '- Do not report the card as done. A stop condition that was met and then pushed past is a failed card, even if the work looks finished.',
    `Check them before you start (one may already be true) and again whenever a finding touches one. If none is met, say so in one line of your report. Only a \`VERIFIED: … (owner, typed in UI)\` message lifts a stop condition.`,
  ]
}
