/**
 * Knowledge-base search eval (obj 900816): keyword vs hybrid vs semantic recall@5
 * over a COPY of a vault, plus backfill time and DB growth.
 *
 *   tsx server/src/scripts/kb-search-eval.ts --root /path/to/vault-copy \
 *       --queries docs/evals/kb-hybrid-search/<set>.json [--out report.md] [--model Xenova/all-MiniLM-L6-v2]
 *
 * The query file: { queries: [{ id, kind, q, relevant: [paths relative to --root] }] }.
 * Uses a throwaway SQLite file (never the live DB) and the LOCAL provider, so it
 * makes no paid API call. Prints a markdown report (also written to --out).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const root = path.resolve(arg('root') ?? '')
const queriesFile = arg('queries')
if (!arg('root') || !queriesFile || !fs.existsSync(root)) {
  console.error('usage: kb-search-eval.ts --root <vault copy> --queries <file.json> [--out report.md] [--model <hf id>]')
  process.exit(2)
}
// The keyword index reads the knowledge base root from env at call time.
process.env.SECOND_BRAIN_ROOT = root

const { createLocalProvider, PROVIDER_DEFAULTS } = await import('../services/kb-semantic/providers.js')
const { runBackfill } = await import('../services/kb-semantic/indexer.js')
const { searchKnowledgeBase } = await import('../services/kb-semantic/search.js')
const { ensureSchema } = await import('../services/kb-semantic/store.js')

interface Q { id: string; kind: string; q: string; relevant: string[] }
const spec = JSON.parse(fs.readFileSync(queriesFile, 'utf8')) as { queries: Q[] }

const model = arg('model') ?? PROVIDER_DEFAULTS.local.model
const provider = createLocalProvider({ provider: 'local', model, baseUrl: '', apiKeySecret: '', dimensions: PROVIDER_DEFAULTS.local.dimensions })
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-eval-'))
const dbPath = path.join(dbDir, 'eval.db')
const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)')
ensureSchema(db)
const size = () => {
  db.pragma('wal_checkpoint(TRUNCATE)')
  return fs.statSync(dbPath).size
}
const before = size()

// Warm the model so load time is reported separately from embedding time.
const tLoad = Date.now()
await provider.embed(['warm-up'], 'document')
const loadMs = Date.now() - tLoad

const t0 = Date.now()
const job = await runBackfill({ db, provider, root }, { trigger: 'eval' })
const backfillMs = Date.now() - t0
const after = size()

// Second pass = the incremental/resume path: everything is up to date.
const t1 = Date.now()
const job2 = await runBackfill({ db, provider, root }, { trigger: 'eval-resume' })
const resumeMs = Date.now() - t1

type Mode = 'keyword' | 'hybrid' | 'semantic'
const modes: Mode[] = ['keyword', 'hybrid', 'semantic']
const rows: Array<{ q: Q; per: Record<Mode, { recall: number; rr: number; top: string[] }> }> = []
const totals: Record<Mode, { recall: number; rr: number; hit: number; ms: number }> = {
  keyword: { recall: 0, rr: 0, hit: 0, ms: 0 }, hybrid: { recall: 0, rr: 0, hit: 0, ms: 0 }, semantic: { recall: 0, rr: 0, hit: 0, ms: 0 },
}
for (const q of spec.queries) {
  const rel = new Set(q.relevant.map(r => path.join(root, r)))
  const per = {} as Record<Mode, { recall: number; rr: number; top: string[] }>
  for (const mode of modes) {
    const ts = Date.now()
    const r = await searchKnowledgeBase(q.q, { mode, limit: 5, db, provider, root })
    totals[mode].ms += Date.now() - ts
    const top = r.results.map(h => h.path)
    const found = top.filter(p => rel.has(p)).length
    const firstRel = top.findIndex(p => rel.has(p))
    per[mode] = { recall: found / rel.size, rr: firstRel >= 0 ? 1 / (firstRel + 1) : 0, top: top.map(p => path.relative(root, p)) }
    totals[mode].recall += per[mode].recall
    totals[mode].rr += per[mode].rr
    totals[mode].hit += found > 0 ? 1 : 0
  }
  rows.push({ q, per })
}

const n = spec.queries.length
const pct = (x: number) => `${(100 * x).toFixed(1)}%`
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(2)} MB`
const byKind = (kind: string, mode: Mode) => {
  const rs = rows.filter(r => r.q.kind === kind)
  return rs.length ? pct(rs.reduce((s, r) => s + r.per[mode].recall, 0) / rs.length) : '—'
}
const kinds = [...new Set(spec.queries.map(q => q.kind))]
const lines: string[] = []
lines.push(`# KB search eval — ${path.basename(queriesFile)}`, '')
lines.push(`- Vault copy: ${job.total} markdown files; model \`${provider.modelId}\``)
lines.push(`- Backfill: ${job.embedded} files → ${job.chunks} chunks in **${(backfillMs / 1000).toFixed(1)} s** (model load ${loadMs} ms, ${job.failed} failed); status \`${job.status}\``)
lines.push(`- Re-run (resume / nothing changed): ${job2.skipped} skipped, ${job2.embedded} embedded in ${(resumeMs / 1000).toFixed(2)} s`)
lines.push(`- DB size: ${mb(before)} → ${mb(after)} (**+${mb(after - before)}**, ${(after - before) / Math.max(1, job.chunks) | 0} bytes/chunk)`)
lines.push('')
lines.push('| mode | recall@5 | hit@5 | MRR@5 | avg latency |', '|---|---|---|---|---|')
for (const m of modes) lines.push(`| ${m} | **${pct(totals[m].recall / n)}** | ${totals[m].hit}/${n} | ${(totals[m].rr / n).toFixed(3)} | ${(totals[m].ms / n).toFixed(0)} ms |`)
lines.push('')
lines.push(`| kind | n | ${modes.map(m => `${m} recall@5`).join(' | ')} |`, `|---|---|${modes.map(() => '---').join('|')}|`)
for (const k of kinds) lines.push(`| ${k} | ${rows.filter(r => r.q.kind === k).length} | ${modes.map(m => byKind(k, m)).join(' | ')} |`)
lines.push('')
lines.push('| id | query | keyword | hybrid | semantic |', '|---|---|---|---|---|')
for (const r of rows) lines.push(`| ${r.q.id} | ${r.q.q.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')} | ${pct(r.per.keyword.recall)} | ${pct(r.per.hybrid.recall)} | ${pct(r.per.semantic.recall)} |`)
const report = lines.join('\n') + '\n'
console.log(report)
if (process.argv.includes('--verbose')) {
  for (const r of rows) console.log(r.q.id, JSON.stringify({ kw: r.per.keyword.top, hy: r.per.hybrid.top }, null, 0))
}
const out = arg('out')
if (out) fs.writeFileSync(out, report)
db.close()
fs.rmSync(dbDir, { recursive: true, force: true })
