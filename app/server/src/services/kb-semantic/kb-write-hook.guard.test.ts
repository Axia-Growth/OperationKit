/**
 * Guard: one re-index hook on every knowledge-base write path (obj 900965).
 *
 * `noteKbChanged(absPath)` in services/kb-semantic/service.ts is the ONE hook a
 * write, move or delete path calls. It runs both halves: the semantic index
 * (`noteKbWrite`) and the link graph (`noteKbFileWritten`). Before it existed
 * several paths called one half or neither, so a new page was missing from
 * semantic search for up to 15 minutes, or from the graph until a rescan.
 *
 * Two rules, both read from source (comments ignored):
 *   1. Nobody calls a half directly. Only the files in HALF_HOOK_HOMES may
 *      name `noteKbWrite` / `noteKbFileWritten`.
 *   2. In the modules listed in KB_WRITE_MODULES, every file write, append,
 *      move or delete is followed by `noteKbChanged(` within a few lines, or
 *      is listed in NOT_A_KB_WRITE with the reason.
 *
 * A new module that writes into the knowledge base goes in KB_WRITE_MODULES.
 * Modelled on lib/no-hardcoded-brand.server.test.ts.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(import.meta.dirname, '..', '..')

/** The only files that may name the two half-hooks. */
const HALF_HOOK_HOMES = [
  'services/kb-semantic/service.ts', // defines noteKbWrite, calls both from noteKbChanged
  'services/kb-wiki/graph-sync.ts', // defines noteKbFileWritten
]

/**
 * Modules that write knowledge-base files with `fs` themselves. Value = how
 * many `noteKbChanged(` call sites the module has today. A changed count means
 * a write path was added or removed: update the number in the same change, so
 * the reviewer sees it.
 */
const KB_WRITE_MODULES: Record<string, number> = {
  'routes/docs.ts': 1, // PUT /api/docs/file (editor, MCP write_doc, card sessions)
  'routes/internal-vault.ts': 4, // append-note, append-touchpoint, update-field, create-contact
  'services/contacts.ts': 2, // createContact, patchContact
  'services/loops.ts': 6, // migrate, create, body, status, meta, archive (a move)
  'services/granola-content.ts': 3, // draft status, draft body, hook videos
  'services/agent-chat/tools.ts': 1, // chat write_doc
  'services/kb-wiki/wiki.ts': 1,
  'services/kb-wiki/answers.ts': 1,
  'services/kb-wiki/lint.ts': 1,
  'services/kb-wiki/imports.ts': 2,
  'services/kb-setup/runs.ts': 3,
  'services/doc-ingest/notes.ts': 2,
  'routes/decisions.ts': 1, // decisions/decision-log.md, through the injected noteWrite
  'services/agent-chat/bot-memory.ts': 2, // journal roll-over: archive month files, kept journal
}

/**
 * Modules where rule 2 is enforced line by line: every `fs` mutation needs the
 * hook right after it. The other KB_WRITE_MODULES also write uploads, run
 * state and staging files next to their knowledge-base writes, so they are
 * held by rule 1 and the call-site count instead.
 */
const STRICT_MODULES = [
  'routes/docs.ts',
  'routes/internal-vault.ts',
  'routes/kb-wiki.ts',
  'services/contacts.ts',
  'services/loops.ts',
  'services/granola-content.ts',
]

/** `fs` mutations in STRICT_MODULES that are not knowledge-base files. Match = file + the call as written. */
const NOT_A_KB_WRITE: Array<{ file: string; call: string; why: string }> = [
  {
    file: 'routes/kb-wiki.ts',
    call: 'fs.unlinkSync(f.path)', // cleanupUploads()
    why: 'multer temp uploads in the OS temp dir, never a knowledge-base file',
  },
]

const FS_MUTATION = /\bfs(?:\.promises)?\.(?:writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|rm|rmSync|copyFile|copyFileSync)\s*\(/
/** How many lines after the mutation the hook may sit (same statement block). */
const HOOK_WITHIN_LINES = 3

/** Strip // and block comments so prose about the hooks doesn't count. Line numbers are kept. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs, out)
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(abs)
  }
  return out
}

const rel = (abs: string) => path.relative(SRC, abs).split(path.sep).join('/')
const read = (r: string) => stripComments(fs.readFileSync(path.join(SRC, r), 'utf8'))

describe('knowledge-base writes go through the one re-index hook (noteKbChanged)', () => {
  it('every listed file exists (a rename must update this list, not silently drop it)', () => {
    const listed = [...HALF_HOOK_HOMES, ...Object.keys(KB_WRITE_MODULES), ...STRICT_MODULES, ...NOT_A_KB_WRITE.map(a => a.file)]
    const missing = [...new Set(listed)].filter(r => !fs.existsSync(path.join(SRC, r)))
    expect(missing).toEqual([])
  })

  it('noteKbChanged calls both halves', () => {
    const src = read('services/kb-semantic/service.ts')
    const start = src.indexOf('export function noteKbChanged(')
    expect(start).toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    expect(body).toMatch(/\bnoteKbWrite\(/)
    expect(body).toMatch(/\bnoteKbFileWritten\(/)
  })

  it('no file outside the hook homes calls a half-hook directly', () => {
    const hits: string[] = []
    for (const abs of walk(SRC)) {
      const r = rel(abs)
      if (HALF_HOOK_HOMES.includes(r)) continue
      stripComments(fs.readFileSync(abs, 'utf8')).split('\n').forEach((line, i) => {
        if (/\b(noteKbWrite|noteKbFileWritten)\b/.test(line)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
    }
    expect(hits, 'call noteKbChanged(absPath) instead: it runs both the semantic and the graph hook').toEqual([])
  })

  it('the allowed call sites are exactly the listed modules, with the listed counts', () => {
    const found: Record<string, number> = {}
    for (const abs of walk(SRC)) {
      const r = rel(abs)
      if (HALF_HOOK_HOMES.includes(r)) continue
      const n = (stripComments(fs.readFileSync(abs, 'utf8')).match(/\bnoteKbChanged\(/g) ?? []).length
      if (n) found[r] = n
    }
    expect(found).toEqual(KB_WRITE_MODULES)
  })

  it('in the strict modules every file write, move or delete is followed by the hook', () => {
    const hits: string[] = []
    for (const r of STRICT_MODULES) {
      const lines = read(r).split('\n')
      lines.forEach((line, i) => {
        if (!FS_MUTATION.test(line)) return
        if (NOT_A_KB_WRITE.some(a => a.file === r && line.includes(a.call))) return
        const window = lines.slice(i, i + 1 + HOOK_WITHIN_LINES).join('\n')
        if (!/\bnoteKbChanged\(/.test(window)) hits.push(`${r}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
    }
    expect(hits, 'add noteKbChanged(absPath) right after the write, or list the line in NOT_A_KB_WRITE with the reason').toEqual([])
  })

  it('every NOT_A_KB_WRITE entry still matches a line (a stale entry is removed, not kept)', () => {
    const stale = NOT_A_KB_WRITE.filter(a => !read(a.file).split('\n').some(l => l.includes(a.call))).map(a => `${a.file}: ${a.call}`)
    expect(stale).toEqual([])
  })

  it('the guard itself catches a write that skips the hook', () => {
    const bad = ['fs.writeFileSync(abs, text)', 'return { ok: true }']
    const good = ['fs.writeFileSync(abs, text)', 'noteKbChanged(abs)']
    const skips = (ls: string[]) => ls.some((l, i) => FS_MUTATION.test(l) && !/\bnoteKbChanged\(/.test(ls.slice(i, i + 1 + HOOK_WITHIN_LINES).join('\n')))
    expect(skips(bad)).toBe(true)
    expect(skips(good)).toBe(false)
  })
})
