/**
 * Saved-answer check eval (obj 901746, public issues #120 / #153): how often the
 * check catches an answer its cited pages do not back up, and how often it
 * holds a good one by mistake. Neighbour of kb-search-eval.ts (retrieval).
 *
 *   tsx server/src/scripts/kb-answer-eval.ts [--cases docs/evals/kb-answer-check/sample.json]
 *       [--ai none|live|replay] [--replies <replies.json>] [--out report.md] [--json result.json]
 *   tsx server/src/scripts/kb-answer-eval.ts --dump-prompts <dir>
 *
 *   --ai none    the AI-free citation rules only (default; no model call)
 *   --ai live    the install's own AI (the same one Ask and the wiki use)
 *   --ai replay  recorded replies {"<case id>": "<raw model reply>"}, so a measured
 *                run can be re-checked anywhere without a model or a key
 *   --dump-prompts  write system.txt + <id>.txt (exactly what the AI is sent) for
 *                recording replies, then exit
 *
 * The knowledge base is a throwaway temp folder built from the case file; the
 * live DB and the real knowledge base are never touched.
 */
import fs from 'node:fs'
import path from 'node:path'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const { validateSpec, runAnswerCheckEval, renderEvalReport, promptsFor } = await import('../services/kb-wiki/answer-check-eval.js')
const { VERIFY_SYSTEM } = await import('../services/kb-wiki/answer-check.js')

const casesFile = path.resolve(arg('cases') ?? path.join(import.meta.dirname, '../../../../docs/evals/kb-answer-check/sample.json'))
const spec = validateSpec(JSON.parse(fs.readFileSync(casesFile, 'utf8')))

const dump = arg('dump-prompts')
if (dump) {
  fs.mkdirSync(dump, { recursive: true })
  fs.writeFileSync(path.join(dump, 'system.txt'), VERIFY_SYSTEM)
  const prompts = promptsFor(spec)
  for (const p of prompts) fs.writeFileSync(path.join(dump, `${p.id}.txt`), p.prompt)
  console.log(`Wrote system.txt and ${prompts.length} prompts to ${dump} (the other ${spec.cases.length - prompts.length} cases are held by the rules, no AI call).`)
  process.exit(0)
}

const mode = arg('ai', 'none')!
let llmFor: (id: string) => ((s: string, p: string) => Promise<string>) | null
if (mode === 'none') llmFor = () => null
else if (mode === 'live') {
  const { wikiLlm } = await import('../services/kb-wiki/llm.js')
  const llm = wikiLlm()
  llmFor = () => llm
} else if (mode === 'replay') {
  const file = arg('replies')
  if (!file) { console.error('--ai replay needs --replies <file.json>'); process.exit(2) }
  const replies = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
  llmFor = id => async () => {
    if (typeof replies[id] !== 'string') throw new Error(`no recorded reply for ${id}`)
    return replies[id]
  }
} else {
  console.error('--ai must be none, live or replay')
  process.exit(2)
}

const result = await runAnswerCheckEval(spec, llmFor, mode === 'replay' ? `replay of ${path.basename(arg('replies')!)}` : mode)
const report = renderEvalReport(result)
console.log(report)
const out = arg('out')
if (out) fs.writeFileSync(out, report)
const json = arg('json')
if (json) fs.writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`)
