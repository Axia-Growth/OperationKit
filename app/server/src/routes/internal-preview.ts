/**
 * Preview TLS check + PR-created hook — extracted from internal.ts
 * (behavior frozen). Localhost gate and SQL unchanged.
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { broadcast } from '../ws/index.js'
import type { Objective } from '@operationkit/shared'
import { parsePrNumberFromUrl } from '../services/pr-url.js'
import { upsertObjectivePR } from '../services/objective-prs.js'
import { enqueuePreviewDeploy, kickHostDrain } from '../services/preview-spool.js'
import { isLocalhost } from '../lib/is-localhost.js'
import { resolvePreviewDomain } from '../lib/install-defaults.js'

export function registerInternalPreviewRoutes(router: Router): void {
// Caddy on-demand TLS check — validates preview subdomains
router.get('/check-preview', (req, res) => {
  const domain = req.query.domain as string
  // obj 900803: only `pr-<N>.<this install's preview domain>`; none configured → 404.
  const previewDomain = resolvePreviewDomain()
  const m = typeof domain === 'string' ? /^pr-(\d+)\.(.+)$/.exec(domain.toLowerCase()) : null
  if (previewDomain && m && m[2] === previewDomain) {
    res.status(200).end()
  } else {
    res.status(404).end()
  }
})

// Session reports PR creation — updates objective with branch/PR info
router.post('/pr-created', (req, res) => {
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'Internal API: localhost only' })
    return
  }
  const { objective_id, branch_name, pr_url, pr_number } = req.body as {
    objective_id: number
    branch_name?: string
    pr_url?: string
    pr_number?: number
  }
  if (!objective_id) {
    res.status(400).json({ error: 'objective_id required' })
    return
  }
  // Durable correctness: never leave pr_number NULL when pr_url is set. Workers often
  // link only the URL; without the number the harness gate can't post harness/test-agent
  // and the PR is stuck BLOCKED. Derive the number from the URL when not supplied.
  const resolvedPrNumber = pr_number ?? parsePrNumberFromUrl(pr_url)
  const db = getDb()
  db.prepare(
    "UPDATE objectives SET branch_name = ?, pr_url = ?, pr_number = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(branch_name || null, pr_url || null, resolvedPrNumber || null, objective_id)

  // Append to the per-objective PR log (obj 2300). This is ADDITIVE to the
  // "latest pointer" UPDATE above — two distinct PRs from one objective become
  // two rows; a re-reported PR upserts the same row. A branch-only report (no
  // resolvable PR number) inserts nothing, leaving the branch_name behavior intact.
  upsertObjectivePR({
    objective_id,
    pr_number: resolvedPrNumber,
    pr_url,
    branch_name,
  })

  const updated = db.prepare('SELECT * FROM objectives WHERE id = ?').get(objective_id) as Objective | undefined
  if (updated) broadcast({ type: 'objective_updated', payload: updated })
  console.log(`[internal] PR created for objective ${objective_id}: ${pr_url || branch_name}`)

  // Auto-deploy the PR preview (obj 1452). The harness/test-agent (the
  // parent card's AI reviewer) drives the LIVE preview at
  // https://pr-<N>.cc.example.com via Playwright; without an auto-deploy it
  // hit a dead host and the PR got a spurious BLOCKED. We enqueue a deploy job
  // for the host-side privileged runner (the Caddy/docker-build steps need host
  // root the container lacks). Best-effort: a spool failure never fails this
  // request, and the runner/preview-deploy.sh is idempotent on re-request.
  if (resolvedPrNumber && (branch_name || updated?.branch_name)) {
    if (enqueuePreviewDeploy(resolvedPrNumber, branch_name || updated?.branch_name, objective_id)) {
      kickHostDrain() // fire the host-root drain now; no systemd install required
    }
  }

  // obj 901228: this hook used to INSERT a `[Review] <title>` child card
  // (agent_context 'cto', workflow_hint 'adversarial') on every PR report. That
  // path is retired. Nothing ever started those children (queue auto-start skips
  // `[Review]%` titles and child cards), and neither auto-merge nor the close gate
  // read them, so they only stranded in `queue`. The built-in AI review on the
  // PARENT card (state-poller → spawnReviewerSession → ai_review_verdict) is what
  // gates merge and close. Do not reintroduce a child here.

  res.json({ ok: true })
})

}
