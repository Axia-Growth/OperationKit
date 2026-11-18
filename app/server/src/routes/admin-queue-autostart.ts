/**
 * Settings → Platform → Queue auto-start (obj 900625). Mounted under /api/admin,
 * so the admin.ts facade already applies requireAuth + requireAdmin (admin role
 * only; agent keys are rejected). No new scope or permission is introduced.
 *
 *   GET /api/admin/queue-autostart                     → per-workspace state + caps + time limits
 *   PUT /api/admin/queue-autostart/:workspace           { enabled: boolean }
 *   PUT /api/admin/queue-autostart/:workspace/time-limit { minutes: number | null }
 *
 * Turning a workspace ON stamps its `enabled_at` to now — only cards that enter
 * the queue after that (or that were explicitly start-requested) are started.
 * A workspace listed in CC_QUEUE_AUTOSTART_WORKSPACES is on regardless of the
 * toggle; the response says so (`source`).
 *
 * The job time limit (obj 901375, follow-up to #901371) is `settings` key
 * `job_wallclock_ceiling_ms:<workspace>` — the same key `resolveConfiguredCeiling`
 * already reads for queue auto-start and chat-filed cards. Setting it here is
 * independent of the auto-start toggle above: a workspace can have a time limit
 * with auto-start off, and vice versa. `time_limits` in the GET response covers
 * every known workspace, not just ones with auto-start on.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { listWorkspaces, workspaceExists } from '../services/workspaces.js'
import { parseFiniteCeiling, resolveAutoStartPolicy, resolveConfiguredCeiling } from '../services/job-accounting.js'
import {
  countAutostartedInFlight,
  queueAutostartGraceMinutes,
  queueAutostartMaxConcurrent,
  resolveEnabledWorkspaces,
  setQueueAutostartWorkspace,
} from '../lib/queue-autostart.js'

const router = Router()

const MIN_LIMIT_MINUTES = 1
const MAX_LIMIT_MINUTES = 24 * 60

function timeLimitKey(workspace: string): string {
  return `job_wallclock_ceiling_ms:${workspace}`
}

function readSettingValue(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string | null } | undefined
  return row?.value ?? null
}

export interface JobTimeLimit {
  minutes: number | null
  source: 'workspace' | 'global' | 'none'
}

function resolveJobTimeLimit(workspace: string): JobTimeLimit {
  const wsMs = parseFiniteCeiling(readSettingValue(timeLimitKey(workspace)))
  if (wsMs !== null) return { minutes: Math.round(wsMs / 60000), source: 'workspace' }
  const globalMs = parseFiniteCeiling(readSettingValue('job_wallclock_ceiling_ms'))
  if (globalMs !== null) return { minutes: Math.round(globalMs / 60000), source: 'global' }
  return { minutes: null, source: 'none' }
}

function view() {
  const db = getDb()
  const max = queueAutostartMaxConcurrent(db)
  const timeLimits: Record<string, JobTimeLimit> = {}
  for (const ws of listWorkspaces()) timeLimits[ws.slug] = resolveJobTimeLimit(ws.slug)
  return {
    workspaces: resolveEnabledWorkspaces(db).map(w => {
      const policy = resolveAutoStartPolicy(db, 'queue_autostart', w.workspace)
      const ceiling = resolveConfiguredCeiling(db, 0, w.workspace)
      return {
        workspace: w.workspace,
        enabled: true,
        source: w.source,
        enabled_at: w.enabledAt,
        ceiling_policy: policy.policy,
        ceiling_policy_source: policy.source,
        // Workspace/global ceiling only (a per-card ceiling can still be set on the card).
        ceiling_configured: ceiling.costUsd !== null || ceiling.wallclockMs !== null,
        ceiling_source: ceiling.source,
      }
    }),
    max_concurrent: max.value,
    max_concurrent_source: max.source,
    in_flight: countAutostartedInFlight(db),
    grace_minutes: queueAutostartGraceMinutes(),
    time_limits: timeLimits,
  }
}

router.get('/queue-autostart', (_req: AuthRequest, res) => {
  res.json(view())
})

router.put('/queue-autostart/:workspace', (req: AuthRequest, res) => {
  const workspace = String(req.params.workspace || '')
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: 'body must be { "enabled": true | false }' })
    return
  }
  if (!workspaceExists(workspace)) {
    res.status(404).json({ error: `Unknown workspace '${workspace}'` })
    return
  }
  const db = getDb()
  setQueueAutostartWorkspace(db, workspace, enabled)
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('command-center', ?, 'decision', 'queue_autostart_toggled', ?, ?)`,
    ).run(
      workspace,
      `Queue auto-start ${enabled ? 'enabled' : 'disabled'} for ${workspace} by ${req.user?.username ?? req.user?.id ?? 'unknown'}`,
      JSON.stringify({ kind: 'queue_autostart_toggled', enabled, actor_user_id: req.user?.id ?? null }),
    )
  } catch { /* the toggle itself already landed */ }
  console.log(`[queue-autostart] ${workspace} ${enabled ? 'ENABLED' : 'disabled'} by user ${req.user?.id ?? '?'}`)
  res.json(view())
})

router.put('/queue-autostart/:workspace/time-limit', (req: AuthRequest, res) => {
  const workspace = String(req.params.workspace || '')
  if (!workspaceExists(workspace)) {
    res.status(404).json({ error: `Unknown workspace '${workspace}'` })
    return
  }
  const raw = (req.body as { minutes?: unknown } | undefined)?.minutes
  const clearing = raw === null || raw === undefined
  if (!clearing && (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_LIMIT_MINUTES || raw > MAX_LIMIT_MINUTES)) {
    res.status(400).json({
      error: `body must be { "minutes": null } to clear, or a whole number of minutes between ${MIN_LIMIT_MINUTES} and ${MAX_LIMIT_MINUTES}`,
    })
    return
  }
  const db = getDb()
  const key = timeLimitKey(workspace)
  if (clearing) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, String((raw as number) * 60000))
  }
  try {
    db.prepare(
      `INSERT INTO activity_log (project, workspace, event_type, title, detail, metadata)
       VALUES ('command-center', ?, 'decision', 'job_time_limit_updated', ?, ?)`,
    ).run(
      workspace,
      clearing
        ? `Job time limit cleared for ${workspace} by ${req.user?.username ?? req.user?.id ?? 'unknown'}`
        : `Job time limit set to ${raw} minute(s) for ${workspace} by ${req.user?.username ?? req.user?.id ?? 'unknown'}`,
      JSON.stringify({ kind: 'job_time_limit_updated', minutes: clearing ? null : raw, actor_user_id: req.user?.id ?? null }),
    )
  } catch { /* the write itself already landed */ }
  console.log(`[queue-autostart] job time limit for ${workspace} ${clearing ? 'CLEARED' : `set to ${raw}m`} by user ${req.user?.id ?? '?'}`)
  res.json(view())
})

export default router
