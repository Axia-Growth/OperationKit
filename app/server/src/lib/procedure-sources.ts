/**
 * Where a worker session gets its procedure from (obj 901765).
 *
 * Skills used to be sold as the way to add capability: write a SKILL.md, wire
 * it to an agent in the skill graph, assign it. That made a new install feel
 * empty until someone curated a skill library, and skill files rot because they
 * behave differently per model and harness. The harness owns procedure now:
 * a session works it out from the card, the repo's own living docs and the
 * workspace knowledge base. A SKILL.md stays an escape hatch for a rare,
 * exact procedure — an agent that already declares skills still gets them.
 *
 * Pure and constant: no flag, no DB read, so it renders the same on every
 * install (tmux or jailed) and is trivially testable.
 */
export const PROCEDURE_SOURCES_HEADING = '## Where your procedure comes from'

export function buildProcedureSourcesBlock(): string[] {
  return [
    '',
    PROCEDURE_SOURCES_HEADING,
    '',
    'You do not need a skill file to do this card. Work out how to do it from, in this order:',
    '1. This card: the description, approved plan, acceptance criteria and any verified owner message.',
    '2. The living docs of the repo you work in: its README, CLAUDE.md or AGENTS.md, and docs/ — they describe how this code is built, tested and shipped today.',
    '3. The workspace knowledge base: decisions, runbooks and earlier cards (see the knowledge-base section of this prompt).',
    'Skill files (SKILL.md) are an optional escape hatch for a rare procedure that must be followed exactly. Use one only when this card, your agent file or a skill assignment names it; do not write a new skill file as a side effect of this card. If a procedure you needed was missing from all three places, say so in one line of your final summary.',
  ]
}
