/**
 * The two card-brief arguments every card-filing chat tool takes (obj 901496):
 * `done_when` and `stop_conditions`. One definition, so `create_objective` and
 * `repo_session_start` tell bots the same thing. The storage rule is in
 * `shared/card-brief.ts`.
 */
import { MAX_STOP_CONDITIONS } from '../../../../shared/card-brief.js'

/** Appended to the description of every tool that files a card. */
export const CARD_BRIEF_TOOL_HINT =
  'Every card you file names what done looks like (done_when) and when the worker must stop and report (stop_conditions): fill both. ' +
  'They show as their own sections on the card and in the worker\'s brief.'

export const DONE_WHEN_ARG = {
  type: 'string',
  description:
    'ONE checkable statement of what done looks like, e.g. "One open PR with CI green; the settings page shows the new field". ' +
    'Something a reviewer can check, not "it works". It becomes the card\'s completion goal.',
} as const

export const STOP_CONDITIONS_ARG = {
  type: 'array',
  items: { type: 'string' },
  maxItems: MAX_STOP_CONDITIONS,
  description:
    'Short lines, each a case where the worker must STOP and report instead of pushing on, e.g. "this needs a database migration", ' +
    '"the fix needs a paid plan", "the data is already there under another name". Name the real risks of this job; one line each.',
} as const
