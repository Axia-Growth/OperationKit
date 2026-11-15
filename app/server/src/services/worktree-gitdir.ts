/**
 * worktree-gitdir — keep a card worktree's `.git` pointer valid, and make it
 * resolve inside a session jail. (obj 900829, found during audit #900821)
 *
 * ## The bug
 *
 * `ensureWorktree()` creates every card worktree with `git worktree add`, so
 * `/tmp/cc-worktree-<id>/.git` is not a directory but a one-line POINTER file:
 *
 *     gitdir: <projectDir>/.git/worktrees/cc-worktree-<id>
 *
 * Two independent things broke that pointer:
 *
 *   1. **Jail mode never mounted the gitdir.** With `SESSION_ISOLATION=docker`
 *      the jail binds ONLY the worktree at `/workspace` (+ its HOME). The pointer
 *      names a control-plane path under `<projectDir>/.git`, which does not
 *      exist inside the jail, so every git command a jailed card ran died with
 *      `fatal: not a git repository: …/.git/worktrees/cc-worktree-<id>`. That
 *      is what #900821 hit, and what every jailed PR card hits: it cannot
 *      commit, so it cannot open its PR.
 *   2. **The reuse check trusted any `.git`.** On resume `ensureWorktree`
 *      returned early whenever `<worktree>/.git` merely EXISTED. If the admin
 *      dir behind the pointer had been pruned (a `git worktree prune` run while
 *      the worktree dir was briefly unreachable, a re-clone of the project, a
 *      manual cleanup) or the pointer had been rewritten, the card was handed a
 *      dead worktree on every restart and never healed.
 *
 * ## The fix
 *
 *   - {@link checkWorktreePointer} validates a pointer with plain fs reads. It
 *     never runs git INSIDE the worktree: a session controls that tree, so
 *     `git -C <worktree>` as root on a tampered pointer would load a config the
 *     session wrote.
 *   - {@link repairWorktreePointer} rewrites a wrong pointer when the repo still
 *     has an admin dir registered for this worktree path; otherwise the caller
 *     moves the dead tree aside and recreates it.
 *   - {@link resolveJailGitMount} tells the jail what to mount so the SAME
 *     pointer resolves inside it: the repo's common `.git` at its own path, with
 *     sibling worktrees' admin dirs masked and the files git EXECUTES from
 *     (`config`, `hooks/`) plus the admin dir's own redirect files mounted
 *     read-only, so a jailed session cannot plant a hook or `core.fsmonitor`
 *     that the root control plane would later run.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type PointerState =
  | { ok: true; adminDir: string; commonDir: string }
  | { ok: false; reason: PointerProblem; detail: string }

export type PointerProblem =
  | 'missing'          // no `.git` at all
  | 'not-a-pointer'    // `.git` is a directory / unreadable / not `gitdir: …`
  | 'wrong-repo'       // pointer leaves `<commonDir>/worktrees/`
  | 'admin-missing'    // pointer names an admin dir that does not exist (pruned)
  | 'admin-broken'     // admin dir exists but has no HEAD / bad commondir
  | 'backlink-mismatch' // admin dir belongs to a different worktree path

function strip(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

function readTrim(p: string): string | null {
  try { return fs.readFileSync(p, 'utf8').trim() } catch { return null }
}

/** Parse a `.git` pointer file. null when it is not one. */
export function parseGitPointer(content: string): string | null {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content)
  return m ? m[1] : null
}

/**
 * The repo's common git dir, absolute, resolved from the TRUSTED project
 * checkout (never from the session's worktree). Falls back to `<project>/.git`.
 */
export function resolveCommonDir(projectDir: string): string {
  try {
    const out = execFileSync('git', ['-C', projectDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim()
    if (out && out.startsWith('/')) return strip(out)
  } catch {}
  return path.join(strip(projectDir), '.git')
}

/**
 * Is `<worktreePath>/.git` a pointer git can follow to a live admin dir of
 * THIS repo that belongs to THIS worktree? fs only — no git, no exec.
 */
export function checkWorktreePointer(worktreePath: string, commonDir: string): PointerState {
  const wt = strip(worktreePath)
  const common = strip(commonDir)
  const dotGit = path.join(wt, '.git')
  let st: fs.Stats
  try { st = fs.lstatSync(dotGit) } catch {
    return { ok: false, reason: 'missing', detail: `${dotGit} does not exist` }
  }
  if (!st.isFile()) {
    return { ok: false, reason: 'not-a-pointer', detail: `${dotGit} is not a gitdir pointer file` }
  }
  const raw = parseGitPointer(readTrim(dotGit) ?? '')
  if (!raw) return { ok: false, reason: 'not-a-pointer', detail: `${dotGit} has no "gitdir:" line` }
  const adminDir = strip(path.resolve(wt, raw))
  const worktreesRoot = path.join(common, 'worktrees')
  if (path.dirname(adminDir) !== worktreesRoot) {
    return { ok: false, reason: 'wrong-repo', detail: `pointer ${adminDir} is not under ${worktreesRoot}` }
  }
  if (!fs.existsSync(adminDir)) {
    return { ok: false, reason: 'admin-missing', detail: `pointer target ${adminDir} does not exist` }
  }
  if (!fs.existsSync(path.join(adminDir, 'HEAD'))) {
    return { ok: false, reason: 'admin-broken', detail: `${adminDir} has no HEAD` }
  }
  const commondirRaw = readTrim(path.join(adminDir, 'commondir'))
  if (!commondirRaw || strip(path.resolve(adminDir, commondirRaw)) !== common) {
    return { ok: false, reason: 'admin-broken', detail: `${adminDir}/commondir does not resolve to ${common}` }
  }
  const back = readTrim(path.join(adminDir, 'gitdir'))
  if (!back || strip(path.resolve(adminDir, back)) !== dotGit) {
    return { ok: false, reason: 'backlink-mismatch', detail: `${adminDir}/gitdir points at ${back ?? '(none)'}, not ${dotGit}` }
  }
  return { ok: true, adminDir, commonDir: common }
}

/** The admin dir the repo has registered for `worktreePath`, if any. */
export function findRegisteredAdminDir(worktreePath: string, commonDir: string): string | null {
  const dotGit = path.join(strip(worktreePath), '.git')
  const root = path.join(strip(commonDir), 'worktrees')
  let names: string[]
  try { names = fs.readdirSync(root) } catch { return null }
  for (const name of names.sort()) {
    const dir = path.join(root, name)
    const back = readTrim(path.join(dir, 'gitdir'))
    if (back && strip(path.resolve(dir, back)) === dotGit && fs.existsSync(path.join(dir, 'HEAD'))) return dir
  }
  return null
}

export type RepairOutcome =
  | { action: 'ok'; adminDir: string }
  | { action: 'repaired'; adminDir: string; was: PointerProblem }
  | { action: 'unrecoverable'; reason: PointerProblem; detail: string }

/**
 * Make `<worktreePath>/.git` valid if the repo still knows this worktree:
 * rewrite the pointer to the registered admin dir. Returns `unrecoverable`
 * when there is nothing to point at (the caller recreates the worktree).
 */
export function repairWorktreePointer(worktreePath: string, commonDir: string): RepairOutcome {
  const state = checkWorktreePointer(worktreePath, commonDir)
  if (state.ok) return { action: 'ok', adminDir: state.adminDir }
  if (state.reason === 'missing' || (state.reason === 'not-a-pointer' && isDir(path.join(worktreePath, '.git')))) {
    // A `.git` DIRECTORY is a standalone repo someone made in place; never
    // overwrite it. Missing = not a worktree. Both: recreate.
    return { action: 'unrecoverable', reason: state.reason, detail: state.detail }
  }
  const registered = findRegisteredAdminDir(worktreePath, commonDir)
  if (!registered) return { action: 'unrecoverable', reason: state.reason, detail: state.detail }
  // Also re-seat commondir, which may be the broken part.
  try { fs.writeFileSync(path.join(registered, 'commondir'), '../..\n') } catch {}
  fs.writeFileSync(path.join(strip(worktreePath), '.git'), `gitdir: ${registered}\n`)
  const after = checkWorktreePointer(worktreePath, commonDir)
  if (!after.ok) return { action: 'unrecoverable', reason: after.reason, detail: after.detail }
  return { action: 'repaired', adminDir: after.adminDir, was: state.reason }
}

function isDir(p: string): boolean {
  try { return fs.lstatSync(p).isDirectory() } catch { return false }
}

/** Where a dead worktree is moved so uncommitted edits are never deleted. */
export function staleWorktreePath(worktreePath: string, now: Date = new Date()): string {
  return `${strip(worktreePath)}.stale-${now.toISOString().replace(/[-:.]/g, '').replace(/Z$/, '')}`
}

// ── Jail mounts ───────────────────────────────────────────────────────────────

/**
 * What the jail must mount so a worktree pointer resolves inside it. Every path
 * is a CONTROL-PLANE path and is also the jail-side target, because the pointer
 * text is shared by both sides and must stay byte-identical for host-side git.
 */
export interface JailGitMount {
  /** `<project>/.git` — mounted rw at the same path (objects, refs, logs). */
  commonDir: string
  /** `<commonDir>/worktrees/<name>` — this worktree's private admin dir, rw. */
  adminDir: string
  /** The worktree's control-plane path, re-bound so the admin dir's backlink resolves. */
  worktreeAlias: string
}

/**
 * Validate a worktree and return its jail git mount, or null (with a reason)
 * when the pointer is not valid. Ensures `hooks/` exists on the host before it
 * is mounted read-only — otherwise a jail could CREATE it in the rw common dir.
 */
export function resolveJailGitMount(
  worktreePath: string,
  commonDir: string,
): { mount: JailGitMount } | { mount: null; reason: string } {
  const state = checkWorktreePointer(worktreePath, commonDir)
  if (!state.ok) return { mount: null, reason: `${state.reason}: ${state.detail}` }
  try {
    fs.mkdirSync(path.join(state.commonDir, 'hooks'), { recursive: true })
  } catch (err) {
    return { mount: null, reason: `cannot ensure ${state.commonDir}/hooks: ${(err as Error).message}` }
  }
  if (!fs.existsSync(path.join(state.commonDir, 'config'))) {
    return { mount: null, reason: `${state.commonDir}/config is missing` }
  }
  return { mount: { commonDir: state.commonDir, adminDir: state.adminDir, worktreeAlias: strip(worktreePath) } }
}

/**
 * Env-scoped `safe.directory` entries for a jailed worktree (GIT_CONFIG_COUNT
 * form = command-line scope, which git honours for this key). The jail runs as
 * a different uid than whoever owns `<project>/.git`, and git refuses a repo it
 * considers foreign ("dubious ownership"). Appends after any GIT_CONFIG_* the
 * env already carries (e.g. the GitHub push helper). {} when no git mount.
 *
 * Also `gc.auto=0` / `maintenance.auto=false`: the jail sees the shared object
 * store but NOT the other cards' admin dirs (masked), so an auto-gc in here
 * could judge objects only another worktree's index/HEAD references unreachable.
 */
export function jailGitSafeDirEnv(
  env: Record<string, string>,
  mount: JailGitMount | undefined,
  jailWorkspacePath = '/workspace',
): Record<string, string> {
  if (!mount) return {}
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10)
  let n = Number.isFinite(existing) && existing > 0 ? existing : 0
  const out: Record<string, string> = {}
  const pairs: Array<[string, string]> = [
    ['safe.directory', jailWorkspacePath],
    ['safe.directory', mount.worktreeAlias],
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
  ]
  for (const [key, value] of pairs) {
    out[`GIT_CONFIG_KEY_${n}`] = key
    out[`GIT_CONFIG_VALUE_${n}`] = value
    n++
  }
  out.GIT_CONFIG_COUNT = String(n)
  return out
}

/**
 * Paths under the shared git dir a jailed session must be able to WRITE for a
 * commit + push to land: new objects, its branch ref + reflog, and the
 * remote-tracking ref `git push` updates. Deliberately NOT `config`, `hooks/`
 * or the git dir itself (those stay control-plane owned and are mounted
 * read-only), and NOT the admin dir's `commondir` / `gitdir` redirect files.
 */
export function jailGitWritablePaths(mount: Pick<JailGitMount, 'commonDir' | 'adminDir'>): string[] {
  const c = strip(mount.commonDir)
  return [...['objects', 'refs', 'logs'].map(sub => path.join(c, sub)), strip(mount.adminDir)]
}

/**
 * Hand {@link jailGitWritablePaths} to the jail uid. Runs at EVERY jailed spawn,
 * not only at worktree creation, because a control-plane `git fetch` (root)
 * keeps adding root-owned `objects/xx/` dirs a resumed jail could not write
 * into. Best-effort: returns false (and the caller logs) when not root.
 */
export function ensureJailGitWritable(mount: Pick<JailGitMount, 'commonDir' | 'adminDir'>, uid: number, gid: number): boolean {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false
  let ok = true
  for (const p of jailGitWritablePaths(mount)) {
    if (!fs.existsSync(p)) continue
    try {
      execFileSync('chown', ['-R', `${uid}:${gid}`, p], { timeout: 30000, stdio: 'ignore' })
    } catch { ok = false }
  }
  return ok
}
