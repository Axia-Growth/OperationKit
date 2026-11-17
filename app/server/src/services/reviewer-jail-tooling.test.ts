/**
 * obj 901229 — reviewer jail tooling.
 *
 *   1. python3 is on PATH in every jail image a reviewer can run on (the base
 *      layer of app/jail/Dockerfile, asserted at build time; live proof in
 *      .github/workflows/install-smoke.yml).
 *   2. A UI-change review (attachPlaywright) in jail mode runs on the BROWSER
 *      jail image with the worker browser-jail path: browser seccomp profile,
 *      in-jail egress guard, Playwright MCP config in the jail HOME.
 *   3. A backend-only review stays on the default jail image, no Playwright.
 *   4. Fail-closed is unchanged: tmux mode keeps the reviewer MCP config,
 *      which is withheld (no browser) when the control-plane guard is down.
 *
 * spawnReviewerSession and spawnInTmux are REAL; only the process-spawning
 * edges (docker / tmux via child_process) and the reviewer's DB/account/prompt
 * dependencies are faked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const execFileSyncCalls: Array<{ file: string; argv: string[] }> = []
const docker = { browserImageMissing: false }
function fakeExecFileSync(file: string, argv: string[]) {
  execFileSyncCalls.push({ file, argv })
  if (file === 'docker' && argv[0] === 'image' && argv[1] === 'inspect' && docker.browserImageMissing) {
    throw new Error(`Error: No such image: ${argv[argv.length - 1]}`)
  }
  return 'abc123def456\n'
}
vi.mock('child_process', () => ({
  execSync: () => Buffer.from(''),
  execFileSync: (file: string, argv: string[]) => fakeExecFileSync(file, argv),
}))
vi.mock('node:child_process', () => ({
  execFile: () => undefined,
  execSync: () => Buffer.from(''),
  execFileSync: (file: string, argv: string[]) => fakeExecFileSync(file, argv),
}))

// ── reviewer dependencies (not under test) ──
const state = { files: [] as string[], gateMode: 'off', tmp: '' }
const stubDb = { prepare: () => ({ get: () => undefined, all: () => [], run: () => ({ changes: 0 }) }) }
vi.mock('../db/index.js', () => ({ getDb: () => stubDb }))
vi.mock('./files-touched.js', () => ({
  resolveFilesTouched: async () => ({ files: state.files, source: 'session_intel' }),
  realGhExec: () => '',
}))
vi.mock('./account-router.js', () => ({
  pickAccount: () => ({ id: 1, label: 'seat-1', homeDir: path.join(state.tmp, 'home') }),
  recordSessionStart: () => {},
}))
vi.mock('./design-context.js', async (orig) => ({
  ...(await orig<typeof import('./design-context.js')>()),
  getEffectiveGateMode: () => state.gateMode,
}))
vi.mock('./prompt-builder.js', () => ({ resolveWorkdir: () => path.join(state.tmp, 'worktree') }))
vi.mock('./model-registry.js', async (orig) => ({
  ...(await orig<typeof import('./model-registry.js')>()),
  getReviewerModelId: () => undefined,
  getPlannerModelId: () => undefined,
}))
vi.mock('./session-spawn-env.js', () => ({ buildSpawnEnv: () => ({ CC_ACTING_USER_ID: '1' }) }))
vi.mock('./seat-credentials.js', () => ({ seatCredentialEnv: () => ({}) }))
const writeReviewerMcp = vi.fn()
vi.mock('./session-reviewer-prompt.js', () => ({
  buildReviewerPrompt: () => 'review this PR',
  isDelegatorWorkerObjective: () => false,
  writeReviewerPlaywrightMcpConfig: (...a: unknown[]) => writeReviewerMcp(...a),
}))
vi.mock('./session-registry.js', async (orig) => ({
  ...(await orig<typeof import('./session-registry.js')>()),
  registerActiveSession: () => {},
}))
vi.mock('./session-manager.js', () => ({ ensureUser: () => {} }))
vi.mock('./session-control.js', () => ({ stopSession: async () => {} }))

const ENV_KEYS = ['SESSION_ISOLATION', 'CC_SCRIPT_DIR', 'CC_JAIL_HOME_ROOT', 'TRANSCRIPT_DIR', 'SESSION_JAIL_BROWSER_IMAGE', 'SESSION_JAIL_IMAGE']
const saved: Record<string, string | undefined> = {}

const UI_FILES = ['app/client/src/components/KanbanBoard.tsx', 'app/server/src/routes/objectives.ts']
const BACKEND_FILES = ['app/server/src/services/state-poller.ts', 'app/server/src/routes/objectives.ts']

function objective(over: Record<string, unknown> = {}) {
  return { id: 901229, title: 'Reviewer jail tooling', project: 'operationkit', pr_number: 850, test_cred_slug: null, ...over } as never
}

async function loadSpawn() {
  vi.resetModules()
  const mod = await import('./session-subsessions.js')
  return mod
}

function dockerRunArgv(): string[] {
  const runs = execFileSyncCalls.filter((c) => c.file === 'docker' && c.argv[0] === 'run')
  expect(runs.length, 'docker run was called').toBeGreaterThan(0)
  return runs[runs.length - 1].argv
}
function jailHome(sid: string): string {
  return path.join(state.tmp, 'jail-homes', sid, '.cc')
}

beforeEach(() => {
  execFileSyncCalls.length = 0
  docker.browserImageMissing = false
  writeReviewerMcp.mockReset()
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  state.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reviewer-jail-'))
  for (const d of ['home', 'worktree', 'transcripts']) fs.mkdirSync(path.join(state.tmp, d), { recursive: true })
  process.env.CC_SCRIPT_DIR = path.join(state.tmp, 'cc-scripts')
  process.env.CC_JAIL_HOME_ROOT = path.join(state.tmp, 'jail-homes')
  process.env.TRANSCRIPT_DIR = path.join(state.tmp, 'transcripts')
  delete process.env.SESSION_ISOLATION
  delete process.env.SESSION_JAIL_BROWSER_IMAGE
  delete process.env.SESSION_JAIL_IMAGE
  state.files = []
  state.gateMode = 'off'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  fs.rmSync(state.tmp, { recursive: true, force: true })
})

// ── 1. python3 ───────────────────────────────────────────────────────────────
describe('python3 is on PATH in every jail image a reviewer runs on (criterion 1)', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'jail', 'Dockerfile'), 'utf8')

  it('python3 is installed in the unconditional base apt layer (so ok-jail AND ok-jail-browser carry it)', () => {
    // The first RUN apt-get install — before the WITH_BROWSER branch exists.
    const start = dockerfile.indexOf('RUN apt-get update')
    const firstApt = dockerfile.slice(start, dockerfile.indexOf('rm -rf /var/lib/apt/lists/*', start))
    expect(start).toBeLessThan(dockerfile.indexOf('ARG WITH_BROWSER'))
    expect(firstApt).toMatch(/^\s+python3 \\$/m)
    expect(firstApt).not.toMatch(/WITH_BROWSER|^\s*#/m)
  })

  it('the build itself asserts `python3 --version` (an image without it fails to build)', () => {
    expect(dockerfile).toMatch(/^RUN python3 --version$/m)
    // Asserted before USER jailuser drops root — but it runs the same binary jailuser gets on PATH.
    expect(dockerfile.indexOf('RUN python3 --version')).toBeLessThan(dockerfile.indexOf('USER jailuser'))
  })

  it('the install smoke runs `python3 --version` inside both built images (live proof in CI)', () => {
    const smoke = fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '.github', 'workflows', 'install-smoke.yml'), 'utf8')
    expect(smoke).toContain("sudo docker run --rm ok-jail:local bash -lc 'command -v python3 && python3 --version'")
    expect(smoke).toContain("sudo docker run --rm ok-jail-browser:local bash -lc 'command -v python3 && python3 --version'")
  })
})

// ── the pure decision ────────────────────────────────────────────────────────
describe('planReviewerBrowser', () => {
  it('UI PR: jail → browser jail, tmux → host reviewer MCP config; never both', async () => {
    const { planReviewerBrowser } = await loadSpawn()
    expect(planReviewerBrowser({ filesTouched: UI_FILES, prNumber: 1, gateMode: 'off', jailed: true }))
      .toEqual({ attachPlaywright: true, hostMcpConfig: false, jailBrowser: true })
    expect(planReviewerBrowser({ filesTouched: UI_FILES, prNumber: 1, gateMode: 'off', jailed: false }))
      .toEqual({ attachPlaywright: true, hostMcpConfig: true, jailBrowser: false })
  })
  it('backend-only: no browser in either mode', async () => {
    const { planReviewerBrowser } = await loadSpawn()
    for (const jailed of [true, false]) {
      expect(planReviewerBrowser({ filesTouched: BACKEND_FILES, prNumber: 1, gateMode: 'hard', jailed }))
        .toEqual({ attachPlaywright: false, hostMcpConfig: false, jailBrowser: false })
    }
  })
  it('unchanged attach rule: no PR and gate off → no browser; unknown files (empty) still attach', async () => {
    const { planReviewerBrowser } = await loadSpawn()
    expect(planReviewerBrowser({ filesTouched: UI_FILES, prNumber: null, gateMode: 'off', jailed: true }).attachPlaywright).toBe(false)
    expect(planReviewerBrowser({ filesTouched: UI_FILES, prNumber: null, gateMode: 'advisory', jailed: true }).attachPlaywright).toBe(true)
    expect(planReviewerBrowser({ filesTouched: [], prNumber: 1, gateMode: 'off', jailed: true }).attachPlaywright).toBe(true)
  })
})

// ── 2. UI review in jail mode → browser jail ─────────────────────────────────
describe('jail mode: a UI-change review runs on the browser jail with Playwright attached (criterion 2)', () => {
  it('docker run uses ok-jail-browser:local (not ok-jail:local), the browser seccomp profile and the in-jail guard; Playwright MCP is wired', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())

    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail-browser:local')
    expect(argv).not.toContain('ok-jail:local')
    expect(argv).toContain('ok-jail-901229-review')
    const sec = argv.filter((_, i) => argv[i - 1] === '--security-opt')
    expect(sec).toContain('no-new-privileges')
    expect(sec.some((s) => /^seccomp=\/.*jail-browser-seccomp\.json$/.test(s))).toBe(true)
    const cmd = argv[argv.length - 1]
    expect(cmd).toContain('tsx /home/jailuser/.cc/browser-guard/run.ts')
    expect(cmd.indexOf('browser-guard/run.ts')).toBeLessThan(cmd.indexOf('tmux new-session'))

    // Playwright MCP: the same contract a worker gets, inside the jail HOME.
    const home = jailHome(sid)
    const wrapper = fs.readFileSync(path.join(home, `${sid}.sh`), 'utf8')
    expect(wrapper).toContain(`--mcp-config "/home/jailuser/.cc/${sid}.browser-mcp.json"`)
    expect(wrapper).toContain('export CC_CARD_BROWSER="1"')
    const args: string[] = JSON.parse(fs.readFileSync(path.join(home, `${sid}.browser-mcp.json`), 'utf8')).mcpServers.playwright.args
    expect(args).toContain('--sandbox')
    expect(args[args.indexOf('--proxy-server') + 1]).toBe('http://127.0.0.1:3099')
    // The worker guard policy: the control-plane API (3002) stays blocked from the reviewer's browser too.
    expect(args.join(' ')).toMatch(/--blocked-origins/)
    // The host reviewer config is not written in jail mode (its path is not mounted there).
    expect(writeReviewerMcp).not.toHaveBeenCalled()
  })

  it('SESSION_JAIL_BROWSER_IMAGE is honoured for the reviewer too', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    process.env.SESSION_JAIL_BROWSER_IMAGE = 'ok-jail-browser@sha256:abc'
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    await spawnReviewerSession(objective())
    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail-browser@sha256:abc')
    expect(argv).not.toContain('ok-jail:local')
  })

  it('no INTERNAL_API_SECRET reaches the reviewer jail', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    expect(fs.readFileSync(path.join(jailHome(sid), `${sid}.sh`), 'utf8')).not.toMatch(/INTERNAL_API_SECRET/)
  })
})

// ── 3. backend-only stays on the default jail ────────────────────────────────
describe('jail mode: a backend-only review stays on the default jail, no Playwright (criterion 3)', () => {
  it('docker run uses ok-jail:local, Docker default seccomp, no guard, no MCP config, no browser env', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    state.files = BACKEND_FILES
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail:local')
    expect(argv.some((a) => a.startsWith('ok-jail-browser'))).toBe(false)
    expect(argv.join(' ')).not.toContain('seccomp=')
    expect(argv[argv.length - 1]).not.toContain('browser-guard')
    const home = jailHome(sid)
    expect(fs.existsSync(path.join(home, 'browser-guard'))).toBe(false)
    expect(fs.existsSync(path.join(home, `${sid}.browser-mcp.json`))).toBe(false)
    const wrapper = fs.readFileSync(path.join(home, `${sid}.sh`), 'utf8')
    expect(wrapper).not.toContain('--mcp-config')
    expect(wrapper).not.toContain('CC_CARD_BROWSER')
    expect(writeReviewerMcp).not.toHaveBeenCalled()
  })

  it('a review with no PR and the gate off also stays on the default jail', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    await spawnReviewerSession(objective({ pr_number: null }))
    expect(dockerRunArgv()).toContain('ok-jail:local')
  })
})

// ── 4. fail closed, unchanged ────────────────────────────────────────────────
describe('fail-closed behaviour is unchanged (criterion 4)', () => {
  it('tmux mode, UI PR: the reviewer MCP config is requested; when it is withheld (guard down → null) no --mcp-config and no browser are given', async () => {
    state.files = UI_FILES
    writeReviewerMcp.mockReturnValue(null) // writeReviewerPlaywrightMcpConfig's guard-down answer
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    expect(writeReviewerMcp).toHaveBeenCalledTimes(1)
    const wrapper = fs.readFileSync(path.join(state.tmp, 'cc-scripts', `${sid}.sh`), 'utf8')
    expect(wrapper).not.toMatch(/--mcp-config/)
    expect(wrapper).not.toContain('CC_CARD_BROWSER')
    // Never the worker app-container browser path: no refusal block, no launcher.
    expect(fs.existsSync(path.join(state.tmp, 'cc-scripts', 'cc-browser.mjs'))).toBe(false)
  })

  it('tmux mode, UI PR, guard up: the reviewer config is passed through as before', async () => {
    state.files = UI_FILES
    const cfg = path.join(state.tmp, 'reviewer.mcp.json')
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: [] } } }))
    writeReviewerMcp.mockReturnValue(cfg)
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    const wrapper = fs.readFileSync(path.join(state.tmp, 'cc-scripts', `${sid}.sh`), 'utf8')
    expect(wrapper).toMatch(/--mcp-config/)
    expect(wrapper).not.toContain('CC_CARD_BROWSER')
  })

  it('jail mode, browser image missing: the reviewer gets NO browser (stock jail, no guard, no MCP) and still starts', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    docker.browserImageMissing = true
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    const argv = dockerRunArgv()
    expect(argv).toContain('ok-jail:local')
    expect(argv.join(' ')).not.toContain('seccomp=')
    const wrapper = fs.readFileSync(path.join(jailHome(sid), `${sid}.sh`), 'utf8')
    expect(wrapper).not.toContain('--mcp-config')
    expect(wrapper).toMatch(/export CC_CARD_BROWSER_REFUSED=".*ok-jail-browser:local is not on this host/)
  })

  it('jail mode: Chromium only ever talks through the in-jail guard (proxy set, sandbox on, no --no-sandbox)', async () => {
    process.env.SESSION_ISOLATION = 'docker'
    state.files = UI_FILES
    const { spawnReviewerSession } = await loadSpawn()
    const sid = await spawnReviewerSession(objective())
    const args: string[] = JSON.parse(fs.readFileSync(path.join(jailHome(sid), `${sid}.browser-mcp.json`), 'utf8')).mcpServers.playwright.args
    expect(args).toContain('--proxy-server')
    expect(args).not.toContain('--no-sandbox')
  })
})
