/**
 * Data-access map (obj 901772): the third kind of knowledge, next to facts and
 * how-tos — WHERE current data lives and HOW to query it.
 *
 * A workspace keeps it as plain markdown in its own knowledge folder:
 *
 *   data-access/map.md              the map: one section per source (system,
 *                                    what lives there, how to query it, gotchas)
 *   data-access/flags/<date>-<slug>.md   one file per "the map is wrong" report
 *
 * The rule is "flag, don't copy". The map holds INSTRUCTIONS, never the data:
 * no rows, exports, query results or schema dumps of a warehouse, CRM or sheet
 * go into the vault. An agent that finds the map wrong (a renamed column, a
 * moved table, a new or dead source) works around it, finishes its card, and
 * files ONE small flag file. It does not edit map.md; the curator does, then
 * marks the flag `status: resolved`.
 *
 * A flag is a file, not an append to one shared page, so two agents flagging at
 * once never overwrite each other (a knowledge-base write is a full replace).
 * Its frontmatter uses `kind: knowledge-gap` + `target:`, the shape a
 * knowledge-gap flag tool can read or write without a migration.
 *
 * This module only READS the knowledge base (to decide whether a workspace has
 * a map and how many flags are open). It writes nothing: agents write flags
 * through the existing paths (`PUT /api/docs/file`, chat `write_doc`), which
 * already run the re-index hook.
 *
 * Prompt cost: `buildDataAccessBlock` returns [] for a workspace with no map,
 * so every prompt on an install that has not made one is byte-identical to
 * before. Docs: docs/knowledge-base/data-access-map.md.
 */
import fs from 'fs'
import path from 'path'
import type { Objective } from '@operationkit/shared'
import { jailEnabled } from './session-jail.js'
import { resolveWriteWorkspace } from './workspaces.js'
import { workspaceKbRoot } from './doc-ingest/kb-paths.js'
import { CC_API } from './kb-access-prompt.js'
import { DATA_ACCESS_SUBDIR, DATA_ACCESS_MAP_NAME, DATA_ACCESS_FLAGS_NAME } from '../lib/vault-layout.js'

/** `data-access/map.md`, relative to the workspace's knowledge folder. */
export const DATA_ACCESS_MAP_REL = `${DATA_ACCESS_SUBDIR}/${DATA_ACCESS_MAP_NAME}`
/** `data-access/flags`, relative to the workspace's knowledge folder. */
export const DATA_ACCESS_FLAGS_REL = `${DATA_ACCESS_SUBDIR}/${DATA_ACCESS_FLAGS_NAME}`

/** What a flag reports. `other` covers anything the list does not name. */
export const DATA_ACCESS_GAPS = ['renamed-field', 'moved-source', 'new-source', 'dead-source', 'wrong-query', 'other'] as const
export type DataAccessGap = (typeof DATA_ACCESS_GAPS)[number]

/** A flag counts as open unless its frontmatter says one of these. */
const CLOSED_STATUSES = new Set(['resolved', 'rejected', 'wontfix', 'closed', 'done'])
/** Flag files read when counting; a folder bigger than this reports `${MAX}+`. */
const MAX_FLAGS_SCANNED = 500
/** Bytes read from each flag file: the frontmatter is at the top. */
const FLAG_HEAD_BYTES = 2048

export interface DataAccessFlag {
  kind: string | null
  target: string | null
  gap: string | null
  source: string | null
  status: string
  open: boolean
}

/**
 * Read a flag file's frontmatter. Tolerant: a missing or malformed block is an
 * OPEN flag with null fields (a person who typed a flag by hand still counts).
 */
export function parseDataAccessFlag(text: string): DataAccessFlag {
  const fm: Record<string, string> = {}
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
      if (kv) fm[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  const status = (fm.status || 'open').toLowerCase()
  return {
    kind: fm.kind || null,
    target: fm.target || null,
    gap: fm.gap || null,
    source: fm.source || null,
    status,
    open: !CLOSED_STATUSES.has(status),
  }
}

export interface DataAccessMapState {
  /** The workspace has `data-access/map.md` (a regular file, not a symlink). */
  exists: boolean
  /** Open flag files under `data-access/flags/` (capped at MAX_FLAGS_SCANNED). */
  openFlags: number
  /** Absolute path of the workspace's knowledge folder; null if it cannot be resolved. */
  kbDir: string | null
}

const NO_MAP: DataAccessMapState = { exists: false, openFlags: 0, kbDir: null }

/** Is `p` a regular file (symlinks are never followed: a link could point out of the workspace)? */
function isPlainFile(p: string): boolean {
  try { return fs.lstatSync(p).isFile() } catch { return false }
}

/**
 * Does this workspace have a data-access map, and how many flags are open?
 * Never throws: an unreadable folder reads as "no map".
 * @param kbDir pass the workspace's knowledge folder (tests); defaults to `workspaceKbRoot(ws)`.
 */
export function readDataAccessMapState(workspace: string | null | undefined, kbDir?: string): DataAccessMapState {
  let dir: string
  try {
    dir = kbDir ?? workspaceKbRoot(resolveWriteWorkspace(workspace))
  } catch {
    return NO_MAP
  }
  if (!isPlainFile(path.join(dir, DATA_ACCESS_MAP_REL))) return { ...NO_MAP, kbDir: dir }
  let openFlags = 0
  try {
    const flagsDir = path.join(dir, DATA_ACCESS_FLAGS_REL)
    const names = fs.readdirSync(flagsDir).filter(n => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort()
    for (const name of names.slice(0, MAX_FLAGS_SCANNED)) {
      const abs = path.join(flagsDir, name)
      if (!isPlainFile(abs)) continue
      let head = ''
      try {
        const fd = fs.openSync(abs, 'r')
        try {
          const buf = Buffer.alloc(FLAG_HEAD_BYTES)
          head = buf.subarray(0, fs.readSync(fd, buf, 0, FLAG_HEAD_BYTES, 0)).toString('utf8')
        } finally { fs.closeSync(fd) }
      } catch { continue }
      if (parseDataAccessFlag(head).open) openFlags++
    }
  } catch { /* no flags folder yet */ }
  return { exists: true, openFlags, kbDir: dir }
}

/** The flag file an agent writes. Shared by the prompt, the docs and the tests. */
export function dataAccessFlagTemplate(flaggedBy: string): string {
  return [
    '---',
    'kind: knowledge-gap',
    `target: ${DATA_ACCESS_MAP_REL}`,
    `gap: <one of: ${DATA_ACCESS_GAPS.join(' | ')}>`,
    'source: <the source as the map names it, e.g. "BigQuery: analytics.orders">',
    'status: open',
    `flagged_by: ${flaggedBy}`,
    'date: YYYY-MM-DD',
    '---',
    'What the map says: <the line in the map that is wrong or missing>',
    'What is true now: <names only: the new table / column / endpoint / owner>',
    'How I worked around it: <the query or step that worked, with names, not results>',
    'Evidence: <the error message or schema line you saw; never rows, exports or secret values>',
  ].join('\n')
}

/**
 * The worker-prompt block. [] when the workspace has no map (prompt unchanged).
 * @param state pass a precomputed state (tests); defaults to reading the disk.
 */
export function buildDataAccessBlock(
  objective: Pick<Objective, 'id' | 'workspace'>,
  jailed: boolean = jailEnabled(),
  state: DataAccessMapState = readDataAccessMapState(objective.workspace),
): string[] {
  if (!state.exists) return []
  const flagsNote = state.openFlags > 0
    ? ` It has ${state.openFlags}${state.openFlags >= MAX_FLAGS_SCANNED ? '+' : ''} open flag${state.openFlags === 1 ? '' : 's'} waiting for the curator; a flag may already describe the problem you hit.`
    : ''
  const flagName = `${DATA_ACCESS_FLAGS_REL}/YYYY-MM-DD-<source>-<what-changed>.md`
  const lines = [
    '',
    '## Data-access map (where current data lives — read before you query a source)',
    '',
    `This workspace keeps a map of which system holds which data and how to query it: \`${DATA_ACCESS_MAP_REL}\` in its knowledge folder.${flagsNote}`,
    '- Before you query a warehouse, database, CRM, spreadsheet or API for this card, read the map and use the source, table and query it names. Query the live source; the map tells you where, it is not a copy.',
    '- **Flag, don\'t copy.** Never put rows, exports, query results or schema dumps into the knowledge base. The map holds instructions only.',
    `- If the map is wrong (a renamed field, a moved table, a new or dead source, a query that no longer works): work around it, finish the card, then write ONE flag file to \`${flagName}\`. Do not edit \`${DATA_ACCESS_MAP_REL}\` yourself; the curator updates it from the flags.`,
    '',
    'Flag file (names only, no data, no secret values):',
    '',
    '```markdown',
    dataAccessFlagTemplate(`card #${objective.id}`),
    '```',
  ]
  if (!jailed) {
    const where = state.kbDir ?? '<workspace knowledge folder>'
    lines.push('', `On disk: \`${path.join(where, DATA_ACCESS_MAP_REL)}\` (read) and \`${path.join(where, DATA_ACCESS_FLAGS_REL)}/\` (write the flag there).`)
    return lines
  }
  lines.push(
    '',
    'You are sandboxed, so read the map and write the flag through the control plane:',
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    `KB=$(curl -s "${CC_API}/api/docs/tree" -H "$H" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).root')`,
    `curl -sG "${CC_API}/api/docs/file" -H "$H" --data-urlencode "path=$KB/${DATA_ACCESS_MAP_REL}"`,
    '# write the flag body to /workspace/flag.md first, then:',
    `curl -s -X PUT "${CC_API}/api/docs/file" -H "$H" -H 'Content-Type: application/json' \\`,
    `  -d "$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1]+"/${DATA_ACCESS_FLAGS_REL}/"+process.argv[2],content:fs.readFileSync(process.argv[3],"utf8"),create_dirs:true}))' "$KB" "$(date -u +%F)-<source>-<what-changed>.md" /workspace/flag.md)"`,
    '```',
  )
  return lines
}
