/**
 * The install's own public base URL — ONE resolver for every link the server
 * hands out (MCP / Agent API card `url`, webhook payloads, chat tool results,
 * secret-upload links, OAuth redirects). obj 901080.
 *
 * Before this, three copies of `cardUrl()` each read a different env var and
 * fell back to a hardcoded domain. The genericised (open-source) build rewrote
 * that fallback to `cc.example.com`, so an install that set only OK_DOMAIN
 * (which is all install.sh writes) handed bots links that never opened.
 *
 * Resolution, highest first (no domain is ever invented):
 *   1. env: CC_PUBLIC_URL, APP_BASE_URL, APP_URL, PUBLIC_URL, then OK_DOMAIN
 *      (a bare host → https://host; `localhost` is skipped as "not public")
 *   2. settings row `install_public_url`
 *   3. the first non-local CORS origin (CORS_ORIGINS env → `install_cors_origins`
 *      setting) — install.sh writes `https://${OK_DOMAIN}` there, and an older
 *      install carries its original origin there (install-defaults.ts)
 *   Steps 2 and 3 skip RFC 2606 placeholder hosts (example.com / .org / .net and
 *   any subdomain): real installs still carry `https://cc.example.com` at the
 *   head of `install_cors_origins`, and a link to it never opens (obj 901089).
 *   4. `http://localhost:<PORT>` — reachable on the box, never a fake domain.
 */
import type Database from 'better-sqlite3'
import { resolveCorsOrigins } from './install-defaults.js'
import { getDb } from '../db/index.js'

export const PUBLIC_URL_SETTING = 'install_public_url'

function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0'
}

/** RFC 2606 documentation hosts: example.com / .org / .net and any subdomain. */
export function isPlaceholderHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return h === 'example.com' || h === 'example.org' || h === 'example.net' ||
    h.endsWith('.example.com') || h.endsWith('.example.org') || h.endsWith('.example.net')
}

/** Normalise a configured value to an origin (+ optional path prefix), or null. */
export function toPublicBase(raw: string | undefined | null, opts: { allowLocal?: boolean; skipPlaceholder?: boolean } = {}): string | null {
  const v = (raw ?? '').trim()
  if (!v) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    if (!u.hostname || (!opts.allowLocal && isLocalHost(u.hostname))) return null
    if (opts.skipPlaceholder && isPlaceholderHost(u.hostname)) return null
    const path = u.pathname.replace(/\/+$/, '')
    return `${u.origin}${path}`
  } catch {
    return null
  }
}

function readSetting(key: string, db?: Database.Database): string | undefined {
  try {
    const row = (db ?? getDb()).prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value?.trim() || undefined
  } catch {
    return undefined
  }
}

export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env, db?: Database.Database): string {
  for (const raw of [env.CC_PUBLIC_URL, env.APP_BASE_URL, env.APP_URL, env.PUBLIC_URL, env.OK_DOMAIN]) {
    const base = toPublicBase(raw)
    if (base) return base
  }
  const fromSetting = toPublicBase(readSetting(PUBLIC_URL_SETTING, db), { skipPlaceholder: true })
  if (fromSetting) return fromSetting
  let cors: string[] = []
  try { cors = resolveCorsOrigins(env, db) } catch { /* unset */ }
  for (const origin of cors) {
    const base = toPublicBase(origin, { skipPlaceholder: true })
    if (base) return base
  }
  const port = Number(env.PORT) > 0 ? Number(env.PORT) : 3002
  return `http://localhost:${port}`
}

/** Absolute board link for a card: `<public base>/o/<id>`. */
export function publicCardUrl(id: number | string, env: NodeJS.ProcessEnv = process.env, db?: Database.Database): string {
  return `${resolvePublicBaseUrl(env, db)}/o/${id}`
}
