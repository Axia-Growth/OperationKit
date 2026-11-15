// ── Knowledge folders on a workspaces/<ws>/ knowledge base (obj 900948) ──
//
// A bot's `knowledge_folders` are paths relative to the knowledge-base root. The
// built-in bots ship generic names (Operation Kit Dev: business, organizations,
// products, projects, topics) that match the LEGACY layout, where those folders
// sit directly under the root. An install that keeps its notes per workspace
// (`<root>/workspaces/<slug>/business`, …) has none of them at the root, so
// list_folders, read_file and search all answered "does not exist" / nothing,
// and the only fix was an install override of the agent file.
//
// The rule, applied per folder:
//   - the folder exists at the root                → kept as is (legacy layout);
//   - it already names a `workspaces/…` path       → kept as is (idempotent);
//   - it is missing at the root and `<root>/workspaces/` is a directory
//                                                  → replaced by
//     `workspaces/<ws>/<folder>` for every workspace in `workspaces`;
//   - otherwise (no workspaces/ dir)               → kept as is, so a fresh legacy
//     install can still create it with write_doc.
//
// WHICH workspaces is the caller's decision and is never widened here: the chat
// passes (the bot's granted workspaces, or every workspace for an unrestricted
// bot) ∩ (the workspaces the PERSON chatting may reach) — kbWorkspacesForChat in
// tools.ts. An unrestricted bot is not walled by its own list, so remapping its
// folders into every workspace would hand a member of workspace A the notes of
// workspace B (review of PR 797). With no person there is no remap at all for
// an unrestricted bot. The prompt shows the same resolved names the tools accept.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatAgent } from './agent-defs.js'
import { WORKSPACE_SLUG_RE } from './bot-workspaces.js'

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function existsPath(p: string): boolean {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * The knowledge folders this bot actually works with on this knowledge base.
 * `workspaces` = the workspaces a missing root folder is remapped into: the
 * person ∩ bot list (kbWorkspacesForChat). Empty = nothing is remapped into.
 */
export function resolveKnowledgeFolders(
  agent: Pick<ChatAgent, 'slug' | 'knowledge_folders'>,
  kbRoot: string,
  workspaces: string[],
): string[] {
  const folders = agent.knowledge_folders
  if (folders.length === 0) return []
  const root = path.resolve(kbRoot)
  const wsRoot = path.join(root, 'workspaces')
  if (!isDir(wsRoot)) return [...folders]
  const targets = workspaces.filter(w => WORKSPACE_SLUG_RE.test(w))
  const out: string[] = []
  const add = (f: string) => {
    if (!out.includes(f)) out.push(f)
  }
  for (const raw of folders) {
    const f = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    if (!f || f === 'workspaces' || f.startsWith('workspaces/') || existsPath(path.join(root, f))) {
      add(raw)
      continue
    }
    for (const ws of targets) add(`workspaces/${ws}/${f}`)
  }
  return out
}

/** The agent with its knowledge folders resolved for this knowledge base (same object shape). */
export function withResolvedKnowledgeFolders<T extends Pick<ChatAgent, 'slug' | 'knowledge_folders'>>(agent: T, kbRoot: string, workspaces: string[]): T {
  const resolved = resolveKnowledgeFolders(agent, kbRoot, workspaces)
  const same = resolved.length === agent.knowledge_folders.length && resolved.every((f, i) => f === agent.knowledge_folders[i])
  return same ? agent : { ...agent, knowledge_folders: resolved }
}
