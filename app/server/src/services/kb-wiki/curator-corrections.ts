import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import type { Database } from 'better-sqlite3'
import { classifyFollowup, isCorrective } from '../daily-retro.detect.js'
import { redactForStorage } from '../secret-redaction.js'
import type { HumanCorrection } from './curator.js'

/**
 * Human-correction signal for the knowledge curator (obj 901768).
 *
 * When a person types into a card's chat while a worker runs ("no, use the new
 * invoice header"), the server appends a `followup` event to the session
 * transcript with a server-derived `sender` (lib/message-provenance.ts). That
 * is the trace this reads. Only:
 *   - sessions of cards in the workspace being curated (session_starts ⨝ objectives),
 *   - follow-ups a PERSON typed in the web app (`sender.kind` owner/member and
 *     `verified`), or — for transcripts from before sender stamps — a follow-up
 *     the retro detector classifies as human,
 *   - that read as a correction (the daily-retro corrective phrasing, or
 *     "from now on / no longer / use the new …").
 * Agent, API, system and delegated messages are never corrections.
 *
 * Read-only: the transcript is never written. Text is redacted again before it
 * is kept, and capped.
 */

const MAX_SESSIONS = 300
const MAX_TEXT = 1500
const LOOKBACK_DAYS = 14

const LASTING_RULE = /\b(from now on|going forward|no longer|use the new|is now|are now|has (changed|moved)|have (changed|moved)|out of date|outdated|not anymore|renamed|replaced|always|never)\b/i

export interface FollowupEvent {
  type?: unknown
  text?: unknown
  timestamp?: unknown
  sender?: { kind?: unknown; verified?: unknown; label?: unknown } | null
}

/** Is this transcript event a person correcting the worker? Pure. */
export function correctionFromEvent(ev: FollowupEvent): { text: string; by: string | null } | null {
  if (ev.type !== 'followup' || typeof ev.text !== 'string') return null
  const text = ev.text.trim()
  if (!text) return null
  let by: string | null = null
  if (ev.sender && typeof ev.sender === 'object') {
    const kind = ev.sender.kind
    if ((kind !== 'owner' && kind !== 'member') || ev.sender.verified !== true) return null
    by = typeof ev.sender.label === 'string' ? ev.sender.label.slice(0, 120) : null
  } else if (classifyFollowup(text) !== 'human') {
    return null
  }
  if (!isCorrective(text) && !LASTING_RULE.test(text)) return null
  return { text: redactForStorage(text).text.slice(0, MAX_TEXT), by }
}

export function correctionId(sessionId: string, line: number): string {
  return `hc-${crypto.createHash('sha256').update(`${sessionId}:${line}`).digest('hex').slice(0, 12)}`
}

/** Corrections in one transcript typed at or after `since`. */
export async function correctionsInTranscript(file: string, sessionId: string, objectiveId: number | null, since: Date): Promise<HumanCorrection[]> {
  const out: HumanCorrection[] = []
  let stream: fs.ReadStream
  try { stream = fs.createReadStream(file, { encoding: 'utf8' }) } catch { return out }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let i = 0
  try {
    for await (const raw of rl) {
      const line = i++
      // Cheap filter first: transcripts are mostly tool output.
      if (!raw.includes('"followup"')) continue
      let ev: FollowupEvent
      try { ev = JSON.parse(raw) as FollowupEvent } catch { continue }
      const at = typeof ev.timestamp === 'string' ? ev.timestamp : ''
      if (!at || !(Date.parse(at) >= since.getTime())) continue
      const c = correctionFromEvent(ev)
      if (c) out.push({ id: correctionId(sessionId, line), at, text: c.text, by: c.by, objective_id: objectiveId, session_id: sessionId })
    }
  } catch { /* unreadable transcript: skip it */ } finally {
    rl.close()
    stream.destroy()
  }
  return out
}

/**
 * Every human correction typed since `since` in the workspace's card sessions.
 * Sessions are found through `session_starts` (every spawn/resume writes a row);
 * a transcript not written to since `since` is skipped without reading it.
 */
export async function collectHumanCorrections(db: Database, workspace: string, since: Date, transcriptDir: string): Promise<HumanCorrection[]> {
  const from = new Date(since.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString()
  let rows: Array<{ session_id: string; objective_id: number }>
  try {
    rows = db.prepare(`
      SELECT s.session_id AS session_id, MAX(s.objective_id) AS objective_id
        FROM session_starts s
        JOIN objectives o ON o.id = s.objective_id
       WHERE o.workspace = ? AND s.session_id IS NOT NULL AND s.session_id != '' AND s.created_at >= ?
       GROUP BY s.session_id
       ORDER BY MAX(s.id) DESC
       LIMIT ?`).all(workspace, from, MAX_SESSIONS) as Array<{ session_id: string; objective_id: number }>
  } catch { return [] }
  const out: HumanCorrection[] = []
  for (const r of rows) {
    if (!/^[\w.-]+$/.test(r.session_id)) continue
    const file = path.join(transcriptDir, `${r.session_id}.jsonl`)
    try { if (fs.statSync(file).mtimeMs < since.getTime()) continue } catch { continue }
    out.push(...await correctionsInTranscript(file, r.session_id, r.objective_id, since))
  }
  return out
}
