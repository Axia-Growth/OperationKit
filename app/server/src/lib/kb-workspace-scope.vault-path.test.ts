/**
 * obj 900963 — workspace-filtered search honours a workspace's custom knowledge
 * folder (`workspaces.vault_path`), the way the bot guard already does.
 *
 * Synthetic fixtures only: a throwaway knowledge base with a made-up workspace
 * (`acme`) whose notes live in `<kb>/clients/acme-notes`, not in
 * `<kb>/workspaces/acme`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcrypt'

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-kb-vaultpath-')))
const KB = path.join(TMP, 'vault')
const OUTSIDE = path.join(TMP, 'outside')
const TMP_DB = path.join(TMP, 'cc.db')
process.env.SECOND_BRAIN_ROOT = KB
process.env.DB_PATH = TMP_DB
process.env.JWT_SECRET = 'test-secret-kb-vault-path-xx'

const { initDb, getDb } = await import('../db/index.js')
const { invalidateWorkspacesCache } = await import('../services/workspaces.js')
const { searchKnowledgeGrep, searchKnowledgeForWorkspace } = await import('../services/knowledge-search.js')
const { resetVaultIndexCache } = await import('../services/vault-index.js')
const { isInWorkspaceScope, filterToWorkspaceScope, workspaceScopeRoots, workspaceVaultRoot, workspaceOfVaultPath } =
  await import('./kb-workspace-scope.js')
const { default: docsRouter } = await import('../routes/docs.js')

function write(p: string, body: string): string {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body)
  return p
}

const ACME_DIR = path.join(KB, 'clients/acme-notes')
const F = {
  acmePlan: path.join(ACME_DIR, 'plan.md'),
  // Another workspace, in the default layout, and the stronger match.
  otherStrong: path.join(KB, 'workspaces/other-co/strong.md'),
  // In no workspace at all.
  shared: path.join(KB, 'shared/handbook.md'),
  // A symlink inside the custom folder pointing out of the knowledge base.
  symlinkEscape: path.join(ACME_DIR, 'escape.md'),
  outsideSecret: path.join(OUTSIDE, 'payroll.md'),
}
const QUERY = 'zorbflux onboarding zorbflux checklist'

let server: http.Server
let baseUrl: string
let cookie: string

function addWorkspace(slug: string, vaultPath: string | null): void {
  getDb().prepare('INSERT OR REPLACE INTO workspaces (slug, name, vault_path) VALUES (?, ?, ?)').run(slug, slug, vaultPath)
  invalidateWorkspacesCache()
}
function dropWorkspace(slug: string): void {
  getDb().prepare('DELETE FROM workspaces WHERE slug = ?').run(slug)
  invalidateWorkspacesCache()
}

beforeAll(async () => {
  write(F.acmePlan, '# acme plan\n\nzorbflux onboarding appears once here. ACME-ONLY\n')
  write(F.otherStrong, `# other\n\n${'zorbflux onboarding zorbflux checklist '.repeat(12)}\nOTHER-ONLY-SECRET\n`)
  write(F.shared, '# handbook\n\nzorbflux onboarding checklist for everyone. SHARED-ONLY\n')
  write(F.outsideSecret, `# payroll\n\n${'zorbflux onboarding zorbflux checklist '.repeat(12)}\nOUTSIDE-SECRET\n`)
  fs.symlinkSync(F.outsideSecret, F.symlinkEscape)

  initDb()
  addWorkspace('acme', ACME_DIR)
  addWorkspace('other-co', null)
  getDb().prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('owner', bcrypt.hashSync('pw', 4), 'admin')
  resetVaultIndexCache()

  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.use('/api/docs', docsRouter)
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()) })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
  cookie = `token=${jwt.sign({ id: 1, username: 'owner', role: 'admin' }, process.env.JWT_SECRET as string, { expiresIn: '1h' })}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try { getDb().close() } catch { /* already closed */ }
  resetVaultIndexCache()
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('workspace scope includes the custom vault folder', () => {
  it('lists the vault_path as one of the workspace roots, next to the default folders', () => {
    expect(workspaceVaultRoot('acme', KB)).toBe(ACME_DIR)
    const roots = workspaceScopeRoots('acme', KB)
    expect(roots).toContain(ACME_DIR)
    expect(roots).toContain(path.join(KB, 'workspaces/acme'))
    // A workspace with no vault_path is unchanged.
    expect(workspaceScopeRoots('other-co', KB)).toEqual([path.join(KB, 'workspaces/other-co'), path.join(KB, 'other-co')])
  })

  it('a file in the custom folder is in scope for that workspace only', () => {
    expect(isInWorkspaceScope(F.acmePlan, 'acme', KB)).toBe(true)
    expect(isInWorkspaceScope(F.acmePlan, 'other-co', KB)).toBe(false)
    expect(workspaceOfVaultPath(F.acmePlan, KB)).toBe('acme')
    expect(workspaceOfVaultPath(F.otherStrong, KB)).toBeNull()
  })

  it('a path outside every root is still rejected', () => {
    expect(isInWorkspaceScope(F.otherStrong, 'acme', KB)).toBe(false)
    expect(isInWorkspaceScope(F.shared, 'acme', KB)).toBe(false)
    expect(isInWorkspaceScope(F.outsideSecret, 'acme', KB)).toBe(false)
    // A sibling folder that merely starts with the same name.
    expect(isInWorkspaceScope(path.join(KB, 'clients/acme-notes-two/x.md'), 'acme', KB)).toBe(false)
    expect(isInWorkspaceScope(path.join(ACME_DIR, '../../workspaces/other-co/strong.md'), 'acme', KB)).toBe(false)
    expect(filterToWorkspaceScope([{ path: F.otherStrong }, { path: F.shared }, { path: F.acmePlan }], 'acme', KB))
      .toEqual([{ path: F.acmePlan }])
  })

  it('a symlink that leaves the custom folder is still rejected', () => {
    expect(fs.existsSync(F.symlinkEscape)).toBe(true)
    expect(isInWorkspaceScope(F.symlinkEscape, 'acme', KB)).toBe(false)
    expect(workspaceOfVaultPath(F.symlinkEscape, KB)).toBeNull()
  })

  it('a vault_path that is itself a symlink is pinned to where it really points', () => {
    const real = path.join(KB, 'clients/linked-notes')
    const note = write(path.join(real, 'n.md'), 'linked note')
    const link = path.join(TMP, 'linked-link')
    fs.symlinkSync(real, link)
    addWorkspace('linked', link)
    try {
      expect(workspaceVaultRoot('linked', KB)).toBe(real)
      expect(isInWorkspaceScope(note, 'linked', KB)).toBe(true)
      expect(isInWorkspaceScope(F.acmePlan, 'linked', KB)).toBe(false)
      expect(isInWorkspaceScope(F.otherStrong, 'linked', KB)).toBe(false)
    } finally {
      dropWorkspace('linked')
      fs.unlinkSync(link)
      fs.rmSync(real, { recursive: true, force: true })
    }
  })

  it('a symlink to ANOTHER workspace\'s folder is refused (obj 901152: equal = overlap)', () => {
    const link = path.join(TMP, 'acme-link')
    fs.symlinkSync(ACME_DIR, link)
    addWorkspace('linked', link)
    try {
      expect(workspaceVaultRoot('linked', KB)).toBeNull()
      expect(isInWorkspaceScope(F.acmePlan, 'linked', KB)).toBe(false)
      // Fail closed on both sides: the two rows overlap, so neither folder counts.
      expect(workspaceVaultRoot('acme', KB)).toBeNull()
    } finally {
      dropWorkspace('linked')
      fs.unlinkSync(link)
    }
    expect(workspaceVaultRoot('acme', KB)).toBe(ACME_DIR)
  })
})

describe('a vault_path that is a container is refused (fail closed)', () => {
  it('the knowledge base root, or a folder above it, never becomes a workspace scope', () => {
    addWorkspace('everything', KB)
    addWorkspace('above', TMP)
    try {
      expect(workspaceVaultRoot('everything', KB)).toBeNull()
      expect(workspaceVaultRoot('above', KB)).toBeNull()
      expect(isInWorkspaceScope(F.otherStrong, 'everything', KB)).toBe(false)
      expect(isInWorkspaceScope(F.acmePlan, 'everything', KB)).toBe(false)
      expect(isInWorkspaceScope(F.outsideSecret, 'above', KB)).toBe(false)
      expect(searchKnowledgeForWorkspace(QUERY, 'everything')).toEqual([])
    } finally {
      dropWorkspace('everything')
      dropWorkspace('above')
    }
  })

  it('a folder that holds another workspace\'s notes is not a scope either', () => {
    addWorkspace('umbrella', path.join(KB, 'workspaces')) // holds workspaces/other-co
    addWorkspace('umbrella-two', path.join(KB, 'clients')) // holds acme's vault_path
    try {
      expect(workspaceVaultRoot('umbrella', KB)).toBeNull()
      expect(workspaceVaultRoot('umbrella-two', KB)).toBeNull()
      expect(isInWorkspaceScope(F.otherStrong, 'umbrella', KB)).toBe(false)
      expect(isInWorkspaceScope(F.acmePlan, 'umbrella-two', KB)).toBe(false)
      // obj 901152: acme's folder is INSIDE umbrella-two's, which is overlap
      // too. The rule cannot tell which row is the mistake, so both fail
      // closed (the admin routes refuse the second save with a 400).
      expect(workspaceVaultRoot('acme', KB)).toBeNull()
      expect(isInWorkspaceScope(F.acmePlan, 'acme', KB)).toBe(false)
    } finally {
      dropWorkspace('umbrella')
      dropWorkspace('umbrella-two')
    }
    // The workspace inside it gets its own folder back once the container goes.
    expect(isInWorkspaceScope(F.acmePlan, 'acme', KB)).toBe(true)
  })
})

describe('search finds the documents in a custom vault folder', () => {
  it('searchKnowledgeForWorkspace (card-start context) returns the workspace\'s own note and nothing else', () => {
    const hits = searchKnowledgeForWorkspace(QUERY, 'acme')
    expect(hits.map((h) => h.path)).toEqual([F.acmePlan])
    const blob = JSON.stringify(hits)
    expect(blob).not.toContain('OTHER-ONLY-SECRET')
    expect(blob).not.toContain('OUTSIDE-SECRET')
    expect(blob).not.toContain('SHARED-ONLY')
  })

  it('the grep fallback agrees', () => {
    expect(searchKnowledgeGrep(QUERY, 'acme').map((h) => h.path)).toEqual([F.acmePlan])
    // The mirror image: the other workspace never sees the custom folder.
    expect(searchKnowledgeGrep(QUERY, 'other-co').map((h) => h.path)).toEqual([F.otherStrong])
  })

  it('GET /api/docs/search?workspace= (keyword) returns it', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=${encodeURIComponent(QUERY)}&workspace=acme&mode=keyword`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: { path: string }[] }
    expect(body.results.map((r) => r.path)).toEqual([F.acmePlan])
    expect(JSON.stringify(body)).not.toContain('OTHER-ONLY-SECRET')
    expect(JSON.stringify(body)).not.toContain('OUTSIDE-SECRET')
  })

  it('and the default (hybrid) mode returns it too', async () => {
    const res = await fetch(`${baseUrl}/api/docs/search?q=${encodeURIComponent(QUERY)}&workspace=acme`, { headers: { Cookie: cookie } })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: { path: string }[] }
    expect(body.results.map((r) => r.path)).toEqual([F.acmePlan])
  })

  it('with the vault_path removed, the same search finds nothing (the bug this card fixes)', () => {
    addWorkspace('acme', null)
    try {
      expect(searchKnowledgeForWorkspace(QUERY, 'acme')).toEqual([])
    } finally {
      addWorkspace('acme', ACME_DIR)
    }
  })
})
