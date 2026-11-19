/**
 * Merged, waiting for deploy (obj 901389). Mounted under /api/admin, so the
 * admin.ts facade already applies requireAuth + requireAdmin (admin role only;
 * agent keys are rejected). READ-ONLY: no POST, no deploy, no restart.
 *
 *   GET /api/admin/deploy-status → services/deploy-waiting.ts DeployStatus
 *
 * Shown on the Jobs page (where Settings → Platform redirects), next to the
 * other platform panels; the drift alert itself stays in the AlertBell.
 */
import { Router } from 'express'
import type { AuthRequest } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { collectDeployStatus } from '../services/deploy-waiting.js'

const router = Router()

router.get('/deploy-status', (_req: AuthRequest, res) => {
  if ((process.env.DRIFT_GUARD || '').trim().toLowerCase() === 'off') {
    // Image-based install: there is no live checkout, so "behind main" has no meaning.
    return res.json({ ok: false, disabled: true, error: 'This install runs from an image (DRIFT_GUARD=off): there is no live checkout to compare with main.', waiting: [] })
  }
  res.json(collectDeployStatus(getDb()))
})

export default router
