/**
 * Who owns a card created through POST /api/internal/objectives (obj 900208).
 *
 * That route is how a running card makes its children (`cc-live.mjs fanout`,
 * delegator decomposition, follow-ups). It used to insert them with no owner at
 * all — `created_by`, `assigned_user_id` and `agent_key_id` all NULL — so every
 * child spawned with `CC_ACTING_USER_ID` unset, the connector guard refused it as
 * `no_owner`, and a coding child had no GitHub token. It then asked for a
 * `GH_TOKEN` secret even though the parent's owner had GitHub connected.
 *
 * Rule: a child is the parent's work, so it acts for the same person under the
 * same limits.
 *   - `created_by` and `assigned_user_id` are copied as-is, so the delegated-card
 *     test (assigned ≠ creator) gives the child exactly the parent's answer — a
 *     card routed to Casey by Operator does not become Casey's own work one level down.
 *   - `agent_key_id` / `agent_key_label` are copied too. Without them a key whose
 *     allow-list excludes GitHub could reach GitHub by filing a child.
 *   - Only within the parent's workspace. A child filed into a different
 *     workspace is not obviously that person's work there, so it stays ownerless
 *     (and the session prompt says so) rather than carrying a token across.
 *
 * Top-level internal creates (no parent, no source job) are unchanged: the route
 * has no caller identity to attribute them to.
 *
 * Job replies (obj 901458): a card filed from a job's thread (`source_job_id`,
 * origin `job_reply`) used to land with no owner, so its session had no GitHub
 * login and only failed at `git push` (#901381). `jobReplyOwnership` gives it
 * one, in this order, each only inside the card's own workspace:
 *   1. the source job card's owner (same copy rule as a parent, key included);
 *   2. the routine's or High Agency wake's user (template `assigned_user_id`,
 *      else `agent_chat_high_agency.run_as_user_id` for a `high-agency:` routine);
 *   3. the workspace's first admin (a `user_workspaces` admin row, else a global
 *      admin who is a member of the workspace, else the first global admin).
 * Connector rules are not touched: the owner's "Who can use it" rules still
 * decide at spawn whether that person's GitHub applies.
 */
import type { Database } from 'better-sqlite3'
import { resolveWorkspaceIn } from '../services/workspaces.js'
import { highAgencyRoutineSlug } from '../services/agent-chat/bot-workspaces.js'

export interface InheritedOwnership {
  created_by: number | null
  assigned_user_id: number | null
  agent_key_id: number | null
  agent_key_label: string | null
}

export const NO_OWNERSHIP: InheritedOwnership = {
  created_by: null,
  assigned_user_id: null,
  agent_key_id: null,
  agent_key_label: null,
}

export function inheritedOwnership(
  db: Database,
  parentId: number | null | undefined,
  childWorkspace: string,
): InheritedOwnership {
  if (typeof parentId !== 'number' || parentId <= 0) return NO_OWNERSHIP
  try {
    const row = db
      .prepare(
        'SELECT workspace, created_by, assigned_user_id, agent_key_id, agent_key_label FROM objectives WHERE id = ?',
      )
      .get(parentId) as
      | {
          workspace: string | null
          created_by: number | null
          assigned_user_id: number | null
          agent_key_id: number | null
          agent_key_label: string | null
        }
      | undefined
    if (!row) return NO_OWNERSHIP
    if (resolveWorkspaceIn(db, row.workspace) !== resolveWorkspaceIn(db, childWorkspace)) return NO_OWNERSHIP
    return {
      created_by: row.created_by ?? null,
      assigned_user_id: row.assigned_user_id ?? null,
      agent_key_id: row.agent_key_id ?? null,
      agent_key_label: row.agent_key_label ?? null,
    }
  } catch {
    // Never fail a create over attribution; an ownerless child is today's behavior.
    return NO_OWNERSHIP
  }
}

/** Where a job-reply card's owner came from (for the create response and tests). */
export type JobReplyOwnerSource = 'source_job' | 'routine' | 'wake' | 'workspace_admin' | 'none'

function userExists(db: Database, id: unknown): number | null {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return null
  try {
    return db.prepare('SELECT id FROM users WHERE id = ?').get(n) ? n : null
  } catch {
    return null
  }
}

/** The workspace's first admin: a workspace-admin member, else a global admin who
 *  is a member, else the first global admin. null when the install has none. */
export function workspaceFirstAdmin(db: Database, workspace: string): number | null {
  const ws = resolveWorkspaceIn(db, workspace)
  const tries: Array<[string, unknown[]]> = [
    ["SELECT uw.user_id AS id FROM user_workspaces uw JOIN users u ON u.id = uw.user_id WHERE uw.workspace = ? AND uw.role = 'admin' ORDER BY uw.user_id LIMIT 1", [ws]],
    ["SELECT u.id AS id FROM users u JOIN user_workspaces uw ON uw.user_id = u.id WHERE uw.workspace = ? AND u.role = 'admin' ORDER BY u.id LIMIT 1", [ws]],
    ["SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1", []],
  ]
  for (const [sql, args] of tries) {
    try {
      const row = db.prepare(sql).get(...args) as { id: number } | undefined
      if (row?.id != null) return Number(row.id)
    } catch { /* table missing on a minimal DB → next rule */ }
  }
  return null
}

/** The user a routine (or a High Agency wake routine) runs as, if any. */
function routineUser(db: Database, routineId: number | null): { userId: number; source: 'routine' | 'wake' } | null {
  if (routineId == null) return null
  try {
    const r = db.prepare('SELECT name, objective_template AS template FROM routines WHERE id = ?').get(routineId) as
      | { name: string | null; template: string | null }
      | undefined
    if (!r) return null
    try {
      const tpl = r.template ? JSON.parse(r.template) : null
      const id = userExists(db, tpl?.assigned_user_id)
      if (id != null) return { userId: id, source: 'routine' }
    } catch { /* unreadable template → try the wake row */ }
    const slug = highAgencyRoutineSlug(r.name)
    if (slug) {
      const ha = db.prepare('SELECT run_as_user_id FROM agent_chat_high_agency WHERE lower(slug) = lower(?)').get(slug) as
        | { run_as_user_id: number | null }
        | undefined
      const id = userExists(db, ha?.run_as_user_id)
      if (id != null) return { userId: id, source: 'wake' }
    }
  } catch { /* no routines / high-agency table */ }
  return null
}

/**
 * Owner for a card filed from a job's reply thread (`source_job_id`). Never
 * returns an empty owner when the install has an admin. Never throws.
 */
export function jobReplyOwnership(
  db: Database,
  sourceJobId: number | null | undefined,
  childWorkspace: string,
): InheritedOwnership & { source: JobReplyOwnerSource } {
  try {
    let keyId: number | null = null
    let keyLabel: string | null = null
    if (typeof sourceJobId === 'number' && sourceJobId > 0) {
      const fromJob = inheritedOwnership(db, sourceJobId, childWorkspace)
      if (fromJob.created_by != null || fromJob.assigned_user_id != null) return { ...fromJob, source: 'source_job' }
      // A key-filed job keeps its key's connector limits whoever ends up owning the reply.
      keyId = fromJob.agent_key_id
      keyLabel = fromJob.agent_key_label
      const job = db.prepare('SELECT workspace, routine_id FROM objectives WHERE id = ?').get(sourceJobId) as
        | { workspace: string | null; routine_id: number | null }
        | undefined
      if (job && resolveWorkspaceIn(db, job.workspace) === resolveWorkspaceIn(db, childWorkspace)) {
        const ru = routineUser(db, job.routine_id ?? null)
        if (ru) return { created_by: ru.userId, assigned_user_id: ru.userId, agent_key_id: keyId, agent_key_label: keyLabel, source: ru.source }
      }
    }
    const admin = workspaceFirstAdmin(db, childWorkspace)
    if (admin != null) return { created_by: admin, assigned_user_id: admin, agent_key_id: keyId, agent_key_label: keyLabel, source: 'workspace_admin' }
    return { ...NO_OWNERSHIP, agent_key_id: keyId, agent_key_label: keyLabel, source: 'none' }
  } catch {
    return { ...NO_OWNERSHIP, source: 'none' }
  }
}
