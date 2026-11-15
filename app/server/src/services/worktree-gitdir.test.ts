/**
 * obj 900829 — card worker's git worktree pointer was broken (found in #900821).
 *
 * Two regressions are pinned here with REAL git repositories in a temp dir:
 *   1. a jailed card's `.git` pointer named a gitdir the jail never mounted, so
 *      git was dead inside every jail — buildJailRunArgv must now mount it;
 *   2. ensureWorktree reused any worktree whose `.git` merely existed, so a
 *      pruned/rewritten pointer was handed to the card on every restart — the
 *      session-start guard must now repair it or recreate the worktree.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// session-worktree pulls in the tmux/pty stack; nothing here spawns a terminal.
vi.mock('node-pty', () => ({ default: {}, spawn: () => { throw new Error('no pty in tests') } }))
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  checkWorktreePointer,
  repairWorktreePointer,
  resolveCommonDir,
  resolveJailGitMount,
  jailGitSafeDirEnv,
  jailGitWritablePaths,
  parseGitPointer,
} from './worktree-gitdir.js'
import { validateExistingWorktree, presetBranchUpstream } from './session-worktree.js'
import { buildJailRunArgv, buildJailGitMountArgs, JAIL_WORKSPACE_PATH, JAIL_HOME_PATH } from './session-jail.js'

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()
}
function gitOk(cwd: string, ...args: string[]): boolean {
  try { git(cwd, ...args); return true } catch { return false }
}

let root: string
let project: string
let worktree: string
let commonDir: string
const BRANCH = 'cc/obj-1-test'

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gitdir-')))
  project = path.join(root, 'projects', 'repo')
  worktree = path.join(root, 'cc-worktree-1')
  fs.mkdirSync(project, { recursive: true })
  git(project, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(project, 'README.md'), 'hi\n')
  git(project, 'add', '.')
  git(project, 'commit', '-qm', 'init')
  git(project, 'remote', 'add', 'origin', 'https://github.com/example/repo.git')
  git(project, 'worktree', 'add', '-q', '-b', BRANCH, worktree, 'main')
  commonDir = resolveCommonDir(project)
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('checkWorktreePointer', () => {
  it('accepts a freshly added worktree', () => {
    const s = checkWorktreePointer(worktree, commonDir)
    expect(s).toEqual({ ok: true, adminDir: path.join(commonDir, 'worktrees', 'cc-worktree-1'), commonDir })
  })

  it('flags a pruned admin dir (the #900821 "gitdir no longer resolves" state)', () => {
    fs.rmSync(path.join(commonDir, 'worktrees', 'cc-worktree-1'), { recursive: true })
    expect(gitOk(worktree, 'status')).toBe(false) // git really is dead here
    const s = checkWorktreePointer(worktree, commonDir)
    expect(s.ok).toBe(false)
    if (!s.ok) expect(s.reason).toBe('admin-missing')
  })

  it('flags a pointer into a different repo', () => {
    fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n')
    const s = checkWorktreePointer(worktree, commonDir)
    expect(s.ok ? null : s.reason).toBe('wrong-repo')
  })

  it('never treats a .git DIRECTORY as a valid pointer', () => {
    fs.rmSync(path.join(worktree, '.git'))
    fs.mkdirSync(path.join(worktree, '.git'))
    const s = checkWorktreePointer(worktree, commonDir)
    expect(s.ok ? null : s.reason).toBe('not-a-pointer')
  })

  it('parses pointer files', () => {
    expect(parseGitPointer('gitdir: /a/.git/worktrees/b\n')).toBe('/a/.git/worktrees/b')
    expect(parseGitPointer('nonsense')).toBeNull()
  })
})

describe('session-start guard: validateExistingWorktree', () => {
  it('reuses a valid worktree untouched', () => {
    fs.writeFileSync(path.join(worktree, 'wip.txt'), 'edit')
    expect(validateExistingWorktree(worktree, project).action).toBe('ok')
    expect(fs.readFileSync(path.join(worktree, 'wip.txt'), 'utf8')).toBe('edit')
  })

  it('REPAIRS a rewritten pointer when the repo still has the worktree registered', () => {
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${commonDir}/worktrees/cc-worktree-gone\n`)
    expect(gitOk(worktree, 'status')).toBe(false)
    const v = validateExistingWorktree(worktree, project)
    expect(v.action).toBe('repaired')
    expect(gitOk(worktree, 'status')).toBe(true)
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
  })

  it('REPAIRS a tampered commondir in the admin dir', () => {
    const admin = path.join(commonDir, 'worktrees', 'cc-worktree-1')
    fs.writeFileSync(path.join(admin, 'commondir'), '/tmp/evil\n')
    expect(repairWorktreePointer(worktree, commonDir).action).toBe('repaired')
    expect(fs.readFileSync(path.join(admin, 'commondir'), 'utf8').trim()).toBe('../..')
    expect(gitOk(worktree, 'status')).toBe(true)
  })

  it('MOVES ASIDE (never deletes) a worktree whose admin dir was pruned, and the recreate path then works', () => {
    fs.writeFileSync(path.join(worktree, 'wip.txt'), 'uncommitted')
    fs.rmSync(path.join(commonDir, 'worktrees', 'cc-worktree-1'), { recursive: true })
    const v = validateExistingWorktree(worktree, project, new Date('2026-11-14T00:00:00Z'))
    expect(v.action).toBe('moved-aside')
    if (v.action !== 'moved-aside') return
    expect(fs.existsSync(worktree)).toBe(false)
    expect(fs.readFileSync(path.join(v.movedTo, 'wip.txt'), 'utf8')).toBe('uncommitted')
    // What ensureWorktree does next: prune, then attach the existing branch.
    git(project, 'worktree', 'prune')
    git(project, 'worktree', 'add', '-q', worktree, BRANCH)
    expect(checkWorktreePointer(worktree, commonDir).ok).toBe(true)
    expect(git(worktree, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(BRANCH)
  })

  it('moves aside a worktree whose .git became a directory', () => {
    fs.rmSync(path.join(worktree, '.git'))
    fs.mkdirSync(path.join(worktree, '.git'))
    expect(validateExistingWorktree(worktree, project).action).toBe('moved-aside')
  })

  it('clears a leftover directory with no .git (historical behaviour)', () => {
    const bare = path.join(root, 'cc-worktree-2')
    fs.mkdirSync(bare)
    fs.writeFileSync(path.join(bare, 'junk'), 'x')
    expect(validateExistingWorktree(bare, project).action).toBe('cleared')
    expect(fs.existsSync(bare)).toBe(false)
  })
})

describe('presetBranchUpstream', () => {
  it('records branch.<name>.remote/merge so `git push` works without writing config', () => {
    presetBranchUpstream(project, BRANCH)
    expect(git(project, 'config', `branch.${BRANCH}.remote`)).toBe('origin')
    expect(git(project, 'config', `branch.${BRANCH}.merge`)).toBe(`refs/heads/${BRANCH}`)
  })
})

/** Which jail mount covers `p`? Deepest target wins, as in the kernel. */
function coveringMount(argv: string[], p: string): { target: string; spec: string } | null {
  let best: { target: string; spec: string } | null = null
  argv.forEach((a, i) => {
    if (a !== '--mount') return
    const spec = argv[i + 1]
    const target = /(?:^|,)target=([^,]+)/.exec(spec)?.[1]
    if (!target) return
    if ((p === target || p.startsWith(target + '/')) && (!best || target.length > best.target.length)) best = { target, spec }
  })
  return best
}

describe('jail mounts: the worktree pointer resolves inside the jail', () => {
  const base = { objectiveId: 1, sessionId: 'sess-1', homePath: '/tmp/cc-jail-homes/sess-1', image: 'ok-jail:local' }

  it('REGRESSION: without a git mount, the pointer target is not visible in the jail', () => {
    const argv = buildJailRunArgv({ ...base, worktreePath: worktree })
    const pointer = parseGitPointer(fs.readFileSync(path.join(worktree, '.git'), 'utf8'))!
    expect(coveringMount(argv, pointer)).toBeNull()
  })

  it('with the git mount every path git follows is mounted, and the dangerous ones are read-only', () => {
    const r = resolveJailGitMount(worktree, commonDir)
    expect(r.mount).not.toBeNull()
    const argv = buildJailRunArgv({ ...base, worktreePath: worktree, gitMount: r.mount! })
    const pointer = parseGitPointer(fs.readFileSync(path.join(worktree, '.git'), 'utf8'))!
    const admin = coveringMount(argv, pointer)!
    expect(admin.target).toBe(pointer)
    expect(admin.spec).not.toContain('readonly')
    // objects/refs are writable (a commit writes them) ...
    expect(coveringMount(argv, `${commonDir}/objects/ab`)!.spec).not.toContain('readonly')
    expect(coveringMount(argv, `${commonDir}/refs/heads/x`)!.spec).not.toContain('readonly')
    // ... but nothing git EXECUTES from is, and the admin dir cannot be redirected.
    for (const p of [`${commonDir}/config`, `${commonDir}/hooks/pre-commit`, `${pointer}/commondir`, `${pointer}/gitdir`]) {
      expect(coveringMount(argv, p)!.spec, p).toContain('readonly')
    }
    // Sibling cards' admin dirs are masked by a tmpfs, never the host dir.
    expect(coveringMount(argv, `${commonDir}/worktrees/cc-worktree-999`)!.spec).toMatch(/^type=tmpfs/)
    // Backlink target (<worktree>/.git) is reachable, so an in-jail prune keeps it.
    expect(coveringMount(argv, path.join(worktree, '.git'))!.target).toBe(worktree)
    expect(coveringMount(argv, JAIL_WORKSPACE_PATH)!.target).toBe(JAIL_WORKSPACE_PATH)
    // hooks/ is created on the host first, so the jail cannot create it in the rw git dir.
    expect(fs.statSync(path.join(commonDir, 'hooks')).isDirectory()).toBe(true)
  })

  it('maps bind SOURCES through the host path map but keeps TARGETS at the pointer path', () => {
    const r = resolveJailGitMount(worktree, commonDir)
    const args = buildJailGitMountArgs(r.mount!, [[root, '/srv/host']])
    expect(args[1]).toBe(`type=bind,source=${commonDir.replace(root, '/srv/host')},target=${commonDir},bind-propagation=rprivate`)
  })

  it('returns no mount for an invalid pointer', () => {
    fs.rmSync(path.join(commonDir, 'worktrees', 'cc-worktree-1'), { recursive: true })
    const r = resolveJailGitMount(worktree, commonDir)
    expect(r.mount).toBeNull()
  })

  it('rejects unsafe mount specs', () => {
    const ok = { commonDir: '/p/r/.git', adminDir: '/p/r/.git/worktrees/w', worktreeAlias: '/tmp/cc-worktree-1' }
    expect(() => buildJailGitMountArgs(ok)).not.toThrow()
    expect(() => buildJailGitMountArgs({ ...ok, commonDir: '/p/r,readonly=false/.git', adminDir: '/p/r,readonly=false/.git/worktrees/w' })).toThrow(/comma/)
    expect(() => buildJailGitMountArgs({ ...ok, adminDir: '/p/r/.git/hooks' })).toThrow(/worktrees/)
    expect(() => buildJailGitMountArgs({ ...ok, commonDir: '/etc', adminDir: '/etc/worktrees/w' })).toThrow(/git dir/)
    expect(() => buildJailGitMountArgs({ ...ok, worktreeAlias: JAIL_HOME_PATH })).toThrow(/overlap/)
    expect(() => buildJailGitMountArgs({ ...ok, worktreeAlias: '/p/r/.git/x' })).toThrow(/overlap/)
    expect(() => buildJailGitMountArgs({ ...ok, adminDir: '/p/r/.git/worktrees/../../x' })).toThrow()
  })
})

describe('jailGitSafeDirEnv', () => {
  it('appends safe.directory + no-auto-gc after existing GIT_CONFIG_* entries', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.https://github.com.helper', GIT_CONFIG_VALUE_0: '!gh auth git-credential' }
    const out = jailGitSafeDirEnv(env, { commonDir: '/p/.git', adminDir: '/p/.git/worktrees/w', worktreeAlias: '/tmp/cc-worktree-1' })
    expect(out).toEqual({
      GIT_CONFIG_COUNT: '5',
      GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '/workspace',
      GIT_CONFIG_KEY_2: 'safe.directory', GIT_CONFIG_VALUE_2: '/tmp/cc-worktree-1',
      GIT_CONFIG_KEY_3: 'gc.auto', GIT_CONFIG_VALUE_3: '0',
      GIT_CONFIG_KEY_4: 'maintenance.auto', GIT_CONFIG_VALUE_4: 'false',
    })
    expect(jailGitSafeDirEnv(env, undefined)).toEqual({})
  })
})

describe("jailGitWritablePaths", () => {
  it("hands the jail objects/refs/logs + its own admin dir, never config, hooks or the git dir itself", () => {
    const paths = jailGitWritablePaths({ commonDir: "/p/.git", adminDir: "/p/.git/worktrees/w" })
    expect(paths).toEqual(["/p/.git/objects", "/p/.git/refs", "/p/.git/logs", "/p/.git/worktrees/w"])
    for (const forbidden of ["/p/.git", "/p/.git/config", "/p/.git/hooks"]) expect(paths).not.toContain(forbidden)
  })
})
