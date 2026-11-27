/**
 * obj 901741 (public issue #97): the Dev host runner's `docker run` must be the
 * exact shape the Docker policy sidecar (install/docker-proxy/policy.mjs) pins.
 * If either side changes alone, the deploy / Cloudflare tools stop working on a
 * client install — this test fails first.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { hostDockerArgs, RUNNER_PATH } from './host-exec.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const policyPath = path.resolve(here, '../../../../../install/docker-proxy/policy.mjs')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const policy: any = await import(policyPath)

/** What the docker CLI turns this argv into (the fields the policy reads). */
function createBodyFromArgv(argv: string[]): { body: Record<string, unknown>; name: string } {
  expect(argv[0]).toBe('run')
  const labels: Record<string, string> = {}
  const hc: Record<string, unknown> = {}
  let entrypoint: string[] | null = null
  let name = ''
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('-')) break
    if (a === '--rm') hc.AutoRemove = true
    else if (a === '-d' || a === '-i') continue
    else if (a === '--name') name = argv[++i]
    else if (a === '--label') { const [k, v] = argv[++i].split('='); labels[k] = v }
    else if (a === '--privileged') hc.Privileged = true
    else if (a === '--pid=host') hc.PidMode = 'host'
    else if (a === '--network=host') hc.NetworkMode = 'host'
    else if (a === '--entrypoint') entrypoint = [argv[++i]]
    else throw new Error(`unmapped flag ${a}`)
  }
  return { body: { Image: argv[i], Entrypoint: entrypoint, Cmd: argv.slice(i + 1), Labels: labels, HostConfig: hc }, name }
}

function cfg(enabled: boolean, script: string) {
  const c = policy.loadConfig({
    DOCKER_PROXY_HOST_RUNNER: enabled ? 'on' : 'off',
    DOCKER_PROXY_HOST_RUNNER_SRC: '/opt/operationkit-src',
    DOCKER_PROXY_HOST_RUNNER_CONF: '/opt/operationkit-src/client.conf',
    DOCKER_PROXY_HOST_RUNNER_DATA: '/srv/ok/state/data',
  })
  c.hostRunner.script = script
  return c
}

describe('host runner argv ↔ docker policy sidecar', () => {
  const script = fs.readFileSync(RUNNER_PATH, 'utf8')
  const cases: Array<[string, string[], { detached?: boolean; name?: string }]> = [
    ['deploy', ['deploy', '/opt/operationkit-src', '/opt/operationkit-src/client.conf', '7', 'https://ai.example.test/api/health', '/srv/ok/state/data'], { detached: true, name: 'ok-dev-ops-deploy-7' }],
    ['src-info', ['src-info', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'], {}],
    ['access-add', ['access-add', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'], {}],
  ]
  for (const [label, args, opts] of cases) {
    it(`${label}: carries the host runner label and passes the pinned check when HOST_RUNNER=on`, () => {
      const argv = hostDockerArgs('operationkit-app:local', args, opts, script)
      expect(argv).toEqual(expect.arrayContaining(['--label', 'ok.host-runner=1']))
      const { body, name } = createBodyFromArgv(argv)
      const q = new URLSearchParams(name ? { name } : {})
      expect(policy.checkCreate(body, q, cfg(true, script), () => null)).toBeNull()
    })
    it(`${label}: refused when HOST_RUNNER is off (the default)`, () => {
      const { body, name } = createBodyFromArgv(hostDockerArgs('operationkit-app:local', args, opts, script))
      expect(policy.checkCreate(body, new URLSearchParams(name ? { name } : {}), cfg(false, script), () => null)).toMatch(/HOST_RUNNER="on"/)
    })
  }
  it('a changed script is refused even when HOST_RUNNER=on', () => {
    const { body } = createBodyFromArgv(hostDockerArgs('operationkit-app:local', ['src-info', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'], {}, script + '\nid'))
    expect(policy.checkCreate(body, new URLSearchParams(), cfg(true, script), () => null)).toMatch(/script is not the one/)
  })
})
