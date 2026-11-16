/**
 * After a deploy, a stale tab still holds hashed asset URLs (e.g.
 * `JobsBoard-DiBVbAZO.js`) from the PREVIOUS build. The old chunk is gone once
 * the new build lands, so a lazy route import 404s with one of these messages
 * instead of rendering. The fix is a single automatic reload — the fresh index
 * HTML points at the new hashes — guarded by sessionStorage so a genuinely
 * broken chunk (not just a stale one) can't reload forever.
 */
const CHUNK_ERROR_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /loading chunk [\w-]+ failed/i,
  /loading css chunk [\w-]+ failed/i,
  /importing a module script failed/i,
]

const RELOAD_FLAG_KEY = 'cc-chunk-reload-attempted'

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false
  const message = error instanceof Error ? error.message : String(error)
  return CHUNK_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

/**
 * Reload once for a stale-chunk error. Returns true if a reload was triggered
 * (caller should not render its own error UI in that case), false if a reload
 * was already attempted this session (caller should fall back to showing the
 * error so the guard can't loop).
 */
export function reloadOnceForChunkError(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_FLAG_KEY)) return false
    sessionStorage.setItem(RELOAD_FLAG_KEY, '1')
  } catch {
    // sessionStorage unavailable (private mode, etc.) — fall back to showing the error
    // rather than risking an unguarded reload loop.
    return false
  }
  window.location.reload()
  return true
}

/** Clear the guard once something has rendered successfully, so a later real deploy can reload again. */
export function clearChunkReloadGuard(): void {
  try {
    sessionStorage.removeItem(RELOAD_FLAG_KEY)
  } catch {
    // ignore
  }
}
