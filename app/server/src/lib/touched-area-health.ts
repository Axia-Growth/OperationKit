/**
 * Touched-area health pass (obj 901769).
 *
 * Why: asking for a feature should not leave nearby slop behind. A worker that
 * changes a linked repo also tidies the files it already touched — tests, dead
 * code, stale calls — so tech debt does not pile up card by card. Cleanup is a
 * BOUNDED side-effect of the feature, not a licence to rewrite the world.
 *
 * Two halves, one source:
 *   - `TOUCHED_AREA_HEALTH_RULES` — worker-prompt block, rendered by `buildPrompt`
 *     for every card with a linked repo (`objective.project`), in both
 *     integration modes (own PR / fold into the parent's PR).
 *   - `buildReviewerTouchedAreaBlock()` — reviewer-prompt block, rendered by
 *     `buildReviewerPrompt` for the same cards. It fails a card whose cleanup
 *     sprawls outside the touched area or breaks the feature, and it never fails
 *     a card for having done NO cleanup.
 *
 * What this is NOT: a skill the user installs, a recurring code-health job, or
 * production-issue intake (sibling cards). It adds no tool and no route.
 */

/** Commit-message prefix that marks cleanup commits, so the reviewer can isolate them. */
export const HEALTH_PASS_COMMIT_PREFIX = 'Health pass:'

/** Line the worker writes when nothing nearby needed fixing. */
export const HEALTH_PASS_NOTHING_LINE = 'Health pass: nothing needed'

/**
 * Size bound for the cleanup, in changed lines (added + removed) across all
 * cleanup commits. Above it, the worker records a follow-up instead of doing it.
 */
export const HEALTH_PASS_MAX_LINES = 80

/** Worker-prompt block: a bounded cleanup in the files the feature touched. */
export const TOUCHED_AREA_HEALTH_RULES: readonly string[] = [
  '### Touched-area health pass (bounded cleanup — obj 901769)',
  '',
  'After the feature works and is committed, spend a few minutes tidying the code you ALREADY touched, so this change leaves its area cleaner than it found it. This is a small side-effect of the feature, not a refactor.',
  '',
  '**The touched area** = the files your feature diff changes, plus the test file next to each of them. Nothing else.',
  '',
  'Allowed inside the touched area (only what you can prove with a test, a typecheck or a grep):',
  '- Tests: add or fix tests for the code you changed; delete a test that only covered code you removed.',
  '- Obvious slop: unused imports, dead branches or helpers your change made unreachable, commented-out code, a stale or wrong comment/docstring next to your change.',
  '- Stale calls: a call in those files to something your change renamed, deprecated or replaced; a duplicate of a helper that already exists.',
  '',
  'NOT allowed (the reviewer fails the card for any of these):',
  '- Editing a file your feature did not need, "while you are there" — even a one-line fix. Note it as a follow-up instead.',
  '- Renames, moves, signature/API changes, new abstractions or new files that exist only for the cleanup (a new test file for a touched module is fine).',
  '- Whole-file reformatting, dependency bumps, lint-config changes.',
  '- Any change in behaviour outside what the card asked for.',
  `- More than about ${HEALTH_PASS_MAX_LINES} changed lines of cleanup in total. If it is bigger, do not do it: list it under "Follow-ups" in ARTIFACT.md.`,
  '',
  'How to ship it:',
  `- Put the cleanup in its OWN commit(s), message starting \`${HEALTH_PASS_COMMIT_PREFIX}\`, AFTER the feature commit — so the reviewer can see it apart from the feature and it can be reverted alone.`,
  '- Re-run the typecheck and the tests for the touched files after the cleanup. If the cleanup breaks anything, revert it; the feature comes first.',
  `- In ARTIFACT.md add one "Health pass" line: what you cleaned and in which files, or exactly \`${HEALTH_PASS_NOTHING_LINE}\`.`,
  `- **Nothing nearby needs fixing? Do nothing.** A clean feature-only change is a complete delivery; write \`${HEALTH_PASS_NOTHING_LINE}\` and move on. Never invent a refactor to have something to show.`,
]

/**
 * Reviewer-prompt block. `filesTouched` is the worker session's touched list
 * (already printed elsewhere in the reviewer prompt); it is only used to say
 * how big the touched area is.
 */
export function buildReviewerTouchedAreaBlock(filesTouched: readonly string[]): string {
  const area = filesTouched.length > 0
    ? `The worker session touched ${filesTouched.length} file(s) (listed under "Files touched by the worker session").`
    : 'No touched-file list was captured; use the branch diff as the touched area.'
  return [
    '## Touched-area health pass — check the cleanup (obj 901769)',
    '',
    `Workers on a linked repo may do a BOUNDED cleanup in the files their feature touched (tests, obvious slop, stale calls), in separate commits whose message starts \`${HEALTH_PASS_COMMIT_PREFIX}\`. ${area}`,
    '',
    'Check it, read-only:',
    '- `git log --format=\'%h %s\' origin/main..HEAD` — find the cleanup commits; `git show --stat <sha>` for each.',
    '- `git diff --stat origin/main...HEAD` — the whole change. The touched area = files the FEATURE needed plus their test files.',
    '',
    'FAIL the card (name the file and commit) when the cleanup:',
    '- **sprawls**: edits a file the feature did not need and that is not a test of a touched file; renames/moves code, changes a signature or public API, adds a new abstraction, reformats a whole file or bumps a dependency for cleanup\'s sake;',
    `- **is too big**: clearly more than about ${HEALTH_PASS_MAX_LINES} changed lines of cleanup, or larger than the feature itself;`,
    '- **regresses**: changes behaviour outside the card\'s ask, deletes code something still calls (grep for it), or turns a test red / removes a test of behaviour that still exists.',
    'Feature changes mixed into a `Health pass:` commit, or cleanup hidden inside the feature commit, are graded by the same rules.',
    '',
    'Record the result as one extra findings line, `- [PASS|FAIL] touched-area-health: <commit sha / file / diffstat>`, even when it is not in the locked rubric; a FAIL here makes the verdict `fail`.',
    '',
    `Do NOT fail a card for doing NO cleanup. \`${HEALTH_PASS_NOTHING_LINE}\` on a clean feature-only change is a correct outcome; never author a criterion that demands a refactor, more tests than the change needs, or cleanup of files the card did not touch.`,
  ].join('\n')
}
