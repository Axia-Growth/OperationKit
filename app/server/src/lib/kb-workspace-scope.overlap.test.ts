/**
 * obj 901152 — a workspace's `vault_path` must be its OWN folder.
 *
 * Before this, `workspaceVaultRoot` only refused a vault_path that was a
 * CONTAINER (the KB root, or a folder holding another workspace's folder). A
 * vault_path pointing INSIDE another workspace's folder, or at the SAME
 * folder, was accepted, so that workspace's search, card-start context,
 * semantic labels and bot guard covered part of another workspace's notes. And
 * the admin routes stored any string.
 *
 * Synthetic fixtures only: a throwaway knowledge base and made-up workspaces.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'

// db/index.ts's import graph reaches node-pty; nothing here opens a terminal.
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in this test') } }))

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-overlap-')))
const KB = path.join(TMP, 'vault')
process.env.SECOND_BRAIN_ROOT = KB
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'test-secret-kb-overlap-xx'

const { initDb, getDb } = await import('../db/index.js')
const { invalidateWorkspacesCache, getWorkspace } = await import('../services/workspaces.js')
const { searchKnowledgeForWorkspace } = await import('../services/knowledge-search.js')
const { resetVaultIndexCache } = await import('../services/vault-index.js')
const { kbWorkspaceGuard } = await import('../services/agent-chat/tools.js')
const { grantBotWorkspace } = await import('../services/agent-chat/bot-workspaces.js')
const {
  isInWorkspaceScope, workspaceScopeRoots, workspaceVaultRoot, workspaceOfVaultPath, vaultPathConflict, resolveVaultPath,
} = await import('./kb-workspace-scope.js')
const { default: adminWorkspacesRouter } = await import('../routes/admin-workspaces.js')

function write(p: string, body: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

// `beta` keeps its notes in the default layout; `gamma` in a custom folder.
const BETA_DIR = path.join(KB, 'workspaces/beta')
const GAMMA_DIR = path.join(KB, 'clients/gamma-notes')
const F = {
  betaSecret: path.join(BETA_DIR, 'sub/payroll.md'),
  gammaSecret: path.join(GAMMA_DIR, 'deep/contract.md'),
  alphaOwn: path.join(KB, 'workspaces/alpha/plan.md'),
}
const QUERY = 'quuxwhistle ledger quuxwhistle'

const added = new Set<string>()
function addWorkspace(slug: string, vaultPath: string | null, opts: { archived?: boolean } = {}): void {
  getDb().prepare('INSERT OR REPLACE INTO workspaces (slug, name, vault_path, archived) VALUES (?, ?, ?, ?)')
    .run(slug, slug, vaultPath, opts.archived ? 1 : 0)
  invalidateWorkspacesCache()
  added.add(slug)
}
function setVault(slug: string, vaultPath: string | null): void {
  getDb().prepare('UPDATE workspaces SET vault_path = ? WHERE slug = ?').run(vaultPath, slug)
  invalidateWorkspacesCache()
}

let server: http.Server
let baseUrl: string
const ADMIN = `token=${jwt.sign({ id: 1, username: 'owner', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`

beforeAll(async () => {
  write(F.betaSecret, `# beta payroll\n\n${'quuxwhistle ledger '.repeat(10)}\nBETA-ONLY-SECRET\n`)
  write(F.gammaSecret, `# gamma contract\n\n${'quuxwhistle ledger '.repeat(10)}\nGAMMA-ONLY-SECRET\n`)
  write(F.alphaOwn, '# alpha plan\n\nquuxwhistle ledger once. ALPHA-OWN\n')
  initDb()
  addWorkspace('alpha', null)
  addWorkspace('beta', null)
  addWorkspace('gamma', GAMMA_DIR)
  resetVaultIndexCache()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/admin/workspaces', adminWorkspacesRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(() => {
  // Back to the baseline rows after every case.
  for (const slug of added) {
    if (!['alpha', 'beta', 'gamma'].includes(slug)) getDb().prepare('DELETE FROM workspaces WHERE slug = ?').run(slug)
  }
  setVault('alpha', null)
  setVault('beta', null)
  setVault('gamma', GAMMA_DIR)
  resetVaultIndexCache()
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  fs.rmSync(TMP, { recursive: true, force: true })
})

/** alpha's vault_path is `vault`; assert it is refused and leaks nothing. */
function expectRefused(vault: string, kind: string, relation?: string) {
  setVault('alpha', vault)
  expect(workspaceVaultRoot('alpha', KB)).toBeNull()
  const conflict = vaultPathConflict('alpha', vault, KB)
  expect(conflict?.kind).toBe(kind)
  if (relation) expect((conflict as { relation?: string }).relation).toBe(relation)
  // Default folders still apply, and nothing of beta / gamma is in scope.
  expect(workspaceScopeRoots('alpha', KB)).toEqual([path.join(KB, 'workspaces/alpha'), path.join(KB, 'alpha')])
  expect(isInWorkspaceScope(F.betaSecret, 'alpha', KB)).toBe(false)
  expect(isInWorkspaceScope(F.gammaSecret, 'alpha', KB)).toBe(false)
  expect(isInWorkspaceScope(F.alphaOwn, 'alpha', KB)).toBe(true)
  const blob = JSON.stringify(searchKnowledgeForWorkspace(QUERY, 'alpha'))
  expect(blob).not.toContain('BETA-ONLY-SECRET')
  expect(blob).not.toContain('GAMMA-ONLY-SECRET')
}

describe('scope: a vault_path that overlaps another workspace is refused (fail closed)', () => {
  it('inside another workspace\'s default folder', () => {
    expectRefused(path.join(BETA_DIR, 'sub'), 'default_folder', 'inside')
    expect(workspaceOfVaultPath(F.betaSecret, KB)).toBeNull()
  })

  it('inside another workspace\'s default folder that does not exist yet', () => {
    addWorkspace('delta', null) // no folder on disk
    expectRefused(path.join(KB, 'workspaces/delta/later'), 'default_folder', 'inside')
  })

  it('inside another workspace\'s vault_path', () => {
    expectRefused(path.join(GAMMA_DIR, 'deep'), 'vault_path', 'inside')
    // And the other side fails closed too: gamma's folder overlaps alpha's.
    expect(workspaceVaultRoot('gamma', KB)).toBeNull()
    expect(workspaceOfVaultPath(F.gammaSecret, KB)).toBeNull()
  })

  it('equal to another workspace\'s default folder', () => {
    expectRefused(BETA_DIR, 'default_folder', 'equal')
  })

  it('equal to another workspace\'s vault_path', () => {
    expectRefused(GAMMA_DIR, 'vault_path', 'equal')
    expect(workspaceVaultRoot('gamma', KB)).toBeNull()
  })

  it('a symlink into another workspace\'s folder', () => {
    const link = path.join(TMP, 'into-beta')
    fs.symlinkSync(path.join(BETA_DIR, 'sub'), link)
    try {
      expectRefused(link, 'default_folder', 'inside')
    } finally { fs.unlinkSync(link) }
  })

  it('a not-yet-created folder under a symlink into another workspace\'s vault_path', () => {
    const link = path.join(TMP, 'into-gamma')
    fs.symlinkSync(GAMMA_DIR, link)
    try {
      expect(resolveVaultPath(path.join(link, 'new/folder'))).toBe(path.join(GAMMA_DIR, 'new/folder'))
      expectRefused(path.join(link, 'new/folder'), 'vault_path', 'inside')
    } finally { fs.unlinkSync(link) }
  })

  it('".." traversal into another workspace\'s folder', () => {
    expectRefused(path.join(KB, 'workspaces/alpha/../beta/sub'), 'default_folder', 'inside')
    expectRefused(`${KB}/clients/x/../gamma-notes`, 'vault_path', 'equal')
  })

  it('the existing container cases are still refused', () => {
    expectRefused(KB, 'kb_root')
    expectRefused(TMP, 'kb_root')
    expectRefused(path.join(KB, 'workspaces'), 'default_folder', 'contains')
    expectRefused(path.join(KB, 'clients'), 'vault_path', 'contains')
  })
})

describe('scope: what still works', () => {
  it('the live-install shape: every workspace\'s vault_path is workspaces/<own-slug>', () => {
    setVault('alpha', path.join(KB, 'workspaces/alpha'))
    setVault('beta', BETA_DIR)
    addWorkspace('epsilon', path.join(KB, 'workspaces/epsilon'))
    expect(workspaceVaultRoot('alpha', KB)).toBe(path.join(KB, 'workspaces/alpha'))
    expect(workspaceVaultRoot('beta', KB)).toBe(BETA_DIR)
    expect(workspaceVaultRoot('epsilon', KB)).toBe(path.join(KB, 'workspaces/epsilon'))
    expect(workspaceVaultRoot('gamma', KB)).toBe(GAMMA_DIR)
    expect(isInWorkspaceScope(F.betaSecret, 'beta', KB)).toBe(true)
    expect(isInWorkspaceScope(F.betaSecret, 'alpha', KB)).toBe(false)
    expect(vaultPathConflict('alpha', path.join(KB, 'workspaces/alpha'), KB)).toBeNull()
  })

  it('a subfolder of the workspace\'s OWN default folder is fine', () => {
    setVault('alpha', path.join(KB, 'workspaces/alpha/notes'))
    expect(workspaceVaultRoot('alpha', KB)).toBe(path.join(KB, 'workspaces/alpha/notes'))
  })

  it('an archived workspace does not block a folder', () => {
    addWorkspace('old-co', null, { archived: true })
    setVault('alpha', path.join(KB, 'workspaces/old-co/kept'))
    expect(workspaceVaultRoot('alpha', KB)).toBe(path.join(KB, 'workspaces/old-co/kept'))
  })

  it('another workspace\'s INVALID vault_path (the KB root) does not take anyone\'s folder away', () => {
    addWorkspace('everything', KB)
    expect(workspaceVaultRoot('everything', KB)).toBeNull()
    expect(workspaceVaultRoot('gamma', KB)).toBe(GAMMA_DIR)
    expect(isInWorkspaceScope(F.gammaSecret, 'gamma', KB)).toBe(true)
  })
})

describe('bot guard: a refused vault_path never grants, it only walls', () => {
  const agent = { slug: 'overlap-guard-bot', name: 'Guard bot' } as Parameters<typeof kbWorkspaceGuard>[0]['agent']

  it('alpha\'s vault_path inside beta does not let an alpha-only bot read beta', () => {
    grantBotWorkspace(agent.slug, 'alpha', 'admin')
    const guard = () => kbWorkspaceGuard({ kbRoot: KB, agent })
    // Baseline: beta's file is beta's, and an alpha-only bot is refused.
    expect(guard().deniedWorkspace(F.betaSecret)).toBe('beta')
    expect(guard().deniedWorkspace(F.alphaOwn)).toBeNull()
    // The overlap: before obj 901152 alpha's raw vault_path was the deepest
    // ALLOWED root here, so this returned null (readable).
    setVault('alpha', path.join(BETA_DIR, 'sub'))
    expect(guard().deniedWorkspace(F.betaSecret)).not.toBeNull()
    setVault('alpha', path.join(GAMMA_DIR, 'deep'))
    expect(guard().deniedWorkspace(F.gammaSecret)).not.toBeNull()
    // Its own folder still reads.
    expect(guard().deniedWorkspace(F.alphaOwn)).toBeNull()
  })
})

describe('admin routes validate vault_path (400, never saved)', () => {
  async function call(method: 'POST' | 'PATCH', url: string, body: unknown) {
    const res = await fetch(`${baseUrl}/api/admin/workspaces${url}`, {
      method, headers: { 'Content-Type': 'application/json', Cookie: ADMIN }, body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() as Record<string, unknown> }
  }

  it('POST refuses a vault_path inside another workspace\'s folder', async () => {
    const r = await call('POST', '/', { slug: 'newco', name: 'New', vault_path: path.join(BETA_DIR, 'sub') })
    expect(r.status).toBe(400)
    expect(r.body.code).toBe('vault_path_overlap')
    expect(String(r.body.error)).toMatch(/inside the folder of workspace 'beta'/)
    expect(getWorkspace('newco')).toBeUndefined()
  })

  it('POST refuses a relative path and the KB root', async () => {
    expect((await call('POST', '/', { slug: 'newco', name: 'New', vault_path: 'workspaces/newco' })).body.code).toBe('vault_path_invalid')
    expect((await call('POST', '/', { slug: 'newco', name: 'New', vault_path: KB })).status).toBe(400)
    expect(getWorkspace('newco')).toBeUndefined()
  })

  it('POST accepts the workspace\'s own folder', async () => {
    const r = await call('POST', '/', { slug: 'newco', name: 'New', vault_path: path.join(KB, 'workspaces/newco') })
    added.add('newco')
    expect(r.status).toBe(201)
    expect(getWorkspace('newco')?.vault_path).toBe(path.join(KB, 'workspaces/newco'))
  })

  it('PATCH refuses equal / inside / containing paths and leaves the row unchanged', async () => {
    for (const bad of [GAMMA_DIR, path.join(GAMMA_DIR, 'deep'), path.join(KB, 'clients'), BETA_DIR, `${KB}/workspaces/alpha/../beta`]) {
      const r = await call('PATCH', '/alpha', { vault_path: bad, name: 'Renamed' })
      expect(r.status, bad).toBe(400)
      expect(r.body.code).toBe('vault_path_overlap')
    }
    expect(getWorkspace('alpha')?.vault_path).toBeNull()
    expect(getWorkspace('alpha')?.name).toBe('alpha')
  })

  it('PATCH accepts an own folder, and null or "" clears it', async () => {
    const own = path.join(KB, 'workspaces/alpha')
    expect((await call('PATCH', '/alpha', { vault_path: own })).status).toBe(200)
    expect(getWorkspace('alpha')?.vault_path).toBe(own)
    expect((await call('PATCH', '/alpha', { vault_path: null })).status).toBe(200)
    expect(getWorkspace('alpha')?.vault_path).toBeNull()
    setVault('alpha', own)
    expect((await call('PATCH', '/alpha', { vault_path: '  ' })).status).toBe(200)
    expect(getWorkspace('alpha')?.vault_path).toBeNull()
  })

  it('PATCH without vault_path does not touch it', async () => {
    expect((await call('PATCH', '/gamma', { name: 'Gamma Co' })).status).toBe(200)
    expect(getWorkspace('gamma')?.vault_path).toBe(GAMMA_DIR)
  })

  it('PATCH re-saving gamma\'s own vault_path is fine (it does not conflict with itself)', async () => {
    expect((await call('PATCH', '/gamma', { vault_path: GAMMA_DIR })).status).toBe(200)
  })
})
