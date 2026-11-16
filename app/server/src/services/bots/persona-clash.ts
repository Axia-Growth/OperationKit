/**
 * Agents-table rows that collide with a chat bot's slug (obj 901026).
 *
 * "A bot and an agent are the same thing" removed the refusal that used to
 * block a bot from owning a card under a slug that ALSO names a worker
 * persona: `botSlugPassesAgentPool` (bot-workspaces.ts), `botOwnershipRefusal`
 * (full-access-tools.ts), `cardSessionFullAccess` (bot-full-access.ts) and
 * `resolveCardWorker` (prompt-builder-workdir.ts) all now let an EXPLICIT
 * workspace grant win over a persona sharing the slug. That makes most such
 * collisions harmless by themselves.
 *
 * What is still worth cleaning up: an agents-table row that exists ONLY
 * because someone (an admin working around the old refusal with a direct
 * agent-create, or a stale migration) added a worker-persona row for what is
 * really just a bot's chat slug — e.g. a chat bot called "operation-kit-dev"
 * that also somehow has its own `agents` row. This module finds those rows
 * and archives them ONE AT A TIME, with a backup, on explicit request.
 *
 * It NEVER touches the five default-roster personas (cto/cmo/coo/cfo/general,
 * `DEFAULT_AGENT_SEED`): those intentionally share names with their namesake
 * chat bots by design (review of PR 797's own test fixtures assign the
 * built-in "General"/"CFO"/"CTO" bots exactly those slugs) and archiving one
 * would break the workspace-default-agent fallback for every install.
 */
import { getDb } from '../../db/index.js'
import { isDefaultRosterSlug } from '../../db/schema/agents.js'
import { archiveAgent, getAgent, listAgents } from '../agent-registry.js'
import { builtinsEnabled, loadChatAgents } from '../agent-chat/agent-defs.js'

export interface PersonaBotClash {
  slug: string
  label: string
  botName: string
}

/**
 * Agents-table rows (archived rows excluded, the default roster excluded)
 * whose slug also names an installed chat bot (built-in or install file).
 */
export function findPersonaBotClashes(): PersonaBotClash[] {
  const bots = loadChatAgents({ includeBuiltins: builtinsEnabled() }).agents
  const botBySlug = new Map(bots.map(b => [b.slug, b]))
  const out: PersonaBotClash[] = []
  for (const agent of listAgents()) {
    if (isDefaultRosterSlug(agent.slug)) continue
    const bot = botBySlug.get(agent.slug)
    if (bot) out.push({ slug: agent.slug, label: agent.label, botName: bot.name || bot.slug })
  }
  return out
}

const BACKUP_SETTING = 'bot_persona_clash_backups'

function readBackups(db: ReturnType<typeof getDb>): unknown[] {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(BACKUP_SETTING) as { value: string } | undefined
    if (!row) return []
    const parsed = JSON.parse(row.value) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export type ArchiveClashResult = { ok: true } | { ok: false; reason: string }

/**
 * Back up and archive ONE clashing agents-table row. Never bulk, never
 * automatic: an operator names the slug after reviewing `findPersonaBotClashes`
 * (or its CLI, `scripts/bot-persona-clash.ts report`). The backup is an
 * append-only JSON array in `settings.bot_persona_clash_backups`, so an
 * earlier archive's snapshot is never overwritten by a later one.
 *
 * Refuses (and archives nothing) for:
 *  - a default-roster slug (cto/cmo/coo/cfo/general) — never touched here;
 *  - a slug with no agents-table row;
 *  - a slug `archiveAgent` itself refuses (active non-terminal objectives
 *    still assigned to it) — the row stays exactly as it was.
 */
export function archivePersonaClash(slug: string): ArchiveClashResult {
  if (isDefaultRosterSlug(slug)) {
    return { ok: false, reason: `"${slug}" is a default-roster persona and is never archived by this tool` }
  }
  const agent = getAgent(slug)
  if (!agent) return { ok: false, reason: 'not_found' }
  const db = getDb()
  const result = archiveAgent(slug)
  if (!result.ok) return { ok: false, reason: result.reason ?? 'archive refused' }
  const backups = readBackups(db)
  backups.push({ ...agent, backed_up_at: new Date().toISOString() })
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(BACKUP_SETTING, JSON.stringify(backups))
  return { ok: true }
}

/** The backup snapshots written by `archivePersonaClash`, oldest first. */
export function readPersonaClashBackups(): unknown[] {
  return readBackups(getDb())
}
