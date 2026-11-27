/**
 * /api/session-broker — host-side connector broker for card sessions
 * (obj 901743, public issue #136). Logic: services/connector-broker.ts.
 *
 * Auth is the card's own `X-CC-Session-Token` (spawn-minted, objective-scoped)
 * and nothing else: no cookie, no API key. Every request is decided on the LIVE
 * card row, so an ended card, a moved card or a changed owner is refused.
 *
 *   GET  /github/git-credential?protocol=&host=&path=
 *        git credential-helper answer (`username=…\npassword=…`) for ONE repo the
 *        card may use. Called by the static helper script the spawn installs.
 *   GET  /github/token?repo=owner/repo
 *        the same credential as plain text, for the `gh` shim, which puts it on
 *        the one `gh` child process it starts.
 *   POST /google/mcp
 *        MCP (stateless JSON-RPC) for Gmail / Calendar with the card's connector
 *        mode enforced before any Google request. GET is 405.
 *   POST|DELETE /mcp/:slug
 *        relay to a workspace MCP server, adding its credential on the host.
 *
 * Not under /api/internal (whose gate refuses sandbox peers) and not under
 * /api/secrets-broker (gated on `session_secret_access`): a connector the owner
 * connected must keep working in a jailed card without an extra flag.
 */
import { Router, type Request, type Response } from 'express'
import { isLocalhost } from '../lib/is-localhost.js'
import { rateLimit } from '../services/file-access.js'
import {
  brokerGithubCredential,
  brokerGoogle,
  callGoogleTool,
  googleToolResultForSession,
  googleToolsForMode,
  GoogleToolRefusal,
  resolveBrokerCard,
  resolveRelayServer,
  type BrokerCard,
  type BrokerRefusal,
} from '../services/connector-broker.js'
import { mcpFetch, requestHeadersFor } from '../services/workspace-mcp-servers.js'

const router = Router()

const RATE = () => Number(process.env.CC_SESSION_BROKER_RATE_PER_MIN) || 120

interface BrokerReq extends Request {
  brokerCard?: BrokerCard
}

function sendRefusal(res: Response, r: BrokerRefusal, asText = false): void {
  res.setHeader('Cache-Control', 'private, no-store')
  if (asText) res.status(r.status).type('text/plain').send(`${r.code}: ${r.error}\n`)
  else res.status(r.status).json({ error: r.error, code: r.code })
}

const MAX_RPC_BATCH = 20

router.use((req: BrokerReq, res, next) => {
  // On-box callers only (loopback, the docker bridge gateway, the jail network),
  // with no forwarding headers: a session token that leaks into a transcript or
  // PR must not work through the public proxy.
  if (!isLocalhost(req)) {
    res.status(403).json({ error: 'The session broker only answers on-box sessions.', code: 'not_on_box' })
    return
  }
  const r = resolveBrokerCard(req.headers)
  if (!r.ok) {
    sendRefusal(res, r)
    return
  }
  const retry = rateLimit(`session-broker:${r.card.objective.id}`, RATE())
  if (retry !== null) {
    res.setHeader('Retry-After', String(retry))
    res.status(429).json({ error: 'Rate limit exceeded', retry_after: retry })
    return
  }
  req.brokerCard = r.card
  next()
})

function auditGithub(card: BrokerCard, repo: string, via: string, outcome: string): void {
  // Names only — never the credential.
  console.log(`[session-broker] github ${via} obj=${card.objective.id} repo=${repo} -> ${outcome}`)
}

// ── GitHub ──────────────────────────────────────────────────────────────────

router.get('/github/git-credential', (req: BrokerReq, res) => {
  const card = req.brokerCard!
  const q = (k: string) => (typeof req.query[k] === 'string' ? (req.query[k] as string) : '')
  res.setHeader('Cache-Control', 'private, no-store')
  if (q('host').toLowerCase() !== 'github.com' || (q('protocol') && q('protocol') !== 'https')) {
    // Not ours to answer: an empty reply lets git try its next helper / prompt.
    res.status(200).type('text/plain').send('')
    return
  }
  const cred = brokerGithubCredential(card, q('path'))
  auditGithub(card, q('path') || '(none)', 'git', cred.ok ? `granted (${cred.source})` : cred.code)
  if (!cred.ok) {
    sendRefusal(res, cred, true)
    return
  }
  res.status(200).type('text/plain').send(`username=x-access-token\npassword=${cred.token}\n`)
})

router.get('/github/token', (req: BrokerReq, res) => {
  const card = req.brokerCard!
  const repo = typeof req.query.repo === 'string' ? req.query.repo : ''
  res.setHeader('Cache-Control', 'private, no-store')
  const cred = brokerGithubCredential(card, repo)
  auditGithub(card, repo || '(none)', 'gh', cred.ok ? `granted (${cred.source})` : cred.code)
  if (!cred.ok) {
    sendRefusal(res, cred, true)
    return
  }
  res.status(200).type('text/plain').send(cred.token)
})

// ── Google Workspace (MCP) ──────────────────────────────────────────────────

const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }

function rpcResult(id: RpcMessage['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}
function rpcError(id: RpcMessage['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

router.all('/google/mcp', async (req: BrokerReq, res) => {
  if (req.method !== 'POST') {
    res.set('Allow', 'POST').status(405).json(rpcError(null, -32000, 'Stateless server: use POST'))
    return
  }
  const card = req.brokerCard!
  const access = brokerGoogle(card)
  const body = req.body
  const batch = Array.isArray(body)
  const messages: RpcMessage[] = batch ? body : [body]
  if (!body || messages.length === 0) {
    res.status(400).json(rpcError(null, -32700, 'Parse error: expected a JSON-RPC body'))
    return
  }
  if (messages.length > MAX_RPC_BATCH) {
    res.status(400).json(rpcError(null, -32600, `Batch too large (max ${MAX_RPC_BATCH} messages).`))
    return
  }
  const handle = async (m: RpcMessage): Promise<object | null> => {
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return rpcError(m?.id, -32600, 'Invalid request')
    const isNotification = m.id === undefined || m.id === null
    switch (m.method) {
      case 'initialize': {
        const asked = typeof m.params?.protocolVersion === 'string' ? (m.params.protocolVersion as string) : ''
        return rpcResult(m.id, {
          protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'cc-google-workspace', version: '1.0.0' },
          instructions: access.ok
            ? `Google Workspace for ${access.email}, mode ${access.mode}. Brokered by the host: no credential is in this session. Drafts are saved, never sent.`
            : `Google Workspace is not available to this card: ${access.error}`,
        })
      }
      case 'ping':
        return rpcResult(m.id, {})
      case 'tools/list':
        return rpcResult(m.id, { tools: access.ok ? googleToolsForMode(access.mode).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) : [] })
      case 'tools/call': {
        const name = typeof m.params?.name === 'string' ? (m.params.name as string) : ''
        const args = (m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {}) as Record<string, unknown>
        if (!access.ok) return rpcResult(m.id, { isError: true, content: [{ type: 'text', text: access.error }] })
        try {
          const out = await callGoogleTool(access, name, args)
          console.log(`[session-broker] google ${name} obj=${card.objective.id} mode=${access.mode} -> ok`)
          return rpcResult(m.id, { content: [{ type: 'text', text: googleToolResultForSession(card, name, out) }] })
        } catch (err) {
          const refused = err instanceof GoogleToolRefusal
          console.log(`[session-broker] google ${name} obj=${card.objective.id} mode=${access.mode} -> ${refused ? 'refused' : 'error'}`)
          return rpcResult(m.id, { isError: true, content: [{ type: 'text', text: (err as Error).message }] })
        }
      }
      default:
        if (isNotification) return null
        return rpcError(m.id, -32601, `Method not found: ${m.method}`)
    }
  }
  const replies = (await Promise.all(messages.map(handle))).filter((r): r is object => r !== null)
  res.setHeader('Cache-Control', 'private, no-store')
  if (replies.length === 0) {
    res.status(202).end()
    return
  }
  res.json(batch ? replies : replies[0])
})

// ── Workspace MCP relay ─────────────────────────────────────────────────────

const RELAY_PASS_REQUEST = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']
const RELAY_PASS_RESPONSE = ['content-type', 'mcp-session-id']

router.all('/mcp/:slug', async (req: BrokerReq, res) => {
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    // No server→client SSE stream through the relay; the spec allows a 405 here.
    res.set('Allow', 'POST, DELETE').status(405).json(rpcError(null, -32000, 'Relay: use POST'))
    return
  }
  const card = req.brokerCard!
  const row = resolveRelayServer(card, String(req.params.slug))
  if (!row) {
    res.status(404).json(rpcError(null, -32000, 'No such MCP server for this card.'))
    return
  }
  const headers: Record<string, string> = {}
  for (const h of RELAY_PASS_REQUEST) {
    const v = req.headers[h]
    if (typeof v === 'string' && v) headers[h] = v
  }
  try {
    Object.assign(headers, await requestHeadersFor(row))
  } catch {
    res.status(502).json(rpcError(null, -32000, 'The MCP server credential could not be read.'))
    return
  }
  let up: globalThis.Response
  try {
    up = await mcpFetch()(row.url, {
      method: req.method,
      headers,
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? null) } : {}),
    })
  } catch {
    res.status(502).json(rpcError(null, -32000, `${row.name} did not answer.`))
    return
  }
  for (const h of RELAY_PASS_RESPONSE) {
    const v = up.headers.get(h)
    if (v) res.setHeader(h, v)
  }
  res.setHeader('Cache-Control', 'private, no-store')
  const buf = Buffer.from(await up.arrayBuffer())
  res.status(up.status).send(buf)
})

export default router
