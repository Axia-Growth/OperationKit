/**
 * obj 901460 — a card with no locked rubric gets one derived from its own text, or a
 * stated reason. Never the silent `criteria: null` that sent #901330 (PR 871) to a
 * no-verdict `blocked` three times.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const TMP_DB = path.join(os.tmpdir(), `cc-review-rubric-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB

const { initDb, getDb } = await import('../db/index.js')
const { deriveRubricFromCard, ensureReviewRubric, hasLockedCriteria, parseLockedCriteria, MAX_DERIVED_CRITERIA } =
  await import('./review-rubric.js')

// The real card text of #901330's sibling shape: "Problem / Change / Done" + process lines.
const CARD = {
  title: 'Reviewer with no locked rubric: lock one from the card text, or say why (PR only)',
  description: [
    'Problem: an AI review ran with no locked rubric and gave no usable verdict.',
    'Change: when a card has no locked acceptance criteria, derive and lock a short rubric from the card title and description.',
    'Done: tests show a card with no criteria gets a locked rubric or a stated reason, never a silent no-verdict.',
    '',
    'How to work:',
    '1. Open a pull request. Do not merge it and do not deploy.',
  ].join('\n'),
  completion_goal: null,
}

describe('deriveRubricFromCard (pure)', () => {
  it('derives title + Change + Done criteria and a checks bar; skips PR-lifecycle lines', () => {
    const r = deriveRubricFromCard(CARD)
    expect(r.criteria).not.toBeNull()
    const c = r.criteria!
    expect(c[0].id).toBe('card-title-delivered')
    expect(c[0].criterion).toContain(CARD.title)
    expect(c.some((x) => x.id.startsWith('change-') && x.criterion.includes('derive and lock a short rubric'))).toBe(true)
    expect(c.some((x) => x.id.startsWith('done-') && x.criterion.includes('never a silent no-verdict'))).toBe(true)
    expect(c[c.length - 1].id).toBe('checks-pass')
    for (const x of c) {
      expect(x.criterion).not.toMatch(/pull request|merge|deploy/i)
      expect(['functional', 'visual', 'data']).toContain(x.type)
      expect(['browser', 'api', 'doc', 'static']).toContain(x.method)
    }
    expect(new Set(c.map((x) => x.id)).size).toBe(c.length)
    expect(c.length).toBeLessThanOrEqual(MAX_DERIVED_CRITERIA)
  })

  it('reads bullets under a "Done:" / "Acceptance criteria" heading', () => {
    const r = deriveRubricFromCard({
      title: 'Add CSV export to the leads page',
      description: 'Acceptance criteria:\n- The leads page has an Export CSV button\n- The CSV has one row per visible lead\n\nNotes: other stuff',
    })
    const texts = r.criteria!.map((x) => x.criterion).join('\n')
    expect(texts).toContain('Export CSV button')
    expect(texts).toContain('one row per visible lead')
    expect(texts).not.toContain('other stuff')
  })

  it('falls back to the first description paragraph, then the completion goal', () => {
    const r = deriveRubricFromCard({
      title: 'Fix the login redirect',
      description: 'After login the user lands on /board instead of the page they asked for.\n\nMore context here.',
      completion_goal: 'Logging in from /o/42 returns the user to /o/42.',
    })
    const texts = r.criteria!.map((x) => x.criterion)
    expect(texts.some((t) => t.includes('lands on /board'))).toBe(true)
    expect(texts.some((t) => t.startsWith('Done as the card states it: Logging in from /o/42'))).toBe(true)
  })

  it('a title of 3+ words alone still yields a gradeable rubric', () => {
    const r = deriveRubricFromCard({ title: 'Rename the Jobs tab to Routines', description: '' })
    expect(r.criteria?.map((x) => x.id)).toEqual(['card-title-delivered', 'checks-pass'])
  })

  it('an empty card returns a stated reason, not a rubric', () => {
    const r = deriveRubricFromCard({ title: '', description: '', completion_goal: '' })
    expect(r.criteria).toBeNull()
    expect(r.reason).toMatch(/no title, description or completion goal/)
  })

  it('a too-short title with no usable description returns a reason', () => {
    const r = deriveRubricFromCard({ title: 'Fix it', description: 'Open a pull request.' })
    expect(r.criteria).toBeNull()
    expect(r.reason).toMatch(/too short to grade against/)
    expect(r.reason).toMatch(/Done:/)
  })
})

describe('parseLockedCriteria / hasLockedCriteria', () => {
  it('treats null, empty, "[]", non-array and garbage as NOT locked', () => {
    for (const v of [null, undefined, '', '  ', '[]', 'null', '{"a":1}', 'not json']) {
      expect(hasLockedCriteria(v)).toBe(false)
    }
    expect(parseLockedCriteria('[{"id":"x","criterion":"x","type":"functional","method":"api"}]')).toHaveLength(1)
    expect(hasLockedCriteria([{ id: 'x' }])).toBe(true)
  })
})

describe('ensureReviewRubric (real DB)', () => {
  beforeAll(() => {
    if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
    initDb()
  })
  afterAll(() => {
    try { getDb().close() } catch { /* ignore */ }
    for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  })
  beforeEach(() => { getDb().prepare('DELETE FROM objectives').run() })

  function insert(id: number, fields: { title: string; description?: string; acceptance_criteria?: string | null }) {
    getDb().prepare(
      `INSERT INTO objectives (id, title, description, status, workspace, acceptance_criteria)
       VALUES (?, ?, ?, 'review', 'operationkit', ?)`,
    ).run(id, fields.title, fields.description ?? '', fields.acceptance_criteria ?? null)
  }
  const stored = (id: number) =>
    (getDb().prepare('SELECT acceptance_criteria FROM objectives WHERE id = ?').get(id) as { acceptance_criteria: string | null }).acceptance_criteria

  it('a card with no criteria gets a rubric derived from its text, LOCKED on the row', () => {
    insert(1, { title: CARD.title, description: CARD.description })
    const r = ensureReviewRubric(getDb(), 1)!
    expect(r.source).toBe('derived')
    expect(r.criteria!.length).toBeGreaterThanOrEqual(3)
    expect(JSON.parse(stored(1)!)).toEqual(r.criteria)
    // Second call reads the lock back unchanged.
    const again = ensureReviewRubric(getDb(), 1)!
    expect(again.source).toBe('locked')
    expect(again.criteria).toEqual(r.criteria)
  })

  it('a stored empty array "[]" is not a lock: it is replaced by a derived rubric', () => {
    insert(2, { title: 'Add CSV export to the leads page', acceptance_criteria: '[]' })
    const r = ensureReviewRubric(getDb(), 2)!
    expect(r.source).toBe('derived')
    expect(parseLockedCriteria(stored(2))).toHaveLength(r.criteria!.length)
  })

  it('an existing lock is returned untouched', () => {
    const lock = '[{"id":"mine","criterion":"the delegator bar","type":"functional","method":"api"}]'
    insert(3, { title: CARD.title, description: CARD.description, acceptance_criteria: lock })
    const r = ensureReviewRubric(getDb(), 3)!
    expect(r.source).toBe('locked')
    expect(r.criteria!.map((c) => c.id)).toEqual(['mine'])
    expect(stored(3)).toBe(lock)
  })

  it('a card too thin to grade gets a stated reason and nothing is locked', () => {
    insert(4, { title: 'Fix', description: '' })
    const r = ensureReviewRubric(getDb(), 4)!
    expect(r.criteria).toBeNull()
    expect(r.source).toBe('none')
    expect(r.reason).toMatch(/none could be derived/)
    expect(stored(4)).toBeNull()
  })

  it('a missing objective is null', () => {
    expect(ensureReviewRubric(getDb(), 999)).toBeNull()
  })
})
