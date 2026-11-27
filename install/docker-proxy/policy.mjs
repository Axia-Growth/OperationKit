// install/docker-proxy/policy.mjs — the rules of the Docker policy sidecar
// (obj 901741, public issue #97).
//
// The app container used to mount /var/run/docker.sock, which is the same as
// host root: one `docker run --privileged -v /:/host` and the host is gone. The
// app only needs a small slice of the Docker API to manage card sandboxes
// ("jails"), so the socket now belongs to this sidecar and the app talks to it
// over a private network (DOCKER_HOST=tcp://docker-proxy:2375). Every request is
// decided HERE, by pure functions with no I/O, so the whole contract is unit
// tested (install/test/docker-proxy-test.mjs) and proved live against a real
// daemon (scripts/docker-proxy-proof.sh).
//
// The rules, in short:
//   * Only the endpoints the app uses are allowed; everything else is 403.
//   * A container create must be a JAIL: name ok-jail-<id>, label ok.objective,
//     an allow-listed image, a non-root user, CapDrop ALL, no-new-privileges,
//     a read-only root filesystem. Privileged, CapAdd, host network / pid / ipc /
//     uts / userns / cgroupns, devices, published ports, named volumes and any
//     bind outside OK_STATE are refused. Unknown HostConfig fields must be empty,
//     so a field Docker adds later is refused until someone reads it.
//   * Every per-container call (start, exec, rm, inspect, logs, attach, wait, …)
//     needs the target to carry the jail label; the server checks it against the
//     daemon before forwarding. `docker ps` only ever lists labelled containers.
//   * One narrow, OFF-by-default exception: the Operation Kit Dev host runner
//     (app/server/src/services/dev-ops/host-exec.ts). It is privileged by nature
//     (it nsenters the host to run install/update.sh), so it is allowed only when
//     the operator sets HOST_RUNNER=on, and only with the script text this sidecar
//     was shipped with, byte for byte, and the install's own source/config/data
//     paths. Anything else that asks for privileged is refused.

export const JAIL_LABEL = 'ok.objective'
export const HOST_RUNNER_LABEL = 'ok.host-runner'

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
const MIN_API_MINOR = 41

/** The only calls that may carry a request body (everything else: none at all). */
export const BODY_OPS = new Set(['container.create', 'exec.create', 'exec.start'])

// ── JSON shape guard ─────────────────────────────────────────────────────────
// Docker decodes request bodies with Go's encoding/json, which matches field
// names CASE-INSENSITIVELY (with Unicode folding: "\u017fource" is Source) and,
// for a repeated object key, MERGES the two objects. A check that reads
// body.HostConfig.Privileged would miss {"hostconfig":{"privileged":true}} or a
// second "HostConfig". So: (1) every key anywhere must be printable ASCII and no
// two keys in one object may be equal ignoring case, (2) every field is read
// case-insensitively with g(), and (3) the server forwards JSON.stringify of
// the parsed body it checked, never the raw bytes, so a duplicate key Go would
// have merged is gone before Docker sees it.

/** Reason string if the JSON tree has a key Docker could read differently, else null. */
export function checkKeys(v, where = 'body', depth = 0) {
  if (depth > 32) return `${where}: nested too deep`
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const e = checkKeys(v[i], `${where}[${i}]`, depth + 1)
      if (e) return e
    }
    return null
  }
  if (!v || typeof v !== 'object') return null
  const seen = new Set()
  for (const k of Object.keys(v)) {
    if (!/^[\x20-\x7e]*$/.test(k)) return `${where}: key ${JSON.stringify(k)} is not plain ASCII`
    const lk = k.toLowerCase()
    if (seen.has(lk)) return `${where}: key ${JSON.stringify(k)} appears twice (ignoring case)`
    seen.add(lk)
    const e = checkKeys(v[k], `${where}.${k}`, depth + 1)
    if (e) return e
  }
  return null
}

/** Read a struct field the way Go does: ignoring case. */
export function g(o, k) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return undefined
  if (Object.prototype.hasOwnProperty.call(o, k)) return o[k]
  const lk = k.toLowerCase()
  for (const key of Object.keys(o)) if (key.toLowerCase() === lk) return o[key]
  return undefined
}

function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
}

/** Split a comma list from the environment. */
function list(v, dflt) {
  const s = (v ?? dflt ?? '').trim()
  return s ? s.split(',').map(x => x.trim()).filter(Boolean) : []
}

function onOff(v, dflt) {
  const s = String(v ?? dflt).trim().toLowerCase()
  return s === 'on' || s === '1' || s === 'true' || s === 'yes'
}

/**
 * Policy configuration from the environment (install/docker-compose.yml sets it).
 * `bindRoots` are HOST paths; the sidecar mounts them read-only at the SAME path
 * so a bind source can be resolved (symlinks included) before Docker sees it.
 */
export function loadConfig(env = process.env) {
  const bindRoots = list(env.DOCKER_PROXY_BIND_ROOTS).map(p => p.replace(/\/+$/, ''))
  for (const r of bindRoots) {
    if (!r.startsWith('/') || r === '' || r.includes('..')) throw new Error(`DOCKER_PROXY_BIND_ROOTS entry must be an absolute path, got ${JSON.stringify(r)}`)
  }
  return {
    images: list(env.DOCKER_PROXY_IMAGES, 'ok-jail:local,ok-jail-browser:local'),
    networks: list(env.DOCKER_PROXY_NETWORKS, 'ok-jails'),
    namePrefix: (env.DOCKER_PROXY_NAME_PREFIX || 'ok-jail-').trim(),
    bindRoots,
    // Paths of the seccomp profiles a jail may use; the server loads them and
    // fills seccompProfiles with their canonical JSON (never from a request).
    seccompProfilePaths: list(env.DOCKER_PROXY_SECCOMP_PROFILES),
    seccompProfiles: [],
    hostRunner: {
      enabled: onOff(env.DOCKER_PROXY_HOST_RUNNER, 'off'),
      image: (env.DOCKER_PROXY_HOST_RUNNER_IMAGE || 'operationkit-app:local').trim(),
      scriptPath: (env.DOCKER_PROXY_HOST_RUNNER_SCRIPT || '').trim(),
      srcDir: (env.DOCKER_PROXY_HOST_RUNNER_SRC || '').trim().replace(/\/+$/, ''),
      configPath: (env.DOCKER_PROXY_HOST_RUNNER_CONF || '').trim(),
      hostDataDir: (env.DOCKER_PROXY_HOST_RUNNER_DATA || '').trim().replace(/\/+$/, ''),
      // Filled in by the server from scriptPath at start-up (never from a request).
      script: null,
    },
  }
}

// ── Routing ──────────────────────────────────────────────────────────────────

/**
 * Classify one request. Returns one of:
 *   { kind: 'allow' }                                  no further check
 *   { kind: 'create' }                                 body must pass checkCreate
 *   { kind: 'container', id, op, body? }               target must carry the label
 *   { kind: 'exec', execId, op }                       the exec's container must carry the label
 *   { kind: 'list' }                                   response filtered to labelled containers
 *   { kind: 'deny', reason }
 * `op` is used for the audit line. The API version prefix (/v1.47) is optional.
 */
export function classify(method, rawUrl) {
  // The raw path is matched as sent: no percent-encoding, no dot segments, no
  // empty segments, so this classification and Docker's router can never see
  // two different paths (URL parsing here would fold "/a/../b" to "/b").
  const rawPath = String(rawUrl).split('?')[0]
  if (!/^\/[A-Za-z0-9._:\/-]*$/.test(rawPath) || /\/\.\.?(\/|$)/.test(rawPath) || rawPath.includes('//')) {
    return { kind: 'deny', reason: 'request path is not a plain Docker API path' }
  }
  const u = new URL(rawUrl, 'http://docker')
  // Old API versions change what a call means (≤1.23 start takes a HostConfig
  // body; <1.41 create defaults to the host cgroup namespace). Floor: 1.41.
  const ver = /^\/v(\d+)(?:\.(\d+))?(?=\/)/.exec(u.pathname)
  if (ver && (Number(ver[1]) < 1 || (Number(ver[1]) === 1 && Number(ver[2] ?? 0) < MIN_API_MINOR))) {
    return { kind: 'deny', reason: `Docker API versions below 1.${MIN_API_MINOR} are not allowed` }
  }
  const path = u.pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, '')
  const m = method.toUpperCase()
  const seg = path.split('/').filter(Boolean)

  if ((m === 'GET' || m === 'HEAD') && path === '/_ping') return { kind: 'allow', op: 'ping' }
  if (m === 'GET' && path === '/version') return { kind: 'allow', op: 'version' }
  // `docker image inspect` (card-browser-spawn.ts asks whether the browser jail image exists).
  if (m === 'GET' && seg[0] === 'images' && seg.length >= 3 && seg[seg.length - 1] === 'json') return { kind: 'allow', op: 'image.inspect' }
  if (m === 'GET' && path === '/containers/json') return { kind: 'list', op: 'container.list' }
  if (m === 'POST' && path === '/containers/create') return { kind: 'create', op: 'container.create' }

  if (seg[0] === 'containers' && seg.length >= 2 && seg[1] !== 'json' && seg[1] !== 'create') {
    const id = seg[1]
    const action = seg.slice(2).join('/')
    const containerOps = {
      'GET json': 'container.inspect',
      'GET logs': 'container.logs',
      'POST start': 'container.start',
      'POST stop': 'container.stop',
      'POST kill': 'container.kill',
      'POST wait': 'container.wait',
      'POST attach': 'container.attach',
      'POST resize': 'container.resize',
      'POST exec': 'exec.create',
      'DELETE ': 'container.remove',
    }
    const op = containerOps[`${m} ${action}`]
    if (op) return { kind: 'container', id, op, query: u.searchParams }
    return { kind: 'deny', reason: `endpoint not allowed: ${m} /containers/{id}/${action}` }
  }

  if (seg[0] === 'exec' && seg.length === 3) {
    const execId = seg[1]
    const op = { 'POST start': 'exec.start', 'POST resize': 'exec.resize', 'GET json': 'exec.inspect' }[`${m} ${seg[2]}`]
    if (op) return { kind: 'exec', execId, op }
  }

  return { kind: 'deny', reason: `endpoint not allowed: ${m} ${path}` }
}

// ── Container create ─────────────────────────────────────────────────────────

/** Zero value as the Docker CLI sends it for an unused field (strict: see below). */
export function isEmpty(v) {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return true
  // A KEY is a value: {"22/tcp":[{}]} publishes a port, {"/data":{}} is a
  // volume, [{}] is a device request. Only a container with nothing in it is empty.
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v).length === 0
  return false
}

// HostConfig fields that may carry a value; each one is checked below or is a
// harmless resource / logging knob. ANY other HostConfig field must be empty, so
// a field Docker adds later is refused until someone has read what it does.
// (Lower-cased: Go matches field names ignoring case.)
const HOSTCONFIG_CHECKED = new Set([
  'binds', 'mounts', 'networkmode', 'capdrop', 'securityopt', 'readonlyrootfs',
  'restartpolicy', 'ipcmode', 'cgroupnsmode', 'tmpfs', 'autoremove', 'logconfig',
  // Only the host runner exception may set these (checkHostRunner).
  'privileged', 'pidmode',
])
const HOSTCONFIG_HARMLESS = new Set([
  'consolesize', 'init', 'shmsize', 'extrahosts', 'dns', 'dnsoptions', 'dnssearch',
  'oomscoreadj', 'oomkilldisable', 'isolation', 'ulimits',
  'cpushares', 'memory', 'nanocpus', 'cpuperiod', 'cpuquota', 'cpurealtimeperiod', 'cpurealtimeruntime',
  'cpusetcpus', 'cpusetmems', 'memoryreservation', 'memoryswap', 'memoryswappiness', 'pidslimit',
  'blkioweight', 'blkioweightdevice', 'cpucount', 'cpupercent', 'kernelmemory', 'kernelmemorytcp',
])
// An explicit [] here UNMASKS /proc paths (--security-opt systempaths=unconfined),
// so "empty" is not good enough: they must be absent or null.
const MUST_BE_NULL = new Set(['maskedpaths', 'readonlypaths'])

const CONFIG_HARMLESS = new Set([
  'hostname', 'domainname', 'user', 'attachstdin', 'attachstdout', 'attachstderr', 'exposedports',
  'tty', 'openstdin', 'stdinonce', 'env', 'cmd', 'healthcheck', 'argsescaped', 'image', 'workingdir',
  'entrypoint', 'networkdisabled', 'macaddress', 'onbuild', 'labels', 'stopsignal', 'stoptimeout', 'shell',
  'hostconfig', 'networkingconfig', 'volumes',
])

function isRootUser(user) {
  const u = String(user ?? '').trim()
  if (!u) return true // the image default; our jail images are non-root, but the request must say so
  // uid OR gid 0 / root: group root still opens root-group files on the binds.
  // Docker parses numbers with Go's strconv.Atoi, so "00", "+0" and "-0" are 0 too.
  return u.split(':').some(raw => {
    const part = raw.trim()
    if (part === 'root' || part === '') return true
    return /^[+-]?[0-9]+$/.test(part) && Number(part) === 0
  })
}

function normPath(p) {
  // posix normalisation without touching the filesystem
  const out = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return '/' + out.join('/')
}

/** Is `p` equal to or inside one of `roots`? Pure string check on normalised paths. */
export function underRoots(p, roots) {
  return roots.some(r => p === r || p.startsWith(r.endsWith('/') ? r : r + '/'))
}

/**
 * Check one bind source. `resolve(path)` returns the real path (symlinks
 * followed) or null if it does not exist; the server passes fs.realpathSync
 * over the sidecar's read-only view of the roots.
 */
export function checkBindSource(source, cfg, resolve) {
  if (typeof source !== 'string' || !source.startsWith('/')) return `bind source must be an absolute host path (named volumes are not allowed): ${JSON.stringify(source)}`
  if (source.includes('\0')) return 'bind source holds a NUL byte'
  if (!cfg.bindRoots.length) return 'no bind roots are configured (DOCKER_PROXY_BIND_ROOTS), so no bind is allowed'
  const n = normPath(source)
  if (n !== source.replace(/\/+$/, '') && n !== source) return `bind source must be a normalised path: ${source}`
  if (!underRoots(n, cfg.bindRoots)) return `bind source ${n} is outside OK_STATE (${cfg.bindRoots.join(', ')})`
  if (n.includes('docker.sock')) return 'bind source may not be the docker socket'
  if (resolve) {
    const real = resolve(n)
    if (!real) return `bind source ${n} does not exist`
    const realRoots = cfg.bindRoots.map(r => resolve(r) || r)
    if (!underRoots(real, realRoots)) return `bind source ${n} resolves to ${real}, outside OK_STATE`
  }
  return null
}

function checkSecurityOpt(opts, cfg) {
  const items = Array.isArray(opts) ? opts : []
  let nnp = false
  for (const o of items) {
    const s = String(o)
    if (/^no-new-privileges(?:[:=]true)?$/.test(s)) { nnp = true; continue }
    if (s.startsWith('seccomp=') || s.startsWith('seccomp:')) {
      const v = s.slice('seccomp='.length).trim()
      if (/^unconfined$/i.test(v)) return 'seccomp=unconfined is not allowed'
      let profile
      try { profile = JSON.parse(v) } catch { return 'seccomp profile must be inline JSON (the docker CLI reads the file)' }
      // Only a profile this install ships (the browser jail's), compared as
      // parsed JSON. Not "anything that is not allow-all": Go folds duplicate
      // keys and SCMP_ACT_LOG allows everything too, so a rule cannot decide it.
      const shape = checkKeys(profile, 'seccomp profile')
      if (shape) return shape
      const canon = JSON.stringify(profile)
      if (!(cfg.seccompProfiles || []).includes(canon)) return 'only the seccomp profiles this install ships are allowed'
      continue
    }
    return `security option not allowed: ${s.slice(0, 80)}`
  }
  if (!nnp) return 'no-new-privileges is required'
  return null
}

function checkNetwork(mode, cfg) {
  const m = String(mode ?? '')
  if (m === '' || m === 'default' || m === 'bridge' || m === 'none') return null
  if (cfg.networks.includes(m)) return null
  if (m === 'host') return 'host network is not allowed'
  if (m.startsWith('container:')) return 'sharing another container\'s network is not allowed'
  return `network ${JSON.stringify(m)} is not allowed (allowed: ${['bridge', ...cfg.networks].join(', ')})`
}

function labelsOf(body) {
  return obj(g(body, 'Labels'))
}

/**
 * Decide a POST /containers/create. `query` is the URLSearchParams of the
 * request (the container name rides there). Returns null when allowed, else a
 * human-readable reason. The caller must forward JSON.stringify(body).
 */
export function checkCreate(body, query, cfg, resolve) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'create body must be a JSON object'
  const shape = checkKeys(body)
  if (shape) return shape
  const hc = obj(g(body, 'HostConfig'))
  const labels = labelsOf(body)

  if (g(hc, 'Privileged') || String(g(hc, 'PidMode') ?? '') !== '' || labels[HOST_RUNNER_LABEL] !== undefined) {
    return checkHostRunner(body, query, cfg)
  }

  for (const k of Object.keys(body)) {
    if (!CONFIG_HARMLESS.has(k.toLowerCase()) && !isEmpty(body[k])) return `container field not allowed: ${k}`
  }
  for (const k of Object.keys(hc)) {
    const lk = k.toLowerCase()
    if (MUST_BE_NULL.has(lk)) {
      if (hc[k] !== null && hc[k] !== undefined) return `HostConfig.${k} may not be changed`
      continue
    }
    if (HOSTCONFIG_CHECKED.has(lk) || HOSTCONFIG_HARMLESS.has(lk)) continue
    if (!isEmpty(hc[k])) return `HostConfig.${k} is not allowed`
  }

  // Identity: a jail, by name, label and image.
  const name = String(query?.get?.('name') ?? '').replace(/^\//, '')
  if (!name.startsWith(cfg.namePrefix) || !ID_RE.test(name.slice(cfg.namePrefix.length))) {
    return `container name must be ${cfg.namePrefix}<id>, got ${JSON.stringify(name)}`
  }
  const jailId = labels[JAIL_LABEL]
  if (typeof jailId !== 'string' || !ID_RE.test(jailId)) return `label ${JAIL_LABEL} is required on every container`
  const image = String(g(body, 'Image') ?? '')
  if (!cfg.images.includes(image)) return `image ${JSON.stringify(image)} is not allowed (allowed: ${cfg.images.join(', ')})`

  // The jail contract (app/server/src/services/session-jail.ts buildJailRunArgv).
  if (isRootUser(g(body, 'User'))) return 'the container must run as a non-root user'
  if (!isEmpty(g(hc, 'CapAdd'))) return 'CapAdd is not allowed'
  const capDrop = g(hc, 'CapDrop')
  if (!Array.isArray(capDrop) || !capDrop.some(c => String(c).toUpperCase() === 'ALL')) return 'CapDrop must include ALL'
  const sec = checkSecurityOpt(g(hc, 'SecurityOpt'), cfg)
  if (sec) return sec
  if (g(hc, 'ReadonlyRootfs') !== true) return 'the root filesystem must be read-only'
  const net = checkNetwork(g(hc, 'NetworkMode'), cfg)
  if (net) return net
  const eps = obj(g(obj(g(body, 'NetworkingConfig')), 'EndpointsConfig'))
  for (const n of Object.keys(eps)) {
    const e = checkNetwork(n, cfg)
    if (e) return e
  }
  const ipc = String(g(hc, 'IpcMode') ?? '')
  if (!['', 'private', 'shareable', 'none'].includes(ipc)) return `IpcMode ${JSON.stringify(ipc)} is not allowed`
  const cgns = String(g(hc, 'CgroupnsMode') ?? '')
  if (!['', 'private'].includes(cgns)) return `CgroupnsMode ${JSON.stringify(cgns)} is not allowed`
  // A logging driver runs IN THE DAEMON: fluentd / gelf / syslog / awslogs dial
  // out from the host. Only the local file drivers, with no options.
  const logc = obj(g(hc, 'LogConfig'))
  if (!['', 'json-file', 'local'].includes(String(g(logc, 'Type') ?? ''))) return `log driver ${JSON.stringify(g(logc, 'Type'))} is not allowed`
  if (!isEmpty(g(logc, 'Config'))) return 'log driver options are not allowed'
  const rp = String(g(obj(g(hc, 'RestartPolicy')), 'Name') ?? '')
  if (rp !== '' && rp !== 'no') return 'a restart policy is not allowed (jails end with their session)'
  if (!isEmpty(g(body, 'Volumes'))) return 'anonymous volumes are not allowed'

  const binds = g(hc, 'Binds')
  for (const b of Array.isArray(binds) ? binds : []) {
    const parts = String(b).split(':')
    if (parts.length < 2 || !parts[1]) return `a bind needs source:target, got ${JSON.stringify(b)}`
    if (/(^|,)r?shared($|,)/.test(parts.slice(2).join(':'))) return 'shared bind propagation is not allowed'
    const e = checkBindSource(parts[0], cfg, resolve)
    if (e) return e
  }
  const mounts = g(hc, 'Mounts')
  for (const mnt of Array.isArray(mounts) ? mounts : []) {
    const type = String(g(mnt, 'Type') ?? '')
    if (type === 'tmpfs') continue
    if (type !== 'bind') return `mount type ${JSON.stringify(type)} is not allowed (bind inside OK_STATE and tmpfs only)`
    const bo = obj(g(mnt, 'BindOptions'))
    const prop = String(g(bo, 'Propagation') ?? '')
    if (prop === 'shared' || prop === 'rshared') return 'shared bind propagation is not allowed'
    if (g(bo, 'CreateMountpoint')) return 'CreateMountpoint is not allowed'
    const e = checkBindSource(g(mnt, 'Source'), cfg, resolve)
    if (e) return e
  }
  return null
}

/**
 * Re-check the bind sources of a created container (its inspect HostConfig)
 * just before it starts: Docker resolves them at start, not at create.
 */
export function checkStartBinds(hc, cfg, resolve) {
  const binds = g(hc, 'Binds')
  for (const b of Array.isArray(binds) ? binds : []) {
    const e = checkBindSource(String(b).split(':')[0], cfg, resolve)
    if (e) return `at start: ${e}`
  }
  const mounts = g(hc, 'Mounts')
  for (const mnt of Array.isArray(mounts) ? mounts : []) {
    const type = String(g(mnt, 'Type') ?? '')
    if (type === 'tmpfs') continue
    if (type !== 'bind') return `at start: mount type ${JSON.stringify(type)} is not allowed`
    const e = checkBindSource(g(mnt, 'Source'), cfg, resolve)
    if (e) return `at start: ${e}`
  }
  return null
}

/**
 * After checkCreate passed for a jail: pin what an empty field would leave to
 * the daemon's default. CgroupnsMode "" means the HOST cgroup namespace on a
 * cgroup v1 host, so a jail always gets "private". Mutates the body the server
 * then forwards.
 */
export function normalizeJailCreate(body) {
  const hcKey = Object.keys(body).find(k => k.toLowerCase() === 'hostconfig')
  if (!hcKey || !body[hcKey] || typeof body[hcKey] !== 'object') return body
  const hc = body[hcKey]
  const k = Object.keys(hc).find(x => x.toLowerCase() === 'cgroupnsmode') ?? 'CgroupnsMode'
  if (!hc[k]) hc[k] = 'private'
  return body
}

// ── The Dev host runner exception (opt-in) ───────────────────────────────────

const HR_PREFIX = ['-t', '1', '-m', '-u', '-i', '-n', '-p', '--', 'bash', '-c']
const HR_CF_OPS = new Set(['access-list', 'access-add', 'access-remove', 'dns-list', 'dns-upsert', 'dns-delete', 'cf-run'])
const HTTPS_URL = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[A-Za-z0-9._/-]*$/
// The only top-level fields the host runner's create may carry (lower-cased).
const HR_CONFIG = new Set(['image', 'entrypoint', 'cmd', 'labels', 'hostconfig', 'networkingconfig',
  'attachstdin', 'attachstdout', 'attachstderr', 'openstdin', 'stdinonce'])
// The only HostConfig fields the host runner's `docker run` may carry.
const HR_HOSTCONFIG = new Set(['privileged', 'pidmode', 'networkmode', 'autoremove', 'consolesize', 'restartpolicy'])

/** The privileged nsenter helper of services/dev-ops/host-exec.ts, pinned exactly. */
export function checkHostRunner(body, query, cfg) {
  const hr = cfg.hostRunner
  if (!hr.enabled) {
    return 'privileged / host-namespace containers are not allowed. The only exception is the Operation Kit Dev host runner, which is off on this install (set HOST_RUNNER="on" in client.conf and re-run install.sh to allow it)'
  }
  if (!hr.script || !hr.srcDir || !hr.configPath || !hr.hostDataDir) return 'the host runner is on but its script or install paths are not configured'
  const hc = obj(g(body, 'HostConfig'))
  const labels = labelsOf(body)
  if (labels[HOST_RUNNER_LABEL] !== '1') return `the host runner must carry label ${HOST_RUNNER_LABEL}=1`
  if (labels[JAIL_LABEL] !== undefined) return 'the host runner may not carry the jail label'
  if (g(body, 'Image') !== hr.image) return `the host runner must use image ${hr.image}`
  const ep = g(body, 'Entrypoint')
  if (!Array.isArray(ep) || ep.length !== 1 || ep[0] !== 'nsenter') return 'the host runner entrypoint must be nsenter'
  const rawCmd = g(body, 'Cmd')
  const cmd = Array.isArray(rawCmd) ? rawCmd.map(String) : []
  for (let i = 0; i < HR_PREFIX.length; i++) if (cmd[i] !== HR_PREFIX[i]) return 'the host runner command is not the pinned nsenter call'
  if (cmd[HR_PREFIX.length] !== hr.script) return 'the host runner script is not the one this install shipped'
  if (cmd[HR_PREFIX.length + 1] !== 'ok-dev-ops') return 'the host runner command is not the pinned nsenter call'
  const [action, src, conf, ...rest] = cmd.slice(HR_PREFIX.length + 2)
  if (src !== hr.srcDir || conf !== hr.configPath) return 'the host runner may only use this install\'s own source folder and config'
  if (action === 'deploy') {
    const [id, health, data, ...extra] = rest
    if (extra.length || !/^[0-9]{1,12}$/.test(id ?? '') || !HTTPS_URL.test(health ?? '') || data !== hr.hostDataDir) return 'bad host runner deploy arguments'
  } else if (action === 'src-info' || HR_CF_OPS.has(action)) {
    if (rest.length) return 'bad host runner arguments'
  } else {
    return `host runner action not allowed: ${JSON.stringify(action)}`
  }
  const name = String(query?.get?.('name') ?? '').replace(/^\//, '')
  if (name && !/^ok-dev-ops-[a-z]+-[0-9]{1,12}$/.test(name)) return 'bad host runner container name'
  for (const k of Object.keys(hc)) {
    const lk = k.toLowerCase()
    if (MUST_BE_NULL.has(lk) || lk === 'logconfig') continue // privileged already unmasks /proc; log driver checked below
    if (!HR_HOSTCONFIG.has(lk) && !HOSTCONFIG_HARMLESS.has(lk) && !isEmpty(hc[k])) return `the host runner may not set HostConfig.${k}`
  }
  const hrLog = obj(g(hc, 'LogConfig'))
  if (!['', 'json-file', 'local'].includes(String(g(hrLog, 'Type') ?? '')) || !isEmpty(g(hrLog, 'Config'))) return 'the host runner may not change the log driver'
  const hrRp = String(g(obj(g(hc, 'RestartPolicy')), 'Name') ?? '')
  if (hrRp !== '' && hrRp !== 'no') return 'the host runner may not have a restart policy'
  // Its OWN allow-list, not CONFIG_HARMLESS: on a privileged container in the
  // host's namespaces a Healthcheck runs any command as host root, and Env
  // (BASH_ENV, BASH_FUNC_*, PATH) rewrites what the pinned script does.
  for (const k of Object.keys(body)) {
    if (!HR_CONFIG.has(k.toLowerCase()) && !isEmpty(body[k])) return `the host runner may not set ${k}`
  }
  const ec = obj(g(obj(g(body, 'NetworkingConfig')), 'EndpointsConfig'))
  for (const [n, v] of Object.entries(ec)) {
    if (!['host', 'default', 'bridge'].includes(n) || !isEmpty(v)) return 'bad host runner network settings'
  }
  if (String(g(hc, 'PidMode') ?? '') !== 'host') return 'the host runner must use the host pid namespace'
  if (!['', 'host', 'default', 'bridge'].includes(String(g(hc, 'NetworkMode') ?? ''))) return 'bad host runner network'
  return null
}

// ── Labels, exec, list ───────────────────────────────────────────────────────

/** May the app act on a container with these labels? */
/** A Dev host runner container (privileged, host namespaces). */
export function isHostRunner(labels) {
  const l = labels && typeof labels === 'object' ? labels : {}
  return l[HOST_RUNNER_LABEL] === '1' && l[JAIL_LABEL] === undefined
}

/**
 * Container calls allowed on a host runner. Never exec: an exec into a
 * privileged container in the host's namespaces is host root with any command,
 * which is exactly what the pinned script exists to prevent.
 */
export const HOST_RUNNER_OPS = new Set(['container.inspect', 'container.logs', 'container.start', 'container.stop', 'container.kill', 'container.wait', 'container.attach', 'container.resize', 'container.remove'])

export function labelAllowed(labels, cfg) {
  const l = labels && typeof labels === 'object' ? labels : {}
  if (typeof l[JAIL_LABEL] === 'string' && ID_RE.test(l[JAIL_LABEL])) return true
  if (cfg.hostRunner.enabled && l[HOST_RUNNER_LABEL] === '1') return true
  return false
}

/** Decide a POST /containers/{id}/exec body (the container label is checked separately). */
export function checkExecCreate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'exec body must be a JSON object'
  const shape = checkKeys(body)
  if (shape) return shape
  if (g(body, 'Privileged')) return 'privileged exec is not allowed'
  // '' = the container's own user, which the create check already made non-root.
  const user = String(g(body, 'User') ?? '')
  if (user !== '' && isRootUser(user)) return 'exec as root is not allowed'
  return null
}

/** Decide a POST /exec/{id}/start body: {Detach, Tty, ConsoleSize} and nothing else. */
export function checkExecStart(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'exec start body must be a JSON object'
  const shape = checkKeys(body)
  if (shape) return shape
  for (const k of Object.keys(body)) {
    if (!['detach', 'tty', 'consolesize'].includes(k.toLowerCase())) return `exec start field not allowed: ${k}`
  }
  return null
}

/** Keep only containers the app may touch in a `docker ps` answer. */
export function filterList(arr, cfg) {
  return Array.isArray(arr) ? arr.filter(c => labelAllowed(g(c, 'Labels'), cfg)) : []
}
