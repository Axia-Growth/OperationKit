import fs from 'fs'
import os from 'os'
import path from 'path'
import type { LlmCall } from '../doc-ingest/llm.js'
import { buildVerifyPrompt, ruleCheck, verifyAnswer, type AnswerCheck } from './answer-check.js'

/**
 * Answer-level eval for the saved-answer check (obj 901746): a small knowledge
 * base plus answers with a known verdict, run through `verifyAnswer` exactly as
 * saving does, to measure how often an unsupported answer is caught (held) and
 * how often a good one is held by mistake. The keyword/semantic retrieval eval
 * is its neighbour, `scripts/kb-search-eval.ts`; the CLI for this one is
 * `scripts/kb-answer-eval.ts`, and the case sets live in `docs/evals/kb-answer-check/`.
 */

export interface EvalCase {
  id: string
  /** What the case exercises (supported, paraphrase, wrong_citation, invented_number…). */
  kind: string
  expect: 'supported' | 'unsupported'
  question: string
  answer: string
  sources: string[]
}

export interface EvalSpec {
  name: string
  description?: string
  /** KB-relative path → page text, written into a throwaway knowledge base. */
  pages: Record<string, string>
  cases: EvalCase[]
}

export interface EvalRow {
  id: string
  kind: string
  expect: EvalCase['expect']
  status: AnswerCheck['status']
  checked_by: AnswerCheck['checked_by']
  /** held === (expect is 'unsupported') */
  correct: boolean
  reason?: string
  ai_skipped?: string
}

export interface EvalTotals {
  cases: number
  bad: number
  good: number
  /** Unsupported answers held. */
  caught: number
  /** …of which the AI-free rules alone caught. */
  caught_by_rules: number
  /** Supported answers held by mistake. */
  false_holds: number
  /** Answers the AI did not judge (no AI, or it failed): neither caught nor held. */
  unchecked: number
  catch_rate: number
  false_hold_rate: number
}

export interface EvalResult { spec: string; mode: string; rows: EvalRow[]; totals: EvalTotals }

/** Fail fast on a malformed case file. */
export function validateSpec(v: unknown): EvalSpec {
  const s = v as EvalSpec
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.pages || typeof s.pages !== 'object' || !Array.isArray(s.cases)) {
    throw new Error('A case file needs name, pages {path: text} and cases [].')
  }
  const ids = new Set<string>()
  for (const c of s.cases) {
    if (!c || typeof c.id !== 'string' || ids.has(c.id)) throw new Error(`Case ids must be unique strings (${JSON.stringify(c?.id)}).`)
    ids.add(c.id)
    if (c.expect !== 'supported' && c.expect !== 'unsupported') throw new Error(`Case ${c.id}: expect must be supported or unsupported.`)
    if (typeof c.question !== 'string' || typeof c.answer !== 'string' || !Array.isArray(c.sources)) throw new Error(`Case ${c.id}: question, answer and sources are required.`)
  }
  for (const rel of Object.keys(s.pages)) {
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`Page path ${rel} must be relative and stay inside the knowledge base.`)
  }
  return s
}

/** Write the spec's pages into a fresh temp knowledge base. The caller removes it. */
export function materialize(spec: EvalSpec): string {
  const kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-answer-eval-'))
  for (const [rel, text] of Object.entries(spec.pages)) {
    const abs = path.join(kb, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, text)
  }
  return kb
}

/**
 * The exact prompt the AI would get for each case the rules let through (the
 * rules hold the rest without an AI call). Used to record replies for a
 * reproducible `replay` run.
 */
export function promptsFor(spec: EvalSpec): Array<{ id: string; prompt: string }> {
  const kb = materialize(spec)
  try {
    return spec.cases.flatMap(c => {
      const rules = ruleCheck(kb, c)
      if (rules.problems.length) return []
      const pages = rules.pages.map(rel => ({ rel, text: fs.readFileSync(path.join(kb, rel), 'utf8') }))
      return [{ id: c.id, prompt: buildVerifyPrompt(c.question, c.answer, pages, 'eval') }]
    })
  } finally { fs.rmSync(kb, { recursive: true, force: true }) }
}

const ratio = (n: number, d: number) => (d ? n / d : 0)

export function summarize(rows: EvalRow[]): EvalTotals {
  const bad = rows.filter(r => r.expect === 'unsupported')
  const good = rows.filter(r => r.expect === 'supported')
  const caught = bad.filter(r => r.status === 'held')
  const falseHolds = good.filter(r => r.status === 'held')
  return {
    cases: rows.length,
    bad: bad.length,
    good: good.length,
    caught: caught.length,
    caught_by_rules: caught.filter(r => r.checked_by === 'rules').length,
    false_holds: falseHolds.length,
    unchecked: rows.filter(r => r.status === 'unchecked').length,
    catch_rate: ratio(caught.length, bad.length),
    false_hold_rate: ratio(falseHolds.length, good.length),
  }
}

/**
 * Run every case through `verifyAnswer`. `llmFor(id)` gives the AI for one case
 * (null = rules only), so a recorded reply can be replayed per case.
 */
export async function runAnswerCheckEval(spec: EvalSpec, llmFor: (id: string) => LlmCall | null, mode = 'custom'): Promise<EvalResult> {
  const kb = materialize(spec)
  try {
    const rows: EvalRow[] = []
    for (const c of spec.cases) {
      const check = await verifyAnswer(kb, c, llmFor(c.id), { workspace: 'eval' })
      const held = check.status === 'held'
      rows.push({
        id: c.id, kind: c.kind, expect: c.expect, status: check.status, checked_by: check.checked_by,
        correct: held === (c.expect === 'unsupported'),
        ...(check.reason ? { reason: check.reason } : {}),
        ...(check.ai_skipped ? { ai_skipped: check.ai_skipped } : {}),
      })
    }
    return { spec: spec.name, mode, rows, totals: summarize(rows) }
  } finally { fs.rmSync(kb, { recursive: true, force: true }) }
}

const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const cell = (s: string) => s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\s+/g, ' ')

export function renderEvalReport(r: EvalResult): string {
  const t = r.totals
  const lines = [
    `# Saved-answer check eval — ${r.spec} (${r.mode})`, '',
    `- Unsupported answers caught (held): **${t.caught}/${t.bad} = ${pct(t.catch_rate)}** (${t.caught_by_rules} by the citation rules alone, ${t.caught - t.caught_by_rules} by the AI)`,
    `- Supported answers held by mistake: **${t.false_holds}/${t.good} = ${pct(t.false_hold_rate)}**`,
    `- Not judged by the AI (no AI, or it failed): ${t.unchecked}`,
    '',
    '| kind | cases | right |', '|---|---|---|',
  ]
  for (const kind of [...new Set(r.rows.map(x => x.kind))]) {
    const of = r.rows.filter(x => x.kind === kind)
    lines.push(`| ${kind} | ${of.length} | ${of.filter(x => x.correct).length} |`)
  }
  lines.push('', '| id | kind | expected | result | by | right | reason |', '|---|---|---|---|---|---|---|')
  for (const x of r.rows) {
    lines.push(`| ${x.id} | ${x.kind} | ${x.expect} | ${x.status} | ${x.checked_by} | ${x.correct ? 'yes' : '**no**'} | ${cell(x.reason ?? x.ai_skipped ?? '')} |`)
  }
  return `${lines.join('\n')}\n`
}
