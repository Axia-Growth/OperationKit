/* Stale-while-revalidate data for Context (obj 900867).

   `useKbResource(spec)` renders the cached copy of a resource at once
   (lib/kbCache.ts — memory, then localStorage), then asks the server again in
   the background and swaps the new answer in ONLY when its JSON differs. When
   nothing changed, the very same object comes back, so the graph does not
   re-layout and the tree does not re-render. One request per key is ever in
   flight, so a hover prefetch and the page mounting share it.

   A resource is `{ key, load }`: `load` is the page's ordinary API call
   (lib/api, wikiApi), so error handling and auth stay where they were. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { kbCacheScope, readKbCache, writeKbCache, type KbCacheEntry } from './kbCache'

export interface KbResourceSpec<T> {
  /** Cache key (per signed-in user, see kbCache). */
  key: string
  /** The API call that produces the value. */
  load: () => Promise<T>
  /** false = keep in memory only (never written to localStorage). */
  persist?: boolean
}

const inflight = new Map<string, Promise<KbCacheEntry<unknown>>>()
/** When each key last came back from the server (this tab only). */
const fetchedAt = new Map<string, number>()
/** A page mounting within this long of a fetch (e.g. the hover prefetch) does not ask again. */
export const KB_FRESH_MS = 5_000

/** In-flight requests and fetch times are per signed-in user, like the cache itself. */
const scoped = (key: string) => `${kbCacheScope() ?? '-'}:${key}`

/** Epoch ms `key` was last confirmed by the server in this tab, or 0. */
export function kbFetchedAt(key: string): number {
  return fetchedAt.get(scoped(key)) ?? 0
}

/**
 * Run `spec.load` into the cache. Resolves to the cached entry when the server
 * sent the same JSON (same `value` object, so nothing re-renders), else to a
 * new entry.
 */
export function revalidateKb<T>(spec: KbResourceSpec<T>): Promise<KbCacheEntry<T>> {
  const { key } = spec
  const id = scoped(key)
  const scope = kbCacheScope()
  const running = inflight.get(id)
  if (running) return running as Promise<KbCacheEntry<T>>
  const p = Promise.resolve()
    .then(() => spec.load())
    .then(value => {
      const raw = JSON.stringify(value)
      // Signed out (or in as someone else) while this was in flight: hand it back, never cache it.
      if (kbCacheScope() !== scope) return { value, raw, at: Date.now() }
      fetchedAt.set(id, Date.now())
      const prev = readKbCache<T>(key)
      if (prev && prev.raw === raw) return prev
      return writeKbCache<T>(key, value, { raw, persist: spec.persist })
    })
    .finally(() => { inflight.delete(id) })
  inflight.set(id, p as Promise<KbCacheEntry<unknown>>)
  return p
}

/** Warm a resource in the background (hover / idle prefetch). Never rejects; skips one fetched in the last `maxAgeMs`. */
export function prefetchKb<T>(spec: KbResourceSpec<T>, opts: { maxAgeMs?: number } = {}): Promise<void> {
  if (readKbCache(spec.key) && Date.now() - kbFetchedAt(spec.key) < (opts.maxAgeMs ?? 15_000)) return Promise.resolve()
  return revalidateKb(spec).then(() => undefined, () => undefined)
}

export interface KbResource<T> {
  /** The freshest value we have: cached first, then the server's. */
  data: T | null
  /** Set when the server could not be reached and there is nothing cached to show. */
  error: string | null
  /** Nothing to show yet (no cache, first request still running). */
  loading: boolean
  /** A background revalidation is running. */
  refreshing: boolean
  /** The value on screen came from the cache and has not been confirmed by the server yet. */
  stale: boolean
  /** Ask the server again now. */
  reload: () => void
}

interface State<T> { key: string | null; data: T | null; error: string | null; stale: boolean }

function initial<T>(key: string | null): State<T> {
  const hit = key ? readKbCache<T>(key) : null
  return { key, data: hit ? hit.value : null, error: null, stale: !!hit }
}

/**
 * Cached-first load. `spec` null = idle. Bumping `refreshKey` (e.g. after an
 * import) revalidates without dropping what is on screen.
 */
export function useKbResource<T>(spec: KbResourceSpec<T> | null, opts: { refreshKey?: unknown } = {}): KbResource<T> {
  const key = spec?.key ?? null
  const [state, setState] = useState<State<T>>(() => initial<T>(key))
  const [refreshing, setRefreshing] = useState(false)
  const [nonce, setNonce] = useState(0)
  // Switching key (another workspace): show that key's cache straight away.
  let current = state
  if (state.key !== key) {
    current = initial<T>(key)
    setState(current)
  }
  // The spec object is usually rebuilt every render; the effect keys on `key` and reads the latest one.
  const specRef = useRef(spec)
  specRef.current = spec

  const lastRefreshKey = useRef(opts.refreshKey)

  useEffect(() => {
    const s = specRef.current
    if (!key || !s) return
    const forced = nonce > 0 || lastRefreshKey.current !== opts.refreshKey
    lastRefreshKey.current = opts.refreshKey
    // Fetched a moment ago (the hover prefetch, or a quick back-and-forth): the cache IS the server's answer.
    if (!forced && !inflight.has(scoped(key)) && Date.now() - kbFetchedAt(key) < KB_FRESH_MS) {
      const hit = readKbCache<T>(key)
      if (hit) {
        setState(prev => (prev.key !== key ? prev : { key, data: hit.value, error: null, stale: false }))
        return
      }
    }
    let live = true
    setRefreshing(true)
    revalidateKb<T>(s)
      .then(entry => {
        if (!live) return
        setState(prev => (prev.key !== key ? prev : prev.data === entry.value && !prev.stale && !prev.error ? prev : { key, data: entry.value, error: null, stale: false }))
      })
      .catch((err: Error) => {
        if (!live) return
        // Keep showing the cached copy if we have one; only an empty screen becomes an error.
        setState(prev => (prev.key !== key ? prev : { ...prev, error: prev.data === null ? err.message || 'Something went wrong. Please try again.' : null }))
      })
      .finally(() => { if (live) setRefreshing(false) })
    return () => { live = false }
  }, [key, opts.refreshKey, nonce])

  const reload = useCallback(() => setNonce(n => n + 1), [])
  return {
    data: current.data,
    error: current.error,
    loading: current.data === null && current.error === null && !!key,
    refreshing,
    stale: current.stale,
    reload,
  }
}

/** Run `fn` when the browser is idle (or soon, where requestIdleCallback is missing). */
export function whenIdle(fn: () => void, timeout = 2000): () => void {
  if (typeof window === 'undefined') return () => {}
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (h: number) => void }
  if (w.requestIdleCallback) {
    const h = w.requestIdleCallback(fn, { timeout })
    return () => w.cancelIdleCallback?.(h)
  }
  const t = setTimeout(fn, 200)
  return () => clearTimeout(t)
}

/** Tests: forget fetch times and in-flight requests. */
export function __resetKbResource(): void {
  inflight.clear()
  fetchedAt.clear()
}
