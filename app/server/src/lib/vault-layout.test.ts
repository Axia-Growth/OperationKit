/**
 * obj 900967 — the vault layout registry.
 *
 * Two promises:
 *  1. With the default `kb_capture_layout` every generated prompt, path and
 *     matcher is BYTE-IDENTICAL to what the callers produced before this module
 *     existed. `__fixtures__/vault-layout-baseline.json` was generated from the
 *     pre-change `buildVaultCaptureBlock` / `vaultDecisionsPath` on main
 *     (199c44bb) and is compared verbatim; the two matchers are compared to the
 *     literals they replaced.
 *  2. With `log-by-month` the capture path is `log/YYYY-MM/` and the capture-gap
 *     detector accepts a doc written there.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import {
  activeFile,
  captureDir,
  captureDocPattern,
  captureLayout,
  captureMonth,
  captureSubdir,
  decisionsDir,
  indexFile,
  isCapturePath,
  knowledgePathMarkers,
  KB_CAPTURE_LAYOUT_SETTING,
  MONTH_PLACEHOLDER,
  parseCaptureLayout,
  workspaceDir,
} from './vault-layout.js'
import { buildVaultCaptureBlock, vaultCapturePath, vaultDecisionsPath } from '../services/kb-access-prompt.js'
import { isCaptureGap } from '../services/session-intel-pipeline.js'

const BASELINE: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, '__fixtures__', 'vault-layout-baseline.json'), 'utf8'),
)
const WORKSPACES = ['example', 'personal', null] as const
const NOV = new Date('2026-11-17T23:59:59Z')

function settingsDb(value?: string): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  if (value !== undefined) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(KB_CAPTURE_LAYOUT_SETTING, value)
  return db
}

describe('vault-layout paths', () => {
  it('names the folders the server used to spell out itself', () => {
    expect(workspaceDir('example')).toBe('workspaces/example')
    expect(workspaceDir('personal')).toBe('personal')
    expect(workspaceDir(null)).toBe('personal')
    expect(workspaceDir(undefined)).toBe('personal')
    expect(decisionsDir('example')).toBe('workspaces/example/decisions')
    expect(decisionsDir(null)).toBe('personal/decisions')
    expect(activeFile('example')).toBe('workspaces/example/active.md')
    expect(activeFile('personal')).toBe('personal/active.md')
    expect(indexFile('example')).toBe('workspaces/example/index.md')
    expect(indexFile(null)).toBe('personal/index.md')
  })

  it('captureDir is the decisions folder by default, whatever the date', () => {
    for (const ws of WORKSPACES) {
      expect(captureDir(ws, NOV, 'decisions')).toBe(decisionsDir(ws))
      expect(captureDir(ws, MONTH_PLACEHOLDER, 'decisions')).toBe(decisionsDir(ws))
    }
    expect(captureSubdir(NOV, 'decisions')).toBe('decisions')
  })

  it('captureDir is log/YYYY-MM under log-by-month (UTC month)', () => {
    expect(captureDir('example', NOV, 'log-by-month')).toBe('workspaces/example/log/2026-11')
    expect(captureDir(null, NOV, 'log-by-month')).toBe('personal/log/2026-11')
    expect(captureDir('example', new Date('2026-12-01T00:00:00Z'), 'log-by-month')).toBe('workspaces/example/log/2026-12')
    expect(captureDir('example', MONTH_PLACEHOLDER, 'log-by-month')).toBe('workspaces/example/log/YYYY-MM')
    expect(captureSubdir(NOV, 'log-by-month')).toBe('log/2026-11')
    expect(captureMonth(NOV)).toBe('2026-11')
  })

  it('log-by-month changes nothing but captureDir', () => {
    // decisionsDir / activeFile / indexFile take no layout at all; this pins that.
    expect(decisionsDir('example')).toBe('workspaces/example/decisions')
    expect(decisionsDir.length).toBe(1)
    expect(activeFile.length).toBe(1)
    expect(indexFile.length).toBe(1)
  })
})

describe('kb_capture_layout setting', () => {
  it('defaults to decisions when unset, empty, unknown, or there is no DB', () => {
    expect(parseCaptureLayout(undefined)).toBe('decisions')
    expect(parseCaptureLayout('')).toBe('decisions')
    expect(parseCaptureLayout('by-quarter')).toBe('decisions')
    expect(captureLayout(settingsDb())).toBe('decisions')
    expect(captureLayout(settingsDb('nonsense'))).toBe('decisions')
    expect(captureLayout(new Database(':memory:'))).toBe('decisions') // no settings table
  })

  it('reads log-by-month from the settings row', () => {
    expect(captureLayout(settingsDb('log-by-month'))).toBe('log-by-month')
    expect(captureLayout(settingsDb(' Log-By-Month '))).toBe('log-by-month')
    expect(captureLayout(settingsDb('decisions'))).toBe('decisions')
  })
})

describe('default layout is byte-identical to before the registry (snapshot)', () => {
  it('capture prompt, tmux and jailed, for every workspace shape', () => {
    for (const ws of WORKSPACES) {
      for (const jailed of [false, true]) {
        const key = `capture:${ws}:${jailed ? 'jailed' : 'tmux'}`
        expect(BASELINE[key], key).toBeTypeOf('string')
        expect(buildVaultCaptureBlock({ id: 1, workspace: ws as never }, jailed, 'decisions').join('\n'), key).toBe(BASELINE[key])
        // ...and through the default argument (no settings row = default layout).
        expect(buildVaultCaptureBlock({ id: 1, workspace: ws as never }, jailed).join('\n'), key).toBe(BASELINE[key])
      }
    }
  })

  it('vault decisions path', () => {
    for (const ws of WORKSPACES) {
      expect(vaultDecisionsPath(ws)).toBe(BASELINE[`path:${ws}`])
      expect(vaultCapturePath(ws, 'decisions')).toBe(BASELINE[`path:${ws}`])
    }
  })

  it('capture-gap regex is the literal session-intel-pipeline.ts had', () => {
    const before = /(?:^|\/)second-brain\/.*\/decisions\/[^/]+\.md$/
    expect(captureDocPattern('decisions').source).toBe(before.source)
    expect(captureDocPattern('decisions').flags).toBe(before.flags)
  })

  it('poller markers are the literal KNOWLEDGE_PATHS poller-worker.ts had', () => {
    expect(knowledgePathMarkers('decisions')).toEqual([
      'second-brain/personal/decisions/',
      'second-brain/workspaces/',
      'second-brain/personal/insights/',
    ])
  })

  it("isCapturePath is the old filePath.includes('/decisions/')", () => {
    const paths = [
      '/home/operator/second-brain/workspaces/example/decisions/2026-11-17-x.md',
      '/home/operator/second-brain/personal/decisions/x.md',
      '/home/operator/second-brain/workspaces/example/log/2026-11/2026-11-17-x.md',
      '/home/operator/second-brain/personal/insights/x.md',
      '/home/operator/second-brain/workspaces/example/decisions.md',
    ]
    for (const p of paths) expect(isCapturePath(p, 'decisions'), p).toBe(p.includes('/decisions/'))
  })

  it('a log/YYYY-MM doc does NOT clear a capture gap under the default layout', () => {
    expect(isCaptureGap(1, null, ['/home/operator/second-brain/workspaces/example/log/2026-11/2026-11-17-x.md'], 'decisions')).toBe(true)
  })
})

describe('log-by-month layout', () => {
  const LOG_DOC = '/home/operator/second-brain/workspaces/example/log/2026-11/2026-11-17-some-choice.md'

  it('tmux capture prompt points at log/YYYY-MM/', () => {
    const text = buildVaultCaptureBlock({ id: 1, workspace: 'example' }, false, 'log-by-month').join('\n')
    expect(text).toContain('write a decision doc to ~/second-brain/workspaces/example/log/YYYY-MM/YYYY-MM-DD-<slug>.md before')
    expect(text).toContain('no `/log/YYYY-MM/*.md` write occurred.')
    expect(text).not.toContain('decisions/')
    expect(vaultCapturePath('example', 'log-by-month')).toBe('~/second-brain/workspaces/example/log/YYYY-MM/')
    expect(vaultCapturePath(null, 'log-by-month')).toBe('~/second-brain/personal/log/YYYY-MM/')
    // The decisions folder itself does not move.
    expect(vaultDecisionsPath('example')).toBe('~/second-brain/workspaces/example/decisions/')
  })

  it('jailed capture prompt PUTs into log/<month of the file name>/', () => {
    const text = buildVaultCaptureBlock({ id: 1, workspace: 'example' }, true, 'log-by-month').join('\n')
    expect(text).toContain('PUT the file into its `log/YYYY-MM/` subfolder:')
    expect(text).toContain('path:process.argv[1]+"/log/"+process.argv[2].slice(0,7)+"/"+process.argv[2]')
    expect(text).not.toContain('decisions/')
    // The expression the prompt ships really yields <kb>/log/2026-11/<file>.
    const argv = ['node', '/kb/workspaces/example', '2026-11-17-some-choice.md']
    expect(argv[1] + '/log/' + argv[2].slice(0, 7) + '/' + argv[2]).toBe('/kb/workspaces/example/log/2026-11/2026-11-17-some-choice.md')
  })

  it('the only lines that differ from the default prompt are the ones naming the folder', () => {
    for (const jailed of [false, true]) {
      const a = buildVaultCaptureBlock({ id: 1, workspace: 'example' }, jailed, 'decisions')
      const b = buildVaultCaptureBlock({ id: 1, workspace: 'example' }, jailed, 'log-by-month')
      expect(b.length).toBe(a.length)
      const changed = a.filter((line, i) => line !== b[i])
      expect(changed.length).toBe(jailed ? 3 : 2)
      for (const line of changed) expect(line).toContain('decisions/')
    }
  })

  it('the capture-gap detector accepts a log/YYYY-MM doc', () => {
    expect(isCaptureGap(2, null, [LOG_DOC], 'log-by-month')).toBe(false)
    expect(isCaptureGap(2, null, ['/home/operator/second-brain/personal/log/2026-11/x.md'], 'log-by-month')).toBe(false)
    expect(captureDocPattern('log-by-month').test(LOG_DOC)).toBe(true)
  })

  it('...still accepts a decisions/ doc, and still flags everything else', () => {
    expect(isCaptureGap(2, null, ['/home/operator/second-brain/workspaces/example/decisions/2026-11-17-x.md'], 'log-by-month')).toBe(false)
    for (const miss of [
      '/home/operator/ai-workspace/objective-memory/1/NOTES.md',
      '/home/operator/second-brain/workspaces/example/log/2026-11/notes.txt',
      '/home/operator/second-brain/workspaces/example/log/2026-11/sub/x.md',
      '/home/operator/second-brain/workspaces/example/log/latest/x.md',
      '/home/operator/second-brain/workspaces/example/log.md',
      '/home/operator/projects/app/log/2026-11/x.md',
    ]) {
      expect(isCaptureGap(2, null, [miss], 'log-by-month'), miss).toBe(true)
    }
    // Routine and zero-decision rules are untouched by the layout.
    expect(isCaptureGap(2, 792, [], 'log-by-month')).toBe(false)
    expect(isCaptureGap(0, null, [], 'log-by-month')).toBe(false)
  })

  it('the live poller scan sees a log/YYYY-MM write as a decision capture', () => {
    expect(knowledgePathMarkers('log-by-month')).toEqual([
      'second-brain/personal/decisions/',
      'second-brain/workspaces/',
      'second-brain/personal/insights/',
      'second-brain/personal/log/',
    ])
    expect(isCapturePath(LOG_DOC, 'log-by-month')).toBe(true)
    expect(isCapturePath('/home/operator/second-brain/personal/log/2026-11/x.md', 'log-by-month')).toBe(true)
    expect(isCapturePath('/home/operator/second-brain/workspaces/example/decisions/x.md', 'log-by-month')).toBe(true)
    expect(isCapturePath('/home/operator/second-brain/personal/insights/x.md', 'log-by-month')).toBe(false)
  })
})
