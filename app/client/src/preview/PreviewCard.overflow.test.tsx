// @vitest-environment jsdom
/**
 * obj 901131 — Operator (Nov 16 2026): in the Needs You column, card tiles drifted
 * left. A long unbroken title / decision text / URL overflowed the tile, the
 * lane list (overflow-y:auto ⇒ overflow-x:auto) became sideways-scrollable and
 * every tile in it slid left as soon as anything scrolled it.
 *
 * jsdom has no layout engine, so this pins the CONTRACT that keeps a tile
 * exactly the lane's width (measured in a real Chromium for the PR: lane
 * scrollWidth/clientWidth went 1078/298 → 298/298):
 *   - the tile rule: min-width:0, max-width:100%, overflow:hidden, overflow-wrap:anywhere
 *   - the title and the summary/decision text break long tokens anywhere
 *   - long single-token chips (project, project name, workspace) truncate
 * The lane-list half (overflow-x hidden) is asserted in PreviewBoard.needsYou.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import type { Objective } from '@operationkit/shared'

vi.mock('../lib/api', () => ({
  api: { get: vi.fn(() => Promise.resolve([])), post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

import { PreviewCard } from './PreviewCard'

const LONG_TITLE = 'Investigate_' + 'NeedsYouColumnOverflowRegression'.repeat(4)
const LONG_URL = 'https://github.com/your-org/operationkit/pull/823/files#diff-' + 'a1b2c3d4e5f6'.repeat(8)
const LONG_TOKEN = 'a-project-name-with-no-spaces-that-goes-on-and-on-and-on-forever'

function longCard(status: Objective['status']): Objective {
  return {
    id: 901131, title: LONG_TITLE, status, session_id: null, workspace: LONG_TOKEN,
    project: LONG_TOKEN, project_name: LONG_TOKEN, pr_url: LONG_URL, pr_number: 823,
    last_session_summary: `Decision needed: approve ${LONG_URL} before shipping`,
    parent_id: null, has_blockers: 0, assigned_usernames: ['someone-with-a-very-long-username-that-never-breaks'],
    updated_at: '2026-11-16 14:00:00', created_at: '2026-11-16 14:00:00',
  } as unknown as Objective
}

/** The declarations of one top-level rule in preview.css, as a name → value map. */
function cssRule(selector: string): Record<string, string> {
  // vitest runs with css disabled, so ?raw is empty here; read the file itself.
  const css = readFileSync(resolve(process.cwd(), 'src/preview/preview.css'), 'utf8')
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))
  expect(m, `rule ${selector} in preview.css`).not.toBeNull()
  const out: Record<string, string> = {}
  for (const decl of m![1].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
    const [k, ...v] = decl.split(':')
    if (k.trim()) out[k.trim()] = v.join(':').trim()
  }
  return out
}

describe('Board card never grows past its lane (obj 901131)', () => {
  let container: HTMLElement
  let root: Root
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    flushSync(() => root.unmount())
    container.remove()
  })

  it('the tile rule pins it to the lane width and clips/wraps whatever is inside', () => {
    const rule = cssRule('.cc-ws-card')
    expect(rule['min-width']).toBe('0')
    expect(rule['max-width']).toBe('100%')
    expect(rule.overflow).toBe('hidden')
    expect(rule['overflow-wrap']).toBe('anywhere')
    expect(cssRule('.cc-ws-col')['max-width']).toBe('100%')
  })

  // Every column renders the same tile; Needs You (review) is the one Operator saw.
  it.each(['review', 'working', 'queue', 'ai_review', 'planning', 'done'] as const)(
    'a %s card with a very long unbroken title and URL wraps or truncates every long token',
    status => {
      flushSync(() => root.render(
        <PreviewCard objective={longCard(status)} onOpen={() => {}} onEdit={() => {}} onChangeStatus={() => {}} showOrgChip />,
      ))
      const tile = container.querySelector('article')!
      expect(tile.classList.contains('cc-ws-card')).toBe(true)

      const title = container.querySelector('[data-testid="card-title"]')!
      expect(title.textContent).toBe(LONG_TITLE)
      expect(title.className).toMatch(/\[overflow-wrap:anywhere\]/)
      expect(title.className).toMatch(/\bmin-w-0\b/)

      const summary = container.querySelector('[data-testid="card-summary"]')!
      expect(summary.textContent).toContain(LONG_URL)
      expect(summary.className).toMatch(/\[overflow-wrap:anywhere\]/)
      expect(summary.className).toMatch(/\bline-clamp-2\b/)

      // Single-token chips: each long label sits in a truncating box that may shrink.
      const project = Array.from(container.querySelectorAll('span')).find(s => s.getAttribute('title') === LONG_TOKEN)!
      expect(project.className).toMatch(/\btruncate\b/)
      for (const id of ['project-chip', 'org-chip']) {
        const chip = container.querySelector(`[data-testid="${id}"]`)!
        expect(chip.className).toMatch(/\bmin-w-0\b/)
        expect(chip.className).toMatch(/\bmax-w-full\b/)
        expect(chip.querySelector('span.truncate')?.textContent).toBe(LONG_TOKEN)
      }

      // Every flex row in the tile may shrink below its content.
      const pr = container.querySelector(`a[href="${LONG_URL}"]`)!
      expect(pr.className).toMatch(/\bmax-w-full\b/)
      expect(pr.parentElement!.className).toMatch(/\bmin-w-0\b/)
    },
  )
})
