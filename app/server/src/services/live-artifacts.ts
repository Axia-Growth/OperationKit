/**
 * Live artifacts (obj 715699) — read-only, mid-run access to a card's objective
 * memory directory (`<OBJECTIVE_MEMORY_ROOT>/<id>/`): progress files, partial
 * outputs (`live/`, `work/`, …) and ARTIFACT.md.
 *
 * Masked by construction:
 *  - `NOTES.md` (the worker's private scratch). The same one-directional mask the
 *    AI reviewer gets (obj 707060): downstream readers see the deliverable and the
 *    partial outputs, never the worker's opinion of itself.
 *  - dotfiles/dot-dirs, symlinks (never followed), anything resolving outside the
 *    card's directory.
 * Text is served through `redactLive`; binaries are listed but not served.
 */
import fs from 'fs'
import path from 'path'
import { redactLive } from './live-redaction.js'
import { MAX_IMAGE_BYTES, sniffImageType } from './agent-chat/attachments.js'

export const DEFAULT_MEMORY_ROOT = '/home/operator/ai-workspace/objective-memory'
export const SCRATCH_FILE = 'NOTES.md'
const MAX_LIST_ENTRIES = 500
const MAX_DEPTH = 6
export const MAX_READ_BYTES = 1_000_000
const BINARY_SNIFF_BYTES = 8192

export function memoryRoot(): string {
  // CC_OBJECTIVE_MEMORY_ROOT is the override prompt-builder-blocks already honours.
  return process.env.OBJECTIVE_MEMORY_ROOT || process.env.CC_OBJECTIVE_MEMORY_ROOT || DEFAULT_MEMORY_ROOT
}

export function objectiveMemoryDir(objectiveId: number): string {
  return path.join(memoryRoot(), String(objectiveId))
}

export interface ArtifactEntry {
  path: string
  size: number
  modified_at: string
  kind: 'text' | 'binary'
}

export class ArtifactError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message)
  }
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function sniff(file: string): 'text' | 'binary' {
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.alloc(BINARY_SNIFF_BYTES)
    const n = fs.readSync(fd, buf, 0, BINARY_SNIFF_BYTES, 0)
    return isBinary(buf.subarray(0, n)) ? 'binary' : 'text'
  } finally {
    fs.closeSync(fd)
  }
}

function hidden(name: string, isTop: boolean): boolean {
  return name.startsWith('.') || (isTop && name === SCRATCH_FILE)
}

export function listArtifacts(objectiveId: number): { entries: ArtifactEntry[]; truncated: boolean } {
  const base = objectiveMemoryDir(objectiveId)
  const entries: ArtifactEntry[] = []
  let truncated = false
  let baseStat: fs.Stats
  try { baseStat = fs.lstatSync(base) } catch { return { entries, truncated } }
  if (!baseStat.isDirectory()) return { entries, truncated }

  const walk = (dir: string, rel: string, depth: number): void => {
    if (truncated || depth > MAX_DEPTH) return
    let names: string[]
    try { names = fs.readdirSync(dir).sort() } catch { return }
    for (const name of names) {
      if (hidden(name, depth === 0)) continue
      const abs = path.join(dir, name)
      const relPath = rel ? `${rel}/${name}` : name
      let st: fs.Stats
      try { st = fs.lstatSync(abs) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) { walk(abs, relPath, depth + 1); continue }
      if (!st.isFile()) continue
      if (entries.length >= MAX_LIST_ENTRIES) { truncated = true; return }
      let kind: 'text' | 'binary' = 'text'
      try { kind = sniff(abs) } catch { continue }
      entries.push({ path: relPath, size: st.size, modified_at: st.mtime.toISOString(), kind })
    }
  }
  walk(base, '', 0)
  return { entries, truncated }
}

/** Resolve a caller-supplied relative path safely inside the card dir. Throws ArtifactError. */
export function resolveArtifactPath(objectiveId: number, relPath: unknown): string {
  if (typeof relPath !== 'string' || !relPath.trim()) throw new ArtifactError('path is required', 400)
  if (relPath.includes('\0') || path.isAbsolute(relPath) || relPath.includes('\\')) throw new ArtifactError('invalid path', 400)
  const segments = relPath.split('/').filter(s => s !== '' && s !== '.')
  if (segments.length === 0 || segments.some(s => s === '..')) throw new ArtifactError('invalid path', 400)
  if (segments.some(s => s.startsWith('.'))) throw new ArtifactError('not found', 404)
  if (segments.length === 1 && segments[0] === SCRATCH_FILE) {
    throw new ArtifactError(`${SCRATCH_FILE} is the worker's private scratch and is not served; read ARTIFACT.md or live/ outputs instead`, 403)
  }
  const base = objectiveMemoryDir(objectiveId)
  // Refuse symlinks at every level — never follow one out of the card dir.
  let cur = base
  for (const seg of segments) {
    cur = path.join(cur, seg)
    let st: fs.Stats
    try { st = fs.lstatSync(cur) } catch { throw new ArtifactError('not found', 404) }
    if (st.isSymbolicLink()) throw new ArtifactError('not found', 404)
  }
  const real = fs.realpathSync(cur)
  const realBase = fs.realpathSync(base)
  if (real !== realBase && !real.startsWith(realBase + path.sep)) throw new ArtifactError('not found', 404)
  if (!fs.statSync(real).isFile()) throw new ArtifactError('not a file', 400)
  return real
}

export interface ArtifactRead {
  path: string
  size: number
  modified_at: string
  offset: number
  bytes: number
  truncated: boolean
  redaction_count: number
  content: string
}

export function readArtifact(
  objectiveId: number,
  relPath: unknown,
  opts: { offset?: number; maxBytes?: number; tailBytes?: number } = {},
): ArtifactRead {
  const abs = resolveArtifactPath(objectiveId, relPath)
  const st = fs.statSync(abs)
  const max = Math.max(1, Math.min(opts.maxBytes ?? MAX_READ_BYTES, MAX_READ_BYTES))
  let offset = Math.max(0, opts.offset ?? 0)
  if (opts.tailBytes && opts.tailBytes > 0) offset = Math.max(0, st.size - Math.min(opts.tailBytes, MAX_READ_BYTES))
  const length = Math.max(0, Math.min(max, st.size - offset))
  const fd = fs.openSync(abs, 'r')
  let buf: Buffer
  try {
    buf = Buffer.alloc(length)
    fs.readSync(fd, buf, 0, length, offset)
  } finally {
    fs.closeSync(fd)
  }
  if (sniff(abs) === 'binary' || isBinary(buf)) throw new ArtifactError('binary file — listed but not served', 415)
  const { text, count } = redactLive(buf.toString('utf8'))
  return {
    path: (relPath as string).split('/').filter(s => s && s !== '.').join('/'),
    size: st.size,
    modified_at: st.mtime.toISOString(),
    offset,
    bytes: length,
    truncated: offset + length < st.size,
    redaction_count: count,
    content: text,
  }
}

// ── Own-card memory writes (obj 900955) ─────────────────────────────────────
// A sandboxed session has no mount of the objective-memory folder, so it writes
// its deliverable, its scratch and its partial outputs through
// `PUT /api/internal/objectives/:id/memory/file`. The path is an ALLOWLIST
// (never a blacklist): exactly `ARTIFACT.md`, `NOTES.md` or `live/<name>`.

export const MAX_WRITE_BYTES = MAX_READ_BYTES
const LIVE_DIR = 'live'
const LIVE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TOP_LEVEL_WRITABLE = new Set(['ARTIFACT.md', SCRATCH_FILE])

/** Validate a caller path against the allowlist. Returns its segments. Throws ArtifactError(400). */
export function parseMemoryFilePath(relPath: unknown): string[] {
  if (typeof relPath !== 'string' || !relPath) throw new ArtifactError('path is required', 400)
  const bad = () => new ArtifactError(`invalid path (allowed: ARTIFACT.md, ${SCRATCH_FILE}, ${LIVE_DIR}/<name>)`, 400)
  if (relPath.includes('\0') || relPath.includes('\\') || path.isAbsolute(relPath)) throw bad()
  const segments = relPath.split('/')
  if (segments.length === 1 && TOP_LEVEL_WRITABLE.has(segments[0])) return segments
  if (segments.length === 2 && segments[0] === LIVE_DIR && LIVE_NAME.test(segments[1])) return segments
  throw bad()
}

function requireRealDir(dir: string): void {
  let st: fs.Stats
  try { st = fs.lstatSync(dir) } catch { throw new ArtifactError('not found', 404) }
  // A symlinked card dir or live/ dir is never followed.
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ArtifactError('invalid path', 400)
}

/** The real directory an allowlisted path lives in, proven to sit inside the card's folder. */
function memoryFileDir(objectiveId: number, segments: string[], create: boolean): string {
  const base = objectiveMemoryDir(objectiveId)
  if (create) fs.mkdirSync(base, { recursive: true })
  requireRealDir(base)
  let dir = base
  if (segments.length === 2) {
    dir = path.join(base, LIVE_DIR)
    if (create) {
      try { fs.mkdirSync(dir) } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err }
    }
    requireRealDir(dir)
  }
  const expected = path.join(fs.realpathSync(memoryRoot()), String(objectiveId), ...(segments.length === 2 ? [LIVE_DIR] : []))
  if (fs.realpathSync(dir) !== expected) throw new ArtifactError('invalid path', 400)
  return expected
}

export interface MemoryFileWrite {
  path: string
  size: number
  modified_at: string
}

/** Write (create or replace) one allowlisted text file in the card's memory folder. */
export function writeMemoryFile(objectiveId: number, relPath: unknown, content: unknown): MemoryFileWrite {
  const segments = parseMemoryFilePath(relPath)
  if (typeof content !== 'string') throw new ArtifactError('content must be a string', 400)
  if (content.includes('\0')) throw new ArtifactError('content must be text', 400)
  const size = Buffer.byteLength(content, 'utf8')
  if (size > MAX_WRITE_BYTES) throw new ArtifactError(`content is over the ${MAX_WRITE_BYTES} byte limit`, 413)
  const dir = memoryFileDir(objectiveId, segments, true)
  const name = segments[segments.length - 1]
  const target = path.join(dir, name)
  let existing: fs.Stats | null = null
  try { existing = fs.lstatSync(target) } catch { /* new file */ }
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) throw new ArtifactError('invalid path', 400)
  // Temp file + rename: a reader never sees a half-written artifact, and rename
  // replaces the directory entry rather than writing through it.
  const tmp = path.join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', flag: 'wx', mode: 0o644 })
    fs.renameSync(tmp, target)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }
  return { path: segments.join('/'), size, modified_at: fs.statSync(target).mtime.toISOString() }
}

/**
 * Read one allowlisted file back, unredacted. This is the OWNING session reading
 * its own files (how a sandboxed worker gets its scratch back after a restart);
 * every other reader goes through `readArtifact`, which masks the scratch.
 */
export function readMemoryFile(objectiveId: number, relPath: unknown): MemoryFileWrite & { content: string } {
  const segments = parseMemoryFilePath(relPath)
  const target = path.join(memoryFileDir(objectiveId, segments, false), segments[segments.length - 1])
  let st: fs.Stats
  try { st = fs.lstatSync(target) } catch { throw new ArtifactError('not found', 404) }
  if (st.isSymbolicLink() || !st.isFile()) throw new ArtifactError('not found', 404)
  if (st.size > MAX_READ_BYTES) throw new ArtifactError('file is too large to read here', 413)
  return { path: segments.join('/'), size: st.size, modified_at: st.mtime.toISOString(), content: fs.readFileSync(target, 'utf8') }
}

export interface ArtifactImage {
  path: string
  media_type: string
  size: number
  bytes: Buffer
}

/**
 * The one exception to "binaries are listed but not served" (obj 901028): a
 * screenshot a worker dropped into its objective-memory dir (`live/`,
 * `work/`, …) is served as real image bytes, so the card view and a bot's
 * `attach_image` tool can show it inline. Same path-traversal guard as every
 * other artifact read; never redacted (there is no text to scan), and capped
 * at the same size a pasted chat image is (`MAX_IMAGE_BYTES`) so a huge file
 * cannot be read fully into memory just to decide it isn't servable.
 */
export function readArtifactImage(objectiveId: number, relPath: unknown): ArtifactImage {
  const abs = resolveArtifactPath(objectiveId, relPath)
  const st = fs.statSync(abs)
  if (st.size > MAX_IMAGE_BYTES) throw new ArtifactError('image too large to serve (5 MB max)', 413)
  const bytes = fs.readFileSync(abs)
  const mediaType = sniffImageType(bytes)
  if (!mediaType) throw new ArtifactError('not a PNG, JPEG, GIF or WebP image', 415)
  return {
    path: (relPath as string).split('/').filter(s => s && s !== '.').join('/'),
    media_type: mediaType,
    size: st.size,
    bytes,
  }
}
