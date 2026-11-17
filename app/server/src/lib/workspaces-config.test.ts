import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { readWorkspacesConfig, filterWorkspacesConfig } from './workspaces-config.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wscfg-'))

describe('readWorkspacesConfig (obj 901202)', () => {
  it('reads a missing file as an empty roster — fresh install, not a 404', () => {
    expect(readWorkspacesConfig(path.join(tmp(), 'workspaces.json'))).toEqual({ workspaces: {} })
  })

  it('returns the parsed config', () => {
    const f = path.join(tmp(), 'workspaces.json')
    fs.writeFileSync(f, JSON.stringify({ workspaces: { a: { projects: ['x'] } }, version: 2 }))
    expect(readWorkspacesConfig(f)).toEqual({ workspaces: { a: { projects: ['x'] } }, version: 2 })
  })

  it('fills a missing workspaces map with {}', () => {
    const f = path.join(tmp(), 'workspaces.json')
    fs.writeFileSync(f, JSON.stringify({ version: 1 }))
    expect(readWorkspacesConfig(f)).toEqual({ version: 1, workspaces: {} })
  })

  it('treats an unparseable file as a failure, never as an empty roster', () => {
    const f = path.join(tmp(), 'workspaces.json')
    fs.writeFileSync(f, '{not json')
    expect(readWorkspacesConfig(f)).toBeNull()
    fs.writeFileSync(f, '[]')
    expect(readWorkspacesConfig(f)).toBeNull()
  })

  it('treats an unreadable path (a directory) as a failure', () => {
    expect(readWorkspacesConfig(tmp())).toBeNull()
  })
})

describe('filterWorkspacesConfig', () => {
  const cfg = { workspaces: { a: 1, b: 2 }, version: 3 }
  it('passes everything through for an admin (null allow-list)', () => {
    expect(filterWorkspacesConfig(cfg, null)).toEqual(cfg)
  })
  it('keeps only the allowed workspaces and the other keys', () => {
    expect(filterWorkspacesConfig(cfg, new Set(['b']))).toEqual({ workspaces: { b: 2 }, version: 3 })
  })
})
