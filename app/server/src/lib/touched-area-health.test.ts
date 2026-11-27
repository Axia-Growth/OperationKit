import { describe, it, expect } from 'vitest'
import {
  TOUCHED_AREA_HEALTH_RULES,
  buildReviewerTouchedAreaBlock,
  HEALTH_PASS_COMMIT_PREFIX,
  HEALTH_PASS_NOTHING_LINE,
  HEALTH_PASS_MAX_LINES,
} from './touched-area-health.js'

// obj 901769 — touched-area health pass: bounded cleanup for the worker, a
// sprawl/regression check for the reviewer, and no forced refactor.
describe('touched-area health pass — worker rules', () => {
  const text = TOUCHED_AREA_HEALTH_RULES.join('\n')

  it('bounds the cleanup to the files the feature touched plus their tests', () => {
    expect(text).toContain('The touched area** = the files your feature diff changes, plus the test file next to each of them. Nothing else.')
    expect(text).toMatch(/Editing a file your feature did not need/)
    expect(text).toMatch(/Renames, moves, signature\/API changes/)
    expect(text).toMatch(/Whole-file reformatting, dependency bumps/)
    expect(text).toMatch(/change in behaviour outside what the card asked for/)
  })

  it('names the allowed kinds of cleanup: tests, obvious slop, stale calls', () => {
    expect(text).toMatch(/^- Tests:/m)
    expect(text).toMatch(/^- Obvious slop:/m)
    expect(text).toMatch(/^- Stale calls:/m)
  })

  it('caps the size and sends anything bigger to a follow-up, not the diff', () => {
    expect(text).toContain(`More than about ${HEALTH_PASS_MAX_LINES} changed lines of cleanup`)
    expect(text).toContain('list it under "Follow-ups" in ARTIFACT.md')
  })

  it('keeps cleanup in separate, re-verified commits after the feature', () => {
    expect(text).toContain(`message starting \`${HEALTH_PASS_COMMIT_PREFIX}\`, AFTER the feature commit`)
    expect(text).toMatch(/Re-run the typecheck and the tests .* revert it; the feature comes first/)
  })

  it('does not force a refactor on a clean feature-only change', () => {
    expect(text).toContain('Nothing nearby needs fixing? Do nothing.')
    expect(text).toContain(HEALTH_PASS_NOTHING_LINE)
    expect(text).toContain('Never invent a refactor')
  })
})

describe('touched-area health pass — reviewer block', () => {
  const block = buildReviewerTouchedAreaBlock(['app/server/src/a.ts', 'app/server/src/a.test.ts'])

  it('fails sprawl outside the touched area', () => {
    expect(block).toMatch(/FAIL the card/)
    expect(block).toMatch(/\*\*sprawls\*\*: edits a file the feature did not need/)
    expect(block).toContain(`more than about ${HEALTH_PASS_MAX_LINES} changed lines`)
  })

  it('fails regressions from the cleanup', () => {
    expect(block).toMatch(/\*\*regresses\*\*: changes behaviour outside the card's ask/)
    expect(block).toMatch(/deletes code something still calls/)
    expect(block).toMatch(/turns a test red/)
  })

  it('records a touched-area-health findings line that can sink the verdict', () => {
    expect(block).toContain('[PASS|FAIL] touched-area-health')
    expect(block).toMatch(/a FAIL here makes the verdict `fail`/)
  })

  it('never fails a card for doing no cleanup', () => {
    expect(block).toContain('Do NOT fail a card for doing NO cleanup.')
    expect(block).toContain(HEALTH_PASS_NOTHING_LINE)
    expect(block).toMatch(/never author a criterion that demands a refactor/)
  })

  it('describes the touched area from the captured file list, or falls back to the diff', () => {
    expect(block).toContain('touched 2 file(s)')
    expect(buildReviewerTouchedAreaBlock([])).toContain('use the branch diff as the touched area')
  })
})
