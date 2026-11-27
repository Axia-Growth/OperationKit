/**
 * Connector credentials that must never sit in a card session's process env
 * (obj 901743, public issue #136).
 *
 * GitHub and Google Workspace are reached through the host-side connector
 * broker (`routes/session-broker.ts`) instead: the session holds only its own
 * card-scoped `CC_SESSION_TOKEN` and asks the broker per request. This module
 * is the ONE list of names that are withheld — `buildSpawnEnv` deletes them
 * whatever their source (a connection, the Secrets store, an inherited server
 * env), the tmux wrapper `unset`s them, and the jail `--env-file` filter drops
 * them as a second wall. Kept dependency-free so every layer can import it.
 */

/** Exact names withheld from every spawn env. */
export const CONNECTOR_CREDENTIAL_ENV: readonly string[] = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
]

/** Workspace MCP server credentials (`CC_MCP_TOKEN_<id>`); relayed by the broker instead. */
export const MCP_TOKEN_ENV_PREFIX = 'CC_MCP_TOKEN_'

/** True for a name that carries a connector credential. Case-insensitive. */
export function isConnectorCredentialEnvKey(name: string): boolean {
  const k = String(name).toUpperCase()
  return CONNECTOR_CREDENTIAL_ENV.includes(k) || k.startsWith(MCP_TOKEN_ENV_PREFIX)
}

/** Remove every connector credential from an env bag, in place. Returns the names removed. */
export function stripConnectorCredentials(env: Record<string, string | undefined>): string[] {
  const removed: string[] = []
  for (const k of Object.keys(env)) {
    if (isConnectorCredentialEnvKey(k)) {
      delete env[k]
      removed.push(k)
    }
  }
  return removed
}

/** Marker: this session's GitHub goes through the broker (git credential helper + gh shim). */
export const GITHUB_BROKER_ENV = 'CC_GITHUB_BROKER'
/** Marker: this session's Google Workspace goes through the broker's MCP endpoint. */
export const GOOGLE_BROKER_ENV = 'CC_GOOGLE_BROKER'
/** Base URL of the broker as seen from inside a session (tmux and jail alike). */
export const CONNECTOR_BROKER_URL_ENV = 'CC_CONNECTOR_BROKER_URL'
/** The route prefix the broker is mounted on. */
export const SESSION_BROKER_PATH = '/api/session-broker'

/**
 * The broker base URL a session uses. `localhost:<port>` reaches the control
 * plane in tmux mode (same container) and in jail mode (obj 900113 forwards it).
 * `CC_CONNECTOR_BROKER_URL` on the server overrides it.
 */
export function connectorBrokerBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env[CONNECTOR_BROKER_URL_ENV] || '').trim().replace(/\/+$/, '')
  if (override) return override
  const port = Number.parseInt(env.PORT || '3002', 10) || 3002
  return `http://localhost:${port}${SESSION_BROKER_PATH}`
}
