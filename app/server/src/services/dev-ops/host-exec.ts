/**
 * Run the dev-ops host runner on the HOST (obj 901424).
 *
 * The app container holds the Docker socket (it starts the card sandboxes), but
 * it cannot run `install/update.sh` and it never holds the installer's
 * Cloudflare token: both live on the host. This starts a throwaway helper
 * container that enters the host's namespaces (PID 1) and runs
 * `host-runner.sh` there as root — the same reach services/preview-spool.ts
 * already uses for its host drain.
 *
 *  - The script TEXT is passed as `bash -c <text>`: the runner that executes is
 *    the one this server shipped with, never a file a deploy is rewriting.
 *  - argv carries only fixed paths, a numeric id and an https URL. Request data
 *    for a Cloudflare call (emails, DNS values, the protected list) goes in on
 *    STDIN as JSON, so none of it is in `ps` or `docker inspect`.
 *  - No secret is ever passed: the runner reads the token file on the host and
 *    hands it to curl on stdin. What comes back is the runner's one JSON line,
 *    redacted again before it reaches a model, a chat or the audit table.
 *
 * The runner is injectable (`setHostRunnerForTests`) so tests never touch Docker.
 */
import { spawn } from 'child_process'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { resolvePublicBaseUrl } from '../../lib/public-url.js'
import { redactForStorage } from '../secret-redaction.js'
import { resolveHostPathMap, toHostPath } from '../session-jail.js'

export const RUNNER_PATH = fileURLToPath(new URL('./host-runner.sh', import.meta.url))
export const DEFAULT_SRC_DIR = '/opt/operationkit-src'
export const DEFAULT_HELPER_IMAGE = 'operationkit-app:local'
const CONTAINER_DATA_DIR = '/app/data'
const PLAIN_PATH = /^\/[A-Za-z0-9._/-]+$/

export interface HostConfig {
  srcDir: string
  configPath: string
  helperImage: string
  /** Where /app/data really lives on the host. */
  hostDataDir: string
  /** The same folder as this container sees it. */
  dataDir: string
  healthUrl: string
}

export type HostConfigResult = { ok: true; config: HostConfig } | { ok: false; code: string; error: string }

function plainPath(p: string): boolean {
  return PLAIN_PATH.test(p) && !p.includes('..')
}

/** Where things are on the host. Env overrides exist for other layouts; every value is validated. */
export function devOpsHostConfig(env: NodeJS.ProcessEnv = process.env): HostConfigResult {
  const srcDir = (env.CC_DEV_OPS_SRC_DIR || DEFAULT_SRC_DIR).trim().replace(/\/+$/, '')
  const configPath = (env.CC_DEV_OPS_CONFIG || `${srcDir}/client.conf`).trim()
  if (!plainPath(srcDir) || !plainPath(configPath)) {
    return { ok: false, code: 'bad_host_path', error: 'The install source or config path is not a plain absolute path.' }
  }
  const helperImage = (env.CC_DEV_OPS_HELPER_IMAGE || DEFAULT_HELPER_IMAGE).trim()
  if (!/^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$/.test(helperImage)) {
    return { ok: false, code: 'bad_helper_image', error: 'The helper image name is not valid.' }
  }
  const dataDir = (env.CC_DEV_OPS_DATA_DIR || CONTAINER_DATA_DIR).replace(/\/+$/, '')
  let hostDataDir = (env.CC_DEV_OPS_HOST_DATA_DIR || '').trim().replace(/\/+$/, '')
  if (!hostDataDir) {
    try {
      const mapped = toHostPath(dataDir, resolveHostPathMap(env))
      hostDataDir = mapped !== dataDir ? mapped : ''
    } catch {
      hostDataDir = ''
    }
  }
  if (!hostDataDir || !plainPath(hostDataDir) || !plainPath(dataDir)) {
    return { ok: false, code: 'no_host_data_path', error: "This server does not say where its data folder lives on the host (SESSION_JAIL_HOST_PATH_MAP has no /app/data entry), so a deploy's result could not be read back." }
  }
  let healthUrl = (env.CC_DEV_OPS_HEALTH_URL || '').trim()
  if (!healthUrl) {
    try { healthUrl = `${resolvePublicBaseUrl(env)}/api/health` } catch { healthUrl = '' }
  }
  if (!/^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._/-]*$/.test(healthUrl)) {
    return { ok: false, code: 'no_public_url', error: "This install has no public https address to health-check after a deploy." }
  }
  return { ok: true, config: { srcDir, configPath, helperImage, hostDataDir, dataDir, healthUrl } }
}

export interface HostRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface HostRunOptions {
  /** Request JSON written to the runner's stdin (sync runs only). */
  stdin?: string
  /** Start detached (`docker run -d`) and return once the container started. */
  detached?: boolean
  /** Container name for a detached run. */
  name?: string
  timeoutMs?: number
}

export type HostRunner = (image: string, runnerArgs: string[], opts: HostRunOptions) => Promise<HostRunResult>

/** The docker argv for one host run. Exported for tests: it must never hold a secret or request data. */
export function hostDockerArgs(image: string, runnerArgs: string[], opts: HostRunOptions, script: string): string[] {
  const mode = opts.detached ? ['-d', ...(opts.name ? ['--name', opts.name] : [])] : ['-i']
  return [
    // ok.host-runner=1: the Docker policy sidecar (install/docker-proxy, obj 901741)
    // allows this privileged call only with that label, this exact nsenter
    // prefix, the shipped script bytes and the install's own paths, and only
    // when the install set HOST_RUNNER=on.
    'run', '--rm', ...mode, '--label', 'ok.host-runner=1', '--privileged', '--pid=host', '--network=host', '--entrypoint', 'nsenter', image,
    '-t', '1', '-m', '-u', '-i', '-n', '-p', '--',
    'bash', '-c', script, 'ok-dev-ops', ...runnerArgs,
  ]
}

const defaultRunner: HostRunner = (image, runnerArgs, opts) =>
  new Promise(resolve => {
    let script: string
    try {
      script = fs.readFileSync(RUNNER_PATH, 'utf8')
    } catch (err) {
      resolve({ code: 127, stdout: '', stderr: `host runner missing: ${(err as Error).message}` })
      return
    }
    const child = spawn('docker', hostDockerArgs(image, runnerArgs, opts, script), { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } }, opts.timeoutMs ?? 120_000)
    child.stdout.on('data', d => { if (stdout.length < 2_000_000) stdout += String(d) })
    child.stderr.on('data', d => { if (stderr.length < 200_000) stderr += String(d) })
    child.on('error', err => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: `${stderr}${err.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    if (opts.stdin) child.stdin.write(opts.stdin)
    child.stdin.end()
  })

let runner: HostRunner = defaultRunner

export function setHostRunnerForTests(r: HostRunner | null): void {
  runner = r ?? defaultRunner
}

export function runOnHost(image: string, runnerArgs: string[], opts: HostRunOptions): Promise<HostRunResult> {
  return runner(image, runnerArgs, opts)
}

/** The runner's last JSON line, redacted. Null when there is none. */
export function parseRunnerJson(stdout: string): Record<string, unknown> | null {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue
    try {
      const parsed = JSON.parse(redactForStorage(lines[i]).text) as Record<string, unknown>
      if (parsed && typeof parsed === 'object') return parsed
    } catch { /* keep looking */ }
  }
  return null
}
