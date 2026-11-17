/**
 * Legacy workspaces project-metadata config (`workspaces.json`), served by
 * `GET /api/workspaces-config`.
 *
 * A fresh install has no such file (obj 901202). That is an empty roster, so it
 * reads as `{ workspaces: {} }` and the route answers 200 — the Settings >
 * Workspaces tab used to log a failed request on every load. A file that exists
 * but cannot be read or parsed is still a failure (`null`), so a broken config
 * is never silently shown as "no projects".
 */
import fs from 'fs'

export interface WorkspacesConfig {
  workspaces: Record<string, unknown>
  [key: string]: unknown
}

export function readWorkspacesConfig(file: string): WorkspacesConfig | null {
  let content: string
  try {
    content = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { workspaces: {} }
    return null
  }
  try {
    const parsed = JSON.parse(content) as Partial<WorkspacesConfig> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const ws = parsed.workspaces
    return { ...parsed, workspaces: ws && typeof ws === 'object' && !Array.isArray(ws) ? ws : {} }
  } catch {
    return null
  }
}

/** Members see only their own workspaces' rosters; admins see all. */
export function filterWorkspacesConfig(config: WorkspacesConfig, allowed: Set<string> | null): WorkspacesConfig {
  if (!allowed) return config
  const workspaces: Record<string, unknown> = {}
  for (const [slug, ws] of Object.entries(config.workspaces)) {
    if (allowed.has(slug)) workspaces[slug] = ws
  }
  return { ...config, workspaces }
}
