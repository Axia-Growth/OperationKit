/**
 * obj 900963 — the semantic index labels a file in a workspace's custom
 * knowledge folder (`workspaces.vault_path`) with THAT workspace, using the same
 * helper as the search wall. The label is the KNN pre-filter, so a wrong label
 * hides the note from workspace-filtered semantic search.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-label-')))
const KB = path.join(TMP, 'vault')
process.env.SECOND_BRAIN_ROOT = KB
process.env.DB_PATH = path.join(TMP, 'cc.db')

const { initDb, getDb } = await import('../../db/index.js')
const { invalidateWorkspacesCache } = await import('../workspaces.js')
const { indexFile, workspaceLabel } = await import('./indexer.js')
const { ensureSchema, getDocRow, loadVecExtension } = await import('./store.js')
const { normalize } = await import('./providers.js')
type EmbeddingProvider = import('./providers.js').EmbeddingProvider

const ACME_DIR = path.join(KB, 'clients/acme-notes')
const write = (p: string, body: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}
const F = {
  acme: path.join(ACME_DIR, 'plan.md'),
  nested: path.join(ACME_DIR, 'deep/more/notes.md'),
  vaultLayout: path.join(KB, 'workspaces/other-co/strong.md'),
  dataLayout: path.join(KB, 'flatco/notes.md'),
  escape: path.join(ACME_DIR, 'escape.md'),
  outside: path.join(TMP, 'outside/payroll.md'),
}

function setVaultPath(slug: string, vaultPath: string | null): void {
  getDb().prepare('INSERT OR REPLACE INTO workspaces (slug, name, vault_path) VALUES (?, ?, ?)').run(slug, slug, vaultPath)
  invalidateWorkspacesCache()
}

let embedCalls = 0
const provider: EmbeddingProvider = {
  config: { provider: 'local', model: 'stub', baseUrl: '', apiKeySecret: '', dimensions: 3 },
  modelId: 'test:stub:3',
  async embed(texts) {
    embedCalls += 1
    return texts.map((t) => normalize([t.length % 7 + 1, 1, 0.05]))
  },
}

beforeAll(() => {
  write(F.acme, '# acme plan\n\nonboarding checklist\n')
  write(F.nested, '# nested\n\nmore notes\n')
  write(F.vaultLayout, '# other\n\nnotes\n')
  write(F.dataLayout, '# flat\n\nnotes\n')
  write(F.outside, '# payroll\n')
  fs.symlinkSync(F.outside, F.escape)
  initDb()
  setVaultPath('acme', ACME_DIR)
  setVaultPath('other-co', null)
})

afterAll(() => {
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('workspaceLabel with a custom vault folder', () => {
  it('labels a file in the custom folder with its workspace, not with the folder name', () => {
    expect(workspaceLabel(KB, F.acme)).toBe('acme')
    expect(workspaceLabel(KB, F.nested)).toBe('acme')
  })

  it('leaves the two default layouts as they were', () => {
    expect(workspaceLabel(KB, F.vaultLayout)).toBe('other-co')
    expect(workspaceLabel(KB, F.dataLayout)).toBe('flatco')
    expect(workspaceLabel(KB, path.join(KB, 'top.md'))).toBe('')
  })

  it('does not give the workspace label to a symlink that leaves the custom folder', () => {
    expect(workspaceLabel(KB, F.escape)).not.toBe('acme')
  })

  it('a vault_path that is the whole knowledge base labels nothing', () => {
    setVaultPath('everything', KB)
    try {
      expect(workspaceLabel(KB, F.vaultLayout)).toBe('other-co')
      expect(workspaceLabel(KB, F.acme)).toBe('acme')
    } finally {
      getDb().prepare(`DELETE FROM workspaces WHERE slug = 'everything'`).run()
      invalidateWorkspacesCache()
    }
  })
})

describe('indexFile stores the label and re-embeds when it changes', () => {
  it('embeds with the workspace label, and a vault_path change re-labels an unchanged file', async () => {
    const db = getDb()
    ensureSchema(db)
    if (!loadVecExtension(db)) return // sqlite-vec not available on this host: the label logic is covered above
    const deps = { db, provider, root: KB }

    expect((await indexFile(deps, F.acme)).outcome).toBe('embedded')
    expect(getDocRow(db, F.acme)?.workspace).toBe('acme')
    const stored = db.prepare('SELECT DISTINCT workspace FROM kb_embed_chunks WHERE path = ?').all(F.acme) as { workspace: string }[]
    expect(stored).toEqual([{ workspace: 'acme' }])

    // Same file, same label: nothing to do.
    const before = embedCalls
    expect((await indexFile(deps, F.acme)).outcome).toBe('skipped')
    expect(embedCalls).toBe(before)

    // The custom folder is taken away: the file is untouched on disk, but its
    // label is now stale, so it is embedded again under the layout label.
    setVaultPath('acme', null)
    try {
      expect((await indexFile(deps, F.acme)).outcome).toBe('embedded')
      expect(getDocRow(db, F.acme)?.workspace).toBe('clients')
    } finally {
      setVaultPath('acme', ACME_DIR)
    }
    expect((await indexFile(deps, F.acme)).outcome).toBe('embedded')
    expect(getDocRow(db, F.acme)?.workspace).toBe('acme')
  })
})
