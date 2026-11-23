/**
 * Which changed files make a merged pull request a database change (obj 901389).
 *
 * The owner deploys merges a bot made under a merge grant, and a merge that
 * carries a schema or migration change is the one to look at twice before a
 * deploy. One rule, used by the grant-merge card line and the "merged, waiting
 * for deploy" list:
 *
 *  - anything under `app/server/src/db/` (the SQLite schema and its migrations), or
 *  - any path with a `migrations/` folder in it (Supabase and other repos),
 *
 * except test files (`*.test.*`, `*.spec.*`), which change no schema.
 */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i

export function isMigrationPath(file: string): boolean {
  const p = String(file || '').trim().replace(/^\.?\//, '')
  if (!p || TEST_FILE.test(p)) return false
  if (p.startsWith('app/server/src/db/')) return true
  return /(^|\/)migrations\//.test(p)
}

/** The migration / schema paths among `files`, de-duplicated, in input order. */
export function migrationPaths(files: readonly string[]): string[] {
  return Array.from(new Set(files.filter(isMigrationPath)))
}
