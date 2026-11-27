import { describe, it, expect } from 'vitest'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { promptsFor, renderEvalReport, runAnswerCheckEval, summarize, validateSpec, type EvalRow } from './answer-check-eval.js'

// The committed case set and one recorded model run (docs/evals/kb-answer-check/README.md).
const SAMPLE = fileURLToPath(new URL('../../../../../docs/evals/kb-answer-check/sample.json', import.meta.url))
const REPLIES = fileURLToPath(new URL('../../../../../docs/evals/kb-answer-check/sample.replies.json', import.meta.url))
const spec = validateSpec(JSON.parse(fs.readFileSync(SAMPLE, 'utf8')))
const replies = JSON.parse(fs.readFileSync(REPLIES, 'utf8')) as Record<string, string>

describe('saved-answer check eval (obj 901746)', () => {
  it('the sample set has known good and bad answers', () => {
    expect(spec.cases.filter(c => c.expect === 'supported').length).toBe(10)
    expect(spec.cases.filter(c => c.expect === 'unsupported').length).toBe(14)
  })

  it('rules only: catches the wrong, missing and held-answer citations, holds no good answer', async () => {
    const r = await runAnswerCheckEval(spec, () => null, 'none')
    expect(r.rows.filter(x => x.status === 'held').map(x => x.id).sort()).toEqual(['b01', 'b02', 'b12'])
    expect(r.totals).toMatchObject({ caught: 3, caught_by_rules: 3, false_holds: 0, unchecked: 21 })
  })

  it('the recorded replies cover exactly the cases the AI is asked about, and replay to the published numbers', async () => {
    expect(Object.keys(replies).sort()).toEqual(promptsFor(spec).map(p => p.id).sort())
    const r = await runAnswerCheckEval(spec, id => async () => replies[id], 'replay')
    expect(r.totals).toMatchObject({ bad: 14, good: 10, caught: 14, caught_by_rules: 3, false_holds: 0, unchecked: 0 })
    expect(r.rows.every(x => x.correct)).toBe(true)
    expect(renderEvalReport(r)).toContain('**14/14 = 100.0%** (3 by the citation rules alone, 11 by the AI)')
  })

  it('a judge that holds everything scores 100% caught and 100% false holds (the arithmetic is honest)', async () => {
    const r = await runAnswerCheckEval(spec, () => async () => '{"unsupported":[{"claim":"x","why":"y"}]}', 'hold-all')
    expect(r.totals.catch_rate).toBe(1)
    expect(r.totals.false_hold_rate).toBe(1)
    const none = summarize([] as EvalRow[])
    expect(none.catch_rate).toBe(0)
  })

  it('rejects a malformed case file', () => {
    expect(() => validateSpec({ name: 'x', pages: {}, cases: [{ id: 'a', expect: 'maybe', question: 'q', answer: 'a', sources: [] }] })).toThrow('expect must be')
    expect(() => validateSpec({ name: 'x', pages: { '../escape.md': 'x' }, cases: [] })).toThrow('stay inside')
    expect(() => validateSpec({ name: 'x', pages: {}, cases: [{ id: 'a', expect: 'supported', question: 'q', answer: 'a', sources: [] }, { id: 'a', expect: 'supported', question: 'q', answer: 'a', sources: [] }] })).toThrow('unique')
  })
})
