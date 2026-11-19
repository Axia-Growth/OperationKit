/**
 * obj 901381 — request an AI review for cards already sitting in `review` with
 * a linked PR and no verdict, without re-running the work session.
 *
 *   GET  /api/internal/ai-review/stranded[?workspace=]   list the cards (read-only)
 *   POST /api/internal/ai-review/request                  spawn reviewers
 *        body: { ids?: number[], workspace?: string, dry_run?: boolean }
 *        no `ids` = every stranded card (in `workspace` when given).
 *
 * Both are localhost + `X-Internal-Secret` (same split as /supervisor/run and
 * /routines): the POST spawns reviewer sessions, and the GET is a board-wide
 * read. Logic lives in services/ai-review-backfill.ts.
 *
 * Operator, after deploy (dry run first, then the real one):
 *   docker exec command-center sh -c 'curl -s -X POST http://localhost:3002/api/internal/ai-review/request \
 *     -H "Content-Type: application/json" -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
 *     -d "{\"workspace\":\"operationkit\",\"dry_run\":true}"'
 */
import { Router, type Request, type Response } from 'express'
import { getDb } from '../db/index.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { requireInternalSecret } from '../middleware/internal-secret.js'
import { findStrandedPrReviews, requestAiReview, type RequestReviewDeps } from '../services/ai-review-backfill.js'
import { repoForObjective } from '../services/objective-prs.js'
import { parsePrNumberFromUrl } from '../services/pr-url.js'
import { sessionCapReached, SESSION_CAP_ERROR } from '../lib/session-cap.js'
import type { Objective } from '@operationkit/shared'

/** Hard cap per call so one request cannot fan out an unbounded number of reviewers. */
export const MAX_REVIEWS_PER_REQUEST = 10

function gate(req: Request, res: Response): boolean {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return false
  }
  return requireInternalSecret(req, res)
}

/** Production deps, loaded lazily so importing this router never pulls in the spawn stack. */
export function defaultAiReviewDeps(): RequestReviewDeps {
  return {
    spawnReviewer: async (o: Objective) => (await import('../services/session-manager.js')).spawnReviewerSession(o),
    stopSession: async (sid: string) => { await (await import('../services/session-manager.js')).stopSession(sid) },
    prState: async (o: Objective) => {
      const repo = repoForObjective(getDb(), o)
      const n = o.pr_number ?? parsePrNumberFromUrl(o.pr_url)
      if (!repo || !n) return null
      const { realGhExec } = await import('../services/files-touched.js')
      const out = await realGhExec(['pr', 'view', String(n), '--repo', repo, '--json', 'state', '-q', '.state'])
      return out.trim() || null
    },
  }
}

export function createAiReviewRouter(deps: () => RequestReviewDeps = defaultAiReviewDeps): Router {
  const router = Router()

  router.get('/stranded', (req, res) => {
    if (!gate(req, res)) return
    const workspace = typeof req.query.workspace === 'string' && req.query.workspace ? req.query.workspace : undefined
    const rows = findStrandedPrReviews(getDb(), { workspace })
    res.json({ count: rows.length, objectives: rows })
  })

  router.post('/request', async (req, res) => {
    if (!gate(req, res)) return
    const body = (req.body ?? {}) as { ids?: unknown; workspace?: unknown; dry_run?: unknown }
    const dryRun = body.dry_run === true
    const workspace = typeof body.workspace === 'string' && body.workspace ? body.workspace : undefined
    let ids: number[]
    if (body.ids !== undefined) {
      if (!Array.isArray(body.ids) || body.ids.length === 0 || !body.ids.every((x) => Number.isInteger(x) && (x as number) > 0)) {
        return void res.status(400).json({ error: '`ids` must be a non-empty array of positive integers' })
      }
      ids = [...new Set(body.ids as number[])]
    } else {
      ids = findStrandedPrReviews(getDb(), { workspace }).map((r) => r.id)
    }
    if (ids.length > MAX_REVIEWS_PER_REQUEST) {
      return void res.status(400).json({
        error: `At most ${MAX_REVIEWS_PER_REQUEST} cards per request; ${ids.length} matched. Pass \`ids\` in batches.`,
        matched_ids: ids,
      })
    }

    const db = getDb()
    const d = deps()
    const results = []
    for (const id of ids) {
      if (!dryRun && sessionCapReached(db)) {
        results.push({ id, ok: false, code: 'session_cap', detail: SESSION_CAP_ERROR })
        continue
      }
      results.push(await requestAiReview(db, id, d, { dryRun, requestedBy: 'internal:ai-review/request' }))
    }
    res.json({
      dry_run: dryRun,
      requested: results.filter((r) => r.ok).length,
      refused: results.filter((r) => !r.ok).length,
      results,
    })
  })

  return router
}

export default createAiReviewRouter()
