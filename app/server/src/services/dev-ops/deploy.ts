/**
 * Operation Kit Dev: the standard live deploy from chat (obj 901424, scope 2).
 *
 * Not a hot self-deploy. This runs the install's own update flow on the host:
 *
 *   sudo bash /opt/operationkit-src/install/update.sh --config /opt/operationkit-src/client.conf
 *
 * through host-runner.sh `deploy`, which (on the host, detached, so it outlives
 * the app restart the update causes):
 *  1. runs update.sh exactly as above — update.sh takes the pre-update backup
 *     (database, seat logins, secrets, client.conf) and tags the old images;
 *     never with --skip-cloudflare, --skip-backup or any force flag;
 *  2. waits for the app, runs install/verify.sh, then checks the public
 *     `<public url>/api/health`;
 *  3. if verify or health fails: rolls back to that backup — the old commit, the
 *     pre-update images, `install/backup.sh restore <backup> --yes`, stack up —
 *     and checks health again;
 *  4. writes the outcome to <data>/dev-ops/deploy-<id>.json.
 *
 * `settleDeploys` (the dev-ops tick, and every status call) turns that file into
 * the `dev_ops_deploys` row + an audit row. One deploy at a time; a started
 * deploy with no outcome after DEPLOY_TIMEOUT_MS is settled as failed.
 */
import fs from 'fs'
import path from 'path'
import { getDb } from '../../db/index.js'
import { scrub, writeDevOpsAudit } from './audit.js'
import { devOpsHostConfig, runOnHost } from './host-exec.js'
import type { DevActor } from './merge.js'

export const DEPLOY_TIMEOUT_MS = 75 * 60_000
const COOLDOWN_MS = 2 * 60_000
const TERMINAL = new Set(['deployed', 'rolled_back', 'rollback_failed', 'failed'])

export interface DeployRow {
  id: number
  bot_slug: string
  user_id: number | null
  username: string | null
  status: 'started' | 'deployed' | 'rolled_back' | 'rollback_failed' | 'failed'
  step: string | null
  from_sha: string | null
  to_sha: string | null
  backup_dir: string | null
  detail: string | null
  created_at: string
  finished_at: string | null
}

export interface DeployStartResult {
  ok: boolean
  code: 'started' | 'deploy_running' | 'cooldown' | 'host_config' | 'spawn_failed'
  message: string
  deploy_id?: number
}

const ms = (sqlTime: string) => Date.parse(sqlTime.replace(' ', 'T') + (sqlTime.endsWith('Z') ? '' : 'Z'))

/** The exact command the host runs. Shown to the person; asserted by tests. */
export function updateCommand(srcDir: string, configPath: string): string {
  return `sudo bash ${srcDir}/install/update.sh --config ${configPath}`
}

export async function startDevDeploy(actor: DevActor, note: string, now: () => number = Date.now): Promise<DeployStartResult> {
  const db = getDb()
  const audit = (r: DeployStartResult) => {
    writeDevOpsAudit({
      bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action: 'deploy',
      target: r.deploy_id ? `deploy #${r.deploy_id}` : null,
      outcome: r.ok ? 'started' : r.code === 'spawn_failed' ? 'failed' : 'refused', code: r.code,
      detail: note ? `${r.message} Note: ${note}` : r.message,
    })
    return r
  }
  const hc = devOpsHostConfig()
  if (!hc.ok) return audit({ ok: false, code: 'host_config', message: hc.error })

  settleDeploys(now)
  const running = db.prepare("SELECT id, created_at FROM dev_ops_deploys WHERE status = 'started' ORDER BY id DESC LIMIT 1").get() as { id: number; created_at: string } | undefined
  if (running) return audit({ ok: false, code: 'deploy_running', message: `Deploy #${running.id} is still running. Ask for the deploy status.` })
  const last = db.prepare('SELECT created_at FROM dev_ops_deploys ORDER BY id DESC LIMIT 1').get() as { created_at: string } | undefined
  if (last && now() - ms(last.created_at) < COOLDOWN_MS) {
    return audit({ ok: false, code: 'cooldown', message: 'A deploy finished moments ago; wait two minutes before the next one.' })
  }

  const { srcDir, configPath, helperImage, hostDataDir, healthUrl } = hc.config
  const id = Number(db.prepare("INSERT INTO dev_ops_deploys (bot_slug, user_id, username, status, step, detail) VALUES (?, ?, ?, 'started', 'starting', ?)")
    .run(actor.botSlug, actor.userId, actor.username, scrub(note, 500)).lastInsertRowid)
  const r = await runOnHost(helperImage, ['deploy', srcDir, configPath, String(id), healthUrl, hostDataDir], {
    detached: true, name: `ok-dev-ops-deploy-${id}`, timeoutMs: 120_000,
  })
  if (r.code !== 0) {
    const why = scrub((r.stderr || r.stdout || `exit ${r.code}`).trim(), 400)
    db.prepare("UPDATE dev_ops_deploys SET status = 'failed', step = 'spawn', detail = ?, finished_at = datetime('now') WHERE id = ?").run(why, id)
    return audit({ ok: false, code: 'spawn_failed', deploy_id: id, message: `The deploy could not start on the host: ${why}` })
  }
  return audit({
    ok: true, code: 'started', deploy_id: id,
    message: `Deploy #${id} started on the host: \`${updateCommand(srcDir, configPath)}\` (backup first), then verify.sh and ${healthUrl}; it rolls back to the backup on its own if either fails. The app restarts during it, so chat drops for a minute or two. Ask me for the deploy status afterwards.`,
  })
}

interface StatusFile {
  state?: string
  step?: string
  message?: string
  from_sha?: string
  to_sha?: string
  backup_dir?: string
  log_tail?: string
}

function readStatusFile(dataDir: string, id: number): StatusFile | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'dev-ops', `deploy-${id}.json`), 'utf8')) as StatusFile
  } catch {
    return null
  }
}

function dataDir(): string {
  const hc = devOpsHostConfig()
  return hc.ok ? hc.config.dataDir : (process.env.CC_DEV_OPS_DATA_DIR || '/app/data')
}

/** Turn finished host runs into rows + audit. Returns the ids it settled. */
export function settleDeploys(now: () => number = Date.now): number[] {
  const db = getDb()
  const rows = db.prepare("SELECT * FROM dev_ops_deploys WHERE status = 'started' ORDER BY id").all() as DeployRow[]
  const settled: number[] = []
  const dir = dataDir()
  for (const row of rows) {
    const f = readStatusFile(dir, row.id)
    let status: DeployRow['status'] | null = null
    let detail = ''
    if (f && TERMINAL.has(String(f.state))) {
      status = f.state as DeployRow['status']
      detail = `${f.message ?? ''}${f.log_tail ? `\n--- log tail ---\n${f.log_tail.slice(-2500)}` : ''}`
    } else if (now() - ms(row.created_at) > DEPLOY_TIMEOUT_MS) {
      status = 'failed'
      detail = `No outcome from the host after ${DEPLOY_TIMEOUT_MS / 60_000} minutes${f?.step ? ` (last step: ${f.step})` : ''}.`
    } else {
      if (f?.step && f.step !== row.step) db.prepare('UPDATE dev_ops_deploys SET step = ? WHERE id = ?').run(f.step, row.id)
      continue
    }
    const clean = scrub(detail, 4000)
    db.prepare(`UPDATE dev_ops_deploys SET status = ?, step = ?, from_sha = ?, to_sha = ?, backup_dir = ?, detail = ?, finished_at = datetime('now') WHERE id = ?`)
      .run(status, f?.step ?? row.step, f?.from_sha ?? null, f?.to_sha ?? null, f?.backup_dir ?? null, clean, row.id)
    writeDevOpsAudit({
      bot_slug: row.bot_slug, user_id: row.user_id, username: row.username, action: 'deploy_settled', target: `deploy #${row.id}`,
      outcome: status === 'deployed' ? 'done' : status === 'rolled_back' ? 'rolled_back' : 'failed', code: status,
      detail: f?.message ?? clean,
    })
    settled.push(row.id)
  }
  return settled
}

export interface DeployStatusView {
  id: number
  status: string
  step: string | null
  from_sha: string | null
  to_sha: string | null
  backup_dir: string | null
  message: string | null
  started_at: string
  finished_at: string | null
}

export function deployStatus(limit = 3, now: () => number = Date.now): DeployStatusView[] {
  settleDeploys(now)
  const rows = getDb().prepare('SELECT * FROM dev_ops_deploys ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(10, limit))) as DeployRow[]
  return rows.map(r => ({
    id: r.id, status: r.status, step: r.step, from_sha: r.from_sha, to_sha: r.to_sha, backup_dir: r.backup_dir,
    message: r.detail ? r.detail.slice(0, 1500) : null, started_at: r.created_at, finished_at: r.finished_at,
  }))
}
