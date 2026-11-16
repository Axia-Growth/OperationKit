/**
 * Where an FYI stop goes instead of Needs you (obj 901151): the activity feed.
 * The entry is a `milestone` event with `metadata.kind = 'fyi_report'` (the
 * event_type CHECK constraint allows no new types; new kinds go in metadata).
 */
import type { FyiSink } from './decision-autobrief.js'
import { logActivity } from '../routes/feed.js'

export const fyiSink: FyiSink = {
  logFyi: ({ objective, decision, summary }) => {
    logActivity({
      project: objective?.project || objective?.workspace || 'operationkit',
      workspace: objective?.workspace ?? decision.workspace,
      objective_id: decision.objective_id,
      event_type: 'milestone',
      title: `FYI from ${decision.agent_slug || 'the bot'} on card #${decision.objective_id}`.slice(0, 200),
      detail: [summary, decision.raw_note && decision.raw_note !== summary ? `Original note: ${decision.raw_note}` : ''].filter(Boolean).join('\n\n').slice(0, 2000),
      metadata: { kind: 'fyi_report', decision_id: decision.id },
    })
  },
}
