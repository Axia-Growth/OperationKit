import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../../lib/api'
import type { AgentsResponse, ThreadResponse, ThreadsResponse } from './types'

/* Bots page cache (obj 900865): switching bots must paint at once.

   One in-memory, stale-while-revalidate store for everything the Bots page
   reads per bot: the bot list, the sidebar state, each bot's conversation and
   side threads, and the settings sections. A bot you have already opened (or
   hovered, see prefetch) paints from here immediately and is then refreshed in
   the background, so a switch never waits on the network and never shows a
   blank pane.

   - It lives for the browser tab only (module memory, never localStorage), so
     no chat history is written to disk.
   - It is scoped to ONE signed-in person: `setChatCacheScope(userId)` empties it
     when a different person signs in on the same tab.
   - Concurrent reads of the same key share one request, so a hover prefetch and
     the click that follows it never fetch twice.
   - A write made while a read is in flight wins: the older read result is
     dropped instead of overwriting a just-sent message. */

type Entry = { data: unknown; at: number }

const store = new Map<string, Entry>()
const inflight = new Map<string, Promise<unknown>>()
const writes = new Map<string, number>()
const listeners = new Set<() => void>()
let scope: string | null = null
let generation = 0

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

function reset() {
  generation++
  store.clear()
  inflight.clear()
  writes.clear()
}

/**
 * Bind the cache to one person; a different person (or sign-out) empties it.
 * Safe to call while rendering: it does not notify subscribers (whoever reads
 * next simply finds the cache empty).
 */
export function setChatCacheScope(next: string | null) {
  if (next === scope) return
  scope = next
  reset()
}

/** Forget everything (tests). */
export function clearChatCache() {
  scope = null
  reset()
  emit()
}

export function readCache<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined
}

/** Milliseconds since the key was last stored, or Infinity when it never was. */
export function cacheAge(key: string): number {
  const e = store.get(key)
  return e ? Date.now() - e.at : Infinity
}

/** Store a value (or update the cached one). A write always beats an older in-flight read. */
export function writeCache<T>(key: string, next: T | ((prev: T | undefined) => T)) {
  const prev = store.get(key)?.data as T | undefined
  const data = typeof next === 'function' ? (next as (p: T | undefined) => T)(prev) : next
  writes.set(key, (writes.get(key) ?? 0) + 1)
  store.set(key, { data, at: Date.now() })
  emit()
}

/**
 * Read `key` from the network into the cache. Callers asking for the same key
 * while a read is in flight share it. Resolves with what the cache now holds.
 */
export function fetchInto<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const running = inflight.get(key)
  if (running) return running as Promise<T>
  const gen = generation
  const seen = writes.get(key) ?? 0
  const p = fetcher()
    .then(data => {
      if (gen !== generation) return data
      // Someone wrote this key after we asked: theirs is newer than our answer.
      if ((writes.get(key) ?? 0) !== seen && store.has(key)) return store.get(key)!.data as T
      store.set(key, { data, at: Date.now() })
      emit()
      return data
    })
    .finally(() => {
      if (inflight.get(key) === p) inflight.delete(key)
    })
  inflight.set(key, p)
  return p
}

/** Warm `key` unless it is fresh (younger than maxAgeMs) or already loading. Never throws. */
export function prefetch<T>(key: string, fetcher: () => Promise<T>, maxAgeMs = 15_000) {
  if (inflight.has(key) || cacheAge(key) < maxAgeMs) return
  fetchInto(key, fetcher).catch(() => {
    /* a failed warm-up is not an error: the real open will retry and show it */
  })
}

/**
 * Subscribe to one cached key and revalidate it whenever the key changes (or
 * `reload` is called). `data` is the cached value, so a key that was ever
 * loaded paints on the first render; `error` is set only by a failed read
 * (`fallbackError` when the failure carries no message of its own).
 */
export function useCached<T>(key: string | null, fetcher: () => Promise<T>, fallbackError = 'Could not load') {
  const data = useSyncExternalStore(
    subscribe,
    () => (key ? readCache<T>(key) : undefined),
    () => (key ? readCache<T>(key) : undefined),
  )
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const fetchRef = useRef(fetcher)
  fetchRef.current = fetcher

  const reload = useCallback(async () => {
    if (!key) return
    try {
      await fetchInto(key, () => fetchRef.current())
      setError(e => (e?.key === key ? null : e))
    } catch (e) {
      setError({ key, message: e instanceof Error && e.message ? e.message : fallbackError })
    }
  }, [key, fallbackError])

  useEffect(() => {
    void reload()
  }, [reload])

  return { data, error: error && error.key === key ? error.message : null, reload }
}

// ── what the Bots page caches, and how it reads each one ──

export const AGENTS_KEY = 'agents'
export const SIDEBAR_KEY = 'sidebar'

const botBase = (slug: string) => `/agent-chat/agents/${encodeURIComponent(slug)}`

/** One lane of one bot: `lane` null = the main conversation, a number = that side thread. */
export const messagesKey = (slug: string, lane: number | null) => `messages:${slug}:${lane ?? 'main'}`
export const threadsKey = (slug: string) => `threads:${slug}`

export const fetchAgents = () => api.get<AgentsResponse>('/agent-chat/agents')
// Omitting thread_id is what asks for the main conversation, server-side.
export const fetchMessages = (slug: string, lane: number | null) =>
  api.get<ThreadResponse>(`${botBase(slug)}/messages${lane === null ? '' : `?thread_id=${lane}`}`)
export const fetchThreads = (slug: string) => api.get<ThreadsResponse>(`${botBase(slug)}/threads`)

/**
 * Warm what opening a bot reads first — its main conversation and its side
 * threads — so the click that follows paints from memory. Called on hover,
 * keyboard focus and touch-down in the sidebar, and once at idle for the
 * first few bots.
 */
export function prefetchBot(slug: string) {
  prefetch(messagesKey(slug, null), () => fetchMessages(slug, null))
  prefetch(threadsKey(slug), () => fetchThreads(slug))
}
