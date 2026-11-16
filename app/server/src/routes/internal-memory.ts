/**
 * Own-card memory files over the control plane (obj 900955).
 *
 * A sandboxed session has only its worktree and its HOME on disk; the
 * objective-memory folder on the host is not mounted. The reviewer reads
 * ARTIFACT.md from that folder as the deliverable, so a sandboxed card had no
 * way to hand one in. These two routes are that way.
 *
 *   PUT /api/internal/objectives/:id/memory/file   { path, content }
 *   GET /api/internal/objectives/:id/memory/file?path=…
 *
 * Auth is the card's OWN session token and nothing else: no localhost trust and
 * no internal secret, because this writes the file a review grades. The path is
 * an allowlist (`ARTIFACT.md`, the scratch file, `live/<name>`), enforced in
 * `services/live-artifacts.ts` together with the size cap and containment.
 */
import type { Request, Response, Router } from 'express'
import { requireBoardPrincipal } from '../middleware/internal-board-auth.js'
import { sessionTokenFromHeaders } from '../lib/session-trust.js'
import { ArtifactError, readMemoryFile, writeMemoryFile } from '../services/live-artifacts.js'

/** The card id, when the caller holds that card's own session token. Otherwise the response is sent. */
function ownCard(req: Request, res: Response): number | null {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid objective id' })
    return null
  }
  if (!sessionTokenFromHeaders(req.headers as Record<string, string | string[] | undefined>)) {
    res.status(401).json({ error: 'X-CC-Session-Token (CC_SESSION_TOKEN) is required', code: 'session_token_required' })
    return null
  }
  const principal = requireBoardPrincipal(req, res)
  if (!principal) return null
  if (principal.kind !== 'session' || principal.objectiveId !== id) {
    res.status(403).json({ error: "A session may only read or write its own card's memory files", code: 'not_own_card' })
    return null
  }
  return id
}

function sendError(res: Response, err: unknown, what: string): void {
  if (err instanceof ArtifactError) {
    res.status(err.status).json({ error: err.message })
    return
  }
  console.error(`[internal-memory] ${what} failed:`, err)
  res.status(500).json({ error: `memory file ${what} failed` })
}

export function registerInternalMemoryRoutes(router: Router): void {
  router.put('/objectives/:id/memory/file', (req, res) => {
    const id = ownCard(req, res)
    if (id === null) return
    const body = (req.body ?? {}) as { path?: unknown; content?: unknown }
    try {
      res.json({ ok: true, objective_id: id, ...writeMemoryFile(id, body.path, body.content) })
    } catch (err) {
      sendError(res, err, 'write')
    }
  })

  router.get('/objectives/:id/memory/file', (req, res) => {
    const id = ownCard(req, res)
    if (id === null) return
    try {
      res.json({ objective_id: id, ...readMemoryFile(id, req.query.path) })
    } catch (err) {
      sendError(res, err, 'read')
    }
  })
}
