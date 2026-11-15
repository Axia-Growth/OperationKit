// High Agency activity cards (obj 900947). Kept dependency-free (a DB handle only)
// so low-level pollers such as bot-thread-delivery.ts can ask without pulling
// in the board helpers.
import type { Database } from 'better-sqlite3'

/** Is this card High Agency activity: a wake, or a card a wake filed / parents? */
export function isHighAgencyActivityCard(db: Database, objectiveId: number): boolean {
  try {
    const row = db
      .prepare(
        `SELECT
           (SELECT r.name FROM routines r WHERE r.id = o.routine_id) AS own,
           (SELECT r.name FROM objectives s JOIN routines r ON r.id = s.routine_id WHERE s.id = o.source_job_id) AS via_source,
           (SELECT r.name FROM objectives p JOIN routines r ON r.id = p.routine_id WHERE p.id = o.parent_id) AS via_parent
         FROM objectives o WHERE o.id = ?`,
      )
      .get(objectiveId) as { own: string | null; via_source: string | null; via_parent: string | null } | undefined
    if (!row) return false
    return [row.own, row.via_source, row.via_parent].some(n => typeof n === 'string' && n.startsWith('high-agency:'))
  } catch {
    return false
  }
}
