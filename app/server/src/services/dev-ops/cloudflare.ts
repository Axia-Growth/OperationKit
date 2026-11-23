/**
 * Operation Kit Dev: Cloudflare Access and DNS (obj 901424, scope 4).
 *
 * Runs through the install's EXISTING Cloudflare integration on the host: the
 * installer's API token file and install/cloudflare.sh, via host-runner.sh. The
 * token never enters this process.
 *
 * Hard guards, checked here BEFORE the host is touched and again in the runner:
 *  - Access: one exact email address per call. Never a domain rule, never a
 *    wildcard, never "everyone". `ACCESS_ALLOWED_EMAIL_DOMAIN` stays as the
 *    owner left it (empty): no tool writes a domain allow, for any domain.
 *  - Access: a protected address is never removed. Protected = the owner's two
 *    sign-in addresses (the seed below, held as SHA-256 hashes), the installer's
 *    list (OK_CF_ACCESS_PROTECTED_EMAILS), the setting
 *    `dev_ops_protected_access_emails`, every admin user's email, the owner's
 *    address held server-side in EMAILGUARD_EMAIL, and any extra hash in
 *    CC_DEV_OPS_PROTECTED_SHA256. Configuration can only ADD to this. The
 *    protected list is never returned to the bot: a refusal only says
 *    "protected".
 *
 * Why hashes for the seed: the live host runs the PUBLISHED tree, and the OSS
 * publish rewrites personal domains (scripts/oss-genericize.sh), so a plain
 * address in this file would protect the WRONG address on the live host — and
 * it would publish the owner's address. A SHA-256 of the lower-cased address
 * survives the publish unchanged and names nobody.
 *  - Access: a write adds or drops that one entry; the runner checks every other
 *    entry is still there afterwards (no side-effect drops).
 *  - DNS: only inside the install's ZONE, never the install's own DOMAIN record,
 *    only A / AAAA / CNAME / TXT / MX, values shape-checked, and a change or
 *    delete must match exactly one record.
 *  - install/cloudflare.sh: only `status`, `api-bypass`, `api-bic` (idempotent
 *    reconciles). Never `down`, never `up --replace-dns`, never `agent-pass add`.
 */
import { createHash } from 'crypto'
import { getDb } from '../../db/index.js'
import { writeDevOpsAudit } from './audit.js'
import { devOpsHostConfig, parseRunnerJson, runOnHost } from './host-exec.js'
import type { DevActor } from './merge.js'

/**
 * Always protected, whatever the configuration says: SHA-256 of the lower-cased
 * address, for the owner's two Access sign-in addresses (obj 901424). See the
 * header for why these are hashes. host-runner.sh carries the same two values.
 */
export const ACCESS_PROTECTED_SEED_SHA256: readonly string[] = Object.freeze([
  '4dbf772d2cbb322b1e9f8e01905405fba1008e5b95a605ea339597e960161536',
  '7f65a1e471709cd9bf4414ee24a7210e5e692a36be87828edc18de6bf1a1a5f2',
])
export const ACCESS_PROTECTED_SHA256_ENV = 'CC_DEV_OPS_PROTECTED_SHA256'

export function emailSha256(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

/** The seed hashes plus any extra the operator added (never fewer than the seed). */
export function protectedAccessHashes(env: NodeJS.ProcessEnv = process.env): string[] {
  const extra = String(env[ACCESS_PROTECTED_SHA256_ENV] ?? '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => /^[0-9a-f]{64}$/.test(x))
  return [...new Set([...ACCESS_PROTECTED_SEED_SHA256, ...extra])]
}

/** Is this address protected (by plain list or by hash)? */
export function isProtectedAccessEmail(email: string, plain: readonly string[], hashes: readonly string[] = protectedAccessHashes()): boolean {
  const e = email.trim().toLowerCase()
  return plain.includes(e) || hashes.includes(emailSha256(e))
}
export const ACCESS_PROTECTED_SETTING = 'dev_ops_protected_access_emails'
/** The env var whose VALUE is the owner's sign-in address (never logged or returned). */
export const ACCESS_PROTECTED_ENV_NAMES: readonly string[] = ['EMAILGUARD_EMAIL']

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/

export function normaliseAccessEmail(raw: unknown): string | null {
  const e = String(raw ?? '').trim().toLowerCase()
  return EMAIL_RE.test(e) ? e : null
}

const splitEmails = (v: string | null | undefined) =>
  String(v ?? '').split(/[\s,;]+/).map(x => x.trim().toLowerCase()).filter(x => EMAIL_RE.test(x))

/** Every protected address. SERVER-ONLY: never put the result in a tool result, chat or log. */
export function protectedAccessEmails(env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>()
  for (const e of splitEmails(env.OK_CF_ACCESS_PROTECTED_EMAILS)) out.add(e)
  for (const name of ACCESS_PROTECTED_ENV_NAMES) for (const e of splitEmails(env[name])) out.add(e)
  try {
    const db = getDb()
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(ACCESS_PROTECTED_SETTING) as { value?: string } | undefined
    for (const e of splitEmails(row?.value)) out.add(e)
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND email IS NOT NULL").all() as Array<{ email: string | null }>
    for (const a of admins) for (const e of splitEmails(a.email)) out.add(e)
  } catch { /* no DB: the seed + env still apply */ }
  return [...out]
}

export type AccessAction = 'list' | 'add' | 'remove'

export interface GuardRefusal {
  ok: false
  code: string
  message: string
}

/**
 * The Access guard. Pure. `raw` is whatever the model sent; anything that is
 * not exactly one email address (a domain, `@domain`, `*@domain`, `everyone`,
 * a list) is refused.
 */
export function accessGuard(
  action: AccessAction,
  raw: unknown,
  protectedList: readonly string[],
  protectedHashes: readonly string[] = protectedAccessHashes(),
): GuardRefusal | { ok: true; email: string | null } {
  if (action === 'list') return { ok: true, email: null }
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, code: 'bad_email', message: 'Give one exact email address.' }
  if (/[*\s,;]/.test(text) || text.startsWith('@') || !text.includes('@') || /^everyone$/i.test(text)) {
    return {
      ok: false,
      code: action === 'add' ? 'domain_allow_refused' : 'bad_email',
      message: action === 'add'
        ? 'Only one exact email address can be allowed. A domain, wildcard or "everyone" allow is never added.'
        : 'Give one exact email address.',
    }
  }
  const email = normaliseAccessEmail(text)
  if (!email) return { ok: false, code: 'bad_email', message: 'That is not a valid email address.' }
  if (action === 'remove' && isProtectedAccessEmail(email, protectedList, protectedHashes)) {
    return { ok: false, code: 'protected', message: `${email} is a protected address and is never removed from Access.` }
  }
  return { ok: true, email }
}

export type DnsAction = 'list' | 'upsert' | 'delete'
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX'] as const

export interface DnsRequest {
  action: DnsAction
  type?: string
  name?: string
  content?: string
  proxied?: boolean
  ttl?: number
  priority?: number
}

export interface DnsZoneInfo {
  /** The install's zone (client.conf ZONE), lower-case; null when unknown here. */
  zone: string | null
  /** The install's own record (client.conf DOMAIN / OK_DOMAIN). */
  domain: string | null
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/
const IPV6 = /^[0-9a-f:]+$/i

/** The DNS guard. Pure. The runner re-checks zone and own-record against client.conf. */
export function dnsGuard(req: DnsRequest, info: DnsZoneInfo): GuardRefusal | { ok: true; request: Required<Pick<DnsRequest, 'action'>> & DnsRequest } {
  if (req.action === 'list') {
    const name = req.name ? String(req.name).trim().toLowerCase().replace(/\.$/, '') : undefined
    if (name && !HOST_RE.test(name)) return { ok: false, code: 'bad_name', message: 'That is not a valid DNS name.' }
    return { ok: true, request: { action: 'list', name } }
  }
  const type = String(req.type ?? '').trim().toUpperCase()
  if (!(DNS_TYPES as readonly string[]).includes(type)) {
    return { ok: false, code: 'bad_type', message: `Only ${DNS_TYPES.join(', ')} records may be changed.` }
  }
  const name = String(req.name ?? '').trim().toLowerCase().replace(/\.$/, '')
  if (!HOST_RE.test(name)) return { ok: false, code: 'bad_name', message: 'Give the full record name, e.g. mail.example.com.' }
  if (info.zone && name !== info.zone && !name.endsWith(`.${info.zone}`)) {
    return { ok: false, code: 'outside_zone', message: `The name must be inside ${info.zone}.` }
  }
  if (info.domain && name === info.domain) {
    return { ok: false, code: 'own_record', message: `${info.domain} is this install's own record; install/cloudflare.sh manages it.` }
  }
  const content = req.content == null ? '' : String(req.content).trim()
  if (req.action === 'upsert') {
    if (!content) return { ok: false, code: 'bad_content', message: 'content is required.' }
    if (type === 'A' && !IPV4.test(content)) return { ok: false, code: 'bad_content', message: 'An A record needs an IPv4 address.' }
    if (type === 'AAAA' && !(IPV6.test(content) && content.includes(':'))) return { ok: false, code: 'bad_content', message: 'An AAAA record needs an IPv6 address.' }
    if ((type === 'CNAME' || type === 'MX') && !HOST_RE.test(content.toLowerCase().replace(/\.$/, ''))) {
      return { ok: false, code: 'bad_content', message: `A ${type} record needs a host name.` }
    }
    if (type === 'TXT' && content.length > 2048) return { ok: false, code: 'bad_content', message: 'TXT content is too long.' }
    const ttl = req.ttl == null ? 1 : Number(req.ttl)
    if (!Number.isInteger(ttl) || !(ttl === 1 || (ttl >= 60 && ttl <= 86400))) return { ok: false, code: 'bad_ttl', message: 'ttl is 1 (automatic) or 60-86400 seconds.' }
    const priority = req.priority == null ? 10 : Number(req.priority)
    if (!Number.isInteger(priority) || priority < 0 || priority > 65535) return { ok: false, code: 'bad_priority', message: 'priority is 0-65535.' }
    return { ok: true, request: { action: 'upsert', type, name, content, proxied: req.proxied === true, ttl, priority } }
  }
  if (req.action === 'delete') return { ok: true, request: { action: 'delete', type, name, content: content || undefined } }
  return { ok: false, code: 'bad_action', message: 'action must be list, upsert or delete.' }
}

/** Zone/domain as this container knows them (the runner re-reads client.conf on the host). */
export function dnsZoneInfo(env: NodeJS.ProcessEnv = process.env): DnsZoneInfo {
  const domain = String(env.OK_DOMAIN || '').trim().toLowerCase() || null
  const zone = String(env.CC_DEV_OPS_ZONE || '').trim().toLowerCase() || null
  return { zone, domain: domain && domain !== 'localhost' ? domain : null }
}

export const CF_RUN_COMMANDS = ['status', 'api-bypass', 'api-bic'] as const

export interface CfOpResult {
  ok: boolean
  code: string
  message?: string
  [k: string]: unknown
}

async function runCf(op: string, body: Record<string, unknown>): Promise<CfOpResult> {
  const hc = devOpsHostConfig()
  if (!hc.ok && hc.code !== 'no_host_data_path' && hc.code !== 'no_public_url') return { ok: false, code: hc.code, message: hc.error }
  // A Cloudflare call needs only the source + config paths, not the data dir or health URL.
  const srcDir = hc.ok ? hc.config.srcDir : (process.env.CC_DEV_OPS_SRC_DIR || '/opt/operationkit-src')
  const configPath = hc.ok ? hc.config.configPath : (process.env.CC_DEV_OPS_CONFIG || `${srcDir}/client.conf`)
  const image = hc.ok ? hc.config.helperImage : (process.env.CC_DEV_OPS_HELPER_IMAGE || 'operationkit-app:local')
  const r = await runOnHost(image, [op, srcDir, configPath], { stdin: JSON.stringify(body), timeoutMs: op === 'cf-run' ? 300_000 : 90_000 })
  const parsed = parseRunnerJson(r.stdout)
  if (!parsed) {
    return { ok: false, code: 'host_failed', message: `The host runner did not answer (exit ${r.code}).` }
  }
  return { ok: parsed.ok === true, code: String(parsed.code ?? (parsed.ok ? 'ok' : 'failed')), ...parsed } as CfOpResult
}

function auditCf(actor: DevActor, action: string, target: string | null, r: CfOpResult, refused = false): void {
  writeDevOpsAudit({
    bot_slug: actor.botSlug, user_id: actor.userId, username: actor.username, action, target,
    outcome: refused ? 'refused' : r.ok ? 'done' : 'failed', code: r.code,
    detail: r.message ? String(r.message) : null,
  })
}

export async function cloudflareAccess(actor: DevActor, action: AccessAction, email: unknown): Promise<CfOpResult> {
  const prot = protectedAccessEmails()
  const g = accessGuard(action, email, prot)
  const target = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : null
  if (!g.ok) {
    const r: CfOpResult = { ok: false, code: g.code, message: g.message }
    auditCf(actor, `access_${action}`, target, r, true)
    return r
  }
  const r = await runCf(`access-${action}`, action === 'remove' ? { email: g.email, protected: prot, protected_sha256: protectedAccessHashes() } : { email: g.email })
  if (action === 'list' && r.ok) {
    const allow = (r.allow ?? {}) as { emails?: string[]; domains?: string[]; other_rules?: number }
    r.allow = {
      emails: Array.isArray(allow.emails) ? allow.emails : [],
      domains: Array.isArray(allow.domains) ? allow.domains : [],
      other_rules: Number(allow.other_rules ?? 0),
    }
    r.protected_count = prot.length
  }
  auditCf(actor, `access_${action}`, g.email, r)
  return r
}

export async function cloudflareDns(actor: DevActor, req: DnsRequest): Promise<CfOpResult> {
  const g = dnsGuard(req, dnsZoneInfo())
  const target = req.name ? `${String(req.type ?? '').toUpperCase()} ${String(req.name).toLowerCase()}`.trim().slice(0, 300) : null
  if (!g.ok) {
    const r: CfOpResult = { ok: false, code: g.code, message: g.message }
    auditCf(actor, `dns_${req.action}`, target, r, true)
    return r
  }
  const r = await runCf(`dns-${g.request.action}`, { ...g.request })
  auditCf(actor, `dns_${g.request.action}`, target, r)
  return r
}

export async function cloudflareRun(actor: DevActor, command: unknown): Promise<CfOpResult> {
  const cmd = String(command ?? '')
  if (!(CF_RUN_COMMANDS as readonly string[]).includes(cmd)) {
    const r: CfOpResult = { ok: false, code: 'bad_command', message: `Only ${CF_RUN_COMMANDS.join(', ')} may run (never down, never --replace-dns).` }
    auditCf(actor, 'cloudflare_run', cmd.slice(0, 50), r, true)
    return r
  }
  const r = await runCf('cf-run', { command: cmd })
  auditCf(actor, 'cloudflare_run', cmd, r)
  return r
}
