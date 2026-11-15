// Seed a SCRATCH Command Center DB for the Context load benchmark (obj 900867).
// Run from app/server with DB_PATH + SECOND_BRAIN_ROOT pointing at temp paths:
//   DB_PATH=/tmp/x/cc.db SECOND_BRAIN_ROOT=/tmp/kb-bench-vault npx tsx ../../scripts/bench/seed-scratch.mts
// Never point it at the live DB.
import path from 'path'
const vault = process.env.SECOND_BRAIN_ROOT
if (!vault || !process.env.DB_PATH || process.env.DB_PATH.includes('/app/data')) throw new Error('set a scratch DB_PATH and SECOND_BRAIN_ROOT')
const { initDb, getDb } = await import(path.resolve('src/db/index.ts'))
const { createWorkspace, getWorkspace } = await import(path.resolve('src/services/workspaces.ts'))
initDb()
const db = getDb()
db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('starter_pack:knowledge-import', '1')").run()
db.prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (1, 'bench', 'x', 'admin')").run()
for (const slug of ['operationkit', 'your-org']) {
  if (!getWorkspace(slug)) createWorkspace({ slug, name: slug, vault_path: path.join(vault, 'workspaces', slug) })
}
console.log('seeded', process.env.DB_PATH)
