/**
 * okit Tool runner for workflow `tool` nodes (obj 900911, systems audit #4).
 *
 * The flow engine (flow-engine.ts) resolves a `tool` node's slug through a
 * FlowToolRegistry. Until this module, nothing outside tests ever called
 * registerFlowTool(), so in production every `tool` node failed `unknown_tool`.
 * startFlowEngine() now calls {@link startOkitFlowToolRunner} BEFORE its first
 * (resume-on-boot) tick, which scans the okit Tools layer
 * (`<AI_WORKSPACE_DIR>/tools/<slug>/TOOL.md`) and registers every Tool that
 * declares how to execute it.
 *
 * ## The execution contract (`run:` in TOOL.md frontmatter)
 *
 * Most TOOL.md files are connection facts for an agent to read. A Tool is
 * callable from a workflow only when its frontmatter also carries a `run:` block:
 *
 * ```yaml
 * effect: read            # read | write | send | spend. Missing ⇒ the engine treats it as `send`.
 * idempotent: true        # ONLY a literal `true` lets the engine re-run an in-flight send/spend.
 * auth:
 *   secrets:
 *     - env: ACME_API_KEY # secret NAME only; resolved from the run's workspace at call time
 * run:
 *   type: http
 *   method: POST
 *   url: https://api.acme.com/v1/contacts/{contact_id}   # {x} ← input.x, URL-encoded
 *   headers: { Authorization: "Bearer ${ACME_API_KEY}" } # ${NAME} must be a declared secret
 *   timeout_ms: 30000
 * # or
 * run:
 *   type: script
 *   command: run.mjs      # a file INSIDE the tool dir (realpath-contained), executed without a shell
 *   args: ["--json"]      # fixed strings, never templated
 * ```
 *
 * A script gets `{input, context}` as JSON on stdin and must print JSON on
 * stdout. It runs with a MINIMAL env (PATH/LANG + its declared secrets +
 * CC_FLOW_* ids) — never the server's own environment, which holds every
 * install credential.
 *
 * ## Gates (all checked before the call goes out, via FlowTool.refuse)
 *
 *  - `settings.flows_enabled` ≠ '1' ⇒ `flows_disabled` (the engine already refuses
 *    to start/claim runs; this also stops a run that was mid-flight when the
 *    switch flipped).
 *  - The Tool is not enabled for the run's workspace (`flow_workspace_tools`) ⇒
 *    `tool_disabled`. Fail closed: a new Tool runs nowhere until an owner/admin
 *    enables it per workspace (PUT /api/flows/tools/:slug/enabled).
 *
 * Send/spend approval and unknown-outcome-on-crash are NOT re-implemented here:
 * the engine owns them and reads this Tool's `effect` and `idempotent` flags
 * (flow-engine.ts `effectOf` / `retrySafe`), exactly as for any FlowTool.
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { parse as parseYaml } from 'yaml'
import type Database from 'better-sqlite3'
import { FLOW_EFFECTS, type FlowEffect } from '../../../shared/flow/types.js'
import {
  FlowStepError, flowsEnabled, getRegisteredFlowTool, registerFlowTool, unregisterFlowTool,
  type FlowTool, type FlowToolContext,
} from './flow-engine.js'

// ── definitions ─────────────────────────────────────────────────────────────

/** Same slug rule okit and internal-operationkit.ts use. */
const TOOL_SLUG_RE = /^[a-z0-9_]+(-[a-z0-9_]+)*$/
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
type HttpMethod = (typeof HTTP_METHODS)[number]
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 10 * 60_000
/** Response/stdout cap. Step output is stored in SQLite and shown in the viewer. */
export const OKIT_TOOL_MAX_OUTPUT_BYTES = 1024 * 1024
const STDERR_TAIL_CHARS = 2000
const TOOL_MD_MAX_BYTES = 256 * 1024
export const OKIT_TOOL_RESCAN_MS = 5 * 60_000

export interface OkitHttpRun {
  type: 'http'
  method: HttpMethod
  url: string
  headers: Record<string, string>
  timeoutMs: number
}

export interface OkitScriptRun {
  type: 'script'
  /** Absolute, realpath-resolved, inside the tool dir. */
  command: string
  args: string[]
  timeoutMs: number
}

export interface OkitToolDef {
  slug: string
  description?: string
  effect?: FlowEffect
  idempotent: boolean
  /** Declared secret NAMES (auth.secrets[].env). Values are resolved per call, per workspace. */
  secrets: string[]
  run: OkitHttpRun | OkitScriptRun
  dir: string
}

export type ParseResult = { ok: true; def: OkitToolDef } | { ok: false; reason: string }

/** Pull the YAML frontmatter out of a TOOL.md. */
export function readFrontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text)
  if (!m) return null
  const fm = parseYaml(m[1])
  return fm && typeof fm === 'object' && !Array.isArray(fm) ? (fm as Record<string, unknown>) : null
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

/**
 * Validate one Tool's frontmatter into an executable definition. Pure except for
 * the realpath check of a script command.
 */
export function parseOkitTool(
  slug: string,
  fm: Record<string, unknown>,
  dir: string,
  opts: { allowHttpLoopback?: boolean } = {},
): ParseResult {
  if (!TOOL_SLUG_RE.test(slug)) return { ok: false, reason: 'slug is not a valid okit slug' }
  if (fm.name !== undefined && fm.name !== slug) return { ok: false, reason: `frontmatter name "${String(fm.name)}" does not match its directory` }
  const run = fm.run
  if (run === undefined || run === null) return { ok: false, reason: 'no run block (documentation-only Tool)' }
  if (typeof run !== 'object' || Array.isArray(run)) return { ok: false, reason: 'run must be a mapping' }
  const r = run as Record<string, unknown>

  let effect: FlowEffect | undefined
  if (fm.effect !== undefined) {
    if (typeof fm.effect !== 'string' || !(FLOW_EFFECTS as readonly string[]).includes(fm.effect)) {
      return { ok: false, reason: `effect must be one of ${FLOW_EFFECTS.join(', ')}` }
    }
    effect = fm.effect as FlowEffect
  }

  const secrets: string[] = []
  const auth = fm.auth as { secrets?: unknown } | undefined
  if (auth && Array.isArray(auth.secrets)) {
    for (const s of auth.secrets) {
      const env = (s as { env?: unknown } | null)?.env
      if (typeof env !== 'string' || !SECRET_NAME_RE.test(env)) return { ok: false, reason: 'auth.secrets[].env must be an UPPER_SNAKE_CASE name' }
      if (!secrets.includes(env)) secrets.push(env)
    }
  }

  const rawTimeout = r.timeout_ms
  let timeoutMs = DEFAULT_TIMEOUT_MS
  if (rawTimeout !== undefined) {
    if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) || rawTimeout < 1 || rawTimeout > MAX_TIMEOUT_MS) {
      return { ok: false, reason: `run.timeout_ms must be an integer in 1..${MAX_TIMEOUT_MS}` }
    }
    timeoutMs = rawTimeout
  }

  const description = typeof fm.description === 'string' ? fm.description.slice(0, 300) : undefined
  const base = { slug, ...(description ? { description } : {}), ...(effect ? { effect } : {}), idempotent: fm.idempotent === true, secrets, dir }

  if (r.type === 'http') {
    const method = typeof r.method === 'string' ? r.method.toUpperCase() : 'GET'
    if (!(HTTP_METHODS as readonly string[]).includes(method)) return { ok: false, reason: `run.method must be one of ${HTTP_METHODS.join(', ')}` }
    if (typeof r.url !== 'string') return { ok: false, reason: 'run.url is required' }
    let u: URL
    try { u = new URL(r.url.replace(/\{[a-z_][a-z0-9_]*\}/gi, 'x')) } catch { return { ok: false, reason: 'run.url is not a URL' } }
    const loopbackOk = opts.allowHttpLoopback === true && u.protocol === 'http:' && isLoopbackHost(u.hostname)
    if (u.protocol !== 'https:' && !loopbackOk) return { ok: false, reason: 'run.url must be https://' }
    if (u.username || u.password) return { ok: false, reason: 'run.url must not carry credentials; declare a secret and use a header' }
    // The host is fixed by the Tool author; input may only fill path/query placeholders.
    if (/\{[^}]*\}/.test(r.url.split('/').slice(0, 3).join('/'))) return { ok: false, reason: 'run.url placeholders are allowed in the path and query only' }
    const headers: Record<string, string> = {}
    if (r.headers !== undefined) {
      if (!r.headers || typeof r.headers !== 'object' || Array.isArray(r.headers)) return { ok: false, reason: 'run.headers must be a mapping' }
      for (const [k, v] of Object.entries(r.headers as Record<string, unknown>)) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) return { ok: false, reason: `run.headers: bad header name "${k}"` }
        if (typeof v !== 'string' || /[\r\n]/.test(v)) return { ok: false, reason: `run.headers.${k} must be a single-line string` }
        for (const m of v.matchAll(/\$\{([^}]*)\}/g)) {
          if (!secrets.includes(m[1])) return { ok: false, reason: `run.headers.${k} references \${${m[1]}}, which is not declared in auth.secrets` }
        }
        headers[k] = v
      }
    }
    return { ok: true, def: { ...base, run: { type: 'http', method: method as HttpMethod, url: r.url, headers, timeoutMs } } }
  }

  if (r.type === 'script') {
    if (typeof r.command !== 'string' || !r.command.trim()) return { ok: false, reason: 'run.command is required' }
    if (path.isAbsolute(r.command)) return { ok: false, reason: 'run.command must be a path inside the tool directory' }
    let realDir: string
    let realCmd: string
    try {
      realDir = fs.realpathSync(dir)
      realCmd = fs.realpathSync(path.join(dir, r.command))
    } catch {
      return { ok: false, reason: `run.command "${r.command}" does not exist` }
    }
    if (!realCmd.startsWith(realDir + path.sep)) return { ok: false, reason: 'run.command resolves outside the tool directory' }
    try {
      if (!fs.statSync(realCmd).isFile()) return { ok: false, reason: 'run.command is not a file' }
      fs.accessSync(realCmd, fs.constants.X_OK)
    } catch {
      return { ok: false, reason: 'run.command is not executable' }
    }
    const args = r.args === undefined ? [] : r.args
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string') || args.length > 32) {
      return { ok: false, reason: 'run.args must be a list of at most 32 strings' }
    }
    return { ok: true, def: { ...base, run: { type: 'script', command: realCmd, args: args as string[], timeoutMs } } }
  }

  return { ok: false, reason: 'run.type must be http or script' }
}

export interface LoadedOkitTools {
  tools: OkitToolDef[]
  /** Tools with a `run:` block that did not validate. Documentation-only Tools are not listed. */
  invalid: { slug: string; reason: string }[]
  /** The tools dir did not exist / could not be read. */
  missing: boolean
}

/** Scan `<toolsDir>/<slug>/TOOL.md` (one level, like okit) for executable Tools. */
export function loadOkitTools(toolsDir: string, opts: { allowHttpLoopback?: boolean } = {}): LoadedOkitTools {
  const out: LoadedOkitTools = { tools: [], invalid: [], missing: false }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(toolsDir, { withFileTypes: true })
  } catch {
    out.missing = true
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('_')) continue
    const dir = path.join(toolsDir, e.name)
    const file = path.join(dir, 'TOOL.md')
    let text: string
    try {
      if (fs.statSync(file).size > TOOL_MD_MAX_BYTES) { out.invalid.push({ slug: e.name, reason: 'TOOL.md is too large' }); continue }
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let fm: Record<string, unknown> | null
    try {
      fm = readFrontmatter(text)
    } catch (err) {
      out.invalid.push({ slug: e.name, reason: `frontmatter is not valid YAML: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` })
      continue
    }
    if (!fm || fm.run === undefined) continue // documentation-only Tool — not an error
    const r = parseOkitTool(e.name, fm, dir, opts)
    if (r.ok) out.tools.push(r.def)
    else out.invalid.push({ slug: e.name, reason: r.reason })
  }
  return out
}

/** Does a node declaring `node` cover a Tool whose class is `tool`? (read < write < send; spend only covers spend.) */
export function effectCovers(node: FlowEffect, tool: FlowEffect): boolean {
  const allowed: Record<FlowEffect, FlowEffect[]> = {
    read: ['read', 'write', 'send', 'spend'],
    write: ['write', 'send', 'spend'],
    send: ['send', 'spend'],
    spend: ['spend'],
  }
  return allowed[tool].includes(node)
}

// ── workspace enablement ────────────────────────────────────────────────────

export function isToolEnabledForWorkspace(db: Database.Database, workspace: string, slug: string): boolean {
  try {
    return !!db.prepare('SELECT 1 FROM flow_workspace_tools WHERE workspace = ? AND tool_slug = ?').get(workspace, slug)
  } catch {
    return false // no table ⇒ nothing enabled (fail closed)
  }
}

export function enabledToolsForWorkspace(db: Database.Database, workspace: string): Set<string> {
  try {
    const rows = db.prepare('SELECT tool_slug FROM flow_workspace_tools WHERE workspace = ?').all(workspace) as { tool_slug: string }[]
    return new Set(rows.map((r) => r.tool_slug))
  } catch {
    return new Set()
  }
}

export function setToolEnabledForWorkspace(db: Database.Database, workspace: string, slug: string, enabled: boolean, by: string): void {
  if (enabled) {
    db.prepare('INSERT OR IGNORE INTO flow_workspace_tools (workspace, tool_slug, enabled_by) VALUES (?, ?, ?)').run(workspace, slug, by)
  } else {
    db.prepare('DELETE FROM flow_workspace_tools WHERE workspace = ? AND tool_slug = ?').run(workspace, slug)
  }
}

// ── the runner ──────────────────────────────────────────────────────────────

/** Resolves the declared secret names for one workspace. Returns only names it found. */
export type OkitSecretResolver = (workspace: string, names: string[]) => Record<string, string> | Promise<Record<string, string>>

export interface OkitRunnerDeps {
  /** DB holding settings + flow_workspace_tools. Default: getDb(), resolved lazily. */
  db?: Database.Database
  secrets?: OkitSecretResolver
  fetch?: typeof fetch
}

async function hostDb(): Promise<Database.Database> {
  const { getDb } = await import('../db/index.js')
  return getDb()
}

/** Workspace-scoped secret resolution, decrypting ONLY the declared names (secrets-store keyFilter). */
const hostSecretResolver: OkitSecretResolver = async (workspace, names) => {
  if (!names.length) return {}
  const { resolveSecrets } = await import('./secrets-store.js')
  const wanted = new Set(names)
  return resolveSecrets({ workspace, keyFilter: (k) => wanted.has(k) })
}

/** Replace every declared secret value in text, so stderr/body echoes never reach a stored row. */
function scrub(text: string, values: string[]): string {
  let out = text
  for (const v of values) if (v && v.length >= 4) out = out.split(v).join('[REDACTED]')
  return out
}

/** `{name}` placeholders in the URL ← input.name (URL-encoded); returns the URL and the input keys it used. */
export function fillUrl(template: string, input: Record<string, unknown>, slug: string): { url: string; used: Set<string> } {
  const used = new Set<string>()
  const url = template.replace(/\{([a-z_][a-z0-9_]*)\}/gi, (_m, name: string) => {
    const v = input[name]
    if (v === undefined || v === null || typeof v === 'object') {
      throw new FlowStepError('tool_input_invalid', `Tool "${slug}" needs input.${name} (a string or number) for its URL`, false)
    }
    used.add(name)
    return encodeURIComponent(String(v))
  })
  return { url, used }
}

function combinedSignal(outer: AbortSignal, timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const c = new AbortController()
  const onAbort = () => c.abort()
  if (outer.aborted) c.abort()
  else outer.addEventListener('abort', onAbort, { once: true })
  const t = setTimeout(() => c.abort(), timeoutMs)
  t.unref?.()
  return { signal: c.signal, done: () => { clearTimeout(t); outer.removeEventListener('abort', onAbort) } }
}

async function readCapped(res: Response, slug: string): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > OKIT_TOOL_MAX_OUTPUT_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new FlowStepError('tool_output_too_large', `Tool "${slug}" returned more than ${OKIT_TOOL_MAX_OUTPUT_BYTES} bytes`, false)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function runHttp(def: OkitToolDef, run: OkitHttpRun, input: unknown, ctx: FlowToolContext, secrets: Record<string, string>, f: typeof fetch): Promise<unknown> {
  const obj = (input && typeof input === 'object' && !Array.isArray(input) ? input : {}) as Record<string, unknown>
  const { url: filled, used } = fillUrl(run.url, obj, def.slug)
  const rest = Object.fromEntries(Object.entries(obj).filter(([k]) => !used.has(k)))
  const url = new URL(filled)
  const headers: Record<string, string> = { Accept: 'application/json' }
  for (const [k, v] of Object.entries(run.headers)) {
    headers[k] = v.replace(/\$\{([^}]*)\}/g, (_m, name: string) => {
      const value = secrets[name]
      if (!value) throw new FlowStepError('tool_secret_missing', `Tool "${def.slug}" needs secret ${name}, which is not set for workspace "${ctx.workspace}"`, false)
      return value
    })
  }
  if (ctx.idempotencyKey) headers['Idempotency-Key'] = ctx.idempotencyKey
  let body: string | undefined
  if (run.method === 'GET' || run.method === 'DELETE') {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
  } else {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(Array.isArray(input) ? input : rest)
  }

  const { signal, done } = combinedSignal(ctx.signal, run.timeoutMs)
  try {
    let res: Response
    try {
      // redirect: 'manual' — never forward the Tool's credentials to a host its author did not name.
      res = await f(url, { method: run.method, headers, body, signal, redirect: 'manual' })
    } catch (err) {
      if (signal.aborted) throw new FlowStepError('tool_timeout', `Tool "${def.slug}" did not answer within ${run.timeoutMs} ms`, true)
      throw new FlowStepError('tool_unreachable', `Tool "${def.slug}" request failed: ${err instanceof Error ? err.message : String(err)}`, true)
    }
    const text = scrub(await readCapped(res, def.slug), Object.values(secrets))
    let parsed: unknown = text
    if (text && /json/i.test(res.headers.get('content-type') ?? '')) {
      try { parsed = JSON.parse(text) } catch { /* keep the text */ }
    }
    if (res.status >= 300) {
      const retryable = res.status === 429 || res.status >= 500
      const err = new FlowStepError(`http_${res.status}`, `Tool "${def.slug}" answered HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`, retryable)
      throw err
    }
    return { status: res.status, body: parsed }
  } finally {
    done()
  }
}

/** sysexits(3) usage/config errors are not transient; EX_TEMPFAIL (75) is. 126/127 = definition rot. */
function scriptExitRetryable(code: number): boolean {
  if (code === 75) return true
  if (code === 126 || code === 127) return false
  if (code >= 64 && code <= 78) return false
  return true
}

function runScript(def: OkitToolDef, run: OkitScriptRun, input: unknown, ctx: FlowToolContext, secrets: Record<string, string>): Promise<unknown> {
  // A MINIMAL environment: the server's own env holds every install credential.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    LANG: process.env.LANG ?? 'C.UTF-8',
    ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    ...secrets,
    CC_FLOW_RUN_ID: String(ctx.runId),
    CC_FLOW_NODE_ID: ctx.nodeId,
    CC_FLOW_WORKSPACE: ctx.workspace,
    CC_FLOW_ATTEMPT: String(ctx.attempt),
    ...(ctx.idempotencyKey ? { CC_FLOW_IDEMPOTENCY_KEY: ctx.idempotencyKey } : {}),
  }
  const secretValues = Object.values(secrets)
  return new Promise((resolve, reject) => {
    const { signal, done } = combinedSignal(ctx.signal, run.timeoutMs)
    let settled = false
    const finish = (fn: () => void) => { if (!settled) { settled = true; done(); fn() } }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(run.command, run.args, { cwd: def.dir, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    } catch (err) {
      const e = new FlowStepError('tool_definition_rot', `Tool "${def.slug}" could not start: ${err instanceof Error ? err.message : String(err)}`, false)
      reject(Object.assign(e, { code: (err as { code?: string }).code ?? 'ENOENT' }))
      return
    }
    const out: Buffer[] = []
    let outBytes = 0
    let errTail = ''
    let tooLarge = false
    child.stdout!.on('data', (b: Buffer) => {
      outBytes += b.byteLength
      if (outBytes > OKIT_TOOL_MAX_OUTPUT_BYTES) { tooLarge = true; child.kill('SIGKILL'); return }
      out.push(b)
    })
    child.stderr!.on('data', (b: Buffer) => { errTail = (errTail + b.toString('utf8')).slice(-STDERR_TAIL_CHARS) })
    const onAbort = () => {
      child.kill('SIGTERM')
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL') }, 2000).unref?.()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err: NodeJS.ErrnoException) => finish(() => {
      const e = new FlowStepError('tool_definition_rot', `Tool "${def.slug}" could not start: ${err.message}`, false)
      reject(Object.assign(e, { code: err.code ?? 'ENOENT' }))
    }))
    child.on('close', (code, sig) => finish(() => {
      signal.removeEventListener('abort', onAbort)
      const stderr = scrub(errTail.trim(), secretValues)
      if (tooLarge) return reject(new FlowStepError('tool_output_too_large', `Tool "${def.slug}" printed more than ${OKIT_TOOL_MAX_OUTPUT_BYTES} bytes`, false))
      if (signal.aborted) return reject(new FlowStepError('tool_timeout', `Tool "${def.slug}" did not finish within ${run.timeoutMs} ms`, true))
      if (code !== 0) {
        const exit = code ?? -1
        const type = exit === 126 || exit === 127 ? 'tool_definition_rot' : 'tool_script_failed'
        const e = new FlowStepError(type, `Tool "${def.slug}" exited ${code ?? sig}${stderr ? `: ${stderr.slice(-500)}` : ''}`, scriptExitRetryable(exit))
        return reject(Object.assign(e, { exit_code: exit }))
      }
      const text = scrub(Buffer.concat(out).toString('utf8').trim(), secretValues)
      if (!text) return resolve(null)
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new FlowStepError('tool_output_invalid', `Tool "${def.slug}" must print JSON on stdout`, false))
      }
    }))
    child.stdin!.on('error', () => undefined) // a script that ignores stdin closes the pipe early
    child.stdin!.end(JSON.stringify({
      input: input ?? null,
      context: { run_id: ctx.runId, node_id: ctx.nodeId, workspace: ctx.workspace, attempt: ctx.attempt, idempotency_key: ctx.idempotencyKey },
    }))
  })
}

/** Build the FlowTool the engine calls for one okit Tool. */
export function createOkitFlowTool(def: OkitToolDef, deps: OkitRunnerDeps = {}): FlowTool & { okit: OkitToolDef } {
  const f = deps.fetch ?? globalThis.fetch
  const resolveSecrets = deps.secrets ?? hostSecretResolver
  let db: Database.Database | null = deps.db ?? null
  const dbNow = (): Database.Database | null => db
  return {
    okit: def,
    ...(def.effect ? { effect: def.effect } : {}),
    idempotent: def.idempotent,
    meta: { ...(def.description ? { description: def.description } : {}), source: 'okit', runner: def.run.type },
    refuse({ workspace, effect }) {
      const d = dbNow()
      if (!d) return { type: 'tool_disabled', title: `Tool "${def.slug}" cannot check whether workspace "${workspace}" enabled it` }
      if (!flowsEnabled(d)) {
        return { type: 'flows_disabled', title: `Workflows are switched off on this install (settings.flows_enabled), so Tool "${def.slug}" was not called` }
      }
      // A node's own `effect` wins in the engine, so a node must not label a send/spend
      // Tool as read/write: that would skip the publish approval and turn a crash into
      // a silent re-send. Undeclared Tool effect = send (the engine's rule).
      const declared = def.effect ?? 'send'
      if (effect && !effectCovers(effect, declared)) {
        return {
          type: 'tool_effect_mismatch',
          title: `Tool "${def.slug}" is a ${declared} Tool, but this node declares effect "${effect}". Set the node's effect to ${declared} (or remove it) so the approval and crash rules apply.`,
        }
      }
      if (!isToolEnabledForWorkspace(d, workspace, def.slug)) {
        return {
          type: 'tool_disabled',
          title: `Tool "${def.slug}" is not enabled for workspace "${workspace}". An owner/admin can enable it in Jobs → Workflows → Tools.`,
        }
      }
      return null
    },
    async run(input, ctx) {
      if (!db) db = await hostDb()
      // Re-checked at call time: refuse() ran before the row, but this keeps the
      // gate on the run() path too (e.g. an llm tool loop calling a read Tool).
      const refused = this.refuse!({ workspace: ctx.workspace, runId: ctx.runId, nodeId: ctx.nodeId, effect: def.effect ?? 'send' })
      if (refused) throw new FlowStepError(refused.type, refused.title, false)
      const secrets = def.secrets.length ? await resolveSecrets(ctx.workspace, def.secrets) : {}
      const scoped: Record<string, string> = {}
      for (const n of def.secrets) if (typeof secrets[n] === 'string' && secrets[n]) scoped[n] = secrets[n]
      return def.run.type === 'http'
        ? runHttp(def, def.run, input, ctx, scoped, f)
        : runScript(def, def.run, input, ctx, scoped)
    },
  }
}

// ── registration (production startup) ───────────────────────────────────────

export interface OkitFlowToolOptions extends OkitRunnerDeps {
  /** Default: `$OKIT_TOOLS_DIR`, else `<AI_WORKSPACE_DIR>/tools`. */
  toolsDir?: string
  /** Test fixtures only: allow `http://127.0.0.1` URLs. Production never sets it. */
  allowHttpLoopback?: boolean
  /** Re-scan interval; 0 = no timer. Default {@link OKIT_TOOL_RESCAN_MS}. */
  rescanMs?: number
}

export interface OkitRegistrationReport {
  toolsDir: string
  registered: string[]
  removed: string[]
  invalid: { slug: string; reason: string }[]
  /** Slugs already registered by something other than this runner; left untouched. */
  shadowed: string[]
  missing: boolean
}

/** Slugs this runner owns in the engine's registry (so a re-scan can drop removed Tools). */
const owned = new Set<string>()
let rescanTimer: ReturnType<typeof setInterval> | null = null
let lastReport: OkitRegistrationReport | null = null

export async function defaultOkitToolsDir(): Promise<string> {
  if (process.env.OKIT_TOOLS_DIR) return process.env.OKIT_TOOLS_DIR
  const { AI_WORKSPACE_DIR } = await import('../config.js')
  return path.join(AI_WORKSPACE_DIR, 'tools')
}

/** Scan the okit Tools dir and (re)register every executable Tool with the flow engine. */
export async function registerOkitFlowTools(opts: OkitFlowToolOptions = {}): Promise<OkitRegistrationReport> {
  const toolsDir = opts.toolsDir ?? (await defaultOkitToolsDir())
  const loaded = loadOkitTools(toolsDir, { allowHttpLoopback: opts.allowHttpLoopback })
  const report: OkitRegistrationReport = { toolsDir, registered: [], removed: [], invalid: loaded.invalid, shadowed: [], missing: loaded.missing }
  const seen = new Set<string>()
  // Resolve the DB once, up front: refuse() is synchronous and runs before the call.
  const deps: OkitRunnerDeps = { ...opts, db: opts.db ?? (loaded.tools.length ? await hostDb() : undefined) }
  for (const def of loaded.tools) {
    const existing = getRegisteredFlowTool(def.slug)
    if (existing && !owned.has(def.slug)) { report.shadowed.push(def.slug); continue }
    registerFlowTool(def.slug, createOkitFlowTool(def, deps))
    owned.add(def.slug)
    seen.add(def.slug)
    report.registered.push(def.slug)
  }
  // A Tool deleted from the registry (or whose run block became invalid) stops being callable.
  for (const slug of [...owned]) {
    if (seen.has(slug)) continue
    unregisterFlowTool(slug)
    owned.delete(slug)
    report.removed.push(slug)
  }
  lastReport = report
  return report
}

export function lastOkitRegistrationReport(): OkitRegistrationReport | null { return lastReport }

/** Called from startFlowEngine(): register now, then re-scan so a new Tool appears without a restart. */
export async function startOkitFlowToolRunner(opts: OkitFlowToolOptions = {}): Promise<OkitRegistrationReport> {
  const report = await registerOkitFlowTools(opts)
  const where = report.missing ? `${report.toolsDir} (not found)` : report.toolsDir
  console.log(`[flows] okit tool runner: ${report.registered.length} tool(s) registered from ${where}` +
    (report.invalid.length ? `; ${report.invalid.length} invalid: ${report.invalid.map((i) => `${i.slug} (${i.reason})`).join('; ')}` : '') +
    (report.shadowed.length ? `; shadowed: ${report.shadowed.join(', ')}` : ''))
  const every = opts.rescanMs ?? OKIT_TOOL_RESCAN_MS
  if (rescanTimer) clearInterval(rescanTimer)
  rescanTimer = null
  if (every > 0) {
    rescanTimer = setInterval(() => {
      registerOkitFlowTools(opts).catch((err) => console.error('[flows] okit tool re-scan failed:', err))
    }, every)
    rescanTimer.unref?.()
  }
  return report
}

/** Stop re-scanning and drop every Tool this runner registered. */
export function stopOkitFlowToolRunner(): void {
  if (rescanTimer) clearInterval(rescanTimer)
  rescanTimer = null
  for (const slug of owned) unregisterFlowTool(slug)
  owned.clear()
  lastReport = null
}
