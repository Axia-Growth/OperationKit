// @vitest-environment node
/**
 * One action map for the board card and the card viewer (polish F4, obj 900805).
 * Before: the card said "Approve" / "Re-open" where the viewer of the SAME card
 * said "Done" / "Re-Open" / "Force Done". Both now render from STATUS_ACTIONS.
 */
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OBJECTIVE_STATUSES, type Objective, type ObjectiveStatus } from '@operationkit/shared'
import { PreviewCard } from '../preview/PreviewCard'
import { ViewerHeader } from '../components/session-viewer/ViewerHeader'
import { STATUS_ACTIONS, actionStatusOf } from './statusActions'

function obj(status: ObjectiveStatus, session_id: string | null = null): Objective {
  return {
    id: 7, title: 'A card', description: '', status, workspace: 'demo', agent_context: 'general',
    session_id, session_count: 0, total_cost_usd: 0, assigned_usernames: [],
    updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
  } as unknown as Objective
}

const noop = () => {}
const buttonLabels = (html: string) =>
  [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)

function cardLabels(o: Objective): string[] {
  const html = renderToStaticMarkup(<PreviewCard objective={o} onOpen={noop} onChangeStatus={noop} />)
  return buttonLabels(html).filter(l => l !== 'View' && l !== 'A card')
}

function viewerLabels(o: Objective): string[] {
  const html = renderToStaticMarkup(
    <ViewerHeader
      objective={o} isActive={false} connState="live" time="" hasActivity={false}
      skillsInvoked={[]} subagentPersonas={[]} subagentWorkers={[]} agentLabel={s => s}
      showBrief={false} setShowBrief={noop} showCorrection={false} setShowCorrection={noop}
      setCorrectionError={noop} correctionSaved={false} onChangeStatus={noop}
      isFull={false} toggleSize={noop} onClose={noop} hideSizeToggle
    />,
  )
  const moves = new Set(Object.values(STATUS_ACTIONS).flat().map(a => a.label))
  // The header renders its actions twice (desktop cluster + mobile row).
  return [...new Set(buttonLabels(html).filter(l => moves.has(l)))]
}

describe('one status-action map', () => {
  it('labels are sentence case and never the old variants', () => {
    const labels = Object.values(STATUS_ACTIONS).flat().map(a => a.label)
    for (const l of labels) expect(l.slice(1)).toBe(l.slice(1).toLowerCase())
    expect(labels).not.toContain('Re-Open')
    expect(labels).not.toContain('Force Done')
    expect(STATUS_ACTIONS.review.map(a => a.label)).toEqual(['Approve', 'Rework'])
  })

  for (const status of OBJECTIVE_STATUSES) {
    it(`card and viewer offer the same moves for a ${status} card`, () => {
      const o = obj(status)
      const expected = STATUS_ACTIONS[status].map(a => a.label)
      expect(cardLabels(o)).toEqual(expected)
      expect(viewerLabels(o)).toEqual(expected)
    })
  }

  it('a review card with an agent still on it offers Working moves in both (obj 900669)', () => {
    const o = obj('review', 'sess-1')
    expect(actionStatusOf(o)).toBe('working')
    expect(cardLabels(o)).toEqual(['Done'])
    expect(viewerLabels(o)).toEqual(['Done'])
  })
})
