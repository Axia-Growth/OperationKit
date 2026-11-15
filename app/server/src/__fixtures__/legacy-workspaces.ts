/**
 * TEST FIXTURE ONLY (obj 900803). Before white-label polish F2 every fresh DB
 * was seeded with the original author's workspaces and their dev-registry
 * repos / integrations. Production no longer does that (a fresh install starts
 * blank), but many suites were written against those rows. They call this
 * right after initDb() to get the same starting state, explicitly.
 *
 * Import it dynamically AFTER the suite has set DB_PATH (it pulls in the
 * workspace service graph).
 */
import type Database from 'better-sqlite3'

const LEGACY_WORKSPACES: Array<[slug: string, name: string, shortLabel: string, badge: string, vault: string | null, sort: number]> = [
  ['example', 'Example', 'Example', 'bg-blue-500/20 text-blue-400', '/home/operator/second-brain/workspaces/example', 1],
  ['example-project', 'Example Project', 'WS', 'bg-green-500/20 text-green-400', '/home/operator/second-brain/workspaces/example-project', 2],
  ['operator', 'Operator', 'ML', 'bg-purple-500/20 text-purple-400', '/home/operator/second-brain/workspaces/operator', 3],
  ['example2', 'Example3', 'EXAMPLE2', 'bg-emerald-500/20 text-emerald-400', null, 4],
  ['example5', 'Example Five', 'EXAMPLE5', 'bg-teal-500/20 text-teal-400', '/home/operator/second-brain/workspaces/example5', 5],
]

export async function seedLegacyWorkspaces(db: Database.Database): Promise<void> {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO workspaces
       (slug, name, short_label, badge_color, vault_path, doc_read_roots, doc_write_roots, default_agent_pool, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const [slug, name, label, badge, vault, sort] of LEGACY_WORKSPACES) {
    const roots = vault ? [vault, '/home/operator/second-brain/shared', '/home/operator/ai-workspace/agents', '/home/operator/ai-workspace/skills'] : []
    ins.run(slug, name, label, badge, vault, JSON.stringify(roots), JSON.stringify(vault ? [vault] : []),
      JSON.stringify(['cto', 'cmo', 'coo', 'cfo', 'general']), sort)
  }
  // The dev registry seeds repos / integrations only into workspaces that exist.
  const { seedDevelopmentRegistry } = await import('../db/schema/development.js')
  seedDevelopmentRegistry(db)
  // services/workspaces.ts caches the table — make the new rows visible.
  const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
  invalidateWorkspacesCache()
}
