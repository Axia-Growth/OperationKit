import type { Response, NextFunction } from 'express'
import { getDb } from '../db/index.js'
import type { AuthRequest } from './auth.js'
import type { UserWorkspace } from '@operationkit/shared'

export function getUserWorkspaces(userId: number): UserWorkspace[] {
  const db = getDb()
  return db
    .prepare('SELECT workspace, role FROM user_workspaces WHERE user_id = ? ORDER BY workspace')
    .all(userId) as UserWorkspace[]
}

export function userHasWorkspace(userId: number, workspace: string): boolean {
  const db = getDb()
  const row = db
    .prepare('SELECT 1 FROM user_workspaces WHERE user_id = ? AND workspace = ?')
    .get(userId, workspace)
  return !!row
}

/**
 * Enforce that req.user has access to the workspace specified on the request.
 * Looks at req.query.workspace, falling back to req.body.workspace.
 * - If `workspace` is 'all' or missing, the handler is responsible for scoping
 *   results to `getUserWorkspaces(userId)`; this middleware allows it through.
 * - Otherwise returns 403 when the user is not a member of that workspace.
 */
export function requireWorkspaceAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const ws = (req.query.workspace as string | undefined) ?? (req.body?.workspace as string | undefined)
  // obj 901106: a card browser session has exactly ONE workspace (its card's).
  // Its synthetic user id is in no user_workspaces row, so membership can never
  // widen it; any other named workspace is refused here, and `all` / missing is
  // left to the handler, which sees no memberships for that id.
  if (req.cardBrowser) {
    if (ws && ws !== 'all' && ws !== req.cardBrowser.workspace) {
      res.status(403).json({ error: `No access to workspace '${ws}'`, code: 'card_browser_workspace' })
      return
    }
    next()
    return
  }
  if (!ws || ws === 'all') {
    next()
    return
  }
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }
  if (!userHasWorkspace(req.user.id, ws)) {
    res.status(403).json({ error: `No access to workspace '${ws}'` })
    return
  }
  next()
}
