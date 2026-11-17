/**
 * obj 900023 — the Cloudflare Access sync token never reaches the browser bundle.
 *
 * The token is write-only by design: the browser sends it once and no API sends
 * it back. This guards the other way a credential leaks into a client: being
 * baked in at build time. No client source may name the server's token env var
 * or its secrets-store key, or read a Cloudflare credential from import.meta.env.
 * When a production build exists (CI builds after tests; locally run
 * `npm run build --workspace=client`), the built assets are checked too.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const CLIENT = path.resolve(__dirname, '../../..')
const FORBIDDEN = ['OK_CF_ACCESS_API_TOKEN', 'CC_SERVER_CF_ACCESS_SYNC_TOKEN', 'CLOUDFLARE_ACCESS_SYNC_TOKEN']

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, exts, out) } else if (exts.test(e.name)) out.push(p)
  }
  return out
}

describe('Cloudflare sync token stays out of the client bundle', () => {
  it('no client source names the token variable or store key (tests excluded)', () => {
    const files = walk(path.join(CLIENT, 'src'), /\.(tsx?|jsx?|css|html)$/).filter(f => !/\.test\.tsx?$/.test(f))
    expect(files.length).toBeGreaterThan(50)
    const hits = files.flatMap(f => FORBIDDEN.filter(k => fs.readFileSync(f, 'utf8').includes(k)).map(k => `${path.relative(CLIENT, f)}: ${k}`))
    expect(hits).toEqual([])
  })

  it('no client source reads a Cloudflare credential from the build env', () => {
    const files = walk(path.join(CLIENT, 'src'), /\.(tsx?|jsx?)$/).filter(f => !/\.test\.tsx?$/.test(f))
    const hits = files.filter(f => /import\.meta\.env\.[A-Z_]*(CF|CLOUDFLARE)[A-Z_]*/.test(fs.readFileSync(f, 'utf8')))
    expect(hits).toEqual([])
  })

  it('a built bundle (when present) carries none of them either', () => {
    const assets = walk(path.join(CLIENT, 'dist'), /\.(js|css|html|map)$/)
    const hits = assets.flatMap(f => FORBIDDEN.filter(k => fs.readFileSync(f, 'utf8').includes(k)).map(k => `${path.relative(CLIENT, f)}: ${k}`))
    expect(hits).toEqual([])
  })
})
