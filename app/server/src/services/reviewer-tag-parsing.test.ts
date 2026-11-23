import { describe, it, expect } from 'vitest'
import { extractTag, extractJsonArrayTag } from './poller-decisions.js'

// The reviewer transcript is every assistant message joined with blank lines
// (extractReviewerOutput in poller-ai-review.ts). A reviewer can write a tag
// while it is still working, so the parser must take the FINAL block.
const join = (...msgs: string[]) => msgs.join('\n\n')

describe('extractTag: reviewer transcripts with more than one block', () => {
  it('a mid-session blocked does not outrank the final fail', () => {
    const t = join(
      'Preview host is not answering yet. If it stays down I will emit `<verdict>blocked</verdict>`. Retrying.',
      'Preview is up now.\n[FAIL] login-redirect: still redirects to /home\n<verdict>fail</verdict>',
    )
    expect(extractTag(t, 'verdict')).toBe('fail')
  })

  it('an early pass does not let a final fail through', () => {
    const t = join(
      'First look: <verdict>pass</verdict> pending the API check.',
      'API check returned 500.\n<verdict>fail</verdict>\n<findings>api-create returns 500</findings>',
    )
    expect(extractTag(t, 'verdict')).toBe('fail')
    expect(extractTag(t, 'findings')).toBe('api-create returns 500')
  })

  it('findings and mode also come from the final answer', () => {
    const t = join(
      '<mode>browser</mode><findings>draft notes</findings>',
      '<mode>api</mode>\n<verdict>pass</verdict>\n<findings>all 3 criteria pass</findings>',
    )
    expect(extractTag(t, 'mode')).toBe('api')
    expect(extractTag(t, 'findings')).toBe('all 3 criteria pass')
  })

  it('an unclosed early tag is not glued onto the final block', () => {
    const t = join('Thinking about <verdict>blocked here, never closed.', '<verdict>fail</verdict>')
    expect(extractTag(t, 'verdict')).toBe('fail')
  })

  it('still reads a single block, case-insensitive, multi-line and trimmed', () => {
    expect(extractTag('x <VERDICT>\n pass \n</VERDICT> y', 'verdict')).toBe('pass')
    expect(extractTag('<findings>line 1\nline 2</findings>', 'findings')).toBe('line 1\nline 2')
  })

  it('returns null when the tag is absent or never closed', () => {
    expect(extractTag('no tags here', 'verdict')).toBeNull()
    expect(extractTag('<verdict>pass', 'verdict')).toBeNull()
  })

  it('keeps an empty final block empty instead of falling back to an earlier one', () => {
    expect(extractTag(join('<findings>old</findings>', '<findings></findings>'), 'findings')).toBe('')
  })

  it('JSON-array tags use the final block too', () => {
    const t = join(
      '<criteria_results>[{"id":"a","status":"fail"}]</criteria_results>',
      '<criteria_results>[{"id":"a","status":"pass"}]</criteria_results>',
    )
    expect(JSON.parse(extractJsonArrayTag(t, 'criteria_results'))).toEqual([{ id: 'a', status: 'pass' }])
  })

  it('stays fast on a long transcript', () => {
    const t = 'x'.repeat(500_000) + '<verdict>pass</verdict>' + ' <verdict>'.repeat(20_000)
    const t0 = Date.now()
    expect(extractTag(t, 'verdict')).toBe('pass')
    expect(Date.now() - t0).toBeLessThan(1000)
  })
})
