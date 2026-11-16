#!/usr/bin/env node
// vault-migrate.mjs — move knowledge-base files inside ONE workspace folder
// without breaking links (obj 900968; step 3 of the knowledge base migration
// plan in the 2026-11-15 quality audit).
//
//   node scripts/vault-migrate.mjs --workspace <folder> --map <mapping.csv>            # dry run
//   node scripts/vault-migrate.mjs --workspace <folder> --map <mapping.csv> --apply    # write
//
// Mapping CSV: old_path,new_path,type — paths relative to the workspace folder.
//
// What it does, in this order:
//   1. Validates every row. ANY problem refuses the whole run before a byte is
//      written (absolute paths, "..", symlinks, a missing source, a taken
//      destination, duplicates, chains).
//   2. Moves the files.
//   3. Rewrites [[wiki links]] and relative markdown links in every markdown
//      file of the workspace that points at a moved file, and the relative
//      links INSIDE a moved file (its own folder changed).
//   4. Adds missing front matter keys (title, type, date, workspace) to the
//      mapped markdown files. An existing key is never changed.
//   5. Appends the moves to the redirect table archive/moved.md.
//   6. Prints a report.
//
// Dry run is the default and shares the planner with --apply, so the dry-run
// report is exactly what --apply will do. A second run with the same mapping is
// a no-op. Plain Node, no dependencies. Full page: docs/knowledge-base/vault-migrate.md

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const posix = path.posix
export const REDIRECT_FILE = 'archive/moved.md'
const FRONT_MATTER_KEYS = ['title', 'type', 'date', 'workspace']
const SKIP_DIRS = new Set(['node_modules'])

// ---------------------------------------------------------------- CSV

/** Minimal RFC 4180 reader: quoted cells, "" escapes, CRLF, BOM. Blank lines and # comments are skipped. */
export function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  const src = text.replace(/^﻿/, '')
  const endRow = () => {
    row.push(cell)
    cell = ''
    const blank = row.every((c) => c.trim() === '')
    const comment = row[0].trim().startsWith('#')
    if (!blank && !comment) rows.push({ line: rowLine, cells: row.map((c) => c.trim()) })
    row = []
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++ }
      else if (ch === '"') quoted = false
      else { if (ch === '\n') line++; cell += ch }
    } else if (ch === '"' && cell.trim() === '') { cell = ''; quoted = true }
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      rowLine = line
    } else cell += ch
  }
  if (cell !== '' || row.length) endRow()
  if (rows.length && /^(old|old[_ ]path|from)$/i.test(rows[0].cells[0])) rows.shift()
  return rows
}

// ---------------------------------------------------------------- paths

/** A mapping path must be a plain relative path that stays inside the workspace. Returns {rel} or {error}. */
export function checkRelPath(raw) {
  const p = String(raw ?? '').trim()
  if (!p) return { error: 'empty path' }
  if (p.includes('\0')) return { error: 'path contains a NUL byte' }
  if (p.includes('\\')) return { error: 'backslashes are not allowed (use /)' }
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.startsWith('~')) return { error: 'absolute paths are not allowed' }
  const segs = p.split('/')
  if (segs.includes('..')) return { error: 'paths with ".." are refused' }
  const clean = segs.filter((s) => s !== '' && s !== '.')
  if (!clean.length || p.endsWith('/')) return { error: 'not a file path' }
  if (clean.some((s) => s.startsWith('.'))) return { error: 'hidden files and folders are not moved' }
  return { rel: clean.join('/') }
}

const isMd = (rel) => /\.md$/i.test(rel)
const dirOf = (rel) => { const d = posix.dirname(rel); return d === '.' ? '' : d }
const stripMd = (rel) => rel.replace(/\.md$/i, '')

/** Every regular file and folder under root (posix-relative). Symlinks and hidden folders are never followed. */
function walk(root) {
  const files = new Set()
  const dirs = new Set([''])
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.isSymbolicLink()) continue
      const child = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        dirs.add(child)
        stack.push(child)
      } else if (ent.isFile()) files.add(child)
    }
  }
  return { files, dirs }
}

/** First symlink on the way from root down to rel (existing parts only), or null. */
function symlinkOnPath(root, rel) {
  let cur = root
  for (const seg of rel.split('/')) {
    cur = path.join(cur, seg)
    let st
    try { st = fs.lstatSync(cur) } catch { return null }
    if (st.isSymbolicLink()) return path.relative(root, cur)
  }
  return null
}

// ---------------------------------------------------------------- front matter

function yamlScalar(v) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(v) ? v : JSON.stringify(v)
}

const isSpace = (ch) => /\s/.test(ch)
const isLineTerminator = (ch) => ch === '\n' || ch === '\r' || ch === ' ' || ch === ' '

/**
 * The trimmed text of a level-1 ATX heading (`# Title ##`), or null when the
 * line is not one. Same result as `line.match(/^#\s+(.+?)\s*#*\s*$/)?.[1].trim()`
 * (a match whose title is all blank gives ''), computed in one linear pass:
 * that regex backtracks polynomially on long runs of spaces and `#`.
 */
export function atxHeadingText(line) {
  const len = line.length
  if (len < 2 || line[0] !== '#' || !isSpace(line[1])) return null
  let start = 1
  while (start < len && isSpace(line[start])) start++
  // Start of the longest suffix (after the leading '#') shaped \s* #* \s*.
  let tail = len
  while (tail > 1 && isSpace(line[tail - 1])) tail--
  while (tail > 1 && line[tail - 1] === '#') tail--
  while (tail > 1 && isSpace(line[tail - 1])) tail--
  if (start === len) {
    // All blank: the regex hands one blank back to (.+?), and `.` needs a non-terminator.
    for (let i = 2; i < len; i++) if (!isLineTerminator(line[i])) return ''
    return null
  }
  const text = line.slice(start, Math.max(start + 1, tail))
  for (const ch of text) if (isLineTerminator(ch)) return null
  return text.trim()
}

function titleFor(body, rel) {
  let fence = null
  for (const line of body.split(/\r?\n/)) {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (f) { fence = fence ? (f[1][0] === fence ? null : fence) : f[1][0]; continue }
    if (fence) continue
    const h = atxHeadingText(line)
    if (h !== null) return h
  }
  const base = stripMd(posix.basename(rel)).replace(/^\d{4}-\d{2}-\d{2}[-_ ]?/, '').replace(/[-_]+/g, ' ').trim()
  const name = base || stripMd(posix.basename(rel))
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function typeFromFolder(rel) {
  const top = rel.includes('/') ? rel.split('/')[0] : ''
  if (!top) return 'note'
  if (/ies$/i.test(top)) return top.slice(0, -3) + 'y'
  if (/(ss|x|ch|sh)es$/i.test(top)) return top.slice(0, -2)
  return top.length > 1 && /s$/i.test(top) ? top.slice(0, -1) : top
}

/**
 * Add the missing ones of `values` to the page's front matter. Existing keys
 * (any case) are left exactly as they are; a page with no front matter gets a
 * new block. Returns {content, added} or {skip: reason}.
 */
export function addFrontMatter(content, values) {
  const bom = content.startsWith('﻿') ? '﻿' : ''
  const text = bom ? content.slice(1) : content
  const eol = /\r\n/.test(text) ? '\r\n' : '\n'
  const render = (keys) => keys.map((k) => `${k}: ${k === 'date' ? values[k] : yamlScalar(values[k])}${eol}`).join('')
  const first = text.match(/^---[ \t]*\r?\n/)
  if (!first) {
    const keys = FRONT_MATTER_KEYS.filter((k) => values[k])
    return { content: `${bom}---${eol}${render(keys)}---${eol}${eol}${text}`, added: keys }
  }
  const have = new Set()
  let offset = first[0].length
  let close = -1
  while (offset <= text.length) {
    const nl = text.indexOf('\n', offset)
    const line = text.slice(offset, nl === -1 ? text.length : nl).replace(/\r$/, '')
    if (/^(---|\.\.\.)[ \t]*$/.test(line)) { close = offset; break }
    const key = line.match(/^([A-Za-z0-9_-]+)[ \t]*:/)
    if (key) have.add(key[1].toLowerCase())
    if (nl === -1) break
    offset = nl + 1
  }
  if (close === -1) return { skip: 'front matter block is never closed' }
  const keys = FRONT_MATTER_KEYS.filter((k) => values[k] && !have.has(k))
  if (!keys.length) return { content, added: [] }
  return { content: bom + text.slice(0, close) + render(keys) + text.slice(close), added: keys }
}

// ---------------------------------------------------------------- link rewriting

/**
 * Index of the first run of EXACTLY n backticks at or after `from` (runs are
 * maximal: no backtick right before or after), or -1. `from` must not sit
 * inside a backtick run. A plain scan, so no RegExp is built from the text.
 */
export function findClosingTickRun(line, from, n) {
  let i = from
  while (i < line.length) {
    if (line[i] !== '`') { i++; continue }
    let j = i
    while (j < line.length && line[j] === '`') j++
    if (j - i === n) return i
    i = j
  }
  return -1
}

/** Calls fn(text) on every stretch of markdown that is NOT code (fenced block or inline span). */
export function mapOutsideCode(content, fn) {
  const parts = content.split(/(\r?\n)/)
  let fence = null
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/)
    if (f) {
      if (!fence) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
      continue
    }
    if (fence || !line) continue
    let out = ''
    let pos = 0
    const tick = /`+/g
    let m
    while ((m = tick.exec(line))) {
      const c = findClosingTickRun(line, m.index + m[0].length, m[0].length)
      if (c === -1) continue
      out += fn(line.slice(pos, m.index), m.index === 0) + line.slice(m.index, c + m[0].length)
      pos = c + m[0].length
      tick.lastIndex = pos
    }
    parts[i] = out + fn(line.slice(pos), pos === 0)
  }
  return parts.join('')
}

const WIKI_RE = /(!?\[\[)([^[\]|#\n]*)(#[^[\]|\n]*)?(\|[^[\]\n]*)?(\]\])/g
const MD_LINK_RE = /(\]\()(<[^>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)(\s+(?:"[^"\n]*"|'[^'\n]*'))?(\s*\))/g
const REF_DEF_RE = /^( {0,3}\[[^\]\n]+\]:[ \t]*)(<[^>\n]*>|\S+)/

// ---------------------------------------------------------------- planner

/**
 * Work out everything a run would do, touching nothing.
 * opts: { workspace, rows: [{line, cells}], today?: 'YYYY-MM-DD', workspaceName? }
 */
export function buildPlan(opts) {
  const plan = {
    workspace: '', workspaceName: '', errors: [], warnings: [],
    moves: [], alreadyMoved: [], inPlace: [], links: [], frontMatter: [], mentions: [],
    writes: new Map(), redirect: null,
  }
  let root
  try {
    root = fs.realpathSync(path.resolve(opts.workspace))
    if (!fs.statSync(root).isDirectory()) throw new Error('not a folder')
  } catch (e) {
    plan.errors.push(`workspace folder not usable: ${opts.workspace} (${e.code || e.message})`)
    return plan
  }
  if (root === path.parse(root).root) {
    plan.errors.push('refusing to use the filesystem root as the workspace folder')
    return plan
  }
  plan.workspace = root
  const wsName = plan.workspaceName = opts.workspaceName || path.basename(root)
  const today = opts.today || new Date().toISOString().slice(0, 10)
  const { files, dirs } = walk(root)

  // ---- 1. validate the mapping
  const rows = []
  const seenOld = new Map()
  const seenNew = new Map()
  for (const r of opts.rows) {
    const at = `row ${r.line}`
    if (r.cells.length < 2) { plan.errors.push(`${at}: needs old_path,new_path[,type]`); continue }
    const o = checkRelPath(r.cells[0])
    const n = checkRelPath(r.cells[1])
    if (o.error) plan.errors.push(`${at}: old path "${r.cells[0]}": ${o.error}`)
    if (n.error) plan.errors.push(`${at}: new path "${r.cells[1]}": ${n.error}`)
    if (o.error || n.error) continue
    const type = (r.cells[2] || '').trim()
    if (type && !/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/.test(type)) { plan.errors.push(`${at}: type "${type}" has characters that are not allowed`); continue }
    if (seenOld.has(o.rel)) plan.errors.push(`${at}: old path ${o.rel} is already on row ${seenOld.get(o.rel)}`)
    if (seenNew.has(n.rel)) plan.errors.push(`${at}: new path ${n.rel} is already on row ${seenNew.get(n.rel)}`)
    seenOld.set(o.rel, r.line)
    seenNew.set(n.rel, r.line)
    rows.push({ line: r.line, old: o.rel, new: n.rel, type })
  }
  for (const r of rows) {
    const at = `row ${r.line}`
    if (r.old === REDIRECT_FILE || r.new === REDIRECT_FILE) { plan.errors.push(`${at}: ${REDIRECT_FILE} is the redirect table and cannot be moved or replaced`); continue }
    if (r.old !== r.new && seenOld.has(r.new)) { plan.errors.push(`${at}: new path ${r.new} is also an old path (row ${seenOld.get(r.new)}); chained moves are refused`); continue }
    for (const p of [r.old, r.new]) {
      const link = symlinkOnPath(root, p)
      if (link) plan.errors.push(`${at}: ${p} goes through a symlink (${link}); refused`)
    }
    const parent = dirOf(r.new)
    for (let d = parent; d; d = dirOf(d)) if (files.has(d)) plan.errors.push(`${at}: ${d} is a file, so ${r.new} cannot be created`)
    if (dirs.has(r.new)) { plan.errors.push(`${at}: new path ${r.new} is a folder`); continue }
    const hasOld = files.has(r.old)
    const hasNew = files.has(r.new)
    if (r.old === r.new) {
      if (!hasOld) plan.errors.push(`${at}: ${r.old} does not exist`)
      else plan.inPlace.push(r)
    } else if (hasOld && hasNew) plan.errors.push(`${at}: ${r.new} already exists; will not overwrite`)
    else if (hasOld) plan.moves.push(r)
    else if (hasNew) plan.alreadyMoved.push(r)
    else plan.errors.push(`${at}: ${r.old} does not exist (and ${r.new} is not there either)`)
  }
  if (symlinkOnPath(root, REDIRECT_FILE)) plan.errors.push(`${REDIRECT_FILE} goes through a symlink; refused`)
  if (dirs.has(REDIRECT_FILE) || files.has(dirOf(REDIRECT_FILE))) plan.errors.push(`${REDIRECT_FILE} cannot be written (a file or folder is in the way)`)
  if (plan.errors.length) return plan

  // ---- 2. where things go
  const moveMap = new Map(plan.moves.map((r) => [r.old, r.new]))
  // A link that still points at the OLD path of an already-moved file is fixed too.
  const redirect = new Map(moveMap)
  for (const r of plan.alreadyMoved) redirect.set(r.old, r.new)
  const tree = new Set(files)
  for (const r of plan.alreadyMoved) tree.add(r.old)
  const post = (rel) => redirect.get(rel) ?? rel
  const postFiles = new Set([...files].map(post))

  const byName = new Map()
  const postByName = new Map()
  const index = (map, rel) => {
    const k = stripMd(posix.basename(rel)).toLowerCase()
    if (!map.has(k)) map.set(k, new Set())
    map.get(k).add(rel)
  }
  for (const f of tree) index(byName, f)
  for (const f of postFiles) index(postByName, f)

  const rootSegs = root.split(path.sep).filter(Boolean)
  const lookup = (t) => (tree.has(t) ? t : tree.has(`${t}.md`) ? `${t}.md` : null)

  /** Which file a wiki target means BEFORE the move: {pre, style, prefix?} | {ambiguous} | null. */
  const resolveWiki = (target, preDir) => {
    const t = target.replace(/^\/+/, '')
    if (/^\.\.?\//.test(target)) {
      const joined = posix.normalize(posix.join(preDir, target))
      const hit = joined.startsWith('..') ? null : lookup(joined)
      return hit ? { pre: hit, style: 'rel' } : null
    }
    if (t.includes('/')) {
      const hit = lookup(t)
      if (hit) return { pre: hit, style: 'ws' }
      for (let i = rootSegs.length - 1; i >= 0; i--) {
        const prefix = rootSegs.slice(i).join('/') + '/'
        if (t.startsWith(prefix)) {
          const inner = lookup(t.slice(prefix.length))
          if (inner) return { pre: inner, style: 'prefixed', prefix }
        }
      }
      return null
    }
    const cands = byName.get(stripMd(t).toLowerCase())
    if (!cands) return null
    const exact = [...cands].filter((c) => posix.basename(c) === t || posix.basename(c) === `${t}.md`)
    const pool = exact.length ? exact : [...cands]
    const dests = new Set(pool.map(post))
    if (dests.size > 1) return pool.some((c) => redirect.has(c)) ? { ambiguous: pool } : null
    return { pre: pool.find((c) => redirect.has(c)) ?? pool[0], style: 'name' }
  }

  // ---- 3. rewrite links, file by file
  for (const cur of [...files].filter(isMd).sort()) {
    if (cur === REDIRECT_FILE) continue
    const finalRel = post(cur)
    const fileMoves = moveMap.has(cur)
    const preDir = dirOf(cur)
    const postDir = dirOf(finalRel)
    const original = fs.readFileSync(path.join(root, cur), 'utf8')
    const note = (from, to) => plan.links.push({ file: finalRel, from, to })

    const wiki = (whole, open, rawTarget, heading = '', alias = '', close) => {
      let target = rawTarget
      let tail = ''
      if (target.endsWith('\\')) { target = target.slice(0, -1); tail = '\\' } // [[a\|b]] inside a table
      const trimmed = target.trim()
      if (!trimmed) return whole
      const res = resolveWiki(trimmed, preDir)
      if (!res) return whole
      if (res.ambiguous) {
        plan.warnings.push(`${finalRel}: ${whole} could mean ${res.ambiguous.join(' or ')}; left as written`)
        return whole
      }
      const dest = post(res.pre)
      if (dest === res.pre && !(res.style === 'rel' && fileMoves)) return whole
      const hadExt = /\.md$/i.test(trimmed)
      const shape = (rel) => (hadExt || !isMd(rel) ? rel : stripMd(rel))
      let next
      if (res.style === 'ws') next = (trimmed.startsWith('/') ? '/' : '') + shape(dest)
      else if (res.style === 'prefixed') next = (trimmed.startsWith('/') ? '/' : '') + res.prefix + shape(dest)
      else if (res.style === 'rel') {
        const rel = posix.relative(postDir, dest)
        next = shape(rel.startsWith('.') ? rel : `./${rel}`)
      } else {
        const newBase = stripMd(posix.basename(dest))
        if (newBase.toLowerCase() === stripMd(trimmed).toLowerCase()) return whole // same name still finds it
        const unique = (postByName.get(newBase.toLowerCase())?.size ?? 0) <= 1
        next = unique ? shape(posix.basename(dest)) : shape(dest)
      }
      if (next === trimmed) return whole
      const rewritten = `${open}${target.replace(trimmed, () => next)}${tail}${heading}${alias}${close}`
      note(whole, rewritten)
      return rewritten
    }

    const href = (raw) => {
      const angle = raw.startsWith('<') && raw.endsWith('>')
      const inner = angle ? raw.slice(1, -1) : raw
      if (!inner || /^[a-z][a-z0-9+.-]*:/i.test(inner) || /^[#/?]/.test(inner)) return null
      const cut = inner.search(/[#?]/)
      const pathPart = cut === -1 ? inner : inner.slice(0, cut)
      const suffix = cut === -1 ? '' : inner.slice(cut)
      let decoded = pathPart
      try { decoded = decodeURIComponent(pathPart) } catch { /* keep as written */ }
      const slash = decoded.endsWith('/')
      const joined = posix.normalize(posix.join(preDir, decoded)).replace(/\/$/, '')
      const pre = joined === '.' ? '' : joined
      let rel
      if (pre === '..' || pre.startsWith('../')) {
        // Points outside the workspace: only the moved file's own position matters.
        if (!fileMoves || !fs.existsSync(path.join(root, pre))) return null
        rel = path.relative(path.join(root, postDir), path.join(root, pre)).split(path.sep).join('/')
      } else {
        const known = tree.has(pre) || dirs.has(pre)
        if (!known) {
          if (fileMoves) plan.warnings.push(`${finalRel}: link target "${pathPart}" was not found; left as written`)
          return null
        }
        const dest = post(pre)
        if (dest === pre && !fileMoves) return null
        rel = posix.relative(postDir, dest) || '.'
      }
      if (slash && !rel.endsWith('/')) rel += '/'
      if (decoded.startsWith('./') && !rel.startsWith('.')) rel = `./${rel}`
      if (decoded !== pathPart) rel = encodeURI(rel)
      else if (!angle) rel = rel.replace(/ /g, '%20')
      if (rel === pathPart) return null
      return (angle ? `<${rel}>` : rel) + suffix
    }

    let content = mapOutsideCode(original, (text, lineStart) => {
      let out = text.replace(WIKI_RE, wiki)
      out = out.replace(MD_LINK_RE, (whole, open, dest, title = '', close) => {
        const next = href(dest)
        if (next === null) return whole
        note(`${open}${dest}${close}`.replace(/\s+/g, ''), `${open}${next}${close}`.replace(/\s+/g, ''))
        return `${open}${next}${title}${close}`
      })
      if (lineStart) {
        out = out.replace(REF_DEF_RE, (whole, label, dest) => {
          const next = href(dest)
          if (next === null) return whole
          note(whole.trim(), `${label}${next}`.trim())
          return `${label}${next}`
        })
      }
      return out
    })

    // ---- 4. front matter, for the mapped pages only
    const row = plan.moves.find((r) => r.old === cur) || plan.alreadyMoved.find((r) => r.new === cur) || plan.inPlace.find((r) => r.old === cur)
    if (row) {
      const dated = posix.basename(finalRel).match(/^(\d{4}-\d{2}-\d{2})/)
      const fm = addFrontMatter(content, {
        title: titleFor(content.replace(/^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n(---|\.\.\.)[ \t]*(\r?\n|$)/, ''), finalRel),
        type: row.type || typeFromFolder(finalRel),
        date: dated ? dated[1] : fs.statSync(path.join(root, cur)).mtime.toISOString().slice(0, 10),
        workspace: wsName,
      })
      if (fm.skip) plan.warnings.push(`${finalRel}: ${fm.skip}; front matter left alone`)
      else if (fm.added.length) {
        content = fm.content
        plan.frontMatter.push({ file: finalRel, added: fm.added })
      }
    }

    if (content !== original) plan.writes.set(finalRel, content)
    for (const old of moveMap.keys()) {
      if (content.includes(old)) plan.mentions.push({ file: finalRel, path: old })
    }
  }

  // ---- 5. redirect table
  const tableRows = [...plan.moves, ...plan.alreadyMoved]
  if (tableRows.length) {
    const cellOf = (s) => '`' + s.replace(/\|/g, '\\|') + '`'
    const existing = files.has(REDIRECT_FILE) ? fs.readFileSync(path.join(root, REDIRECT_FILE), 'utf8') : null
    const fresh = tableRows.filter((r) => !existing || !existing.includes(`| ${cellOf(r.old)} | ${cellOf(r.new)} |`))
    if (fresh.length) {
      const header = '| Old path | New path | Type | Moved |\n|---|---|---|---|\n'
      const lines = fresh.map((r) => `| ${cellOf(r.old)} | ${cellOf(r.new)} | ${r.type || typeFromFolder(r.new)} | ${today} |\n`).join('')
      let content
      if (existing === null) {
        content = `---\ntitle: Moved pages\ntype: redirect\ndate: ${today}\nworkspace: ${yamlScalar(wsName)}\n---\n\n# Moved pages\n\n` +
          'Where pages went when the knowledge base was reorganised. Written by `scripts/vault-migrate.mjs`; one row per moved file.\n\n' + header + lines
      } else {
        const body = existing.endsWith('\n') || existing === '' ? existing : existing + '\n'
        const lastLine = body.trimEnd().split('\n').pop() || ''
        content = body + (lastLine.startsWith('|') && body.endsWith('|\n') ? '' : '\n' + header) + lines
      }
      plan.redirect = { file: REDIRECT_FILE, rows: fresh.length, content }
    }
  }
  return plan
}

// ---------------------------------------------------------------- apply

/** Carry out a plan from buildPlan. Moves first, then page rewrites, then the redirect table. */
export function applyPlan(plan) {
  if (plan.errors.length) throw new Error('refusing to apply a plan with errors')
  const abs = (rel) => path.join(plan.workspace, ...rel.split('/'))
  for (const r of plan.moves) {
    if (fs.existsSync(abs(r.new))) throw new Error(`${r.new} appeared since planning; stopped before moving ${r.old}`)
    fs.mkdirSync(path.dirname(abs(r.new)), { recursive: true })
    try {
      fs.renameSync(abs(r.old), abs(r.new))
    } catch (e) {
      if (e.code !== 'EXDEV') throw e
      fs.copyFileSync(abs(r.old), abs(r.new), fs.constants.COPYFILE_EXCL)
      fs.unlinkSync(abs(r.old))
    }
  }
  for (const [rel, content] of plan.writes) fs.writeFileSync(abs(rel), content)
  if (plan.redirect) {
    fs.mkdirSync(path.dirname(abs(plan.redirect.file)), { recursive: true })
    fs.writeFileSync(abs(plan.redirect.file), plan.redirect.content)
  }
}

// ---------------------------------------------------------------- report

export function summarize(plan, applied) {
  return {
    mode: applied ? 'apply' : 'dry-run',
    workspace: plan.workspace,
    workspace_name: plan.workspaceName,
    errors: plan.errors,
    warnings: plan.warnings,
    moves: plan.moves.map((r) => ({ old: r.old, new: r.new, type: r.type })),
    already_moved: plan.alreadyMoved.map((r) => ({ old: r.old, new: r.new })),
    links: plan.links,
    front_matter: plan.frontMatter,
    files_rewritten: [...plan.writes.keys()],
    redirect_rows: plan.redirect ? plan.redirect.rows : 0,
    plain_mentions: plan.mentions,
    changes: plan.moves.length + plan.writes.size + (plan.redirect ? 1 : 0),
  }
}

export function formatReport(plan, applied) {
  const out = []
  const s = summarize(plan, applied)
  out.push(plan.errors.length ? 'vault-migrate: REFUSED, nothing written'
    : applied ? 'vault-migrate: APPLIED' : 'vault-migrate: DRY RUN, nothing written (add --apply to write)')
  if (plan.workspace) out.push(`workspace: ${plan.workspace} (${plan.workspaceName})`)
  if (plan.errors.length) {
    out.push('', `Problems (${plan.errors.length}):`, ...plan.errors.map((e) => `  - ${e}`))
    return out.join('\n') + '\n'
  }
  const verb = applied ? 'moved' : 'to move'
  out.push('', `Files ${verb}: ${plan.moves.length}   already moved: ${plan.alreadyMoved.length}   front matter only: ${plan.inPlace.length}`)
  for (const r of plan.moves) out.push(`  ${r.old} -> ${r.new}`)
  const linkFiles = new Set(plan.links.map((l) => l.file))
  out.push('', `Links rewritten: ${plan.links.length} in ${linkFiles.size} file(s)`)
  for (const l of plan.links) out.push(`  ${l.file}: ${l.from} -> ${l.to}`)
  out.push('', `Front matter added: ${plan.frontMatter.length} file(s)`)
  for (const f of plan.frontMatter) out.push(`  ${f.file}: + ${f.added.join(', ')}`)
  out.push('', `Redirect table: ${plan.redirect ? `${REDIRECT_FILE} (+${plan.redirect.rows} row(s))` : 'no new rows'}`)
  if (plan.mentions.length) {
    out.push('', `Old paths still written as plain text (not links, not changed): ${plan.mentions.length}`)
    for (const m of plan.mentions) out.push(`  ${m.file}: ${m.path}`)
  }
  if (plan.warnings.length) out.push('', `Warnings (${plan.warnings.length}):`, ...plan.warnings.map((w) => `  - ${w}`))
  out.push('', s.changes === 0 ? 'Nothing to do.' : applied ? 'Done.' : 'Run again with --apply to make these changes.')
  return out.join('\n') + '\n'
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage: node scripts/vault-migrate.mjs --workspace <folder> --map <mapping.csv> [--apply] [--json]

  --workspace <folder>   the ONE workspace folder to work in (nothing outside it is written)
  --map <file.csv>       rows of old_path,new_path,type (paths relative to the workspace folder)
  --apply                write the changes (without it: dry run, nothing is written)
  --json                 print the report as JSON
  --workspace-name <n>   value for the "workspace" front matter key (default: the folder name)
  --date <YYYY-MM-DD>    date written into the redirect table (default: today, UTC)
`

export function main(argv, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const args = { apply: false, json: false }
  const valued = { '--workspace': 'workspace', '--map': 'map', '--workspace-name': 'workspaceName', '--date': 'today' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--apply') args.apply = true
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') { io.out(USAGE); return 0 }
    else if (valued[a] && argv[i + 1] !== undefined) args[valued[a]] = argv[++i]
    else { io.err(`Unknown or incomplete option: ${a}\n\n${USAGE}`); return 2 }
  }
  if (!args.workspace || !args.map) { io.err(USAGE); return 2 }
  if (args.today && !/^\d{4}-\d{2}-\d{2}$/.test(args.today)) { io.err('--date must look like 2026-11-16\n'); return 2 }
  let csv
  try { csv = fs.readFileSync(args.map, 'utf8') } catch (e) { io.err(`Cannot read mapping file ${args.map}: ${e.code || e.message}\n`); return 2 }
  const plan = buildPlan({ workspace: args.workspace, rows: parseCsv(csv), today: args.today, workspaceName: args.workspaceName })
  const willApply = args.apply && !plan.errors.length
  if (willApply) applyPlan(plan)
  io.out(args.json ? JSON.stringify(summarize(plan, willApply), null, 2) + '\n' : formatReport(plan, willApply))
  return plan.errors.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2))
}
