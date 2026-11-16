/**
 * Unauthenticated discovery for third-party agents.
 * Spec + how-to-auth; no board data.
 */
import { Router } from 'express'
import { AGENT_DISCOVERY, AGENT_OPENAPI } from '../api/agent-openapi.js'
import { resolvePublicBaseUrl } from '../lib/public-url.js'

const router = Router()

router.get('/agent', (_req, res) => {
  res.json({ ...AGENT_DISCOVERY, base_url: resolvePublicBaseUrl() })
})

/** obj 901080: `servers[0]` is THIS install's public URL, resolved per request. */
export function agentOpenApiForInstall(): typeof AGENT_OPENAPI {
  const base = resolvePublicBaseUrl()
  const servers = [
    { url: base, description: 'This install' },
    ...AGENT_OPENAPI.servers.filter(s => s.url !== base && s.url.startsWith('http://localhost')),
  ]
  return { ...AGENT_OPENAPI, servers } as unknown as typeof AGENT_OPENAPI
}

router.get('/openapi.json', (_req, res) => {
  res.json(agentOpenApiForInstall())
})

export default router
