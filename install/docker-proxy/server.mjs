// install/docker-proxy/server.mjs — the Docker policy sidecar (obj 901741, issue #97).
//
// Owns the host Docker socket and serves a FILTERED Docker API on a private
// network. The app sets DOCKER_HOST=tcp://docker-proxy:2375 and keeps using the
// docker CLI exactly as before; every request is decided by policy.mjs.
//
// No dependencies (node: builtins only), so it runs from the app image that the
// installer already builds, with this folder mounted read-only — the app
// container has no write path to it.
//
// Audit: one JSON line per call, to stdout (docker logs ok-docker-proxy) and,
// when DOCKER_PROXY_AUDIT_LOG is set, appended to that file (rotated at 50 MB,
// one old copy kept). The file lives on the host outside every app mount.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { BODY_OPS, HOST_RUNNER_OPS, checkExecStart, checkCreate, isHostRunner as hostRunnerLabels, normalizeJailCreate, checkExecCreate, checkStartBinds, classify, filterList, g, isHostRunner, labelAllowed, loadConfig } from './policy.mjs'

const MAX_BODY = 8 * 1024 * 1024
const AUDIT_ROTATE_BYTES = 50 * 1024 * 1024

export function createProxy(opts = {}) {
  const env = opts.env ?? process.env
  const cfg = opts.config ?? loadConfig(env)
  const upstream = opts.upstream ?? env.DOCKER_PROXY_UPSTREAM ?? '/var/run/docker.sock'
  const auditPath = opts.auditLog ?? env.DOCKER_PROXY_AUDIT_LOG ?? ''
  const resolve = opts.resolve ?? (p => { try { return fs.realpathSync(p) } catch { return null } })
  const quiet = !!opts.quiet

  for (const p of cfg.seccompProfilePaths || []) {
    try { cfg.seccompProfiles.push(JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8')))) } catch (err) {
      console.error(`[docker-proxy] seccomp profile ${p} cannot be read: ${err.message} — a jail asking for it will be refused`)
    }
  }
  if (cfg.hostRunner.enabled && !cfg.hostRunner.script && cfg.hostRunner.scriptPath) {
    try { cfg.hostRunner.script = fs.readFileSync(cfg.hostRunner.scriptPath, 'utf8') } catch (err) {
      console.error(`[docker-proxy] HOST_RUNNER is on but ${cfg.hostRunner.scriptPath} cannot be read: ${err.message} — every host runner request will be refused`)
    }
  }

  function audit(entry) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry })
    if (!quiet) process.stdout.write(line + '\n')
    if (auditPath) {
      try {
        try { if (fs.statSync(auditPath).size > AUDIT_ROTATE_BYTES) fs.renameSync(auditPath, auditPath + '.1') } catch { /* new file */ }
        fs.appendFileSync(auditPath, line + '\n', { mode: 0o640 })
      } catch (err) {
        if (!quiet) process.stderr.write(`[docker-proxy] audit write failed: ${err.message}\n`)
      }
    }
    opts.onAudit?.(entry)
  }

  /** One request to the real daemon; resolves {status, headers, body(Buffer)}. */
  function upstreamJson(method, p) {
    return new Promise((res, rej) => {
      const r = http.request({ socketPath: upstream, method, path: p, headers: { Host: 'docker' } }, resp => {
        const chunks = []
        resp.on('data', c => chunks.push(c))
        resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }))
        resp.on('error', rej)
      })
      r.on('error', rej)
      r.end()
    })
  }

  /** Labels of a container, or {status, body} when the daemon says it is not there. */
  async function containerLabels(id) {
    const r = await upstreamJson('GET', `/containers/${id}/json`)
    if (r.status !== 200) return { missing: r }
    let j
    try { j = JSON.parse(r.body.toString('utf8')) } catch { return { missing: { status: 502, body: Buffer.from('{"message":"docker-proxy: unreadable inspect"}') } } }
    return { labels: g(g(j, 'Config'), 'Labels') || {}, name: String(g(j, 'Name') || '').replace(/^\//, ''), hostConfig: g(j, 'HostConfig') || {}, startedAt: String(g(g(j, 'State'), 'StartedAt') || '') }
  }

  /**
   * Decide one request. Returns {allow:true, body?, target?, filter?} or
   * {allow:false, status, message} — never throws for a policy reason.
   */
  async function decide(req, readBody) {
    const c = classify(req.method, req.url)
    if (c.kind === 'deny') return { allow: false, status: 403, message: c.reason, op: 'denied' }
    // Only create and exec create carry a body, and theirs are re-serialised.
    // Any other body is refused, never streamed through: a GET or DELETE body
    // is not framed for Docker and would be parsed as the NEXT request.
    if (!BODY_OPS.has(c.op)) {
      const raw = await readBody()
      if (raw.length) return { allow: false, status: 400, message: `${c.op ?? 'this call'} takes no request body`, op: c.op ?? 'denied' }
    }
    if (c.kind === 'allow') return { allow: true, op: c.op }
    if (c.kind === 'list') return { allow: true, op: c.op, filter: true }
    if (c.kind === 'create') {
      const raw = await readBody()
      let body
      try { body = JSON.parse(raw.toString('utf8') || '{}') } catch { return { allow: false, status: 400, message: 'create body is not JSON', op: c.op } }
      const q = new URL(req.url, 'http://docker').searchParams
      const why = checkCreate(body, q, cfg, resolve)
      const labels = g(body, 'Labels') || {}
      const target = { name: q.get('name') || '', image: String(g(body, 'Image') ?? ''), objective: labels['ok.objective'] ?? null, host_runner: labels['ok.host-runner'] === '1' || undefined }
      if (why) return { allow: false, status: 403, message: why, op: c.op, target }
      // Forward exactly what was checked (see policy.mjs checkKeys).
      if (!hostRunnerLabels(labels)) normalizeJailCreate(body)
      return { allow: true, op: c.op, body: Buffer.from(JSON.stringify(body)), target }
    }
    if (c.kind === 'container') {
      let body
      if (c.op === 'exec.create') {
        const raw = await readBody()
        let parsed
        try { parsed = JSON.parse(raw.toString('utf8') || '{}') } catch { return { allow: false, status: 400, message: 'exec body is not JSON', op: c.op } }
        const why = checkExecCreate(parsed)
        if (why) return { allow: false, status: 403, message: why, op: c.op, target: { container: c.id } }
        body = Buffer.from(JSON.stringify(parsed))
      }
      const info = await containerLabels(c.id)
      if (info.missing) return { allow: false, status: info.missing.status, raw: info.missing.body, message: 'no such container', op: c.op, target: { container: c.id } }
      if (!labelAllowed(info.labels, cfg)) return { allow: false, status: 403, message: `container ${info.name || c.id} has no jail label (ok.objective); the app may not touch it`, op: c.op, target: { container: c.id } }
      if (isHostRunner(info.labels) && !HOST_RUNNER_OPS.has(c.op)) {
        return { allow: false, status: 403, message: `${c.op} is not allowed on the Dev host runner (it runs in the host's namespaces)`, op: c.op, target: { container: info.name || c.id } }
      }
      if (c.op === 'container.start' && !isHostRunner(info.labels) && info.startedAt && !info.startedAt.startsWith('0001-')) {
        // A jail runs once (--restart no; the app never restarts one). Refusing
        // a second start also stops "start, swap a bind source, start again" retries.
        return { allow: false, status: 403, message: 'a jail is started only once', op: c.op, target: { container: info.name || c.id } }
      }
      if (c.op === 'container.start' && !isHostRunner(info.labels)) {
        // Docker resolves bind sources at START. The app can write inside
        // OK_STATE, so check them again here (symlinks followed): a folder
        // swapped for a symlink since the create is refused.
        const why = checkStartBinds(info.hostConfig, cfg, resolve)
        if (why) return { allow: false, status: 403, message: why, op: c.op, target: { container: info.name || c.id } }
      }
      return { allow: true, op: c.op, body, target: { container: info.name || c.id, objective: info.labels['ok.objective'] ?? null } }
    }
    if (c.kind === 'exec') {
      const r = await upstreamJson('GET', `/exec/${c.execId}/json`)
      if (r.status !== 200) return { allow: false, status: r.status, raw: r.body, message: 'no such exec', op: c.op }
      let cid = ''
      try { cid = String(g(JSON.parse(r.body.toString('utf8')), 'ContainerID') || '') } catch { /* below */ }
      if (!/^[a-f0-9]{12,64}$/.test(cid)) return { allow: false, status: 502, message: 'exec has no readable container', op: c.op }
      const info = await containerLabels(cid)
      if (info.missing || !labelAllowed(info.labels, cfg) || isHostRunner(info.labels)) return { allow: false, status: 403, message: 'exec belongs to a container without the jail label', op: c.op, target: { exec: c.execId } }
      let body
      if (c.op === 'exec.start') {
        const raw = await readBody()
        let parsed
        try { parsed = JSON.parse(raw.toString('utf8') || '{}') } catch { return { allow: false, status: 400, message: 'exec start body is not JSON', op: c.op } }
        const why = checkExecStart(parsed)
        if (why) return { allow: false, status: 403, message: why, op: c.op }
        body = Buffer.from(JSON.stringify(parsed))
      }
      return { allow: true, op: c.op, body, target: { container: info.name || cid, objective: info.labels['ok.objective'] ?? null } }
    }
    return { allow: false, status: 403, message: 'not allowed', op: 'denied' }
  }

  function readBodyOf(req) {
    let p
    return () => p ?? (p = new Promise((res, rej) => {
      const chunks = []
      let n = 0
      req.on('data', c => {
        n += c.length
        if (n > MAX_BODY) { rej(new Error('body too large')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => res(Buffer.concat(chunks)))
      req.on('error', rej)
    }))
  }

  function forwardHeaders(req, body) {
    const h = { ...req.headers }
    delete h['content-length']
    delete h['transfer-encoding']
    if (body) h['content-length'] = String(body.length)
    return h
  }

  function sendDeny(res, d) {
    const payload = d.raw ?? Buffer.from(JSON.stringify({ message: `docker-proxy: ${d.message}` }))
    res.writeHead(d.status, { 'Content-Type': 'application/json', 'Content-Length': payload.length })
    res.end(payload)
  }

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now()
    const base = { method: req.method, path: req.url }
    let d
    try {
      d = await decide(req, readBodyOf(req))
    } catch (err) {
      d = { allow: false, status: 400, message: err.message, op: 'error' }
    }
    if (!d.allow) {
      audit({ ...base, op: d.op, decision: 'deny', status: d.status, reason: d.message, target: d.target })
      sendDeny(res, d)
      return
    }
    const fwd = http.request({ socketPath: upstream, method: req.method, path: req.url, headers: forwardHeaders(req, d.body) }, up => {
      if (d.filter && up.statusCode === 200) {
        const chunks = []
        up.on('data', c => chunks.push(c))
        up.on('end', () => {
          let out
          try { out = Buffer.from(JSON.stringify(filterList(JSON.parse(Buffer.concat(chunks).toString('utf8')), cfg))) } catch { out = Buffer.from('[]') }
          const h = { ...up.headers, 'content-length': String(out.length) }
          delete h['transfer-encoding']
          res.writeHead(200, h)
          res.end(out)
          audit({ ...base, op: d.op, decision: 'allow', status: 200, ms: Date.now() - t0 })
        })
        return
      }
      res.writeHead(up.statusCode ?? 502, up.headers)
      // Send the headers NOW, not with the first body byte: `docker run`
      // (CLI 29) opens wait?condition=next-exit and only sends start once the
      // daemon has answered it; a wait's body comes when the container exits.
      res.flushHeaders()
      up.pipe(res)
      up.on('end', () => audit({ ...base, op: d.op, decision: 'allow', status: up.statusCode, target: d.target, ms: Date.now() - t0 }))
    })
    fwd.on('error', err => {
      audit({ ...base, op: d.op, decision: 'allow', status: 502, reason: `upstream: ${err.message}` })
      if (!res.headersSent) sendDeny(res, { status: 502, message: `upstream: ${err.message}` })
      else res.destroy()
    })
    // Never stream the client's body: d.body is the checked one, else none.
    fwd.end(d.body ?? undefined)
  })

  // attach and exec start switch the connection to a raw stream
  // ("Connection: Upgrade, Upgrade: tcp"). The splice is the one place bytes
  // reach Docker without Node parsing them as requests, so it is fenced:
  //   * only those two calls may upgrade, with a fixed-length body (no chunked);
  //   * exactly ONE request (head + Content-Length body) is written to Docker;
  //   * anything else the client sends is HELD until Docker answers 101 — only
  //     then is the connection a raw stream. Any other answer (an error, a
  //     daemon that did not hijack) goes back to the client and both sides are
  //     closed, so a request pipelined behind it is never parsed by Docker.
  const UPGRADE_OPS = new Set(['container.attach', 'exec.start'])
  const MAX_UPGRADE_BODY = 64 * 1024
  server.on('upgrade', async (req, sock, head) => {
    const base = { method: req.method, path: req.url, upgrade: true }
    sock.pause()
    let pending = head?.length ? Buffer.from(head) : Buffer.alloc(0)
    const onEarly = c => { pending = Buffer.concat([pending, c]) }
    sock.on('data', onEarly)
    let d
    try {
      d = await decide(req, async () => Buffer.alloc(0))
      if (d.allow && !UPGRADE_OPS.has(d.op)) d = { allow: false, status: 403, message: `${d.op} cannot be an upgrade (stream) request`, op: d.op, target: d.target }
      // exec start's own body rides the stream below (fixed Content-Length,
      // forwarded once, before Docker's answer); no other checked body may.
      if (d.allow && d.body && d.op !== 'exec.start') d = { allow: false, status: 403, message: 'a checked body cannot ride an upgrade request', op: d.op }
    } catch (err) {
      d = { allow: false, status: 400, message: err.message, op: 'error' }
    }
    const bodyLen = Number(req.headers['content-length'] || 0)
    if (d.allow && (req.headers['transfer-encoding'] || !Number.isInteger(bodyLen) || bodyLen < 0 || bodyLen > MAX_UPGRADE_BODY)) {
      d = { allow: false, status: 400, message: 'a stream request needs a small Content-Length body (no chunked encoding)', op: d.op, target: d.target }
    }
    if (!d.allow) {
      audit({ ...base, op: d.op, decision: 'deny', status: d.status, reason: d.message, target: d.target })
      const payload = JSON.stringify({ message: `docker-proxy: ${d.message}` })
      sock.removeListener('data', onEarly)
      sock.end(`HTTP/1.1 ${d.status} Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`)
      return
    }
    audit({ ...base, op: d.op, decision: 'allow', target: d.target })

    const up = net.connect(upstream)
    const done = () => { sock.destroy(); up.destroy() }
    up.on('error', done)
    sock.on('error', done)
    sock.on('close', () => up.destroy())
    sock.resume()

    // 1. the request body, exactly bodyLen bytes; the rest stays pending.
    const sendRequest = () => {
      let bodyBuf = pending.subarray(0, bodyLen)
      pending = pending.subarray(bodyLen)
      if (bodyLen > 0) {
        // Same rule as the plain path: parse, check, forward our serialisation.
        let parsed
        try { parsed = JSON.parse(bodyBuf.toString('utf8')) } catch { parsed = null }
        const why = parsed === null ? 'stream request body is not JSON' : (d.op === 'exec.start' ? checkExecStart(parsed) : 'this stream call takes no body')
        if (why) {
          audit({ ...base, op: d.op, decision: 'deny', status: 403, reason: why, target: d.target })
          const payload = JSON.stringify({ message: `docker-proxy: ${why}` })
          sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`)
          up.destroy()
          return
        }
        bodyBuf = Buffer.from(JSON.stringify(parsed))
      }
      let headText = `${req.method} ${req.url} HTTP/1.1\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]
        if (/^(content-length|transfer-encoding)$/i.test(k)) continue
        headText += `${k}: ${req.rawHeaders[i + 1]}\r\n`
      }
      headText += `Content-Length: ${bodyBuf.length}\r\n\r\n`
      up.write(Buffer.concat([Buffer.from(headText, 'latin1'), bodyBuf]))
    }
    let sent = false
    const trySend = () => { if (!sent && pending.length >= bodyLen) { sent = true; sendRequest() } }
    up.on('connect', trySend)
    sock.on('data', () => { if (up.readyState === 'open') trySend() })

    // 2. Docker's answer decides whether this becomes a raw stream.
    let answer = Buffer.alloc(0)
    const onAnswer = c => {
      answer = Buffer.concat([answer, c])
      const end = answer.indexOf('\r\n\r\n')
      if (end < 0) { if (answer.length > 64 * 1024) done(); return }
      up.removeListener('data', onAnswer)
      const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(answer.subarray(0, end).toString('latin1')) || [])[1])
      sock.write(answer)
      if (status === 101) {
        sock.removeListener('data', onEarly)
        if (pending.length) up.write(pending)
        pending = Buffer.alloc(0)
        sock.pipe(up)
        up.pipe(sock)
        up.on('close', () => sock.end())
      } else {
        // Not hijacked: relay the rest of this one answer, then close both. The
        // held client bytes are dropped, never written to Docker.
        sock.removeListener('data', onEarly)
        sock.on('data', () => {})
        up.pipe(sock)
        up.on('end', () => sock.end())
        up.end()
        setTimeout(done, 10_000).unref()
      }
    }
    up.on('data', onAnswer)
  })

  return { server, config: cfg }
}

// Run as a program: node server.mjs
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/server.mjs')) {
  const listen = process.env.DOCKER_PROXY_LISTEN || '0.0.0.0:2375'
  const idx = listen.lastIndexOf(':')
  const host = listen.slice(0, idx)
  const port = Number(listen.slice(idx + 1))
  const auditLog = process.env.DOCKER_PROXY_AUDIT_LOG
  if (auditLog) { try { fs.mkdirSync(path.dirname(auditLog), { recursive: true }) } catch { /* reported on first write */ } }
  const { server, config } = createProxy()
  server.listen(port, host, () => {
    console.log(JSON.stringify({
      ts: new Date().toISOString(), op: 'start', listen, upstream: process.env.DOCKER_PROXY_UPSTREAM || '/var/run/docker.sock',
      images: config.images, networks: config.networks, bind_roots: config.bindRoots,
      host_runner: config.hostRunner.enabled ? (config.hostRunner.script ? 'on' : 'on, script missing') : 'off',
    }))
  })
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)))
}
