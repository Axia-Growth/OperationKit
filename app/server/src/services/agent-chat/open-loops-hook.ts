// Wiring for the open-loops digest (obj 901382): when a High Agency wake card
// ends as done, post the waiting-on-owner list into the bot's chat thread.
// Kept apart from open-loops.ts so the chat engine and the wake brief do not
// pull the WebSocket server into their import graph.
import { getDb } from '../../db/index.js'
import { onObjectiveEnded } from '../../ws/index.js'
import { postOpenLoopsDigest } from './open-loops.js'

let stop: (() => void) | null = null
/** Register the wake-ended hook once (index.ts, host instance only). */
export function startOpenLoopsDigestHook(): void {
  if (stop) return
  stop = onObjectiveEnded((id, status) => {
    if (status !== 'done') return
    const out = postOpenLoopsDigest(getDb(), id)
    if (out.posted) console.log(`[open-loops] posted the waiting-on-owner digest (${out.count} lines) to ${out.slug}'s chat after wake #${id}`)
  })
}
export function stopOpenLoopsDigestHook(): void {
  stop?.()
  stop = null
}
