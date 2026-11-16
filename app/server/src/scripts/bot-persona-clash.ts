#!/usr/bin/env tsx
/**
 * Report, and (on explicit request) archive, agents-table rows that collide
 * with a chat bot's slug (obj 901026 — "a bot and an agent are the same
 * thing"). Never automatic and never touches the default-roster personas
 * (cto/cmo/coo/cfo/general) — see services/bots/persona-clash.ts.
 *
 *   docker exec command-center tsx server/src/scripts/bot-persona-clash.ts report
 *   docker exec command-center tsx server/src/scripts/bot-persona-clash.ts archive <slug>
 *   docker exec command-center tsx server/src/scripts/bot-persona-clash.ts backups
 */
import { initDb } from '../db/index.js'
import { archivePersonaClash, findPersonaBotClashes, readPersonaClashBackups } from '../services/bots/persona-clash.js'

function main(): void {
  const [cmd, slug] = process.argv.slice(2)
  initDb()

  if (cmd === 'archive') {
    if (!slug) {
      console.error('Usage: bot-persona-clash.ts archive <slug>')
      process.exitCode = 1
      return
    }
    const r = archivePersonaClash(slug)
    if (!r.ok) {
      console.error(`Refused: ${r.reason}`)
      process.exitCode = 1
      return
    }
    console.log(`Archived "${slug}" (backed up first in settings.bot_persona_clash_backups). It no longer appears as a worker persona — the bot owns its own slug now.`)
    return
  }

  if (cmd === 'backups') {
    console.log(JSON.stringify(readPersonaClashBackups(), null, 2))
    return
  }

  const clashes = findPersonaBotClashes()
  if (clashes.length === 0) {
    console.log('No agents-table rows collide with a chat bot slug.')
    return
  }
  console.log('Agents-table rows that also name a chat bot (default-roster personas are never listed here):')
  for (const c of clashes) console.log(`  ${c.slug} — persona "${c.label}", bot "${c.botName}"`)
  console.log('\nReview each one, then: bot-persona-clash.ts archive <slug>')
}

main()
