import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// obj 901080: every card link the server hands out uses the install's real host.
const TMP_DB = path.join(os.tmpdir(), `cc-public-url-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const { initDb, getDb } = await import('../db/index.js')
const { resolvePublicBaseUrl, publicCardUrl, toPublicBase, isPlaceholderHost, PUBLIC_URL_SETTING } = await import('./public-url.js')

beforeAll(() => { initDb() })
afterAll(() => {
  try { getDb().close() } catch {}
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
})

function setSetting(key: string, value: string | null) {
  const db = getDb()
  db.prepare('DELETE FROM settings WHERE key = ?').run(key)
  if (value !== null) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, value)
}

describe('resolvePublicBaseUrl', () => {
  it('an install that only sets OK_DOMAIN (all install.sh writes) gets https://<domain>', () => {
    expect(resolvePublicBaseUrl({ OK_DOMAIN: 'ops.acme.test' }, getDb())).toBe('https://ops.acme.test')
    expect(publicCardUrl(901075, { OK_DOMAIN: 'ops.acme.test' }, getDb())).toBe('https://ops.acme.test/o/901075')
  })

  it('explicit URLs win, in order, and trailing slashes are trimmed', () => {
    expect(resolvePublicBaseUrl({ CC_PUBLIC_URL: 'https://a.test/', APP_BASE_URL: 'https://b.test', OK_DOMAIN: 'c.test' }, getDb())).toBe('https://a.test')
    expect(resolvePublicBaseUrl({ APP_BASE_URL: 'https://b.test//', OK_DOMAIN: 'c.test' }, getDb())).toBe('https://b.test')
    expect(resolvePublicBaseUrl({ APP_URL: 'https://d.test', OK_DOMAIN: 'c.test' }, getDb())).toBe('https://d.test')
  })

  it('OK_DOMAIN=localhost is not a public host: falls through to settings / CORS', () => {
    setSetting(PUBLIC_URL_SETTING, 'https://from-setting.test')
    expect(resolvePublicBaseUrl({ OK_DOMAIN: 'localhost' }, getDb())).toBe('https://from-setting.test')
    setSetting(PUBLIC_URL_SETTING, null)
    expect(resolvePublicBaseUrl({ OK_DOMAIN: 'localhost', CORS_ORIGINS: 'http://localhost:5173,https://cors.test' }, getDb())).toBe('https://cors.test')
  })

  it('never invents a placeholder domain: with nothing configured it is the local server', () => {
    const url = resolvePublicBaseUrl({ PORT: '3912' }, getDb())
    expect(url).toBe('http://localhost:3912')
    expect(url).not.toMatch(/example\.com/)
  })

  it('a placeholder-only CORS list (the live default) resolves to localhost, not cc.example.com (obj 901089)', () => {
    setSetting(PUBLIC_URL_SETTING, null)
    const live = 'https://cc.example.com,http://localhost:5173,http://localhost:3002'
    expect(resolvePublicBaseUrl({ PORT: '3002', CORS_ORIGINS: live }, getDb())).toBe('http://localhost:3002')
    // same list via the install_cors_origins setting, no env
    setSetting('install_cors_origins', live)
    expect(resolvePublicBaseUrl({ PORT: '3002' }, getDb())).toBe('http://localhost:3002')
    setSetting('install_cors_origins', null)
  })

  it('a placeholder followed by a real origin resolves to the real one', () => {
    setSetting(PUBLIC_URL_SETTING, null)
    expect(resolvePublicBaseUrl({ CORS_ORIGINS: 'https://cc.example.com,https://example.org,https://ops.acme.test' }, getDb())).toBe('https://ops.acme.test')
  })

  it('an install_public_url placeholder is skipped too and falls through to CORS', () => {
    setSetting(PUBLIC_URL_SETTING, 'https://cc.example.net')
    expect(resolvePublicBaseUrl({ CORS_ORIGINS: 'https://real.acme.test' }, getDb())).toBe('https://real.acme.test')
    setSetting(PUBLIC_URL_SETTING, null)
  })

  it('isPlaceholderHost covers RFC 2606 domains and their subdomains only', () => {
    for (const h of ['example.com', 'cc.example.com', 'EXAMPLE.ORG', 'a.b.example.net', 'example.com.']) expect(isPlaceholderHost(h)).toBe(true)
    for (const h of ['notexample.com', 'example.co', 'example.com.evil.test', 'ops.acme.test']) expect(isPlaceholderHost(h)).toBe(false)
  })

  it('toPublicBase rejects junk and non-http schemes', () => {
    expect(toPublicBase('')).toBeNull()
    expect(toPublicBase('ftp://x.test')).toBeNull()
    expect(toPublicBase('http://localhost:3002')).toBeNull()
    expect(toPublicBase('http://localhost:3002', { allowLocal: true })).toBe('http://localhost:3002')
    expect(toPublicBase('host.test/app/')).toBe('https://host.test/app')
  })
})

describe('every card-link builder uses it', () => {
  it('MCP / Agent API, webhook payloads and chat tools return the configured host', async () => {
    const saved = { ...process.env }
    for (const k of ['CC_PUBLIC_URL', 'APP_BASE_URL', 'APP_URL', 'PUBLIC_URL', 'CORS_ORIGINS']) delete process.env[k]
    process.env.OK_DOMAIN = 'ops.acme.test'
    try {
      const mcp = await import('../routes/agent-mcp.js')
      const hooks = await import('../services/agent-webhooks.js')
      expect(mcp.cardUrl(901075)).toBe('https://ops.acme.test/o/901075')
      expect(hooks.cardUrl(901075)).toBe('https://ops.acme.test/o/901075')
    } finally {
      process.env = saved
    }
  })

  it('no server source hardcodes a card-link host any more', () => {
    const SRC = path.resolve(import.meta.dirname, '..')
    const files = ['routes/agent-mcp.ts', 'services/agent-webhooks.ts', 'routes/objective-needs-secret.ts', 'connectors/dcr-routes.ts', 'services/agent-chat/tools.ts']
    for (const rel of files) {
      const src = fs.readFileSync(path.join(SRC, rel), 'utf8')
      expect(src, rel).not.toMatch(/(APP_BASE_URL|CC_PUBLIC_URL|APP_URL|PUBLIC_URL)\s*\|\|\s*'https?:/)
      expect(src, rel).not.toMatch(/\|\| 'https:\/\//)
    }
  })
})
