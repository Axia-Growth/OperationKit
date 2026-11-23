import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveInstallPaths, LEGACY_APP_HOME } from './config.js'

// obj 901032: with no path env vars set, the server's folders used to default to
// one operator's home (/home/operator/...), so a fresh install failed with ENOENT the
// first time it tried to write there (enabling a starter pack: mkdir
// '/home/operator/ai-workspace/agents').

const PATH_VARS = ['USER_HOME', 'PROJECTS_DIR', 'AI_WORKSPACE_DIR', 'SECOND_BRAIN_DIR', 'TRANSCRIPT_DIR', 'ASSISTANT_DIR'] as const
const FRESH = { legacyHomeExists: false, userHome: '/srv/okuser', dataDir: '/var/lib/ok/data' }

describe('resolveInstallPaths (obj 901032)', () => {
  it('a fresh install with no path env vars resolves under the current user home, never the legacy home', () => {
    const p = resolveInstallPaths({}, FRESH)
    expect(p).toEqual({
      HOME_DIR: '/srv/okuser',
      PROJECTS_DIR: '/srv/okuser/projects',
      AI_WORKSPACE_DIR: '/srv/okuser/ai-workspace',
      SECOND_BRAIN_DIR: '/srv/okuser/second-brain',
      TRANSCRIPT_DIR: '/srv/okuser/transcripts',
      ASSISTANT_DIR: '/srv/okuser/assistant',
    })
    for (const v of Object.values(p)) expect(v.startsWith(LEGACY_APP_HOME)).toBe(false)
  })

  it('a process with no usable home falls back to a home folder in the data directory', () => {
    for (const userHome of ['', '/']) {
      const p = resolveInstallPaths({}, { ...FRESH, userHome })
      expect(p.HOME_DIR).toBe('/var/lib/ok/data/home')
      expect(p.AI_WORKSPACE_DIR).toBe('/var/lib/ok/data/home/ai-workspace')
    }
  })

  it('explicit env vars always win, so a host that sets them is unchanged', () => {
    const env = {
      USER_HOME: '/h', PROJECTS_DIR: '/p', AI_WORKSPACE_DIR: '/a',
      SECOND_BRAIN_DIR: '/s', TRANSCRIPT_DIR: '/t', ASSISTANT_DIR: '/as',
    }
    for (const legacyHomeExists of [true, false]) {
      expect(resolveInstallPaths(env, { ...FRESH, legacyHomeExists })).toEqual({
        HOME_DIR: '/h', PROJECTS_DIR: '/p', AI_WORKSPACE_DIR: '/a',
        SECOND_BRAIN_DIR: '/s', TRANSCRIPT_DIR: '/t', ASSISTANT_DIR: '/as',
      })
    }
  })

  it('USER_HOME alone moves every unset path under it', () => {
    const p = resolveInstallPaths({ USER_HOME: '/opt/ok/home', AI_WORKSPACE_DIR: '/data/aiw' }, FRESH)
    expect(p.HOME_DIR).toBe('/opt/ok/home')
    expect(p.PROJECTS_DIR).toBe('/opt/ok/home/projects')
    expect(p.AI_WORKSPACE_DIR).toBe('/data/aiw')
  })

  it('blank env values count as unset', () => {
    expect(resolveInstallPaths({ USER_HOME: '  ', AI_WORKSPACE_DIR: '' }, FRESH).AI_WORKSPACE_DIR).toBe('/srv/okuser/ai-workspace')
  })

  it('an install set up against the old default (its legacy home exists) keeps exactly its old paths', () => {
    const p = resolveInstallPaths({}, { ...FRESH, legacyHomeExists: true })
    expect(p).toEqual({
      HOME_DIR: LEGACY_APP_HOME,
      PROJECTS_DIR: `${LEGACY_APP_HOME}/projects`,
      AI_WORKSPACE_DIR: `${LEGACY_APP_HOME}/ai-workspace`,
      SECOND_BRAIN_DIR: `${LEGACY_APP_HOME}/second-brain`,
      TRANSCRIPT_DIR: `${LEGACY_APP_HOME}/transcripts`,
      ASSISTANT_DIR: `${LEGACY_APP_HOME}/assistant`,
    })
  })

  it('install/lib.sh app_home() can still read the legacy home literal from config.ts', () => {
    const src = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'config.ts'), 'utf8')
    const m = src.match(/^export const LEGACY_APP_HOME = '([^']*)'/m)
    expect(m?.[1]).toBe(LEGACY_APP_HOME)
  })
})

describe('config module defaults on a machine without the legacy home (obj 901032)', () => {
  const saved: Record<string, string | undefined> = {}
  afterEach(() => {
    for (const k of [...PATH_VARS, 'HOME']) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
    vi.resetModules()
  })

  it.skipIf(fs.existsSync(LEGACY_APP_HOME))('with no path env vars, every exported folder is under the current user home', async () => {
    for (const k of [...PATH_VARS, 'HOME']) saved[k] = process.env[k]
    for (const k of PATH_VARS) delete process.env[k]
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cfg-home-'))
    process.env.HOME = home
    vi.resetModules()
    const cfg = await import('./config.js')
    expect(cfg.HOME_DIR).toBe(home)
    expect(cfg.AI_WORKSPACE_DIR).toBe(path.join(home, 'ai-workspace'))
    expect(cfg.AGENTS_DIR).toBe(path.join(home, 'ai-workspace', 'agents'))
    for (const v of [cfg.PROJECTS_DIR, cfg.AI_WORKSPACE_DIR, cfg.SECOND_BRAIN_DIR, cfg.TRANSCRIPT_DIR, cfg.ASSISTANT_DIR, cfg.HOME_DIR, cfg.AGENTS_DIR]) {
      expect(v.startsWith(LEGACY_APP_HOME)).toBe(false)
    }
    fs.rmSync(home, { recursive: true, force: true })
  })
})
