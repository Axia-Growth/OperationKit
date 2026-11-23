/**
 * Audit trail for the Operation Kit Dev operator tools (obj 901424).
 *
 * Every dev-ops tool call writes one row here, allowed or refused, and every
 * background step (branch updated, merged on green, deploy settled) writes one
 * more. `detail` passes through `redactForStorage` (known secret values + high
 * confidence token shapes) before it is stored, and callers never put a token
 * in it to begin with. Rows are never deleted by this module.
 */
import { getDb } from '../../db/index.js'
import { redactForStorage } from '../secret-redaction.js'

export type DevOpsOutcome = 'allowed' | 'refused' | 'started' | 'done' | 'failed' | 'rolled_back' | 'waiting' | 'no_change'

export interface DevOpsAuditEntry {
  bot_slug: string
  user_id?: number | null
  username?: string | null
  /** e.g. merge, branch_update, merge_on_green, close, deploy, deploy_settled, access_add, dns_upsert. */
  action: string
  /** What it acted on: `repo#123`, an email, a DNS name. Redacted like detail. */
  target?: string | null
  objective_id?: number | null
  outcome: DevOpsOutcome
  code?: string | null
  detail?: string | null
}

export interface DevOpsAuditRow extends Required<Omit<DevOpsAuditEntry, 'user_id' | 'username' | 'target' | 'objective_id' | 'code' | 'detail'>> {
  id: number
  at: string
  user_id: number | null
  username: string | null
  target: string | null
  objective_id: number | null
  code: string | null
  detail: string | null
}

const MAX_DETAIL = 4000

export function scrub(text: string | null | undefined, max = MAX_DETAIL): string | null {
  if (text == null) return null
  return redactForStorage(String(text)).text.slice(0, max)
}

export function writeDevOpsAudit(e: DevOpsAuditEntry): number {
  try {
    const r = getDb().prepare(
      `INSERT INTO dev_ops_audit (bot_slug, user_id, username, action, target, objective_id, outcome, code, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      e.bot_slug, e.user_id ?? null, e.username ?? null, e.action, scrub(e.target, 300), e.objective_id ?? null,
      e.outcome, e.code ?? null, scrub(e.detail),
    )
    return Number(r.lastInsertRowid)
  } catch (err) {
    console.warn('[dev-ops] audit write failed:', (err as Error).message)
    return 0
  }
}

export function listDevOpsAudit(limit = 100): DevOpsAuditRow[] {
  const n = Math.max(1, Math.min(500, Math.floor(limit) || 100))
  return getDb().prepare('SELECT * FROM dev_ops_audit ORDER BY id DESC LIMIT ?').all(n) as DevOpsAuditRow[]
}
