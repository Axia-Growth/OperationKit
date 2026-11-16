/**
 * Hard workspace containment for knowledge-base paths (obj 900321, constraint C13).
 *
 * ## The hole this closes
 *
 * The knowledge base is ONE tree with workspaces as folders inside it. Until now
 * the only workspace wall was:
 *
 *   1. `resolveUnder()` on the `/api/docs` + `/api/files` HTTP routes — a real,
 *      realpath-based wall (obj 900204), and
 *   2. a *ranking bonus* inside retrieval (`+6` grep score, `-2.0` bm25) applied
 *      when `inWorkspaceFolder()` matched.
 *
 * (2) is not a wall. `services/context-builder.ts` calls `searchKnowledge()`
 * DIRECTLY at spawn, bypassing (1) entirely, so another workspace's note was
 * injected into a worker's prompt whenever it out-scored the card's own notes.
 * Isolation held for a *deliberate* read and leaked on the *automatic* one.
 *
 * `inWorkspaceFolder()` was itself bypassable twice over:
 *
 *   - **Nested-name spoof.** It tested `file.includes('/workspaces/<ws>/')`, a
 *     bare substring. `…/workspaces/example/notes/workspaces/operationkit/x.md`
 *     lives under `example` and read as `operationkit`.
 *   - **Symlink escape.** No realpath, so `…/workspaces/operationkit/link.md ->
 *     …/workspaces/example/secret.md` was in-scope by its lexical path while the
 *     bytes served came from another workspace.
 *
 * ## The rule now
 *
 * A path is in `workspace`'s scope only when its **realpath** is the workspace
 * root itself or sits under it with a `/` boundary. Both sides are realpath'd,
 * so a symlink that leaves the root is out of scope; containment is computed on
 * path SEGMENTS, so a nested folder of the same name cannot spoof it.
 *
 * Fails CLOSED everywhere: an unresolvable path, an unreadable root, a missing
 * or malformed workspace slug all return `false` / `[]`. A retrieval path that
 * cannot prove containment must not inject the hit.
 */
import fs from 'fs'
import path from 'path'
import { knowledgeBaseRoot } from './knowledge-base-root.js'
import { getWorkspace, listWorkspaces } from '../services/workspaces.js'

/** Workspace slugs are folder names. Anything else (``..``, ``/``, NUL) is refused. */
export const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i

export function isValidWorkspaceSlug(workspace: unknown): workspace is string {
  return typeof workspace === 'string' && WORKSPACE_SLUG.test(workspace)
}

/** realpath, or null when the path cannot be resolved. Never throws. */
export function realpathOrNull(p: string): string | null {
  if (!p || p.includes('\0')) return null
  try {
    return fs.realpathSync(path.resolve(p))
  } catch {
    return null
  }
}

/** The two default folders of one workspace inside the knowledge base (either layout). */
function defaultScopeRoots(workspace: string, base: string): string[] {
  // BOTH layouts, unconditionally. A vault keeps workspaces under
  // `<root>/workspaces/<slug>`, the /app/data fallback directly under
  // `<root>/<slug>` (see knowledge-base-root.ts). Listing both is strictly
  // narrower than it looks — each is still one named folder of this ONE
  // workspace — and it keeps the check independent of ambient env, which a
  // security predicate should not depend on.
  const candidates = [path.join(base, 'workspaces', workspace), path.join(base, workspace)]
  const out: string[] = []
  for (const c of candidates) {
    // A root that exists is pinned to its REAL location; one that does not is
    // kept lexically, so the predicate still answers for a path that has not
    // been created yet (and answers `false` for everything outside it).
    const real = realpathOrNull(c) ?? c
    if (!out.includes(real)) out.push(real)
  }
  return out
}

/** `vault_path` of every workspace row that has one. `[]` when the table cannot be read. */
function vaultPathRows(): { slug: string; vault: string; live: boolean }[] {
  try {
    return listWorkspaces({ includeArchived: true, includeDeleted: true })
      .filter((w) => !!w.vault_path && isValidWorkspaceSlug(w.slug) && !w.vault_path.includes('\0'))
      .map((w) => ({
        slug: w.slug,
        vault: resolveVaultPath(w.vault_path!),
        live: !w.archived && !w.deleted_at,
      }))
  } catch {
    return [] // no database (a unit test, a script): the default folders still apply
  }
}

/**
 * Where a configured `vault_path` really points (obj 901152). An existing
 * folder is its realpath. A folder that does not exist yet is resolved through
 * its deepest EXISTING ancestor, so `<symlink-into-B>/new-folder` is compared
 * as the folder inside B it will become, not as its lexical path. `..` is
 * normalised first. Never throws.
 */
export function resolveVaultPath(p: string): string {
  const abs = path.resolve(p)
  const real = realpathOrNull(abs)
  if (real) return real
  const rest: string[] = []
  let cur = abs
  for (;;) {
    const parent = path.dirname(cur)
    if (parent === cur) return abs
    rest.unshift(path.basename(cur))
    cur = parent
    const r = realpathOrNull(cur)
    if (r) return path.join(r, ...rest)
  }
}

/** Containment of two already-resolved absolute paths, on a segment boundary. */
function within(inner: string, outer: string): boolean {
  if (inner === outer) return true
  const rel = path.relative(outer, inner)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

export type VaultOverlapRelation = 'equal' | 'inside' | 'contains'

function relationOf(vault: string, folder: string): VaultOverlapRelation | null {
  if (vault === folder) return 'equal'
  if (within(vault, folder)) return 'inside'
  if (within(folder, vault)) return 'contains'
  return null
}

/** Why a `vault_path` cannot be a workspace's own folder. */
export type VaultPathConflict =
  | { kind: 'invalid'; message: string }
  | { kind: 'kb_root'; folder: string; message: string }
  | {
      kind: 'default_folder' | 'vault_path'
      other: string
      folder: string
      relation: VaultOverlapRelation
      message: string
    }

const RELATION_WORDS: Record<VaultOverlapRelation, string> = {
  equal: 'is the same folder as',
  inside: 'is inside',
  contains: 'contains',
}

/**
 * Everything the overlap rule compares against, resolved ONCE per call: the
 * knowledge base root, every live workspace's default folders and every
 * `vault_path` row. `workspaceOfVaultPath` runs for each file the semantic
 * indexer embeds, so the per-workspace check must not re-resolve the board.
 */
interface VaultLayout {
  base: string
  defaults: { slug: string; folder: string }[]
  rows: { slug: string; vault: string; live: boolean }[]
}

function vaultLayout(root: string): VaultLayout {
  const base = realpathOrNull(root) ?? path.resolve(root)
  const defaults: VaultLayout['defaults'] = []
  for (const w of listWorkspaces()) {
    if (!isValidWorkspaceSlug(w.slug)) continue
    for (const folder of defaultScopeRoots(w.slug, base)) defaults.push({ slug: w.slug, folder })
  }
  return { base, defaults, rows: vaultPathRows() }
}

/** The conflicts that do not depend on any other workspace's `vault_path`. */
function standaloneConflict(layout: VaultLayout, workspace: string, vault: string): VaultPathConflict | null {
  if (within(layout.base, vault)) {
    return {
      kind: 'kb_root',
      folder: layout.base,
      message: `vault_path ${vault} is the knowledge base root or a folder above it, so it would hold every workspace's notes`,
    }
  }
  for (const { slug: other, folder } of layout.defaults) {
    if (other === workspace) continue
    const relation = relationOf(vault, folder)
    if (!relation) continue
    return {
      kind: 'default_folder',
      other,
      folder,
      relation,
      message: `vault_path ${vault} ${RELATION_WORDS[relation]} the folder of workspace '${other}' (${folder})`,
    }
  }
  return null
}

/** `vault` (already resolved) against the whole layout. */
function conflictIn(layout: VaultLayout, workspace: string, vault: string): VaultPathConflict | null {
  const own = standaloneConflict(layout, workspace, vault)
  if (own) return own
  for (const row of layout.rows) {
    if (row.slug === workspace || !row.live) continue
    if (standaloneConflict(layout, row.slug, row.vault)) continue
    const relation = relationOf(vault, row.vault)
    if (!relation) continue
    return {
      kind: 'vault_path',
      other: row.slug,
      folder: row.vault,
      relation,
      message: `vault_path ${vault} ${RELATION_WORDS[relation]} the vault_path of workspace '${row.slug}' (${row.vault})`,
    }
  }
  return null
}

/**
 * Would `vaultPath` overlap another live workspace's notes? (obj 901152)
 *
 * A workspace's custom folder must be ITS OWN folder. After `..` and symlink
 * resolution (`resolveVaultPath`) it conflicts when it:
 *
 *   - is the knowledge base root or a folder above it;
 *   - is equal to, inside, or contains a default folder of another live
 *     workspace (`<root>/workspaces/<slug>` or `<root>/<slug>`), whether or
 *     not that folder exists yet: creating it later must not quietly hand its
 *     notes to someone else;
 *   - is equal to, inside, or contains another live workspace's `vault_path`.
 *
 * Another workspace's `vault_path` only counts when it is itself a valid own
 * folder (passes the first two rules). An invalid one grants its workspace
 * nothing, so it must not take a legitimate folder away from anyone else.
 *
 * Two workspaces on the SAME folder conflict too: sharing a folder means each
 * reads the other's notes, which is the leak this rule exists to stop.
 *
 * Used by `workspaceVaultRoot` (scope: refused = fail closed) and by the admin
 * save routes (400). Archived and deleted workspaces are ignored, matching
 * scope resolution everywhere else. `null` = no conflict.
 */
export function vaultPathConflict(
  workspace: string,
  vaultPath: string,
  root: string = knowledgeBaseRoot(),
): VaultPathConflict | null {
  if (typeof vaultPath !== 'string' || !vaultPath || vaultPath.includes('\0')) {
    return { kind: 'invalid', message: 'vault_path must be a non-empty path' }
  }
  if (!path.isAbsolute(vaultPath)) {
    return { kind: 'invalid', message: 'vault_path must be an absolute path' }
  }
  return conflictIn(vaultLayout(root), workspace, resolveVaultPath(vaultPath))
}

/** `workspaceVaultRoot` against a layout already resolved by the caller. */
function vaultRootIn(layout: VaultLayout, workspace: string): string | null {
  const row = layout.rows.find((r) => r.slug === workspace)
  if (!row) return null
  return conflictIn(layout, workspace, row.vault) ? null : row.vault
}

/**
 * The workspace's custom knowledge folder (`workspaces.vault_path`), or null
 * (obj 900963, obj 901152).
 *
 * The docs routes already honour `vault_path`; workspace-filtered search did
 * not, so a workspace whose notes live in a custom folder found nothing. The
 * folder is resolved to where it really points and counts as this workspace's
 * scope ONLY when it is a folder of this one workspace: any overlap with the
 * knowledge base root or with another live workspace's folder — inside it,
 * equal to it, or containing it — refuses it (`vaultPathConflict`). Refused =
 * fail closed: null, and the default folders still apply.
 */
export function workspaceVaultRoot(
  workspace: string,
  root: string = knowledgeBaseRoot(),
): string | null {
  if (!isValidWorkspaceSlug(workspace)) return null
  try {
    return vaultRootIn(vaultLayout(root), workspace)
  } catch {
    return null // no database: the default folders still apply
  }
}

/**
 * Which workspace's custom folder (`vault_path`) holds `file`, or null when it
 * is in none. Only a folder `workspaceVaultRoot` accepts counts, and accepted
 * folders never overlap, so at most one matches. The semantic index takes its
 * workspace label from this, so the label and the search wall come from the
 * same rule.
 */
export function workspaceOfVaultPath(file: string, root: string = knowledgeBaseRoot()): string | null {
  let layout: VaultLayout
  try { layout = vaultLayout(root) } catch { return null }
  let best: { slug: string; len: number } | null = null
  for (const row of layout.rows) {
    const vault = vaultRootIn(layout, row.slug)
    if (!vault || !containedIn(file, vault)) continue
    if (!best || vault.length > best.len) best = { slug: row.slug, len: vault.length }
  }
  return best?.slug ?? null
}

/**
 * The on-disk root(s) that make up `workspace`'s slice of the knowledge base.
 *
 * Both layouts are honoured because both exist on real installs: a vault keeps
 * workspaces under `<root>/workspaces/<slug>`, the `/app/data` fallback keeps
 * them directly under `<root>/<slug>` (see `knowledge-base-root.ts`). The
 * workspace's custom folder (`vault_path`, see `workspaceVaultRoot`) is added
 * when it is set, so keyword search, card-start context and semantic search
 * agree with the bot guard (obj 900963). A slug with no folder on disk yields
 * roots nothing sits under, so the scope is empty — fail closed, never
 * "everything".
 */
export function workspaceScopeRoots(
  workspace: string,
  root: string = knowledgeBaseRoot(),
): string[] {
  if (!isValidWorkspaceSlug(workspace)) return []
  const base = realpathOrNull(root) ?? path.resolve(root)
  const out = defaultScopeRoots(workspace, base)
  const vault = workspaceVaultRoot(workspace, root)
  if (vault && !out.includes(vault)) out.push(vault)
  return out
}

/**
 * True when `candidate` is `root` or sits under it on a SEGMENT boundary.
 *
 * Each side is pinned to its realpath when it exists and resolved lexically
 * when it does not. That ordering is what matters: a candidate that EXISTS is
 * always compared at its real location, so a symlink pointing out of the root
 * is rejected; a candidate that does not exist still gets the segment-boundary
 * check, so `<root>/acme-two` never counts as `<root>/acme`.
 */
export function containedIn(candidate: string, root: string): boolean {
  if (!candidate || !root || candidate.includes('\0') || root.includes('\0')) return false
  const c = realpathOrNull(candidate) ?? path.resolve(candidate)
  const r = realpathOrNull(root) ?? path.resolve(root)
  if (c === r) return true
  const rel = path.relative(r, c)
  return rel !== '' && !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

/**
 * The authoritative check: is `file` inside `workspace`'s knowledge-base scope?
 *
 * `extraRoots` lets a caller add roots it has already authorised for that ONE
 * workspace (e.g. a `vault_path` override row) without widening the default.
 */
export function isInWorkspaceScope(
  file: string,
  workspace: string,
  root: string = knowledgeBaseRoot(),
  extraRoots: string[] = [],
): boolean {
  if (!isValidWorkspaceSlug(workspace)) return false
  const roots = [...workspaceScopeRoots(workspace, root), ...extraRoots]
  if (roots.length === 0) return false
  return roots.some((r) => containedIn(file, r))
}

/**
 * Drop every hit that cannot be PROVEN to live in `workspace`'s scope.
 *
 * This is the function that turns the old ranking bonus into a wall: it is a
 * filter, so no score, bm25 weight or synonym expansion can promote another
 * workspace's note back into the result set.
 */
export function filterToWorkspaceScope<T extends { path: string }>(
  hits: T[],
  workspace: string | null | undefined,
  root: string = knowledgeBaseRoot(),
  extraRoots: string[] = [],
): T[] {
  if (!workspace) return hits
  if (!isValidWorkspaceSlug(workspace)) return []
  const roots = [...workspaceScopeRoots(workspace, root), ...extraRoots]
  if (roots.length === 0) return []
  return hits.filter((h) => roots.some((r) => containedIn(h.path, r)))
}
