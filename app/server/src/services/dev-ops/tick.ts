/**
 * The dev-ops background tick (obj 901424). Host only (index.ts; never on a
 * scratch instance): every 30s it merges updated branches whose CI went green
 * (merge.ts `processPendingMerges`) and settles finished deploys (deploy.ts
 * `settleDeploys`). The first pass runs at boot, so a deploy that restarted the
 * app is settled as soon as the new process is up.
 */
import { settleDeploys } from './deploy.js'
import { processPendingMerges } from './merge.js'
import { processRepoPending } from './repo-merge.js'

const TICK_MS = 30_000
let timer: ReturnType<typeof setInterval> | null = null
let busy = false

export async function devOpsTickOnce(): Promise<void> {
  if (busy) return
  busy = true
  try {
    try { settleDeploys() } catch (err) { console.warn('[dev-ops] settle deploys failed:', (err as Error).message) }
    try { await processPendingMerges() } catch (err) { console.warn('[dev-ops] pending merges failed:', (err as Error).message) }
    // obj 901492: PRs updated by repo and number (merge on green, or just "CI really started").
    try { await processRepoPending() } catch (err) { console.warn('[dev-ops] repo pending failed:', (err as Error).message) }
  } finally {
    busy = false
  }
}

export function startDevOpsTicks(): void {
  if (timer) return
  setTimeout(() => { void devOpsTickOnce() }, 5_000).unref?.()
  timer = setInterval(() => { void devOpsTickOnce() }, TICK_MS)
  timer.unref?.()
}

export function stopDevOpsTicks(): void {
  if (timer) clearInterval(timer)
  timer = null
}
