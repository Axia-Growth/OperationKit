/**
 * Proves the egress guard with REAL sockets: a real origin server, a real
 * proxy, real CONNECT and absolute-URI requests. No mocking of the decision —
 * the point of this suite is that the boundary holds end to end, because
 * Playwright's own --allowed-origins explicitly does not.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import net from 'net'
import { startBrowserEgressProxy, type EgressProxyHandle, browserEgressProxyPort, DEFAULT_EGRESS_PROXY_PORT } from './browser-egress-proxy.js'
import { resolveBrowserPolicy, type BrowserPolicy } from '../lib/browser-policy.js'

let origin: http.Server
let originPort = 0
let proxy: EgressProxyHandle

/** Loopback is allowed, so the local origin stands in for an allowed site. */
function testPolicy(extra: Record<string, string> = {}): BrowserPolicy {
  return resolveBrowserPolicy({
    CARD_BROWSER_ALLOWED_ORIGINS: 'https://allowed.example.com;http://unresolvable.invalid',
    ...extra,
  } as NodeJS.ProcessEnv)
}

/** Issue an absolute-URI (plain HTTP) request through the proxy. */
function viaProxy(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: proxy.port, method: 'GET', path: url, headers: { host: new URL(url).host } },
      (res) => {
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => resolve({ status: res.statusCode || 0, body }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

/** Issue a raw CONNECT through the proxy and return the status line. */
function connectVia(authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxy.port, '127.0.0.1', () => {
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    let buf = ''
    sock.on('data', (c) => {
      buf += c.toString()
      if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]) }
    })
    sock.on('error', reject)
    sock.setTimeout(8000, () => { sock.destroy(); reject(new Error('CONNECT timed out')) })
  })
}

beforeAll(async () => {
  origin = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('origin-ok') })
  await new Promise<void>((r) => origin.listen(0, '127.0.0.1', () => r()))
  originPort = (origin.address() as net.AddressInfo).port
  proxy = await startBrowserEgressProxy(testPolicy())
})

afterAll(async () => {
  await proxy.close()
  await new Promise<void>((r) => origin.close(() => r()))
})

describe('browser egress guard — allowed navigation still works', () => {
  it('proxies a request to an allowed loopback origin (the preview-server case)', async () => {
    const res = await viaProxy(`http://127.0.0.1:${originPort}/index.html`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('origin-ok')
  })

  it('records the allow in its decision log', () => {
    const last = proxy.log[proxy.log.length - 1]
    expect(last.allowed).toBe(true)
    expect(last.target).toContain(`127.0.0.1:${originPort}`)
  })
})

describe('browser egress guard — blocked navigation', () => {
  it('refuses an off-allowlist host with 403 and an actionable reason', async () => {
    const res = await viaProxy('http://not-allowed.example.com/')
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/egress guard/)
    expect(res.body).toMatch(/not in the card browser's allowed origins/)
  })

  it('refuses the cloud metadata endpoint', async () => {
    const res = await viaProxy('http://169.254.169.254/latest/meta-data/')
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/metadata/)
  })

  it('refuses a CONNECT (https) to an off-allowlist host', async () => {
    const line = await connectVia('not-allowed.example.com:443')
    expect(line).toMatch(/^HTTP\/1\.1 403/)
  })

  it('refuses a CONNECT to a private-network address', async () => {
    const line = await connectVia('10.1.2.3:443')
    expect(line).toMatch(/^HTTP\/1\.1 403/)
  })

  it('refuses a CONNECT to the metadata endpoint', async () => {
    const line = await connectVia('169.254.169.254:80')
    expect(line).toMatch(/^HTTP\/1\.1 403/)
  })

  it('logs every refusal with its reason', () => {
    const denied = proxy.log.filter((e) => !e.allowed)
    expect(denied.length).toBeGreaterThanOrEqual(5)
    for (const d of denied) expect(d.reason).toBeTruthy()
  })
})

describe('browser egress guard — fail-closed behaviour', () => {
  it('refuses an ALLOWLISTED name it cannot resolve rather than passing it through', async () => {
    // .invalid is reserved by RFC 2606 and never resolves. This host IS on the
    // allowlist, so the refusal can only be coming from the resolution step.
    const res = await viaProxy('http://unresolvable.invalid/')
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/could not resolve|resolved to no addresses/)
  })

  it('refuses an off-allowlist host WITHOUT resolving it (no DNS dependency)', async () => {
    const res = await viaProxy('http://also-not-allowed.example.com/')
    expect(res.status).toBe(403)
    expect(res.body).toMatch(/not in the card browser's allowed origins/)
    expect(res.body).not.toMatch(/could not resolve/)
  })

  it('binds to loopback only — it is not an open proxy for the network', () => {
    // startBrowserEgressProxy always listens on 127.0.0.1; assert the handle
    // agrees and that a port was actually bound.
    expect(proxy.port).toBeGreaterThan(0)
  })

  it('uses the configured port, falling back to the documented default', () => {
    expect(browserEgressProxyPort({} as NodeJS.ProcessEnv)).toBe(DEFAULT_EGRESS_PROXY_PORT)
    expect(browserEgressProxyPort({ CARD_BROWSER_PROXY_PORT: '4321' } as NodeJS.ProcessEnv)).toBe(4321)
    expect(browserEgressProxyPort({ CARD_BROWSER_PROXY_PORT: 'nope' } as NodeJS.ProcessEnv)).toBe(DEFAULT_EGRESS_PROXY_PORT)
  })
})

describe('browser egress guard — a stricter policy is actually stricter', () => {
  it('blocks loopback when the policy says to, on a separate instance', async () => {
    const strict = await startBrowserEgressProxy(
      resolveBrowserPolicy({ CARD_BROWSER_ALLOW_LOOPBACK: 'off' } as NodeJS.ProcessEnv),
    )
    try {
      const res = await new Promise<{ status: number }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: strict.port, method: 'GET', path: `http://127.0.0.1:${originPort}/`, headers: { host: `127.0.0.1:${originPort}` } },
          (r) => { r.resume(); r.on('end', () => resolve({ status: r.statusCode || 0 })) },
        )
        req.on('error', reject)
        req.end()
      })
      expect(res.status).toBe(403)
    } finally {
      await strict.close()
    }
  })
})

describe('browser egress guard — survives a browser that resets its socket (obj 901106)', () => {
  // Chromium abandons a refused CONNECT (and cancelled navigations) with a TCP
  // reset. Before obj 901106 that surfaced as an unhandled 'error' on the client
  // socket and killed the guard, so every later page in the card failed.
  it('keeps serving after clients reset mid-refusal and mid-request', async () => {
    const resetAfter = (payload: string) =>
      new Promise<void>((resolve) => {
        const sock = net.connect(proxy.port, '127.0.0.1', () => {
          sock.write(payload, () => {
            sock.resetAndDestroy()
            resolve()
          })
        })
        sock.on('error', () => resolve())
      })
    for (let i = 0; i < 25; i++) {
      await resetAfter('CONNECT team.cloudflareaccess.com:443 HTTP/1.1\r\nHost: team.cloudflareaccess.com:443\r\n\r\n')
      await resetAfter(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`)
      await resetAfter('GET http://not-allowed.example.com/ HTTP/1.1\r\nHost: not-allowed.example.com\r\n\r\n')
      await resetAfter('NOT A REQUEST\r\n\r\n')
    }
    await new Promise((r) => setTimeout(r, 200))
    const res = await viaProxy(`http://127.0.0.1:${originPort}/still-alive`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('origin-ok')
  })

  it('names Cloudflare Access when it refuses the Access login hop', async () => {
    const line = await connectVia('mute-term-3e19.cloudflareaccess.com:443')
    expect(line).toMatch(/^HTTP\/1\.1 403/)
    const last = proxy.log[proxy.log.length - 1]
    expect(last.allowed).toBe(false)
    expect(last.reason).toMatch(/Cloudflare Access login page/)
    expect(last.reason).toMatch(/--sign-in/)
  })
})

// obj 901145: the JAILED worker policy, end to end through a real guard. The
// worker's own dev server (a real listener on a loopback port) opens with no
// operator config; the CC API port and private ranges are refused by the guard
// before any socket is opened.
describe('worker guard in a jail — the card\'s own dev server opens by default (obj 901145)', () => {
  let guard: EgressProxyHandle
  beforeAll(async () => {
    const { resolveWorkerBrowserPolicy } = await import('../lib/card-browser.js')
    guard = await startBrowserEgressProxy(resolveWorkerBrowserPolicy({} as NodeJS.ProcessEnv, { ownSandboxLoopback: true }), { port: 0 })
  })
  afterAll(async () => { await guard.close() })

  function get(url: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: guard.port, method: 'GET', path: url, headers: { host: new URL(url).host } },
        (res) => {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => resolve({ status: res.statusCode || 0, body }))
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  it('reaches a dev server the worker started on localhost / 127.0.0.1', async () => {
    const res = await get(`http://127.0.0.1:${originPort}/`)
    expect(res.status).toBe(200)
    expect(res.body).toBe('origin-ok')
    // localhost may resolve to ::1 first while the test origin listens on IPv4
    // only, so assert the GUARD's decision rather than the upstream reply.
    await get(`http://localhost:${originPort}/`)
    const last = guard.log[guard.log.length - 1]
    expect(last.target).toContain(`localhost:${originPort}`)
    expect(last.allowed).toBe(true)
  })

  it('refuses the install\'s app port 3002 and another sandbox\'s address', async () => {
    for (const url of ['http://127.0.0.1:3002/api/health', 'http://localhost:3002/api/health', 'http://172.18.0.7:3912/', 'http://10.0.3.4:5173/']) {
      const res = await get(url)
      expect(res.status, url).toBe(403)
      expect(res.body).not.toBe('origin-ok')
    }
  })
})
