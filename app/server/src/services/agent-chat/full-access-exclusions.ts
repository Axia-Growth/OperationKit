// ── Full access: the four hard exclusions (obj 900972) ──
//
// Full access makes a bot a workspace-wide operator, so four kinds of action
// are never part of it (shared/full-access.ts):
//
//   secret_values — using secrets (the secrets broker, secret stores)   PERMANENT
//   keys          — minting, rotating or revoking keys and tokens       PERMANENT
//   dns_access    — DNS records and Cloudflare Access                   PERMANENT
//   billing       — billing, payments, subscriptions                    one switch, off by default
//
// A chat bot has two doors to the outside world that can do any of those: the
// secrets broker (`secrets_list` / `secret_http`) and the workspace's MCP
// connectors. This file is the ONE place that says which exclusion an outbound
// call falls under (`classifyOutbound`), and the one gate both doors call
// (`exclusionGate`). The gate is a wall for a bot that has Full access in that
// workspace, whoever is chatting with it: unless it is billing and an admin
// switched Billing on, the call is
// refused BEFORE anything is sent and the refusal is written to the Full access
// audit log. A bot without Full access there is not touched by this file.
//
// Classification is by what the call is aimed at — the host, the path, the
// HTTP method, the names of the secrets it uses, the connector and its tool —
// never by what the model says it is doing. It errs toward refusing: a call
// that only looks like billing is refused until an admin switches Billing on,
// which is one click, where a missed one is a bot changing DNS.
import { type FullAccessExclusion } from '@operationkit/shared'
import { exclusionAllowed, fullAccessActive, refuseExclusion } from './bot-full-access.js'

export interface OutboundCall {
  /** What to call it in a refusal, e.g. `secret_http POST api.stripe.com`. */
  what: string
  host?: string | null
  path?: string | null
  method?: string | null
  /** Names of the secrets the call would use. */
  secretNames?: string[]
  /** An MCP connector: its slug, name, catalog id and URL host. */
  connector?: { slug?: string | null; name?: string | null; catalogId?: string | null; host?: string | null } | null
  /** The connector tool being called. */
  tool?: string | null
  /** True when the call uses a workspace secret at all (every broker call). */
  usesSecret?: boolean
}

function hostMatches(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`)
}

// Hosts whose whole API is one exclusion.
const DNS_HOSTS = [
  'api.cloudflare.com', 'cloudflareaccess.com', 'cloudflare.com',
  'api.godaddy.com', 'api.ote-godaddy.com', 'api.namecheap.com', 'api.sandbox.namecheap.com',
  'api.dnsimple.com', 'api.porkbun.com', 'porkbun.com', 'api.name.com', 'api.gandi.net',
  'dns.googleapis.com', 'domains.googleapis.com', 'route53.amazonaws.com', 'route53domains.us-east-1.amazonaws.com',
  'dns.hetzner.com', 'api.cloudns.net', 'api.nsone.net', 'api.dynu.com', 'api.domeneshop.no',
]
const BILLING_HOSTS = [
  'stripe.com', 'api.paddle.com', 'vendors.paddle.com', 'chargebee.com', 'api.lemonsqueezy.com',
  'paypal.com', 'quickbooks.api.intuit.com', 'api.xero.com', 'recurly.com', 'api.braintreegateway.com',
  'connect.squareup.com', 'api.mercury.com', 'api.brex.com', 'api.ramp.com', 'api.gocardless.com', 'api.mollie.com',
]
const KEY_HOSTS = ['iam.amazonaws.com', 'iam.googleapis.com', 'sts.amazonaws.com']
const SECRET_STORE_HOSTS = [
  'api.doppler.com', 'secretmanager.googleapis.com', 'vault.azure.net', 'api.1password.com', 'app.infisical.com',
]

// Path segments that mean an exclusion on ANY host.
const DNS_SEGMENTS = new Set(['dns', 'dns_records', 'dns-records', 'dns_zones', 'dns-zones', 'nameservers'])
// Hosts where DNS lives under a general API: only these paths count.
const DNS_HOST_PATHS: { host: string; segment: string }[] = [
  { host: 'api.digitalocean.com', segment: 'domains' },
  { host: 'api.vercel.com', segment: 'domains' },
  { host: 'api.netlify.com', segment: 'dns_zones' },
  { host: 'api.linode.com', segment: 'domains' },
  { host: 'api.hetzner.cloud', segment: 'zones' },
]
const BILLING_SEGMENTS = new Set(['billing', 'invoices', 'invoice', 'payment_methods', 'payment-methods', 'payments', 'charges', 'refunds', 'payouts'])
const KEY_SEGMENTS = new Set([
  'api_keys', 'api-keys', 'apikeys', 'keys', 'access_keys', 'access-keys', 'accesskeys', 'deploy_keys', 'deploy-keys',
  'ssh_keys', 'ssh-keys', 'gpg_keys', 'personal_access_tokens', 'personal-access-tokens', 'access_tokens', 'access-tokens',
  'tokens', 'agent-keys', 'api-key', 'service_account_keys', 'serviceaccountkeys', 'secret-upload',
])

// Secret names that belong to an exclusion whatever host they are sent to.
const DNS_SECRET = /(^|_)(CLOUDFLARE|CF|GODADDY|NAMECHEAP|DNSIMPLE|PORKBUN|ROUTE53|DNS)(_|$)/i
const BILLING_SECRET = /(^|_)(STRIPE|PADDLE|CHARGEBEE|PAYPAL|QUICKBOOKS|XERO|BILLING|LEMONSQUEEZY|BRAINTREE|RECURLY|MERCURY|BREX|GOCARDLESS|MOLLIE)(_|$)/i

// Connector ids / names (lower-case, substring).
const DNS_CONNECTORS = ['cloudflare', 'godaddy', 'namecheap', 'dnsimple', 'route53', 'porkbun']
const BILLING_CONNECTORS = ['stripe', 'paypal', 'quickbooks', 'xero', 'paddle', 'chargebee', 'recurly', 'braintree', 'lemonsqueezy']
const SECRET_STORE_CONNECTORS = ['doppler', '1password', 'onepassword', 'vault', 'infisical', 'secret-manager', 'secretsmanager']

// Connector tool names.
const DNS_TOOL = /(^|[_\-.])(dns|nameserver|zone|domain)s?([_\-.]|$)|access[_\-.]?(policy|policies|app|application|group|rule)/i
const BILLING_TOOL = /(^|[_\-.])(billing|invoice|subscription|payment|charge|refund|payout|checkout|price|customer[_\-.]?balance)s?([_\-.]|$)/i
// A verb that mints or revokes, then (within two words) a key / token / credential — or the reverse order.
const KEY_TOOL = /(?:^|[_\-.])(?:create|mint|generate|issue|new|add|rotate|roll|regenerate|revoke|delete|remove|disable)(?:[_\-.][a-z0-9]+){0,2}[_\-.](?:keys?|tokens?|credentials?)(?:$|[_\-.])|(?:^|[_\-.])(?:keys?|tokens?|credentials?)(?:[_\-.][a-z0-9]+)?[_\-.](?:create|mint|generate|issue|add|rotate|roll|regenerate|revoke|delete|remove|disable)(?:$|[_\-.])/i
const SECRET_TOOL = /(^|[_\-.])secrets?([_\-.]|$)/i

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function segments(pathname: string): string[] {
  return pathname.toLowerCase().split(/[/?#]/).map(s => s.trim()).filter(Boolean)
}

/**
 * Which hard exclusions an outbound call falls under (possibly several,
 * possibly none). Pure: no DB, no network.
 */
export function classifyOutbound(call: OutboundCall): FullAccessExclusion[] {
  const out = new Set<FullAccessExclusion>()
  const host = (call.host ?? '').trim().toLowerCase().replace(/\.$/, '')
  const segs = segments(call.path ?? '')
  const method = (call.method ?? 'GET').toUpperCase()
  const names = call.secretNames ?? []

  if (call.usesSecret || names.length > 0) out.add('secret_values')

  if (host) {
    if (DNS_HOSTS.some(h => hostMatches(host, h))) out.add('dns_access')
    if (BILLING_HOSTS.some(h => hostMatches(host, h))) out.add('billing')
    if (KEY_HOSTS.some(h => hostMatches(host, h)) && WRITE_METHODS.has(method)) out.add('keys')
    if (SECRET_STORE_HOSTS.some(h => hostMatches(host, h))) out.add('secret_values')
    if (DNS_HOST_PATHS.some(r => hostMatches(host, r.host) && segs.includes(r.segment))) out.add('dns_access')
  }
  if (segs.some(s => DNS_SEGMENTS.has(s))) out.add('dns_access')
  if (segs.some(s => BILLING_SEGMENTS.has(s))) out.add('billing')
  // Minting and revoking are writes. An OAuth token exchange is how a call
  // signs in, not a key being minted, so /oauth/token style paths are left out.
  const oauth = segs.some(s => s === 'oauth' || s === 'oauth2' || s === 'openid-connect')
  if (WRITE_METHODS.has(method) && !oauth && segs.some(s => KEY_SEGMENTS.has(s))) out.add('keys')

  if (names.some(n => DNS_SECRET.test(n))) out.add('dns_access')
  if (names.some(n => BILLING_SECRET.test(n))) out.add('billing')

  if (call.connector) {
    const ids = [call.connector.slug, call.connector.name, call.connector.catalogId].map(v => (v ?? '').toLowerCase()).filter(Boolean)
    const chost = (call.connector.host ?? '').toLowerCase()
    const has = (list: string[]) => ids.some(id => list.some(x => id.includes(x)))
    if (has(DNS_CONNECTORS) || (chost && DNS_HOSTS.some(h => hostMatches(chost, h)))) out.add('dns_access')
    if (has(BILLING_CONNECTORS) || (chost && BILLING_HOSTS.some(h => hostMatches(chost, h)))) out.add('billing')
    if (has(SECRET_STORE_CONNECTORS) || (chost && SECRET_STORE_HOSTS.some(h => hostMatches(chost, h)))) out.add('secret_values')
  }
  const tool = call.tool ?? ''
  if (tool) {
    if (DNS_TOOL.test(tool)) out.add('dns_access')
    if (BILLING_TOOL.test(tool)) out.add('billing')
    if (KEY_TOOL.test(tool)) out.add('keys')
    if (SECRET_TOOL.test(tool)) out.add('secret_values')
  }
  return [...out]
}

export interface ExclusionGateInput {
  slug: string
  botName?: string
  workspace: string
  userId?: number | null
  call: OutboundCall
  now?: Date
}

/**
 * The gate both outward doors call before anything is sent.
 *
 * Returns null when the call may go ahead: the bot has no Full access in this
 * workspace (this file does not apply to it), or the call falls under no
 * exclusion, or the only exclusion it falls under is billing and that switch is on.
 *
 * Otherwise returns the refusal text, with the refusal ALREADY written to the
 * audit log (one row per exclusion that was off).
 */
export function exclusionGate(input: ExclusionGateInput): string | null {
  const now = input.now ?? new Date()
  if (!input.workspace || !fullAccessActive(input.slug, input.workspace, now)) return null
  const blocked = classifyOutbound(input.call).filter(x => !exclusionAllowed(input.slug, input.workspace, x, now))
  if (blocked.length === 0) return null
  const messages = blocked.map(x =>
    refuseExclusion({ slug: input.slug, botName: input.botName, workspace: input.workspace, exclusion: x, what: input.call.what, actorUserId: input.userId ?? null }),
  )
  return messages[0]
}
