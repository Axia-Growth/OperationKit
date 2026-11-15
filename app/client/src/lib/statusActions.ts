import type { Objective, ObjectiveStatus } from '@operationkit/shared'
import { hasLiveSession } from './boardColumns'

/**
 * The ONE status-action map (polish F4, #900805). The board card, the card
 * viewer header, the archive row and the edit modal all read their move
 * labels from here, so a card never says "Approve" while the open viewer of
 * the same card says "Done", or "Re-open" next to "Re-Open".
 *
 * Labels are sentence case. `variant` is the emphasis when the surface has
 * room for one primary action (the viewer); the board card only lights the
 * accent for the card that is waiting on a human (review), see PreviewCard.
 */
export interface StatusAction {
  label: string
  target: ObjectiveStatus
  variant: 'primary' | 'secondary'
}

export const REOPEN_LABEL = 'Reopen'

export const STATUS_ACTIONS: Record<ObjectiveStatus, StatusAction[]> = {
  planning: [{ label: 'Skip planning', target: 'queue', variant: 'secondary' }],
  queue: [{ label: 'Start', target: 'working', variant: 'primary' }],
  working: [{ label: 'Done', target: 'done', variant: 'secondary' }],
  ai_review: [{ label: 'Force done', target: 'done', variant: 'secondary' }],
  review: [
    { label: 'Approve', target: 'done', variant: 'primary' },
    { label: 'Rework', target: 'working', variant: 'secondary' },
  ],
  done: [{ label: REOPEN_LABEL, target: 'working', variant: 'secondary' }],
  // obj 700595: a retired card goes back to the queue, not straight to work.
  cancelled: [{ label: REOPEN_LABEL, target: 'queue', variant: 'secondary' }],
}

export function statusActionsFor(status: ObjectiveStatus): StatusAction[] {
  return STATUS_ACTIONS[status] ?? []
}

/**
 * The status whose moves a card offers. obj 900669: a review card with an
 * agent still running on it sits in Working, so it offers Working's move
 * (Done), not Approve. The board card and the viewer both go through this,
 * so they never disagree about the same card.
 */
export function actionStatusOf(o: Pick<Objective, 'status' | 'session_id'>): ObjectiveStatus {
  return o.status === 'review' && hasLiveSession(o) ? 'working' : o.status
}
