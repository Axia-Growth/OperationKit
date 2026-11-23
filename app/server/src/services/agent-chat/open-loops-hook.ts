// Wiring for the open-loops digest (obj 901382): when a High Agency wake card
// ends as done, post the waiting-on-owner list into the bot's chat thread.
// Kept apart from open-loops.ts so the chat engine and the wake brief do not
// pull the WebSocket server into their import graph.
import { getDb } from '../../db/index.js'
import { onObjectiveEnded } from '../../ws/index.js'
import { postOpenLoopsDigest } from './open-loops.js'
import { highAgencyWakeForCard } from '../../lib/high-agency-wake-scope.js'
import { rollBotJournal } from './bot-memory.js'

let stop: (() => void) | null = null
/** Register the wake-ended hook once (index.ts, host instance only). */
export function startOpenLoopsDigestHook(): void {
  if (stop) return
  stop = onObjectiveEnded((id, status) => {
    if (status !== 'done') return
    // obj 901500: a wake writes journal lines; archive the oldest ones now rather than at the next chat turn.
    try {
      const wake = highAgencyWakeForCard(getDb(), id)
      if (wake) rollBotJournal(wake.slug)
    } catch { /* the next chat turn rolls it */ }
    const out = postOpenLoopsDigest(getDb(), id)
    if (out.posted) console.log(`[open-loops] posted the waiting-on-owner digest (${out.count} lines) to ${out.slug}'s chat after wake #${id}`)
  })
}
export function stopOpenLoopsDigestHook(): void {
  stop?.()
  stop = null
}
