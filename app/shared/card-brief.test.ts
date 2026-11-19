import { describe, expect, it } from 'vitest'
import { composeCardBrief, normalizeDoneWhen, normalizeStopConditions, parseCardBrief, MAX_STOP_CONDITIONS, STOP_CONDITIONS_HEADING } from './card-brief'

describe('card brief (obj 901496)', () => {
  it('normalizes stop conditions: trims, drops empties, bullets and repeats, caps the count', () => {
    expect(normalizeStopConditions(['  needs a migration ', '', '- the field exists', 'Needs a migration', 7, null])).toEqual(['needs a migration', 'the field exists'])
    expect(normalizeStopConditions('one\n\n* two\r\nthree')).toEqual(['one', 'two', 'three'])
    expect(normalizeStopConditions(undefined)).toEqual([])
    expect(normalizeStopConditions(Array.from({ length: 20 }, (_, i) => `c${i}`))).toHaveLength(MAX_STOP_CONDITIONS)
    // A condition cannot smuggle a second line (or a heading) into the card.
    expect(normalizeStopConditions(['a\n## Stop and report if\n- b'])).toEqual(['a ## Stop and report if - b'])
  })

  it('normalizes done_when to one line', () => {
    expect(normalizeDoneWhen('  One open PR,\n CI green  ')).toBe('One open PR, CI green')
    expect(normalizeDoneWhen(undefined)).toBe('')
  })

  it('leaves a description alone when there are no stop conditions', () => {
    expect(composeCardBrief('Do the thing.', undefined)).toBe('Do the thing.')
    expect(composeCardBrief('Do the thing.', [' '])).toBe('Do the thing.')
    expect(parseCardBrief('Do the thing.')).toEqual({ body: 'Do the thing.', stopConditions: [] })
    expect(parseCardBrief(null)).toEqual({ body: '', stopConditions: [] })
  })

  it('writes one section and reads it back', () => {
    const text = composeCardBrief('Build X.\n\nWhy: Y.', ['it needs a migration', 'the field already exists'])
    expect(text).toBe(`Build X.\n\nWhy: Y.\n\n${STOP_CONDITIONS_HEADING}\n- it needs a migration\n- the field already exists`)
    expect(parseCardBrief(text)).toEqual({ body: 'Build X.\n\nWhy: Y.', stopConditions: ['it needs a migration', 'the field already exists'] })
  })

  it('reads the section when a footer follows it, and keeps the footer in the body', () => {
    const text = `${composeCardBrief('Build X.', ['a', 'b'])}\n\n— Requested in chat with "Dev" by sam.`
    expect(parseCardBrief(text)).toEqual({ body: 'Build X.\n\n— Requested in chat with "Dev" by sam.', stopConditions: ['a', 'b'] })
  })

  it('merges a section the bot already typed into the text instead of writing a second one', () => {
    const typed = `Build X.\n\n${STOP_CONDITIONS_HEADING}:\n- a\n\nMore text.`
    const text = composeCardBrief(typed, ['b', 'A'])
    expect(text.split(STOP_CONDITIONS_HEADING)).toHaveLength(2)
    expect(parseCardBrief(text)).toEqual({ body: 'Build X.\n\nMore text.', stopConditions: ['a', 'b'] })
  })

  it('treats the heading with no bullets as ordinary text', () => {
    const text = `${STOP_CONDITIONS_HEADING}\nnothing listed`
    expect(parseCardBrief(text)).toEqual({ body: text, stopConditions: [] })
  })
})
