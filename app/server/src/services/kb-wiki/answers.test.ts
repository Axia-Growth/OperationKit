import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { checkAndFileAnswer, fileAnswer, rewriteCitations } from './answers.js'
import { readPage } from './wiki.js'
import { isHeldAnswerFile } from '../../lib/kb-answer-hold.js'

let kb: string
beforeEach(() => { kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-ans-')) })
afterEach(() => { fs.rmSync(kb, { recursive: true, force: true }) })

function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}
const read = (rel: string) => fs.readFileSync(path.join(kb, rel), 'utf8')

const NOW = new Date('2026-10-31T12:00:00Z')

function seed(): void {
  put('organizations/greenway-growers.md', '---\ntitle: Greenway Growers\ntype: organization\n---\n# Greenway Growers\n\nPlant supplier.\n')
  put('people/sam-okafor.md', '---\ntitle: Sam Okafor\ntype: person\n---\n# Sam Okafor\n\nStore manager.\n')
  put('raw/calls/secret.md', '# raw\n')
}

describe('fileAnswer', () => {
  it('writes the answer page, rewrites citations, links back from used pages, and logs it', () => {
    seed()
    const r = fileAnswer(kb, {
      question: 'Who delivers our plants?',
      answer: 'Greenway Growers delivers on Tuesdays [[organizations/greenway-growers.md]]; Sam checks it in [[people/sam-okafor.md|Sam]]. Unknown: [[organizations/nope.md]].',
      sources: ['organizations/greenway-growers.md', 'people/sam-okafor', 'organizations/missing.md', 'raw/calls/secret.md', '../etc/passwd.md'],
      filedBy: 'Rosa Delgado',
      now: NOW,
    })
    expect(r.rel).toBe('answers/2026-10-31-who-delivers-our-plants.md')
    expect(r.title).toBe('Who delivers our plants?')
    // obj 901746: [[organizations/nope.md]] is not a page, so the rules hold it out of search.
    expect(r.check).toMatchObject({ status: 'held', kind: 'ungrounded', checked_by: 'rules' })
    expect(r.check.reason).toContain('"organizations/nope", which is not a page in Context')
    const page = read(r.rel)
    expect(page).toMatch(/^---\ntitle: "Who delivers our plants\?"\ntype: answer\nsources: \[organizations\/greenway-growers.md, people\/sam-okafor.md\]\nfiled_by: Rosa Delgado\nupdated: 2026-10-31\nanswer_check: held\nanswer_check_kind: ungrounded\nanswer_check_reason: .+\nanswer_checked_at: 2026-10-31\nsource_hashes: \{"organizations\/greenway-growers.md":"[0-9a-f]{16}","people\/sam-okafor.md":"[0-9a-f]{16}"\}\ngenerated_by: kb-wiki\n---\n\n# Who delivers our plants\?\n/)
    expect(isHeldAnswerFile(path.join(kb, r.rel))).toBe(true)
    expect(read('log.md')).toContain('Saved an answer (kept out of search until someone reviews it): Who delivers our plants?')
    expect(page).toContain('Tuesdays [[organizations/greenway-growers|Greenway Growers]]; Sam checks it in [[people/sam-okafor|Sam]]. Unknown: [[organizations/nope.md]].')
    expect(page).toContain('## Pages this answer used\n\n- [[organizations/greenway-growers|Greenway Growers]]\n- [[people/sam-okafor|Sam Okafor]]')
    expect(page).not.toContain('raw/calls')
    expect(readPage(kb, 'organizations/greenway-growers.md').backlinks).toEqual([{ rel: r.rel, title: 'Who delivers our plants?' }])
    expect(read('index.md')).toContain('## Answers (1)')
  })

  it('never overwrites an earlier answer to the same question', () => {
    seed()
    const a = fileAnswer(kb, { question: 'Who is Sam?', answer: 'one', sources: [], now: NOW })
    const b = fileAnswer(kb, { question: 'Who is Sam?', answer: 'two', sources: [], now: NOW })
    expect(a.rel).toBe('answers/2026-10-31-who-is-sam.md')
    expect(b.rel).toBe('answers/2026-10-31-who-is-sam-2.md')
    expect(read(a.rel)).toContain('\none\n')
    expect(a.check.status).toBe('held') // cites no page
    expect(read(b.rel)).not.toContain('## Pages this answer used')
  })

  it('an answer citing only real pages is filed unchecked (rules only) and stays searchable', () => {
    seed()
    const r = fileAnswer(kb, { question: 'Who manages the store?', answer: 'Sam Okafor [[people/sam-okafor.md]].', sources: [], now: NOW })
    expect(r.check).toMatchObject({ status: 'unchecked', pages: ['people/sam-okafor.md'] })
    expect(read(r.rel)).toContain('answer_check: unchecked')
    expect(isHeldAnswerFile(path.join(kb, r.rel))).toBe(false)
  })

  it('an answer that cites nothing is held: nothing backs it up', () => {
    seed()
    const r = fileAnswer(kb, { question: 'Who is Sam?', answer: 'A friend.', sources: [], now: NOW })
    expect(r.check.status).toBe('held')
    expect(r.check.reason).toContain('does not cite any page')
  })

  it('checkAndFileAnswer: the AI verdict decides — supported is filed as passed, an unsupported claim is held with the claim', async () => {
    seed()
    const seen: string[] = []
    const ok = await checkAndFileAnswer(kb, { question: 'What does Greenway do?', answer: 'Greenway Growers supplies plants [[organizations/greenway-growers.md]].', sources: [], now: NOW },
      async (_s, p) => { seen.push(p); return '{"unsupported":[]}' })
    expect(ok.check).toMatchObject({ status: 'passed', checked_by: 'ai' })
    expect(seen[0]).toContain('Plant supplier.') // the cited page went to the AI
    expect(isHeldAnswerFile(path.join(kb, ok.rel))).toBe(false)

    const bad = await checkAndFileAnswer(kb, { question: 'When does Greenway deliver?', answer: 'Greenway Growers delivers on Tuesdays [[organizations/greenway-growers.md]].', sources: [], now: NOW },
      async () => JSON.stringify({ unsupported: [{ claim: 'delivers on Tuesdays', page: 'organizations/greenway-growers.md', why: 'The page says nothing about delivery days.' }] }))
    expect(bad.check).toMatchObject({ status: 'held', kind: 'ungrounded', checked_by: 'ai' })
    expect(bad.check.unsupported).toEqual([{ claim: 'delivers on Tuesdays', page: 'organizations/greenway-growers.md', why: 'The page says nothing about delivery days.' }])
    expect(read(bad.rel)).toContain('answer_check: held')
    expect(isHeldAnswerFile(path.join(kb, bad.rel))).toBe(true)
  })

  it('checkAndFileAnswer: an AI that fails leaves the answer unchecked, never lost', async () => {
    seed()
    const r = await checkAndFileAnswer(kb, { question: 'Who is Sam?', answer: 'Store manager [[people/sam-okafor.md]].', sources: [], now: NOW }, async () => { throw new Error('offline') })
    expect(r.check.status).toBe('unchecked')
    expect(r.check.ai_skipped).toContain('offline')
    expect(fs.existsSync(path.join(kb, r.rel))).toBe(true)
  })

  it('rejects an empty question or answer', () => {
    expect(() => fileAnswer(kb, { question: ' ', answer: 'x', sources: [] })).toThrow()
    expect(() => fileAnswer(kb, { question: 'q', answer: ' ', sources: [] })).toThrow()
  })

  it('rewriteCitations keeps unknown targets untouched', () => {
    expect(rewriteCitations('[[a/b.md]] and [[c.md]]', rel => (rel === 'a/b.md' ? 'B' : undefined))).toBe('[[a/b|B]] and [[c.md]]')
  })
})
