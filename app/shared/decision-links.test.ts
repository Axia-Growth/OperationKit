import { describe, expect, it } from 'vitest'
import {
  OWN_ANSWER_CHOICE,
  chosenLabel,
  decisionFollowUpText,
  decisionLinks,
  decisionOutcomeText,
  linkSegments,
  validateDecisionBriefing,
  type DecisionView,
} from './decision-briefing'

// obj 901139 — links in decisions are clickable, and the person can answer in
// their own words.

const v = validateDecisionBriefing({
  context: 'Three PRs are green: https://github.com/acme/app/pull/821, https://github.com/acme/app/pull/828. See card #901131 for the lane bug.',
  question: 'Merge them now?',
  options: [
    { label: 'Merge now', pros: ['Ships today'], cons: ['Needs a click'], next: 'I merge both and check the deploy (runbook: https://docs.example.org/deploy).' },
    { label: 'Wait', pros: ['Evening window'], cons: ['Later'], next: 'I merge at 6pm.' },
  ],
  recommended: 'A',
  recommended_why: 'Both are green.',
})
if (!v.ok) throw new Error('fixture invalid')
const b = v.briefing

describe('linkSegments', () => {
  it('turns http(s) URLs and card references into links, keeps the rest as text', () => {
    const s = linkSegments('PR https://github.com/acme/app/pull/821, then card #42.')
    expect(s).toEqual([
      { kind: 'text', text: 'PR ' },
      { kind: 'url', text: 'https://github.com/acme/app/pull/821', href: 'https://github.com/acme/app/pull/821' },
      { kind: 'text', text: ', then ' },
      { kind: 'card', text: 'card #42', id: 42 },
      { kind: 'text', text: '.' },
    ])
  })

  it('drops sentence punctuation after a URL but keeps a balanced paren', () => {
    expect(linkSegments('see (https://x.example/a).')[1]).toMatchObject({ href: 'https://x.example/a' })
    expect(linkSegments('https://en.wikipedia.org/wiki/Foo_(bar) ok')[0]).toMatchObject({ href: 'https://en.wikipedia.org/wiki/Foo_(bar)' })
  })

  it('never links javascript:, data: or a bare host', () => {
    const s = linkSegments('javascript:alert(1) data:text/html,x example.com http:// ')
    expect(s.every(x => x.kind === 'text')).toBe(true)
  })

  it('stays linear on long hostile input', () => {
    const t0 = Date.now()
    linkSegments('https://' + 'a'.repeat(50_000) + ' ' + 'card '.repeat(20_000))
    expect(Date.now() - t0).toBeLessThan(500)
  })

  // obj 901148 — CodeQL js/polynomial-redos: the trailing-punctuation strip was an
  // end-anchored `[…]+$` regex, quadratic on a long run of "!" inside a URL.
  it('stays fast on a URL holding a long run of "!" (CodeQL polynomial-redos)', () => {
    const t0 = Date.now()
    const s = linkSegments('https://x.example/' + '!'.repeat(100_000) + 'a')
    expect(Date.now() - t0).toBeLessThan(500)
    expect(s[0]).toMatchObject({ kind: 'url' })
    const t1 = Date.now()
    const s2 = linkSegments('https://x.example/' + '!'.repeat(100_000))
    expect(Date.now() - t1).toBeLessThan(500)
    expect(s2).toEqual([
      { kind: 'url', text: 'https://x.example/', href: 'https://x.example/' },
      { kind: 'text', text: '!'.repeat(100_000) },
    ])
  })

  it('stays fast on a very long URL and on many URLs ending in punctuation', () => {
    const t0 = Date.now()
    const long = 'https://x.example/' + 'ab!.'.repeat(250_000)
    expect(linkSegments(long + ' ok')[0]).toMatchObject({ kind: 'url', href: long.slice(0, -2) })
    linkSegments('https://x.example/a!!!, '.repeat(20_000))
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('strips the same trailing punctuation as before (old regex as oracle)', () => {
    const OLD = /[.,;:!?)\]}'"’”]+$/
    const oracle = (url: string) => {
      let tail = ''
      const t = url.match(OLD)
      if (t) {
        let cut = t[0]
        if (cut.startsWith(')') && url.slice(0, -cut.length).includes('(')) cut = cut.slice(1)
        if (cut) { tail = cut; url = url.slice(0, -cut.length) }
      }
      return { url, tail }
    }
    const urls = [
      'https://x.example/a', 'https://x.example/a.', 'https://x.example/a).', 'https://x.example/a(b)',
      'https://x.example/a(b)).', 'https://x.example/a?!', 'https://x.example/a]}', 'https://x.example/a’”',
      'https://x.example/a;:,', 'https://x.example/a!b!', 'https://x.example/(a)!?', 'https://x.example/a))',
    ]
    for (const u of urls) {
      const want = oracle(u)
      const got = linkSegments(`see ${u} now`)
      expect(got[1]).toMatchObject({ kind: 'url', href: want.url })
      expect(got.slice(2).map(x => x.text).join('')).toBe(want.tail + ' now')
    }
  })

  it('card #N links still work next to URLs', () => {
    expect(linkSegments('card #901148! and https://x.example/a!')).toEqual([
      { kind: 'card', text: 'card #901148', id: 901148 },
      { kind: 'text', text: '! and ' },
      { kind: 'url', text: 'https://x.example/a', href: 'https://x.example/a' },
      { kind: 'text', text: '!' },
    ])
  })
})

describe('decisionLinks', () => {
  const d = (extra: Partial<DecisionView> = {}) => ({ objective_id: 7, briefing: b, raw_note: null, decision_note: null, outcome_text: null, ...extra })

  it('lists every distinct link the decision mentions, PRs first, labelled owner/repo#N', () => {
    const links = decisionLinks(d({ decision_note: 'You merge https://github.com/acme/app/pull/821, not me.' }))
    expect(links).toEqual([
      { href: 'https://github.com/acme/app/pull/821', label: 'acme/app#821', kind: 'pr' },
      { href: 'https://github.com/acme/app/pull/828', label: 'acme/app#828', kind: 'pr' },
      { href: 'https://docs.example.org/deploy', label: 'https://docs.example.org/deploy', kind: 'url' },
      { href: '/o/901131', label: 'card #901131', kind: 'card' },
    ])
  })

  it("skips the decision's own card (its header links it already) and reads the Q&A thread", () => {
    const links = decisionLinks(d({ objective_id: 901131, thread: [{ body: 'It is https://github.com/acme/app/pull/9' }] as DecisionView['thread'] }))
    expect(links.map(l => l.href)).not.toContain('/o/901131')
    expect(links.map(l => l.label)).toContain('acme/app#9')
  })
})

describe('own answer', () => {
  const words = 'You merge the PRs, not me.'
  it('the worker is told the words ARE the decision', () => {
    const t = decisionFollowUpText({ decisionId: 3, briefing: b, chosen: OWN_ANSWER_CHOICE, note: words })
    expect(t).toBe(`Decision #3: Merge them now?\nAnswer: none of the listed options as written. The owner answered in their own words, and that answer is the decision. Follow it:\n${words}`)
  })
  it('the outcome line quotes the answer and says what happens', () => {
    expect(decisionOutcomeText({ objectiveId: 7, briefing: b, chosen: OWN_ANSWER_CHOICE, outcome: 'sent', note: words }))
      .toBe(`You answered in your own words: “${words}” Card #7 restarted with your choice. The worker follows your answer instead of the options.`)
  })
  it('the label names it', () => {
    expect(chosenLabel(b, OWN_ANSWER_CHOICE, words)).toBe(`Own answer: “${words}”`)
    expect(chosenLabel(b, OWN_ANSWER_CHOICE)).toBe('Own answer')
  })
})
