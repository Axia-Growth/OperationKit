/**
 * Install defaults (obj 900803, white-label polish F2).
 *
 * A handful of server defaults used to be this repo author's own values:
 * the CORS / CSRF origin, the `pr-N.<domain>` preview host, the GitHub repo
 * the harness opens PRs and statuses against, and the Assistant nudge being ON.
 * A fresh install inherited all of them. They now resolve, highest first:
 *
 *   1. the environment variable (ops / compose override, unchanged names)
 *   2. a `settings` row (per-install, survives restarts)
 *   3. a NEUTRAL built-in default: empty / off / derived from the install's
 *      own public URL. Nothing here names a person, a company or a domain.
 *
 * Existing installs must not change behaviour. `carryLegacyInstallDefaults()`
 * runs once per DB from initDb: on a database that already held objectives
 * before this code first booted, it writes the OLD built-in values as settings
 * rows (only where no row exists yet), so that install keeps behaving exactly
 * as before. A brand-new DB only gets the marker, so it starts blank and never
 * picks those values up later.
 *
 * The legacy literals below are the ONE place the old values live; the server
 * brand guard (no-hardcoded-brand.server.test.ts) allowlists this file.
 */
import type Database from 'better-sqlite3'
import { getDb } from '../db/index.js'

/** settings keys (one per default). */
export const INSTALL_SETTING = {
  corsOrigins: 'install_cors_origins',
  previewDomain: 'install_preview_domain',
  harnessRepo: 'install_harness_repo',
  assistantNudge: 'assistant_nudge_enabled',
  ownerName: 'install_owner_display_name',
} as const

/** Marker: the carry-over below has run for this DB (whatever it decided). */
export const LEGACY_DEFAULTS_MARKER = 'install_legacy_defaults_carried_v1'

/**
 * What the built-in defaults were BEFORE obj 900803. Written as settings rows
 * on a pre-existing DB only. `assistant_nudge_enabled` was ON unless the env said
 * 'false'. The owner name was never configurable — the prompts and the CI
 * hand-back text named him literally — so it is carried too: the first admin
 * of an existing install is not necessarily that person (user 1 can be a
 * generic `admin` account), and the prompts must keep reading the same.
 */
export const LEGACY_INSTALL_DEFAULTS: Readonly<Record<string, string>> = {
  [INSTALL_SETTING.corsOrigins]: 'https://cc.example.com,http://localhost:5173,http://localhost:3002',
  [INSTALL_SETTING.previewDomain]: 'cc.example.com',
  [INSTALL_SETTING.harnessRepo]: 'your-org/operationkit',
  [INSTALL_SETTING.assistantNudge]: '1',
  [INSTALL_SETTING.ownerName]: 'Operator',
}

/** Local Vite + the server's own loopback port: always allowed, as before. */
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:3002']

/** Never throws: an uninitialised DB or a missing table reads as unset. */
export function readSetting(key: string, db?: Database.Database): string | undefined {
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    const v = row?.value?.trim()
    return v ? v : undefined
  } catch {
    return undefined
  }
}

function envOrSetting(envName: string, key: string, env: NodeJS.ProcessEnv, db?: Database.Database): string | undefined {
  const fromEnv = (env[envName] || '').trim()
  return fromEnv || readSetting(key, db)
}

function splitList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

/** The install's own public origin, if it declared one (no default domain). */
export function publicOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const raw of [env.CC_PUBLIC_URL, env.APP_BASE_URL, env.OK_DOMAIN ? `https://${env.OK_DOMAIN}` : '']) {
    if (!raw || !raw.trim()) continue
    try {
      const u = new URL(raw.trim())
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin
    } catch { /* not a URL — try the next */ }
  }
  return null
}

/**
 * CORS / CSRF origins: CORS_ORIGINS env → settings → the install's own public
 * origin (CC_PUBLIC_URL / APP_BASE_URL / OK_DOMAIN) + local dev origins.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env, db?: Database.Database): string[] {
  const explicit = envOrSetting('CORS_ORIGINS', INSTALL_SETTING.corsOrigins, env, db)
  if (explicit) return splitList(explicit)
  const own = publicOrigin(env)
  return own ? [own, ...DEV_ORIGINS] : [...DEV_ORIGINS]
}

/**
 * Domain under which PR previews are served as `pr-<N>.<domain>`.
 * CC_PREVIEW_DOMAIN env → settings → none (no preview host is assumed).
 */
export function resolvePreviewDomain(env: NodeJS.ProcessEnv = process.env, db?: Database.Database): string | null {
  const v = envOrSetting('CC_PREVIEW_DOMAIN', INSTALL_SETTING.previewDomain, env, db)
  if (!v) return null
  const d = v.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  return /^[a-z0-9.-]+$/.test(d) ? d : null
}


/**
 * GitHub `owner/repo` of this install's own source (the harness repo the
 * reviewer / auto-merge / auto-deploy act on). HARNESS_REPO env → settings →
 * '' (unset: callers skip the GitHub call rather than guess a repo).
 */
export function resolveHarnessRepo(env: NodeJS.ProcessEnv = process.env, db?: Database.Database): string {
  const v = envOrSetting('HARNESS_REPO', INSTALL_SETTING.harnessRepo, env, db) || ''
  return /^[\w.-]+\/[\w.-]+$/.test(v) ? v : ''
}

/**
 * The daily Assistant nudge is opt-in. ASSISTANT_NUDGE_ENABLED env ('true'/'1' on,
 * 'false'/'0' off) wins; otherwise settings `assistant_nudge_enabled='1'`.
 */
export function assistantNudgeEnabled(env: NodeJS.ProcessEnv = process.env, db?: Database.Database): boolean {
  const raw = (env.ASSISTANT_NUDGE_ENABLED || '').trim().toLowerCase()
  if (raw === 'false' || raw === '0' || raw === 'off') return false
  if (raw === 'true' || raw === '1' || raw === 'on') return true
  return readSetting(INSTALL_SETTING.assistantNudge, db) === '1'
}

/**
 * How prompts and GitHub text name the person who approves things on this
 * install. settings `install_owner_display_name` → the first admin's username,
 * capitalised (the same rule the chat sender stamp uses) → "the owner".
 */
export function resolveOwnerName(db?: Database.Database): string {
  const explicit = readSetting(INSTALL_SETTING.ownerName, db)
  if (explicit) return explicit.slice(0, 60)
  try {
    const row = (db ?? getDb())
      .prepare("SELECT username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1")
      .get() as { username?: string } | undefined
    const name = row?.username?.trim()
    if (name) return name.charAt(0).toUpperCase() + name.slice(1)
  } catch { /* no DB / no users table */ }
  return 'the owner'
}

/** True when the DB file already held the objectives table before initDb ran. */
export function dbHadObjectivesTable(db: Database.Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'objectives'").get()
  } catch {
    return false
  }
}

/**
 * One-time carry-over (see module header). `preExisting` is whether the DB held
 * an objectives table BEFORE this initDb call. Returns the keys it wrote.
 */
export function carryLegacyInstallDefaults(db: Database.Database, preExisting: boolean): string[] {
  const hasSettings = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()
  if (!hasSettings) return []
  if (db.prepare('SELECT 1 FROM settings WHERE key = ?').get(LEGACY_DEFAULTS_MARKER)) return []
  const written: string[] = []
  db.transaction(() => {
    if (preExisting) {
      const insert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      for (const [key, value] of Object.entries(LEGACY_INSTALL_DEFAULTS)) {
        if (insert.run(key, value).changes > 0) written.push(key)
      }
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(LEGACY_DEFAULTS_MARKER, preExisting ? 'carried' : 'fresh')
  })()
  return written
}
