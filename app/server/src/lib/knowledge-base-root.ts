import fs from 'fs'
import path from 'path'
import { isInWorkspaceScope } from './kb-workspace-scope.js'

/** Fallback KB home on installs with no vault: /app/data is persisted on every install. */
export const DATA_KB_DIR = '/app/data/knowledge-base'
const DEFAULT_VAULT_DIR = '/home/operator/second-brain'

/**
 * The env vars that name the knowledge base explicitly, in precedence order
 * (obj 900964). SECOND_BRAIN_ROOT / SECOND_BRAIN_DIR are the canonical names.
 * KNOWLEDGE_BASE_DIR (was read only by the chat engine) and VAULT_PATH (was
 * read only by loops, content owners, contacts and the internal vault routes)
 * are accepted aliases, so an install that set only one of them keeps its
 * folder, and every module now agrees on it.
 */
export const KB_ROOT_ENV_VARS = ['SECOND_BRAIN_ROOT', 'SECOND_BRAIN_DIR', 'KNOWLEDGE_BASE_DIR', 'VAULT_PATH'] as const

function explicitRoot(env: NodeJS.ProcessEnv): string {
  for (const name of KB_ROOT_ENV_VARS) {
    const value = (env[name] || '').trim()
    if (value) return value
  }
  return ''
}

/**
 * The ONE knowledge base on this install (obj 720348). The Knowledge base page,
 * search, the knowledge MCP tools, chat bots, loops, contacts and every import
 * resolve to this folder; no caller picks a "source" or reads an env var of
 * its own. First match wins:
 *   1. SECOND_BRAIN_ROOT, SECOND_BRAIN_DIR, KNOWLEDGE_BASE_DIR, VAULT_PATH
 *      (in that order) set explicitly;
 *   2. the vault at its default path when it exists on this host;
 *   3. /app/data/knowledge-base (DOC_INGEST_KB_DIR overrides) — a fresh install
 *      has no vault mounted, and anything outside /app/data vanishes on rebuild.
 * Evaluated per call so tests and env changes are honoured.
 */
export function knowledgeBaseRoot(env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): string {
  const vault = explicitRoot(env)
  if (vault) return path.resolve(vault)
  if (vaultOnHost) return DEFAULT_VAULT_DIR
  return path.resolve(env.DOC_INGEST_KB_DIR || DATA_KB_DIR)
}

/**
 * A vault keeps each workspace under `workspaces/<slug>`; the /app/data
 * fallback keeps it directly under `<slug>` (the layout installs already have
 * on disk, so it is not moved).
 */
export function isVaultLayout(env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): boolean {
  return !!explicitRoot(env) || vaultOnHost
}

/** Default folder for one workspace inside the knowledge base (no row override). */
export function defaultWorkspaceKbDir(workspace: string, env: NodeJS.ProcessEnv = process.env, vaultOnHost = fs.existsSync(DEFAULT_VAULT_DIR)): string {
  const root = knowledgeBaseRoot(env, vaultOnHost)
  return isVaultLayout(env, vaultOnHost) ? path.join(root, 'workspaces', workspace) : path.join(root, workspace)
}

/**
 * Is `file` inside `workspace`'s folder of the knowledge base (either layout)?
 *
 * obj 900321 (C13): this used to be a bare substring test
 * (`file.includes('/workspaces/<ws>/')`) plus a lexical `startsWith`. Both were
 * bypassable — a nested `…/workspaces/example/x/workspaces/operationkit/n.md` read
 * as `operationkit`, and a symlink out of the folder was never resolved. The
 * authoritative, realpath-based, segment-boundary check now lives in
 * `lib/kb-workspace-scope.ts`; this stays as the historical name and delegates.
 */
export function inWorkspaceFolder(file: string, workspace: string, root: string = knowledgeBaseRoot()): boolean {
  return isInWorkspaceScope(file, workspace, root)
}
