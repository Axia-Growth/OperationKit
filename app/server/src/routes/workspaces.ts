import { Router } from 'express'
import { requireAuth, type AuthRequest } from '../middleware/auth.js'
import { getUserWorkspaces } from '../middleware/workspace.js'
import { listWorkspaces } from '../services/workspaces.js'

const router = Router()
router.use(requireAuth)

// GET /api/workspaces — list workspaces visible to the caller.
// Admins see every active workspace; members see only the slugs they're in.
router.get('/', (req: AuthRequest, res) => {
  const all = listWorkspaces()
  // obj 901106: a card browser session sees only its card's workspace.
  if (req.cardBrowser) {
    res.json(all.filter(w => w.slug === req.cardBrowser!.workspace))
    return
  }
  if (req.user!.role === 'admin') {
    res.json(all)
    return
  }
  const memberSlugs = new Set(getUserWorkspaces(req.user!.id).map(uw => uw.workspace))
  res.json(all.filter(w => memberSlugs.has(w.slug)))
})

export default router
