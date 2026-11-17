import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import http from 'http'
import express from 'express'
import { CONTENT_SECURITY_POLICY, DESIGN_FRAME_CSP, securityHeaders } from './security-headers.js'

let server!: http.Server
let baseUrl!: string

beforeAll(async () => {
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.get('/ping', (_req, res) => { res.json({ ok: true }) })
  app.get('/api/objectives/:id/design-frame', (_req, res) => { res.send('<html></html>') })
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('securityHeaders', () => {
  it('sets the baseline headers and hides X-Powered-By', async () => {
    const res = await fetch(`${baseUrl}/ping`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('permissions-policy')).toBe('camera=(), microphone=(), geolocation=()')
    expect(res.headers.get('content-security-policy')).toBe(CONTENT_SECURITY_POLICY)
    expect(res.headers.get('x-powered-by')).toBeNull()
    expect(CONTENT_SECURITY_POLICY).toContain("script-src 'self'")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-src 'self' https:")
    expect(CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'")
  })

  it('relaxes CSP and omits X-Frame-Options on the design-frame proxy', async () => {
    const res = await fetch(`${baseUrl}/api/objectives/12/design-frame`)
    expect(res.status).toBe(200)
    expect(res.headers.get('x-frame-options')).toBeNull()
    expect(res.headers.get('content-security-policy')).toBe(DESIGN_FRAME_CSP)
    expect(DESIGN_FRAME_CSP).toContain("style-src 'unsafe-inline' https:")
    expect(DESIGN_FRAME_CSP).toContain("script-src 'unsafe-inline'")
    expect(DESIGN_FRAME_CSP).not.toContain("script-src 'unsafe-inline' https:")
    expect(DESIGN_FRAME_CSP).toContain("base-uri https: 'self'")
    expect(DESIGN_FRAME_CSP).toContain("frame-ancestors 'self'")
  })
})

// obj 901199: index.html used to carry an inline pre-paint theme script, which
// the app's own `script-src 'self'` blocked on every load. Keep the shell free of
// inline scripts (and the CSP free of 'unsafe-inline' / hashes for scripts).
describe('index.html vs the app CSP', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const clientDir = path.resolve(here, '../../../client')
  const html = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf-8')

  it('script-src stays self-only', () => {
    const scriptSrc = CONTENT_SECURITY_POLICY.split('; ').find(d => d.startsWith('script-src '))
    expect(scriptSrc).toBe("script-src 'self'")
  })

  it('has no inline <script> (every script has a same-origin src)', () => {
    const tags = html.match(/<script\b[^>]*>/gi) ?? []
    expect(tags.length).toBeGreaterThan(0)
    for (const tag of tags) expect(tag, tag).toMatch(/\ssrc="\/[^/]/)
    expect(html).not.toMatch(/\son[a-z]+\s*=/i)
  })

  it('loads the pre-paint theme script blocking, in <head>, before the app shell', () => {
    const head = html.slice(0, html.indexOf('</head>'))
    expect(head).toContain('<script src="/theme-init.js"></script>')
    expect(fs.existsSync(path.join(clientDir, 'public', 'theme-init.js'))).toBe(true)
  })
})
