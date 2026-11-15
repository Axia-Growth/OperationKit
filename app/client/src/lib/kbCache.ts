/* Context (knowledge base) client cache — obj 900867.

   Why: every visit to Context used to start from nothing — the page tree, the
   whole-workspace graph and its force layout were all fetched and recomputed
   from scratch, so a return visit was as slow as the first. This is the
   stale-while-revalidate store behind them:

   - a process-wide memory map (survives leaving Context and coming back
     inside the app — the common "click back to Context" case), and
   - localStorage underneath it (survives a reload or a new tab), namespaced
     by the signed-in user so one person never sees another's cached pages on
     a shared browser, and wiped on sign-out.

   Cached data is only ever a FIRST PAINT: callers render it immediately and
   then revalidate against the server (lib/kbResource.ts), replacing it only
   when the server's answer differs. Storage failures (quota, private mode,
   disabled storage) degrade to memory-only and never throw. */

export const KB_CACHE_PREFIX = 'cc:kb:v1:'
/** One entry over this many characters stays memory-only (localStorage is ~5 MB per origin). */
export const KB_CACHE_MAX_ENTRY_CHARS = 2_500_000

export interface KbCacheEntry<T> {
  value: T
  /** The exact JSON the server sent (or the serialised value) — compared on revalidate. */
  raw: string
  /** Epoch ms the value was written. */
  at: number
}

let scope: string | null = null
const mem = new Map<string, KbCacheEntry<unknown>>()

function storage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null // SecurityError when storage is disabled
  }
}

/**
 * Whose cache this is. Called by AuthProvider whenever the signed-in user
 * changes; switching user drops the memory layer, and with no user nothing is
 * persisted at all.
 */
export function setKbCacheScope(userId: string | number | null | undefined): void {
  const next = userId === null || userId === undefined || userId === '' ? null : String(userId)
  if (next === scope) return
  scope = next
  mem.clear()
}

export function kbCacheScope(): string | null {
  return scope
}

function storageKey(key: string): string | null {
  return scope ? `${KB_CACHE_PREFIX}${scope}:${key}` : null
}

function memKey(key: string): string {
  return `${scope ?? '-'}:${key}`
}

/** The cached entry for `key` (memory first, then localStorage), or null. */
export function readKbCache<T>(key: string): KbCacheEntry<T> | null {
  const hit = mem.get(memKey(key))
  if (hit) return hit as KbCacheEntry<T>
  const sk = storageKey(key)
  const s = storage()
  if (!sk || !s) return null
  try {
    const text = s.getItem(sk)
    if (!text) return null
    const stored = JSON.parse(text) as { at?: unknown; raw?: unknown }
    if (typeof stored.raw !== 'string' || typeof stored.at !== 'number') return null
    const entry: KbCacheEntry<T> = { value: JSON.parse(stored.raw) as T, raw: stored.raw, at: stored.at }
    mem.set(memKey(key), entry)
    return entry
  } catch {
    try { s.removeItem(sk) } catch { /* ignore */ }
    return null
  }
}

/** Every persisted key of the current user, oldest first. */
function ownKeysOldestFirst(s: Storage): string[] {
  if (!scope) return []
  const mine = `${KB_CACHE_PREFIX}${scope}:`
  const rows: Array<{ k: string; at: number }> = []
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i)
    if (!k || !k.startsWith(mine)) continue
    let at = 0
    try { at = Number((JSON.parse(s.getItem(k) ?? '{}') as { at?: number }).at) || 0 } catch { /* corrupt: evict first */ }
    rows.push({ k, at })
  }
  return rows.sort((a, b) => a.at - b.at).map(r => r.k)
}

/**
 * Store `value` for `key`. `raw` is the server's JSON text when the caller has
 * it (saves a re-serialise). `persist: false` keeps it in memory only.
 */
export function writeKbCache<T>(key: string, value: T, opts: { raw?: string; persist?: boolean; at?: number } = {}): KbCacheEntry<T> {
  const raw = opts.raw ?? JSON.stringify(value)
  const entry: KbCacheEntry<T> = { value, raw, at: opts.at ?? Date.now() }
  mem.set(memKey(key), entry)
  const sk = storageKey(key)
  const s = storage()
  if (opts.persist === false || !sk || !s) return entry
  const text = JSON.stringify({ at: entry.at, raw })
  if (text.length > KB_CACHE_MAX_ENTRY_CHARS) {
    try { s.removeItem(sk) } catch { /* ignore */ }
    return entry
  }
  try {
    s.setItem(sk, text)
  } catch {
    // Quota: make room by evicting this user's oldest Context entries, then try once more.
    try {
      for (const k of ownKeysOldestFirst(s)) {
        if (k === sk) continue
        s.removeItem(k)
        try { s.setItem(sk, text); return entry } catch { /* keep evicting */ }
      }
    } catch { /* storage unusable: memory only */ }
  }
  return entry
}

/** Drop one key (memory + storage). */
export function deleteKbCache(key: string): void {
  mem.delete(memKey(key))
  const sk = storageKey(key)
  const s = storage()
  if (sk && s) try { s.removeItem(sk) } catch { /* ignore */ }
}

/** Forget everything Context cached, for every user on this browser (sign-out). */
export function clearKbCache(): void {
  mem.clear()
  const s = storage()
  if (!s) return
  try {
    const doomed: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k && k.startsWith(KB_CACHE_PREFIX)) doomed.push(k)
    }
    for (const k of doomed) s.removeItem(k)
  } catch { /* ignore */ }
}

/** Tests: reset memory + scope without touching storage. */
export function __resetKbCacheMemory(): void {
  mem.clear()
  scope = null
}
