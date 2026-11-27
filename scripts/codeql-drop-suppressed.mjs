#!/usr/bin/env node
// ---------------------------------------------------------------------------
// codeql-drop-suppressed.mjs — used by .github/workflows/codeql.yml on PR runs.
//
// CodeQL's AlertSuppression query marks a result `suppressions: [{kind:
// "inSource"}]` when the line above it carries a justified
//     // codeql[<rule-id>] -- <reason>
// comment. GitHub code scanning does not act on that field when the SARIF is
// uploaded. On main, advanced-security/dismiss-alerts closes the matching
// alerts after upload. A PR run cannot do that (it must not dismiss alerts on
// code that is not merged yet), so without this step a PR shows every
// suppressed finding as a "new" alert until the PR merges and main is analysed.
//
// This script removes ONLY results CodeQL itself marked suppressed in source,
// and prints each one it removed so the run log keeps the audit trail. Results
// with no suppression, or with any other suppression kind, are left alone.
//
// Usage: node scripts/codeql-drop-suppressed.mjs <sarif-file-or-dir>
// ---------------------------------------------------------------------------
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** True when CodeQL marked this result suppressed by an in-source comment. */
export function isInSourceSuppressed(result) {
  const s = result && result.suppressions
  if (!Array.isArray(s) || s.length === 0) return false
  // SARIF 2.1.0: status defaults to "accepted" when absent.
  return s.some((x) => x && x.kind === 'inSource' && (x.status === undefined || x.status === 'accepted'))
}

function describe(result) {
  const loc = result.locations?.[0]?.physicalLocation
  const where = loc ? `${loc.artifactLocation?.uri ?? '?'}:${loc.region?.startLine ?? '?'}` : '?'
  return `${result.ruleId ?? result.rule?.id ?? '?'} ${where}`
}

/** Returns { sarif, dropped } with suppressed results removed. Does not mutate the input. */
export function dropSuppressed(sarif) {
  const dropped = []
  const runs = (sarif.runs ?? []).map((run) => {
    if (!Array.isArray(run.results)) return run
    const kept = []
    for (const r of run.results) {
      if (isInSourceSuppressed(r)) dropped.push(describe(r))
      else kept.push(r)
    }
    return { ...run, results: kept }
  })
  return { sarif: { ...sarif, runs }, dropped }
}

function sarifFiles(target) {
  if (statSync(target).isFile()) return [target]
  const out = []
  for (const name of readdirSync(target)) {
    const p = join(target, name)
    if (statSync(p).isDirectory()) out.push(...sarifFiles(p))
    else if (name.endsWith('.sarif') || name.endsWith('.sarif.json')) out.push(p)
  }
  return out
}

function main(argv) {
  const target = argv[2]
  if (!target) {
    console.error('usage: codeql-drop-suppressed.mjs <sarif-file-or-dir>')
    return 2
  }
  const files = sarifFiles(target)
  if (files.length === 0) {
    console.error(`no .sarif files under ${target}`)
    return 1
  }
  for (const f of files) {
    const { sarif, dropped } = dropSuppressed(JSON.parse(readFileSync(f, 'utf8')))
    writeFileSync(f, JSON.stringify(sarif))
    console.log(`${f}: dropped ${dropped.length} result(s) suppressed in source`)
    for (const d of dropped) console.log(`  suppressed  ${d}`)
  }
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv)
}
