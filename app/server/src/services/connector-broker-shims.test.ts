/**
 * obj 901743 (issue #136): the session-side git credential helper and gh shim.
 * They are static (no secret) and fetch a credential per request from the
 * host broker with the session's CC_SESSION_TOKEN. Exercised for real here:
 * `git credential fill` and a fake `gh` behind the shim, against a fake broker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile, execFileSync, spawnSync } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import {
  GH_SHIM_SCRIPT,
  GIT_HELPER_SCRIPT,
  GITHUB_HELPER_CONFIG_KEY,
  connectorBrokerSessionEnv,
  ensureConnectorBrokerShims,
} from './connector-broker-shims.js'

const SESSION_TOKEN = 'ccs_fake.sessiontoken'
const BROKERED = 'ghp_brokeredForThisRequestOnly000'

let server: http.Server
let brokerUrl: string
const seen: { path: string; token: string | undefined }[] = []

/** A temp dir scripts can be executed from (some sandboxes mount /tmp noexec). */
function execDir(prefix: string): string {
  for (const base of [os.tmpdir(), os.homedir()]) {
    const d = fs.mkdtempSync(path.join(base, prefix))
    const probe = path.join(d, 'probe')
    fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    if (spawnSync(probe).status === 0) { fs.rmSync(probe); return d }
    fs.rmSync(d, { recursive: true, force: true })
  }
  throw new Error('no executable temp dir')
}

const lastQuery = () => new URL(seen.at(-1)?.path ?? '/', 'http://x').searchParams

const has = (bin: string) => { try { execFileSync(bin, ['--version'], { stdio: 'pipe' }); return true } catch { return false } }
const toolsAvailable = has('git') && has('curl')

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x')
    seen.push({ path: `${u.pathname}${u.search}`, token: req.headers['x-cc-session-token'] as string | undefined })
    if (req.headers['x-cc-session-token'] !== SESSION_TOKEN) { res.writeHead(401).end('session_token_invalid'); return }
    if (u.pathname.endsWith('/github/git-credential')) {
      if (u.searchParams.get('path') === 'acme/app.git') res.writeHead(200).end(`username=x-access-token\npassword=${BROKERED}\n`)
      else res.writeHead(403).end('repo_out_of_scope')
      return
    }
    if (u.pathname.endsWith('/github/token')) {
      const repo = u.searchParams.get('repo') ?? ''
      if (/acme\/app/i.test(repo)) res.writeHead(200).end(BROKERED)
      else res.writeHead(403).end('repo_out_of_scope')
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const a = server.address()
  if (!a || typeof a === 'string') throw new Error('no address')
  brokerUrl = `http://127.0.0.1:${a.port}/api/session-broker`
})
afterAll(async () => { await new Promise<void>(r => server.close(() => r())) })

describe('the scripts and the env that wires them', () => {
  it('contain no credential, and the env values contain no `$` (the tmux wrapper exports in double quotes)', () => {
    for (const s of [GIT_HELPER_SCRIPT, GH_SHIM_SCRIPT]) {
      expect(s).not.toMatch(/gh[pousr]_[A-Za-z0-9]{10,}|github_pat_/)
      expect(s).toContain('X-CC-Session-Token: $CC_SESSION_TOKEN')
    }
    const env = connectorBrokerSessionEnv({ CC_GITHUB_BROKER: '1', PATH: '/usr/bin' }, '/home/jailuser/.cc/cc-broker-bin', 'http://localhost:3002/api/session-broker')
    for (const v of Object.values(env)) expect(v).not.toContain('$')
    expect(env.PATH).toBe('/home/jailuser/.cc/cc-broker-bin:/usr/bin')
    expect(env.GIT_CONFIG_COUNT).toBe('3')
    expect([env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0]).toEqual([GITHUB_HELPER_CONFIG_KEY, ''])
    expect([env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1]).toEqual([GITHUB_HELPER_CONFIG_KEY, '!sh /home/jailuser/.cc/cc-broker-bin/git-credential-cc'])
    expect([env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2]).toEqual(['credential.https://github.com.useHttpPath', 'true'])
    expect(env.CC_CONNECTOR_BROKER_URL).toBe('http://localhost:3002/api/session-broker')
    expect(Object.keys(env).some(k => /TOKEN/.test(k))).toBe(false)
  })
  it('adds nothing when the session\'s GitHub is not brokered, and appends after existing GIT_CONFIG entries', () => {
    expect(connectorBrokerSessionEnv({}, '/x')).toEqual({})
    const env = connectorBrokerSessionEnv({ CC_GITHUB_BROKER: '1', GIT_CONFIG_COUNT: '2' }, '/x')
    expect(env.GIT_CONFIG_COUNT).toBe('5')
    expect(env.GIT_CONFIG_KEY_2).toBe(GITHUB_HELPER_CONFIG_KEY)
  })
})

describe.skipIf(!toolsAvailable)('real git + sh + curl against a fake broker', () => {
  let bin: string
  let home: string
  beforeAll(() => {
    bin = ensureConnectorBrokerShims(execDir('cc-broker-bin-'))
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-broker-home-'))
    expect(fs.statSync(path.join(bin, 'git-credential-cc')).mode & 0o777).toBe(0o755)
  })
  function sessionEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    const base: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      CC_GITHUB_BROKER: '1',
      CC_SESSION_TOKEN: SESSION_TOKEN,
      ...extra,
    }
    return { ...base, ...connectorBrokerSessionEnv(base, bin, brokerUrl) }
  }
  // Async on purpose: the fake broker lives in THIS process, so a sync child
  // would block the event loop that has to answer it.
  function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      const child = execFile(cmd, args, { env, encoding: 'utf8', timeout: 30_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
      })
      child.stdin?.end(input)
    })
  }

  it('git credential fill gets the brokered credential for a linked repo (path sent via useHttpPath)', async () => {
    const env = sessionEnv()
    expect(env.GH_TOKEN).toBeUndefined()
    const out = (await run('git', ['credential', 'fill'], env, 'protocol=https\nhost=github.com\npath=acme/app.git\n\n')).stdout
    expect(out).toContain(`password=${BROKERED}`)
    expect(lastQuery().get('path')).toBe('acme/app.git')
    expect(lastQuery().get('host')).toBe('github.com')
    expect(seen.at(-1)?.token).toBe(SESSION_TOKEN)
  })
  it('a refused repo yields no credential (git would then fail the push, not use another login)', async () => {
    const r = await run('git', ['credential', 'fill'], sessionEnv(), 'protocol=https\nhost=github.com\npath=evil/repo.git\n\n')
    expect(r.stdout).not.toContain(BROKERED)
    expect(r.stderr).toContain('refused')
  })
  it('a crafted path cannot change the broker request (it is url-encoded)', async () => {
    await run('git', ['credential', 'fill'], sessionEnv(), 'protocol=https\nhost=github.com\npath=acme/app.git&path=x;id\n\n')
    expect(lastQuery().getAll('path')).toEqual(['acme/app.git&path=x;id'])
  })
  it('the gh shim hands the brokered credential to the real gh only (not to the caller\'s env)', async () => {
    const fakeDir = execDir('cc-fake-gh-')
    fs.writeFileSync(path.join(fakeDir, 'gh'), '#!/bin/sh\necho "GH_TOKEN=${GH_TOKEN:-none} ARGS=$*"\n', { mode: 0o755 })
    const env = sessionEnv({ PATH: `${fakeDir}:${process.env.PATH}` })
    const viaRepo = (await run(path.join(bin, 'gh'), ['pr', 'view', '--repo', 'acme/app'], env)).stdout
    expect(viaRepo.trim()).toBe(`GH_TOKEN=${BROKERED} ARGS=pr view --repo acme/app`)
    const refused = (await run(path.join(bin, 'gh'), ['pr', 'view', '-R', 'evil/repo'], env)).stdout
    expect(refused.trim()).toBe('GH_TOKEN=none ARGS=pr view -R evil/repo')
    const optOut = (await run(path.join(bin, 'gh'), ['pr', 'view', '--repo=acme/app'], { ...env, CC_GH_BROKER: '0' })).stdout
    expect(optOut.trim()).toBe('GH_TOKEN=none ARGS=pr view --repo=acme/app')
  })
})
