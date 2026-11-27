/**
 * Bridge from the knowledge-gap flag queue (obj 901767, table `kb_flags`) to the
 * curator's flag input (obj 901768, `KnowledgeFlag`, schema kb-flag/1).
 *
 * The curator was written against a `.kb-wiki/flags.jsonl` file; the flag tool
 * stores rows in SQLite. Rather than mirror every row into a second store, the
 * scheduler hands the curator the open rows through `CuratorOptions.flags`,
 * merged with whatever the file still holds. Read-only: nothing here closes a
 * flag or touches a page.
 */
import type Database from 'better-sqlite3'
import type { KbFlag } from '@operationkit/shared'
import { listKbFlags, MAX_KB_FLAGS_PAGE } from './flags.js'
import { readFlags, safePageRel, type FlagKind, type KnowledgeFlag } from './curator.js'

const KIND_MAP: Record<KbFlag['kind'], FlagKind> = { missing: 'missing', wrong: 'wrong', stale: 'outdated' }

/** SQLite `datetime('now')` ("YYYY-MM-DD HH:MM:SS", UTC) → ISO. */
function isoOf(sqlite: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(sqlite) ? `${sqlite.replace(' ', 'T')}Z` : sqlite
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : new Date(0).toISOString()
}

/** One `kb_flags` row as the curator reads a flag. The curator id is `kbf-<row id>`. */
export function kbFlagToCuratorFlag(f: KbFlag): KnowledgeFlag {
  const page = f.page ? safePageRel(f.page) : null
  const parts = [`${f.subject}: ${f.detail}`]
  if (f.suggested_fix) parts.push(`Suggested fix: ${f.suggested_fix}`)
  if (f.seen_count > 1) parts.push(`(reported ${f.seen_count} times)`)
  return {
    id: `kbf-${f.id}`,
    at: isoOf(f.created_at),
    kind: KIND_MAP[f.kind],
    detail: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1000),
    ...(page ? { page } : { topic: f.subject.slice(0, 200) }),
    objective_id: f.objective_id ?? null,
    by: f.filed_by ? f.filed_by.slice(0, 120) : null,
  }
}

/** Every OPEN flag of a workspace, oldest first, as curator flags. */
export function openKbFlagsForCurator(db: Database.Database, workspace: string): KnowledgeFlag[] {
  const out: KnowledgeFlag[] = []
  let afterId = 0
  for (;;) {
    const { flags } = listKbFlags(db, workspace, { status: 'open', afterId, limit: MAX_KB_FLAGS_PAGE })
    for (const f of flags) out.push(kbFlagToCuratorFlag(f))
    if (flags.length < MAX_KB_FLAGS_PAGE) break
    afterId = flags[flags.length - 1].id
  }
  return out
}

/** The curator's full flag input: the legacy flags file plus the open `kb_flags` rows. */
export function curatorFlagsForWorkspace(db: Database.Database, workspace: string, kbRoot: string): KnowledgeFlag[] {
  let rows: KnowledgeFlag[] = []
  try { rows = openKbFlagsForCurator(db, workspace) } catch (err) {
    console.warn(`[kb-wiki] curator ${workspace}: could not read knowledge flags: ${(err as Error).message}`)
  }
  return [...readFlags(kbRoot).flags, ...rows]
}
