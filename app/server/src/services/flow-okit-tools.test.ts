// okit Tool runner wired into the flow engine (obj 900911, systems audit #4).
//
// Card acceptance, one describe each:
//   1. an integration test boots the REAL registration path (startFlowEngine →
//      startOkitFlowToolRunner → registerFlowTool; no test-only registerFlowTool
//      call) and runs a flow whose tool node calls a real fixture okit Tool
//   2. a non-idempotent Tool in flight at a simulated crash becomes `unknown`
//      and waits for approval
//   3. a disabled Tool, or flows_enabled=false, refuses with a clear error
// (4. retry counters surviving a restart: session-retry-counters.test.ts)
// plus the TOOL.md `run:` contract and the script env / secret handling.
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'
import Database from 'better-sqlite3'
import type { FlowDefinition, FlowNode } from '../../../shared/flow/types.js'
import {
  FlowEngine, FlowStepError, saveFlowVersion, startFlowEngine, stopFlowEngine, defaultFlowToolRegistry,
  listRegisteredFlowTools, getRegisteredFlowTool, flowIdempotencyKey, registerFlowTool, unregisterFlowTool,
} from './flow-engine.js'
import {
  loadOkitTools, parseOkitTool, registerOkitFlowTools, startOkitFlowToolRunner, stopOkitFlowToolRunner,
  setToolEnabledForWorkspace, isToolEnabledForWorkspace, type OkitFlowToolOptions,
} from './flow-okit-tools.js'
import { initFlowSchema } from '../db/schema/flow.js'
import { recordFlowApprovals } from './flow-self-test.js'

vi.mock('node-pty', () => ({ spawn: () => { throw new Error('node-pty is not available in flow-okit-tools tests') } }))

const WS = 'acme'
// Built at runtime so the source holds no key-shaped literal (the OSS gitleaks gate scans tests too).
const SECRET_VALUE = ['fixture', 'cred', String(process.pid), String(Date.now())].join('-')
const LEASE_TTL = 30_000

// ── fixture okit Tools dir ──────────────────────────────────────────────────

/** A temp root where a script can be executed (some sandboxes mount /tmp noexec). */
function execRoot(): string {
  for (const base of [os.tmpdir(), path.join(process.cwd(), 'node_modules', '.cache')]) {
    try {
      fs.mkdirSync(base, { recursive: true })
      const d = fs.mkdtempSync(path.join(base, 'cc-okit-tools-'))
      const probe = path.join(d, 'probe.sh')
      fs.writeFileSync(probe, '#!/bin/sh\n', { mode: 0o755 })
      fs.accessSync(probe, fs.constants.X_OK)
      fs.rmSync(probe)
      return d
    } catch { /* try the next base */ }
  }
  throw new Error('no executable temp dir for the okit script fixtures')
}
const ROOT = execRoot()
const TOOLS = path.join(ROOT, 'tools')
const MARKERS = path.join(ROOT, 'markers')
fs.mkdirSync(TOOLS, { recursive: true })
fs.mkdirSync(MARKERS, { recursive: true })

function writeTool(slug: string, frontmatter: string, files: Record<string, { body: string; mode?: number }> = {}): void {
  const dir = path.join(TOOLS, slug)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'TOOL.md'), `---\n${frontmatter.trim()}\n---\n\n# ${slug}\n`)
  for (const [name, f] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), f.body)
    if (f.mode) fs.chmodSync(path.join(dir, name), f.mode)
  }
}

// A real script Tool: reads {input, context} on stdin, prints JSON. It also
// records each call in a marker file so a test can count real executions, and
// reports which env vars it could see (to prove the env is minimal).
writeTool('rows-count', `
name: rows-count
kind: script
description: Counts the rows it is given. Fixture Tool for the workflow runner test.
effect: read
auth:
  secrets:
    - env: ROWS_API_KEY
run:
  type: script
  command: run.mjs
  args: ["--json"]
  timeout_ms: 20000
`, {
  'run.mjs': {
    mode: 0o755,
    body: `#!/usr/bin/env node
import fs from 'fs'
let raw = ''
process.stdin.on('data', (c) => { raw += c })
process.stdin.on('end', () => {
  const { input, context } = JSON.parse(raw)
  fs.appendFileSync(${JSON.stringify(path.join(MARKERS, 'rows-count.log'))}, context.run_id + '\\n')
  process.stdout.write(JSON.stringify({
    count: (input.rows || []).length,
    argv: process.argv.slice(2),
    workspace: context.workspace,
    env_workspace: process.env.CC_FLOW_WORKSPACE,
    has_key: process.env.ROWS_API_KEY === ${JSON.stringify(SECRET_VALUE)},
    sees_server_secret: Object.prototype.hasOwnProperty.call(process.env, 'JWT_SECRET') || Object.prototype.hasOwnProperty.call(process.env, 'OKIT_FIXTURE_SERVER_ONLY'),
  }))
})
`,
  },
})

// A script that fails with definition rot (127) and one that prints non-JSON.
writeTool('broken-script', `
name: broken-script
description: Exits 127 like a moved runner. Fixture.
effect: read
run:
  type: script
  command: run.sh
`, { 'run.sh': { mode: 0o755, body: '#!/bin/sh\necho "nope: run.sh moved" >&2\nexit 127\n' } })

// Documentation-only Tool (most of the real registry): never registered.
writeTool('docs-only', `
name: docs-only
kind: http-api
description: Connection facts only, no run block.
`)

// A run block that does not validate: logged as invalid, not registered.
writeTool('bad-run', `
name: bad-run
description: Invalid run block. Fixture.
run:
  type: http
  url: http://example.com/x
`)

// ── a local "vendor" HTTP API the http Tools call ───────────────────────────

interface Hit { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }
const hits: Hit[] = []
let holdNext: { entered: () => void; release: Promise<void> } | null = null
const vendor = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', async () => {
    hits.push({ method: req.method!, url: req.url!, headers: req.headers, body })
    const hold = holdNext
    holdNext = null
    if (hold) { hold.entered(); await hold.release }
    if (res.destroyed) return
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, n: hits.length, echo: body ? JSON.parse(body) : null }))
  })
})
await new Promise<void>((r) => vendor.listen(0, '127.0.0.1', () => r()))
const VENDOR = `http://127.0.0.1:${(vendor.address() as { port: number }).port}`

function writeHttpSendTool(slug: string, idempotent: boolean): void {
  writeTool(slug, `
name: ${slug}
kind: http-api
description: Posts a note to the fixture vendor. ${idempotent ? 'Dedupes by Idempotency-Key.' : 'Not idempotent.'}
effect: send
idempotent: ${idempotent}
auth:
  secrets:
    - env: ROWS_API_KEY
run:
  type: http
  method: POST
  url: ${VENDOR}/v1/notes/{channel}
  headers:
    Authorization: "Bearer \${ROWS_API_KEY}"
`)
}
writeHttpSendTool('post-note', false)
writeHttpSendTool('post-note-idem', true)

afterAll(async () => {
  await new Promise<void>((r) => vendor.close(() => r()))
  fs.rmSync(ROOT, { recursive: true, force: true })
})

// ── engine harness (same shape as flow-engine.test.ts) ───────────────────────

let db: Database.Database
let now = Date.parse('2026-11-15T00:00:00.000Z')
const clock = () => now

function freshDb(): Database.Database {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  initFlowSchema(d)
  d.prepare("UPDATE settings SET value = '1' WHERE key = 'flows_enabled'").run()
  return d
}
const setFlowsEnabled = (on: boolean) => db.prepare("UPDATE settings SET value = ? WHERE key = 'flows_enabled'").run(on ? '1' : '0')

const secretsSeen: { workspace: string; names: string[] }[] = []
function okitOpts(extra: Partial<OkitFlowToolOptions> = {}): OkitFlowToolOptions {
  return {
    toolsDir: TOOLS,
    db,
    allowHttpLoopback: true,
    rescanMs: 0,
    // Stands in for the workspace-scoped secrets store (resolveSecrets + keyFilter).
    secrets: (workspace, names): Record<string, string> => {
      secretsSeen.push({ workspace, names })
      return workspace === WS ? { ROWS_API_KEY: SECRET_VALUE } : {}
    },
    ...extra,
  }
}

function hostEngine(owner: string): FlowEngine {
  // The registry the production engine uses — filled only by the okit runner here.
  return new FlowEngine({ db, tools: defaultFlowToolRegistry, clock, owner, leaseTtlMs: LEASE_TTL, heartbeatMs: 60_000 })
}

function flow(nodes: FlowNode[], approvals?: string[]): FlowDefinition {
  return {
    apiVersion: 'okflow/1', id: 'okit-flow', name: 'okit flow', version: 1,
    goal: { statement: 'tool ran', end_condition: { assert: [{ expr: 'true' }] } },
    nodes,
    ...(approvals ? { approvals: { version: 1, nodes: approvals, by: 'user:1', at: '2026-11-15T00:00:00Z' } } : {}),
  }
}

function save(def: FlowDefinition, workspace = WS): number {
  const r = saveFlowVersion(db, { workspace, definition: def, author: 'user:1' })
  if (!r.ok) throw new Error(`save failed: ${r.reason} ${JSON.stringify(r.errors)}`)
  if (def.approvals) recordFlowApprovals(db, r.flowId, def.approvals)
  return r.flowId
}

function start(e: FlowEngine, flowId: number, payload: unknown = {}): number {
  const r = e.startRun({ flowId, version: 1, trigger: { source: 'manual', payload } })
  if (!r.ok) throw new Error(`start failed: ${r.reason}`)
  return r.runId
}

const runRow = (id: number) => db.prepare('SELECT * FROM flow_runs WHERE id = ?').get(id) as Record<string, any>
const steps = (id: number, node: string) =>
  db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ? AND node_id = ? ORDER BY id').all(id, node) as Record<string, any>[]
const markerCalls = () => {
  try { return fs.readFileSync(path.join(MARKERS, 'rows-count.log'), 'utf8').trim().split('\n').filter(Boolean).length } catch { return 0 }
}

const COUNT_FLOW = () => flow([
  { id: 'start', kind: 'trigger', on: 'manual', next: 'count' },
  { id: 'count', kind: 'tool', tool: 'rows-count', effect: 'read', input: { rows: '{{ trigger.payload.rows }}' }, next: 'done' },
  { id: 'done', kind: 'end', output: '{{ steps.count.output }}' },
])

const NOTE_FLOW = (tool: string) => flow([
  { id: 'start', kind: 'trigger', on: 'manual', next: 'note' },
  { id: 'note', kind: 'tool', tool, input: { channel: 'ops team', text: 'hello' }, retry: { max: 3, backoff: 'fixed', delay_ms: 1 }, next: 'done' },
  { id: 'done', kind: 'end', output: '{{ steps.note.output }}' },
], ['note'])

beforeEach(() => {
  db = freshDb()
  hits.length = 0
  holdNext = null
  secretsSeen.length = 0
  fs.rmSync(path.join(MARKERS, 'rows-count.log'), { force: true })
  process.env.OKIT_FIXTURE_SERVER_ONLY = 'server-only-value'
})
afterEach(() => {
  stopFlowEngine()
  stopOkitFlowToolRunner()
  delete process.env.OKIT_FIXTURE_SERVER_ONLY
  db.close()
})

// ── 1. the real registration path ────────────────────────────────────────────

describe('acceptance 1: production startup registers okit Tools and a flow tool node calls one', () => {
  it('startFlowEngine registers the okit runner before its first tick; the flow calls the real script Tool', async () => {
    setToolEnabledForWorkspace(db, WS, 'rows-count', true, 'user:1')
    const flowId = save(COUNT_FLOW())
    const e = hostEngine('host')
    // Queued BEFORE boot: the resume-on-boot tick must already see the Tool.
    const runId = start(e, flowId, { rows: [{ id: 1 }, { id: 2 }, { id: 3 }] })
    expect(getRegisteredFlowTool('rows-count')).toBeNull()

    // The production entry point. No registerFlowTool() call anywhere in this test.
    expect(await startFlowEngine({ scratch: { scratch: false, reason: null }, engine: e, tickMs: 50, okitTools: okitOpts() })).toBe(true)

    await vi.waitFor(() => expect(runRow(runId).status).toBe('succeeded'), { timeout: 15_000, interval: 50 })
    const out = JSON.parse(runRow(runId).output_json)
    expect(out).toEqual({
      count: 3, argv: ['--json'], workspace: WS, env_workspace: WS, has_key: true, sees_server_secret: false,
    })
    expect(markerCalls()).toBe(1)
    // Secrets resolved for the run's workspace, only the declared names.
    expect(secretsSeen).toEqual([{ workspace: WS, names: ['ROWS_API_KEY'] }])
    // The secret value never reaches a stored row.
    const stored = JSON.stringify(db.prepare('SELECT * FROM flow_step_runs WHERE run_id = ?').all(runId))
    expect(stored).not.toContain(SECRET_VALUE)
  })

  it('registers exactly the executable Tools, with their effect and idempotent flags', async () => {
    const report = await startOkitFlowToolRunner(okitOpts())
    expect(report.registered.sort()).toEqual(['broken-script', 'post-note', 'post-note-idem', 'rows-count'])
    expect(report.invalid).toEqual([{ slug: 'bad-run', reason: 'run.url must be https://' }])
    const listed = Object.fromEntries(listRegisteredFlowTools().map((t) => [t.slug, t]))
    expect(listed['rows-count']).toMatchObject({ effect: 'read', idempotent: false, source: 'okit', runner: 'script' })
    expect(listed['post-note']).toMatchObject({ effect: 'send', idempotent: false, runner: 'http' })
    expect(listed['post-note-idem']).toMatchObject({ effect: 'send', idempotent: true })
    expect(listed['docs-only']).toBeUndefined()
  })

  it('an http Tool sends the declared secret as a header, fills the URL from input, and returns the JSON body', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'post-note', true, 'user:1')
    const e = hostEngine('host')
    const runId = start(e, save(NOTE_FLOW('post-note')))
    await e.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ method: 'POST', url: '/v1/notes/ops%20team' })
    expect(hits[0].headers.authorization).toBe(`Bearer ${SECRET_VALUE}`)
    expect(JSON.parse(hits[0].body)).toEqual({ text: 'hello' }) // the URL placeholder is not repeated in the body
    expect(JSON.parse(runRow(runId).output_json)).toMatchObject({ status: 200, body: { ok: true } })
  })

  it('a re-scan drops a Tool removed from the registry, and an in-process Tool is never shadowed', async () => {
    const own = { run: async () => 'mine' }
    registerFlowTool('rows-count', own)
    try {
      const r1 = await registerOkitFlowTools(okitOpts())
      expect(r1.shadowed).toEqual(['rows-count'])
      expect(getRegisteredFlowTool('rows-count')).toBe(own)
    } finally {
      unregisterFlowTool('rows-count')
    }
    const slug = 'short-lived'
    writeTool(slug, `
name: ${slug}
description: Removed after the first scan. Fixture.
effect: read
run: { type: http, url: "https://api.example.com/x" }
`)
    expect((await registerOkitFlowTools(okitOpts())).registered).toContain(slug)
    fs.rmSync(path.join(TOOLS, slug), { recursive: true })
    expect((await registerOkitFlowTools(okitOpts())).removed).toEqual([slug])
    expect(getRegisteredFlowTool(slug)).toBeNull()
  })

  it('a script that exits 127 fails as definition rot, non-retryable, with its exit code kept', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'broken-script', true, 'user:1')
    const e = hostEngine('host')
    const runId = start(e, save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'go' },
      { id: 'go', kind: 'tool', tool: 'broken-script', effect: 'read', retry: { max: 3, backoff: 'fixed', delay_ms: 1 }, next: 'done' },
      { id: 'done', kind: 'end' },
    ])))
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    const rows = steps(runId, 'go')
    expect(rows).toHaveLength(1) // not retried
    expect(JSON.parse(rows[0].error_json)).toMatchObject({ type: 'tool_definition_rot', exit_code: 127, retryable: false })
  })
})

// ── 2. crash with a non-idempotent Tool in flight ────────────────────────────

async function crashDuringNote(tool: string) {
  await startOkitFlowToolRunner(okitOpts())
  setToolEnabledForWorkspace(db, WS, tool, true, 'user:1')
  let entered!: () => void
  const enteredP = new Promise<void>((r) => { entered = r })
  let release!: () => void
  holdNext = { entered, release: new Promise<void>((r) => { release = r }) }
  const a = hostEngine('host-a')
  const runId = start(a, save(NOTE_FLOW(tool)))
  const aTick = a.tick()
  await enteredP // the vendor has the request: the send is in flight
  a.kill() // process death
  await aTick
  release()
  // Restart: the okit runner registers again (fresh process), then a new engine resumes.
  stopOkitFlowToolRunner()
  await startOkitFlowToolRunner(okitOpts())
  now += LEASE_TTL + 1
  const b = hostEngine('host-b')
  await b.resumeOnBoot()
  return { runId, b }
}

describe('acceptance 2: a non-idempotent okit Tool in flight at a crash becomes unknown and waits for approval', () => {
  it('parks on an unknown-outcome approval and never re-sends', async () => {
    const { runId, b } = await crashDuringNote('post-note')
    expect(runRow(runId).status).toBe('waiting')
    const rows = steps(runId, 'note')
    expect(rows.map((r) => r.status)).toEqual(['unknown'])
    expect(JSON.parse(rows[0].error_json)).toMatchObject({ type: 'unknown_outcome', node_id: 'note' })
    const tokens = db.prepare('SELECT kind, reason, resolved_at FROM flow_wait_tokens WHERE run_id = ?').all(runId)
    expect(tokens).toEqual([{ kind: 'approval', reason: 'unknown_outcome', resolved_at: null }])
    now += 3_600_000
    await b.tick()
    expect(hits).toHaveLength(1) // exactly the one in-flight request, never repeated

    // The owner confirms it was NOT sent → the engine sends it again, once.
    expect(b.resolveUnknownOutcome({ runId, nodeId: 'note', outcome: 'not_sent', by: 'user:1' })).toEqual({ ok: true })
    await b.tick()
    expect(runRow(runId).status).toBe('succeeded')
    expect(hits).toHaveLength(2)
  })

  it('control: a Tool whose TOOL.md says idempotent: true IS re-run, with the same Idempotency-Key', async () => {
    const { runId } = await crashDuringNote('post-note-idem')
    expect(runRow(runId).status, JSON.stringify(steps(runId, 'note'))).toBe('succeeded')
    expect(hits).toHaveLength(2)
    const key = flowIdempotencyKey(runId, 'note')
    expect(hits.map((h) => h.headers['idempotency-key'])).toEqual([key, key])
  })
})

// ── 3. disabled Tool / kill switch ───────────────────────────────────────────

describe('acceptance 3: a disabled Tool, or flows_enabled=false, refuses with a clear error', () => {
  it('a Tool the workspace has not enabled fails tool_disabled without being called', async () => {
    await startOkitFlowToolRunner(okitOpts())
    // enabled for ANOTHER workspace only
    setToolEnabledForWorkspace(db, 'other-ws', 'rows-count', true, 'user:1')
    const e = hostEngine('host')
    const runId = start(e, save(COUNT_FLOW()), { rows: [] })
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    const rows = steps(runId, 'count')
    expect(rows).toHaveLength(1)
    const err = JSON.parse(rows[0].error_json)
    expect(err).toMatchObject({ type: 'tool_disabled', retryable: false, node_id: 'count' })
    expect(err.title).toBe('Tool "rows-count" is not enabled for workspace "acme". An owner/admin can enable it in Jobs → Workflows → Tools.')
    expect(markerCalls()).toBe(0)
    expect(secretsSeen).toEqual([]) // no secret was even resolved
  })

  it('a disabled send Tool is a clean failure, never an unknown-outcome wait', async () => {
    await startOkitFlowToolRunner(okitOpts())
    const e = hostEngine('host')
    const runId = start(e, save(NOTE_FLOW('post-note')))
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(steps(runId, 'note').map((r) => r.status)).toEqual(['failed'])
    expect(hits).toHaveLength(0)
  })

  it('disabling a Tool takes effect on the next call', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'rows-count', true, 'user:1')
    expect(isToolEnabledForWorkspace(db, WS, 'rows-count')).toBe(true)
    setToolEnabledForWorkspace(db, WS, 'rows-count', false, 'user:1')
    const e = hostEngine('host')
    const runId = start(e, save(COUNT_FLOW()), { rows: [] })
    await e.tick()
    expect(JSON.parse(steps(runId, 'count')[0].error_json).type).toBe('tool_disabled')
  })

  it('flows_enabled=false: no run starts, and the Tool itself refuses flows_disabled', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'rows-count', true, 'user:1')
    const flowId = save(COUNT_FLOW())
    setFlowsEnabled(false)
    const e = hostEngine('host')
    expect(e.startRun({ flowId, version: 1, trigger: { source: 'manual', payload: {} } })).toEqual({ ok: false, reason: 'flows_disabled' })

    const tool = getRegisteredFlowTool('rows-count')!
    expect(tool.refuse!({ workspace: WS, runId: 1, nodeId: 'count', effect: 'read' })).toEqual({
      type: 'flows_disabled',
      title: 'Workflows are switched off on this install (settings.flows_enabled), so Tool "rows-count" was not called',
    })
    const ctx = { runId: 1, nodeId: 'count', workspace: WS, attempt: 1, idempotencyKey: null, signal: new AbortController().signal }
    const err = await tool.run({ rows: [] }, ctx).catch((x) => x)
    expect(err).toBeInstanceOf(FlowStepError)
    expect(err).toMatchObject({ type: 'flows_disabled', retryable: false })
    expect(markerCalls()).toBe(0)
  })

  it('a run started while on, then switched off mid-run, refuses the Tool step', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'rows-count', true, 'user:1')
    setToolEnabledForWorkspace(db, WS, 'post-note', true, 'user:1')
    const e = hostEngine('host')
    // note (send) parks nothing; flip the switch from inside the first step via the vendor hold
    let entered!: () => void
    const enteredP = new Promise<void>((r) => { entered = r })
    let release!: () => void
    holdNext = { entered, release: new Promise<void>((r) => { release = r }) }
    const runId = start(e, save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'note' },
      { id: 'note', kind: 'tool', tool: 'post-note', input: { channel: 'c' }, next: 'count' },
      { id: 'count', kind: 'tool', tool: 'rows-count', effect: 'read', input: { rows: [] }, next: 'done' },
      { id: 'done', kind: 'end' },
    ], ['note'])))
    const t = e.tick()
    await enteredP
    setFlowsEnabled(false)
    release()
    await t
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(steps(runId, 'count')[0].error_json)).toMatchObject({ type: 'flows_disabled', retryable: false })
    expect(markerCalls()).toBe(0)
  })

  it('a node may not label a send Tool as read (that would skip approval and the crash rule)', async () => {
    await startOkitFlowToolRunner(okitOpts())
    setToolEnabledForWorkspace(db, WS, 'post-note', true, 'user:1')
    const e = hostEngine('host')
    const runId = start(e, save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'note' },
      { id: 'note', kind: 'tool', tool: 'post-note', effect: 'read', input: { channel: 'c' }, next: 'done' },
      { id: 'done', kind: 'end' },
    ])))
    await e.tick()
    expect(runRow(runId).status).toBe('failed')
    expect(JSON.parse(steps(runId, 'note')[0].error_json)).toMatchObject({ type: 'tool_effect_mismatch', retryable: false })
    expect(hits).toHaveLength(0)
  })

  it('an unregistered Tool slug still fails unknown_tool', async () => {
    await startOkitFlowToolRunner(okitOpts())
    const e = hostEngine('host')
    const runId = start(e, save(flow([
      { id: 'start', kind: 'trigger', on: 'manual', next: 'x' },
      { id: 'x', kind: 'tool', tool: 'docs-only', effect: 'read', next: 'done' },
      { id: 'done', kind: 'end' },
    ])))
    await e.tick()
    expect(JSON.parse(steps(runId, 'x')[0].error_json)).toMatchObject({ type: 'unknown_tool' })
  })
})

// ── the TOOL.md run: contract ────────────────────────────────────────────────

describe('parseOkitTool: the run: contract fails closed', () => {
  const dir = path.join(TOOLS, 'rows-count')
  const http = (run: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    parseOkitTool('t', { run: { type: 'http', ...run }, ...extra }, dir)

  it('requires https, a fixed host, no URL credentials, and only declared secrets in headers', () => {
    expect(http({ url: 'http://api.example.com' })).toEqual({ ok: false, reason: 'run.url must be https://' })
    expect(http({ url: 'https://{host}.example.com/x' })).toMatchObject({ ok: false, reason: expect.stringMatching(/path and query only/) })
    expect(http({ url: 'https://u:p@api.example.com' })).toMatchObject({ ok: false, reason: expect.stringMatching(/credentials/) })
    expect(http({ url: 'https://api.example.com', headers: { Authorization: 'Bearer ${JWT_SECRET}' } }))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/not declared in auth.secrets/) })
    expect(http({ url: 'https://api.example.com', method: 'TRACE' })).toMatchObject({ ok: false })
    expect(http({ url: 'https://api.example.com' }, { effect: 'maybe' })).toMatchObject({ ok: false, reason: expect.stringMatching(/effect/) })
    expect(http({ url: 'https://api.example.com/{id}' })).toMatchObject({ ok: true })
  })

  it('a script command must be an executable file inside the tool dir', () => {
    expect(parseOkitTool('t', { run: { type: 'script', command: '../broken-script/run.sh' } }, dir))
      .toEqual({ ok: false, reason: 'run.command resolves outside the tool directory' })
    expect(parseOkitTool('t', { run: { type: 'script', command: '/bin/sh' } }, dir)).toMatchObject({ ok: false })
    expect(parseOkitTool('t', { run: { type: 'script', command: 'nope.sh' } }, dir)).toMatchObject({ ok: false })
  })

  it('idempotent is only ever a literal true', () => {
    const r = http({ url: 'https://api.example.com' }, { idempotent: 'yes' })
    expect(r.ok && r.def.idempotent).toBe(false)
  })

  it('loadOkitTools on a missing dir registers nothing and says so', () => {
    expect(loadOkitTools(path.join(ROOT, 'nope'))).toEqual({ tools: [], invalid: [], missing: true })
  })
})
