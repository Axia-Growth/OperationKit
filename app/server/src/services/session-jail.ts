/**
 * session-jail — sibling-container sandbox for a single Command Center session.
 *
 * Wired behind `SESSION_ISOLATION` (obj 709080 / parent 708982). The flag is
 * OFF by default: unset or `tmux` keeps today's `spawnInTmux` path byte-for-byte.
 * Only `SESSION_ISOLATION=docker` routes a spawn through `createSessionJail`,
 * and that path is fail-closed — a docker failure throws and the session fails.
 * There is no fallback to unsandboxed tmux.
 *
 * The isolation contract below was proven live on GitHub Actions ubuntu-latest
 * by `scripts/session-jail-proof.sh` (obj 709076, PASS=7 FAIL=0) before it was
 * wired here. Changing the argv means re-running that proof.
 *
 * The contract (frozen by PRD §6.2):
 *   - name        `ok-jail-<objectiveId>`
 *   - labels      `ok.objective=<objectiveId>`, `ok.session=<sessionId>`
 *   - restart     `no` — sessions are one-shot; the state poller owns retries
 *   - mounts      ONLY the session's own worktree at /workspace (rw, rprivate)
 *                 and its own per-session HOME at /home/jailuser (rw, rprivate).
 *                 Nothing else from /home/operator. In particular NO
 *                 /var/run/docker.sock and no sibling `ccuser-*` home.
 *   - user        non-root (default uid:gid 1000:1000 = `jailuser`)
 *   - caps        --cap-drop ALL --security-opt no-new-privileges
 *                 never --privileged / --pid=host / --network=host
 *   - network     default bridge; outbound is allowed. This is NOT a network
 *                 jail and must not be described as one. When
 *                 `SESSION_JAIL_NETWORK` is set (client installs: `ok-jails`, a
 *                 bridge shared only with the app container) the jail joins it
 *                 and runs a loopback forwarder so `localhost:3002` reaches the
 *                 control plane (obj 900113).
 *
 * Why a sibling container at all: worktrees + worktree-guard.sh only constrain
 * Claude's Edit/Write tools. A plain `bash` in the shared container still sees
 * the host bind-mounts and (for root) the docker socket. Per-process env
 * scoping cannot drop a mount, so the boundary has to be a separate container.
 */

import { execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { JailGitMount } from './worktree-gitdir.js'

export const JAIL_NAME_PREFIX = 'ok-jail-'

/** Container-side paths. Frozen by PRD §6.2 — do not drift. */
export const JAIL_WORKSPACE_PATH = '/workspace'
export const JAIL_HOME_PATH = '/home/jailuser'

/**
 * Default image. Deliberately a LOCAL tag, not a registry ref: pushing to
 * ghcr.io is a Operator-reserved open question (PRD §9), so prod code must not
 * imply a pull. Built from `app/jail/Dockerfile`. Override with
 * `SESSION_JAIL_IMAGE`; pin by digest in any real deployment.
 */
export const DEFAULT_JAIL_IMAGE = 'ok-jail:local'

/**
 * obj 900113 — how a jailed session reaches the control-plane API.
 *
 * Prompts, skills and scripts tell sessions to call
 * `http://localhost:3002/api/internal/...` (the reviewer's criteria URL, the
 * pr-created callback, objective create, ...). In tmux mode the session runs
 * inside the app container, so that is the app. In a jail on the default bridge
 * `localhost` is the jail itself and the app only publishes 127.0.0.1:3002 on
 * the host, so every such call got ECONNREFUSED. On the first OVH client install
 * that made every AI review come back `blocked`.
 *
 * Fix: when `SESSION_JAIL_NETWORK` names a docker network the app container is
 * also on, the jail joins it and starts a small Node TCP forwarder on
 * 127.0.0.1:3002 → `SESSION_JAIL_CC_UPSTREAM` (default `command-center:3002`).
 * The app trusts that network's subnet as on-box via `INTERNAL_TRUSTED_PEER_CIDRS`
 * (lib/is-localhost.ts), which matches tmux mode, where every session was a
 * loopback caller. Unset = previous behaviour exactly.
 */
export const JAIL_CC_LOOPBACK_PORT = 3002
export const DEFAULT_JAIL_CC_UPSTREAM = 'command-center:3002'

const DOCKER_NET_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
/** Never a namespace-sharing or "default" mode: the jail must be on a user-defined bridge. */
const DISALLOWED_JAIL_NETWORKS = ['host', 'none', 'bridge', 'default']

function assertJailNetwork(net: string): void {
  if (!DOCKER_NET_NAME.test(net) || DISALLOWED_JAIL_NETWORKS.includes(net) || net.startsWith('container:')) {
    throw new Error(`jail network must be a user-defined docker network name, got ${JSON.stringify(net)}`)
  }
}

/** Docker network the jail joins, or '' for the daemon default bridge. */
export function resolveJailNetwork(env: NodeJS.ProcessEnv = process.env): string {
  const net = (env.SESSION_JAIL_NETWORK || '').trim()
  if (!net) return ''
  assertJailNetwork(net)
  return net
}

/** `host:port` the in-jail forwarder dials. */
export function resolveJailCcUpstream(env: NodeJS.ProcessEnv = process.env): { host: string; port: number } {
  const raw = (env.SESSION_JAIL_CC_UPSTREAM || DEFAULT_JAIL_CC_UPSTREAM).trim()
  const m = /^([A-Za-z0-9][A-Za-z0-9_.-]*):(\d{1,5})$/.exec(raw)
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 65535) {
    throw new Error(`SESSION_JAIL_CC_UPSTREAM must be host:port, got ${JSON.stringify(raw)}`)
  }
  return { host: m[1], port: Number(m[2]) }
}

/**
 * Shell prefix (ends with `& `) that starts the loopback forwarder in the
 * background before tmux. Node ships in the jail image (node:22 base), so no
 * image rebuild is needed. It is a pure TCP splice that adds no headers, so the
 * "no forwarding headers" half of `isLocalhost` still holds.
 */
export function buildJailCcForwarderPrefix(upstream: { host: string; port: number }): string {
  if (!DOCKER_NET_NAME.test(upstream.host) || !Number.isInteger(upstream.port)) {
    throw new Error(`invalid jail CC upstream ${JSON.stringify(upstream)}`)
  }
  // Double quotes only, so the single-quoted shell word below needs no escaping.
  const js =
    `const n=require("net");` +
    `n.createServer(c=>{const u=n.connect(${upstream.port},"${upstream.host}");` +
    `c.pipe(u).pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy())})` +
    `.on("error",e=>{console.error("[jail-cc-forwarder]",e.message);process.exit(1)})` +
    `.listen(${JAIL_CC_LOOPBACK_PORT},"127.0.0.1")`
  return `node -e '${js}' >/tmp/jail-cc-forwarder.log 2>&1 & `
}

/**
 * obj 900402 — size of the jail's in-memory `/tmp` (tmpfs).
 *
 * The jail root is `--read-only`, so `/tmp` is the only writable scratch outside
 * the two binds. It used to be hardcoded `size=256m`; Claude Code puts its own
 * scratch at `/tmp/claude-<uid>`, and an AI review that clones a ~170 MB repo
 * filled it ("/tmp/claude-1000 has 0 MB free", 2026-11-09). The OVH install was
 * hotfixed with a docker shim that rewrote 256m → 2g on every spawn; this env
 * knob (default 2g) replaces that shim.
 *
 * tmpfs pages only count against RAM/swap when actually written, so the cap is
 * a ceiling, not a reservation. `SESSION_JAIL_TMP_SIZE` takes docker/tmpfs size
 * syntax: a positive integer with an optional k/m/g suffix. Anything else
 * throws — a typo must fail loudly, never silently mount something else.
 */
export const DEFAULT_JAIL_TMP_SIZE = '2g'
const TMPFS_SIZE = /^[1-9][0-9]*[kmg]?$/

function assertTmpSize(size: string): void {
  if (!TMPFS_SIZE.test(size)) {
    throw new Error(`SESSION_JAIL_TMP_SIZE must be a positive size like 512m or 2g, got ${JSON.stringify(size)}`)
  }
}

export function resolveJailTmpSize(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SESSION_JAIL_TMP_SIZE || '').trim().toLowerCase()
  if (!raw) return DEFAULT_JAIL_TMP_SIZE
  assertTmpSize(raw)
  return raw
}

/**
 * obj 900402 — optional `CLAUDE_CODE_TMPDIR` inside the jail.
 *
 * Points Claude Code's scratch at the disk-backed per-session HOME instead of
 * the RAM-backed `/tmp` tmpfs, so a big clone cannot exhaust it at all.
 * `SESSION_JAIL_CLAUDE_TMPDIR`:
 *   unset / `0` / `off` / `false`  → not set (Claude uses `/tmp`, sized above)
 *   `1` / `on` / `true` / `home`   → `/home/jailuser/.claude-tmp`
 *   an absolute path under `/home/jailuser/` → that path
 * Anything else throws. The path is always inside the session's own HOME bind,
 * so this never adds a mount.
 */
export const DEFAULT_JAIL_CLAUDE_TMPDIR = `${JAIL_HOME_PATH}/.claude-tmp`

function assertClaudeTmpdir(dir: string): void {
  if (!dir.startsWith(`${JAIL_HOME_PATH}/`) || !/^\/[A-Za-z0-9_./-]+$/.test(dir) || dir.split('/').includes('..')) {
    throw new Error(`SESSION_JAIL_CLAUDE_TMPDIR must be on/off or a path under ${JAIL_HOME_PATH}/, got ${JSON.stringify(dir)}`)
  }
}

export function resolveJailClaudeTmpdir(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.SESSION_JAIL_CLAUDE_TMPDIR || '').trim()
  const lc = raw.toLowerCase()
  if (!raw || lc === '0' || lc === 'off' || lc === 'false') return ''
  if (lc === '1' || lc === 'on' || lc === 'true' || lc === 'home') return DEFAULT_JAIL_CLAUDE_TMPDIR
  const dir = raw.replace(/\/+$/, '')
  assertClaudeTmpdir(dir)
  return dir
}

/**
 * Shell prefix (ends with `; `) that creates the Claude tmpdir as the jail user
 * before anything else starts. '' when the feature is off.
 */
export function buildJailClaudeTmpdirPrefix(dir: string): string {
  if (!dir) return ''
  assertClaudeTmpdir(dir)
  return `mkdir -p -m 700 ${dir}; `
}

/** Flags that would defeat the jail. Asserted against in the unit tests. */
export const FORBIDDEN_RUN_FLAGS = [
  '--privileged',
  '--pid=host',
  '--network=host',
  '--net=host',
  '--ipc=host',
  '--userns=host',
] as const

export type IsolationMode = 'tmux' | 'docker'

/**
 * Resolve the spawn isolation mode from an env bag.
 *
 * Deliberately NOT a `config.ts` constant: a source-code default of `docker`
 * would silently change Operator's live droplet on the next deploy (PRD §6.6).
 * Unset / empty / `tmux` / anything unrecognised → `tmux` (today's path).
 * OSS and client installs opt in via `.env.example`, a documentation default.
 */
export function resolveIsolationMode(env: NodeJS.ProcessEnv = process.env): IsolationMode {
  return (env.SESSION_ISOLATION || '').trim().toLowerCase() === 'docker' ? 'docker' : 'tmux'
}

/** True when this process should jail spawns. */
export function jailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveIsolationMode(env) === 'docker'
}

export function jailImage(env: NodeJS.ProcessEnv = process.env): string {
  return env.SESSION_JAIL_IMAGE || DEFAULT_JAIL_IMAGE
}

export interface CreateJailOpts {
  /** Objective id. Becomes `ok-jail-<objectiveId>` and the `ok.objective` label. */
  objectiveId: string | number
  /** Session id. Becomes the `ok.session` label and the in-jail tmux session name. */
  sessionId: string
  /** Absolute host path bind-mounted rw at /workspace. The session's worktree. */
  worktreePath: string
  /** Absolute host path bind-mounted rw at /home/jailuser. Per-session HOME. */
  homePath: string
  /** Already-scoped env (output of buildSpawnEnv). Written to an --env-file. */
  env?: Record<string, string>
  /** Host path of the env file to write/pass. Required when `env` is given. */
  envFilePath?: string
  /** Image to run. Defaults to SESSION_JAIL_IMAGE / ok-jail:local. */
  image?: string
  /** Non-root uid:gid inside the jail. Default 1000:1000. */
  user?: string
  /** Command + args run as PID 1 inside the jail. Defaults to the image entrypoint. */
  command?: string[]
  /**
   * Container-path → host-path prefixes for the two bind sources. The control
   * plane itself runs in a container and asks the HOST daemon to bind-mount, so
   * a path like `/tmp/cc-worktree-7` must be rewritten to where that directory
   * really lives on the host. Defaults to `SESSION_JAIL_HOST_PATH_MAP`; empty =
   * identity (the paths are already host paths).
   */
  hostPathMap?: HostPathMap
  /**
   * Seat pool v2: the ONE extra bind a sandboxed Codex / Grok session gets — its
   * assigned seat's CLI login dir, mounted at `~/.codex` or `~/.grok` inside the
   * jail HOME. Absent for every other session, so the default mount set stays
   * exactly two binds.
   */
  seatMount?: { source: string; target: string }
  /** obj 900113: user-defined docker network to join. Absent = default bridge. */
  network?: string
  /** obj 900402: tmpfs size for the jail's /tmp. Default DEFAULT_JAIL_TMP_SIZE (2g). */
  tmpSize?: string
  /**
   * obj 900402: in-jail CLAUDE_CODE_TMPDIR (a path under the jail HOME). Absent /
   * '' = not set. The caller must create the dir (buildJailClaudeTmpdirPrefix).
   */
  claudeTmpdir?: string
  /**
   * obj 900829: make the worktree's `.git` pointer resolve inside the jail.
   * Control-plane paths, mounted at the SAME path in the jail (the pointer text
   * is shared with host-side git and must not change). See
   * {@link buildJailGitMountArgs} for the exact, hardened mount set.
   */
  gitMount?: JailGitMount
  /**
   * obj 901029: absolute path (on the CONTROL PLANE — the docker CLI reads it
   * client-side) of a seccomp profile. Set ONLY for the jail of a worker
   * that was given the browser, to lib/jail-browser-seccomp.json (Docker's default + chroot/clone/unshare/
   * setns so Chromium's user-namespace sandbox can start). Absent = Docker's
   * default profile, exactly as before. `unconfined` is refused.
   */
  seccompProfile?: string
}

/**
 * obj 900829 — the mounts that let git work inside a jail.
 *
 * Before this, a jailed card's `/workspace/.git` said
 * `gitdir: <project>/.git/worktrees/cc-worktree-<id>` and nothing at that path
 * was mounted, so every git command failed ("not a git repository") and a PR
 * card could not commit. Mount set, all at their control-plane path:
 *
 *   - `<commonDir>`                rw  objects / refs / logs (a commit writes these)
 *   - `<commonDir>/worktrees`      tmpfs, ro — hides every OTHER card's admin dir
 *   - `<adminDir>`                 rw  this worktree's index / HEAD
 *   - `<commonDir>/config`         ro  ┐ git EXECUTES from these (core.fsmonitor,
 *   - `<commonDir>/hooks`          ro  ┘ core.hooksPath, hooks) as the root control
 *                                      plane later — a jail must never write them
 *   - `<adminDir>/commondir|gitdir` ro  the admin dir cannot be redirected elsewhere
 *   - `<worktreeAlias>`            rw  same tree as /workspace, so the admin dir's
 *                                      backlink resolves and an in-jail
 *                                      `git worktree prune` cannot drop it
 *
 * Docker applies mounts parent-first, so the nested ones land on top.
 */
export function buildJailGitMountArgs(m: JailGitMount, hostPathMap: HostPathMap = []): string[] {
  const commonDir = m.commonDir.replace(/\/+$/, '')
  const adminDir = m.adminDir.replace(/\/+$/, '')
  const alias = m.worktreeAlias.replace(/\/+$/, '')
  for (const [k, v] of [['gitMount.commonDir', commonDir], ['gitMount.adminDir', adminDir], ['gitMount.worktreeAlias', alias]] as const) {
    assertAbsolute(k, v)
    // --mount is CSV: a comma would inject mount options.
    if (/[,\n"]/.test(v)) throw new Error(`${k} may not contain a comma, quote or newline: ${JSON.stringify(v)}`)
    if (v.includes('docker.sock')) throw new Error(`${k} may not be the docker socket`)
    for (const reserved of [JAIL_WORKSPACE_PATH, JAIL_HOME_PATH]) {
      if (v === reserved || v.startsWith(reserved + '/') || reserved.startsWith(v + '/')) {
        throw new Error(`${k} may not overlap ${reserved}: ${v}`)
      }
    }
    if (path.posix.normalize(v) !== v) throw new Error(`${k} must be a normalized path: ${v}`)
  }
  if (!/\.git$/.test(commonDir)) {
    throw new Error(`gitMount.commonDir must be a git dir (…/.git), got ${commonDir}`)
  }
  if (path.posix.dirname(adminDir) !== `${commonDir}/worktrees`) {
    throw new Error(`gitMount.adminDir must be ${commonDir}/worktrees/<name>, got ${adminDir}`)
  }
  if (alias === commonDir || alias.startsWith(commonDir + '/') || commonDir.startsWith(alias + '/')) {
    throw new Error(`gitMount.worktreeAlias may not overlap the git dir: ${alias}`)
  }
  const bind = (src: string, target: string, ro = false) =>
    ['--mount', `type=bind,source=${toHostPath(src, hostPathMap)},target=${target}${ro ? ',readonly' : ''},bind-propagation=rprivate`]
  return [
    ...bind(commonDir, commonDir),
    '--mount', `type=tmpfs,target=${commonDir}/worktrees,tmpfs-size=1m,tmpfs-mode=0755`,
    ...bind(adminDir, adminDir),
    ...bind(`${commonDir}/config`, `${commonDir}/config`, true),
    ...bind(`${commonDir}/hooks`, `${commonDir}/hooks`, true),
    ...bind(`${adminDir}/commondir`, `${adminDir}/commondir`, true),
    ...bind(`${adminDir}/gitdir`, `${adminDir}/gitdir`, true),
    ...bind(alias, alias),
  ]
}

/** Ordered `[containerPrefix, hostPrefix]` pairs; first (longest) match wins. */
export type HostPathMap = Array<[string, string]>

/**
 * Parse `SESSION_JAIL_HOST_PATH_MAP` — comma-separated `containerPrefix=hostPrefix`
 * pairs, e.g. `/tmp=/srv/ok/state/tmp,/app/data=/srv/ok/state/data`. The client
 * installer (install.sh) writes it; an unset value keeps today's identity mapping.
 * Malformed or relative entries throw: a wrong bind source must fail closed, never
 * silently mount something else.
 */
export function resolveHostPathMap(env: NodeJS.ProcessEnv = process.env): HostPathMap {
  const raw = (env.SESSION_JAIL_HOST_PATH_MAP || '').trim()
  if (!raw) return []
  const pairs: HostPathMap = raw.split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const eq = entry.indexOf('=')
    const from = eq > 0 ? entry.slice(0, eq).replace(/\/+$/, '') : ''
    const to = eq > 0 ? entry.slice(eq + 1).replace(/\/+$/, '') : ''
    if (!from.startsWith('/') || !to.startsWith('/')) {
      throw new Error(`SESSION_JAIL_HOST_PATH_MAP entry must be /container=/host, got ${JSON.stringify(entry)}`)
    }
    return [from, to] as [string, string]
  })
  return pairs.sort((a, b) => b[0].length - a[0].length)
}

/** Rewrite a container path to its host path using the first matching prefix. */
export function toHostPath(p: string, map: HostPathMap): string {
  for (const [from, to] of map) {
    if (p === from) return to
    if (p.startsWith(from + '/')) return to + p.slice(from.length)
  }
  return p
}

export interface JailHandle {
  containerId: string
  containerName: string
  sessionId: string
  /** The exact command the terminal bridge runs to attach a PTY. */
  attach(): string
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

function assertJailId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(id)) {
    throw new Error(`invalid jail id: ${JSON.stringify(id)}`)
  }
}

function assertAbsolute(label: string, dir: string): void {
  if (!dir.startsWith('/') || dir.includes('\0')) {
    throw new Error(`${label} must be an absolute host path, got ${JSON.stringify(dir)}`)
  }
}

/** obj 901029: a seccomp profile must be a real JSON file path — never "unconfined". */
function assertSeccompProfile(p: string): void {
  if (!path.isAbsolute(p) || !/\.json$/.test(p) || /unconfined/i.test(p) || /[\s,=]/.test(p)) {
    throw new Error(`seccompProfile must be an absolute path to a .json profile (never unconfined), got ${JSON.stringify(p)}`)
  }
}

export function jailName(id: string | number): string {
  const s = String(id)
  assertJailId(s)
  return `${JAIL_NAME_PREFIX}${s}`
}

/**
 * Build the full `docker run` argv (without the leading "docker").
 * Pure — no side effects — so the isolation contract is unit-testable.
 */
export function buildJailRunArgv(opts: CreateJailOpts): string[] {
  const {
    objectiveId,
    sessionId,
    worktreePath,
    homePath,
    envFilePath,
    image = DEFAULT_JAIL_IMAGE,
    user = '1000:1000',
    command,
    hostPathMap = [],
    seatMount,
    network,
    tmpSize = DEFAULT_JAIL_TMP_SIZE,
    claudeTmpdir,
    gitMount,
    seccompProfile,
  } = opts
  const name = jailName(objectiveId)
  assertJailId(sessionId)
  assertAbsolute('worktreePath', worktreePath)
  assertAbsolute('homePath', homePath)
  if (envFilePath) assertAbsolute('envFilePath', envFilePath)
  if (!image) throw new Error('image is required')
  if (user.split(':')[0] === '0' || user === 'root') {
    throw new Error('jail user must be non-root')
  }
  assertTmpSize(tmpSize)
  if (claudeTmpdir) assertClaudeTmpdir(claudeTmpdir)

  const argv = [
    'run',
    '-d',
    '--name', name,
    '--label', `ok.objective=${objectiveId}`,
    '--label', `ok.session=${sessionId}`,
    '--restart', 'no',
    '--user', user,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', `/tmp:rw,nosuid,nodev,size=${tmpSize}`,
    '--mount', `type=bind,source=${toHostPath(worktreePath, hostPathMap)},target=${JAIL_WORKSPACE_PATH},bind-propagation=rprivate`,
    '--mount', `type=bind,source=${toHostPath(homePath, hostPathMap)},target=${JAIL_HOME_PATH},bind-propagation=rprivate`,
  ]
  if (seatMount) {
    assertAbsolute('seatMount.source', seatMount.source)
    // Only a login dir directly under the jail HOME; never the socket, never a
    // path outside the session's own HOME.
    if (!/^\/home\/jailuser\/\.(codex|grok)$/.test(seatMount.target)) {
      throw new Error(`seatMount.target must be ${JAIL_HOME_PATH}/.codex or ${JAIL_HOME_PATH}/.grok`)
    }
    if (seatMount.source.includes('docker.sock')) throw new Error('seatMount.source may not be the docker socket')
    argv.push('--mount', `type=bind,source=${toHostPath(seatMount.source, hostPathMap)},target=${seatMount.target},bind-propagation=rprivate`)
  }
  if (gitMount) argv.push(...buildJailGitMountArgs(gitMount, hostPathMap))
  if (seccompProfile) {
    assertSeccompProfile(seccompProfile)
    // Additive to the controls above: cap-drop ALL and no-new-privileges stay.
    argv.push('--security-opt', `seccomp=${seccompProfile}`)
  }
  if (network) {
    assertJailNetwork(network)
    argv.push('--network', network)
  }
  if (envFilePath) argv.push('--env-file', envFilePath)
  // After --env-file so it wins over any inherited value.
  if (claudeTmpdir) argv.push('--env', `CLAUDE_CODE_TMPDIR=${claudeTmpdir}`)
  argv.push('-w', JAIL_WORKSPACE_PATH, image)
  if (command?.length) argv.push(...command)
  return argv
}

export function buildJailExecArgv(id: string | number, command: string): string[] {
  return ['exec', jailName(id), 'sh', '-lc', command]
}

/**
 * obj 901027 security review (first + second pass) — the argv
 * `card-sandbox-tools.ts`'s `sandbox_run` uses instead of the plain
 * `buildJailExecArgv`.
 *
 * `docker exec` inherits the target container's FULL env by default — the same
 * `--env-file` the card session's own worker was started with, including any
 * scoped GH/workspace secrets. A chat-driven `sandbox_run` must not see those,
 * so this wraps the command in `env -i <allowlist>` to start from an EMPTY
 * environment rather than trying to redact afterwards (redaction of command
 * output catches known secret shapes, not an unknown one, and does nothing for
 * `env`/`printenv` itself). Only PATH/HOME/LANG are set.
 *
 * The first review round noted `env -i` alone is not enough on its own, and
 * the second round confirmed both gaps with a live counter-check inside an
 * equivalent sandboxed container (`unshare --user --net` → `Operation not
 * permitted`, i.e. the obvious network-namespace fix for the first gap does
 * NOT reliably work here — seccomp inside a typical hardened container blocks
 * it even when the kernel's own `unprivileged_userns_clone` sysctl allows it,
 * so this file does not attempt it):
 *
 *   1. The jail's network is reachable regardless of env: nothing here cuts
 *      off `curl localhost:3002/...` (the obj 900113 loopback forwarder) or
 *      the jail's own docker-network CIDR, and `INTERNAL_TRUSTED_PEER_CIDRS`
 *      used to treat that whole subnet as on-box authority with no
 *      credential. Fixed at the OTHER end instead, in
 *      `middleware/internal-api-gate.ts` (`isSandboxPeer`): a peer trusted
 *      only via that CIDR list must now present `X-Internal-Secret` /
 *      the objectives token like any off-box caller — reachability on the
 *      jail network is no longer authority, whatever runs inside the jail.
 *   2. `docker exec` by default runs as the SAME uid as the jail's PID 1 (the
 *      card's own worker session), so `cat /proc/1/environ` (or any other
 *      live PID in the jail) printed the worker's real env — including its
 *      `--env-file` secrets — straight past the `env -i` wrapper entirely,
 *      because Linux's ptrace/procfs access check is UID-based, not
 *      env-based. `--user ${SANDBOX_EXEC_USER}` (below) execs as a uid that
 *      owns nothing else in the jail, so that same kernel check now denies
 *      it: a different real uid with no CAP_SYS_PTRACE cannot read another
 *      uid's `/proc/<pid>/environ`, full stop — this is a kernel invariant
 *      `docker exec --user` gets you for free, not something that depends on
 *      file permissions on disk.
 *
 * `sh -c`, not `sh -lc`: `-l` sources `/etc/profile` and the user's own
 * profile scripts, which is an unnecessary and unaudited extra attack surface
 * for a tool whose whole point is running an UNTRUSTED, chat-supplied command.
 *
 * `timeout -k 5 <seconds>s` runs INSIDE the jail, so the deadline kills the
 * command itself (SIGTERM, then SIGKILL after a 5s grace) — the Node-side
 * `execFile` timeout only ever killed the `docker exec` CLI, leaving the
 * command running headless in the container past its timeout.
 */
export const SANDBOX_EXEC_USER = '65000:65000'

export function buildJailSandboxExecArgv(id: string | number, command: string, timeoutMs: number): string[] {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
  return [
    'exec', '--user', SANDBOX_EXEC_USER, jailName(id),
    'timeout', '-k', '5', `${seconds}s`,
    'env', '-i', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', `HOME=${JAIL_HOME_PATH}`, 'LANG=C.UTF-8',
    'sh', '-c', command,
  ]
}

export function buildJailDestroyArgv(id: string | number): string[] {
  return ['rm', '-f', jailName(id)]
}

/**
 * The attach string the terminal bridge runs instead of `tmux attach`.
 * tmux lives INSIDE the jail; docker.sock stays in the control plane.
 */
export function buildJailAttachCommand(id: string | number, sessionId: string): string {
  assertJailId(sessionId)
  return `docker exec -it ${jailName(id)} tmux attach-session -t ${sessionId}`
}

/**
 * obj 901195 — server credentials that must NEVER enter a jail, whatever the
 * secrets store or the spawn env holds (e.g. a stored copy passed through in
 * `secrets_session_env_mode='migration'`). A jailed card reaches its own card's
 * internal routes with its `CC_SESSION_TOKEN` (lib/card-session-scope.ts); holding
 * either of these would make it board-wide on `/api/internal`.
 */
export const JAIL_FORBIDDEN_ENV: readonly string[] = [
  'INTERNAL_API_SECRET',
  'OBJECTIVES_API_TOKEN',
  'OBJECTIVES_API_TOKEN_FILE',
  // obj 901743 (public issue #136): connector credentials. buildSpawnEnv no
  // longer emits them (GitHub / Google / workspace MCP go through the host-side
  // broker); this is the second wall, in case any other path puts one back.
  // Spelled out rather than imported from lib/connector-credential-env.ts: this
  // module is loaded standalone by scripts/session-jail-proof.sh (node type
  // stripping, no .js → .ts resolution), so it imports node built-ins only.
  // session-jail.test.ts asserts the two lists stay equal.
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GOOGLE_REFRESH_TOKEN',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
]

/** Name families that never enter a jail either (obj 901743): workspace MCP tokens. */
export const JAIL_FORBIDDEN_ENV_PREFIXES: readonly string[] = ['CC_MCP_TOKEN_']

/** True when `name` must not be written to a jail's --env-file. Case-insensitive. */
export function isJailForbiddenEnv(name: string): boolean {
  const k = String(name).toUpperCase()
  return JAIL_FORBIDDEN_ENV.includes(k) || JAIL_FORBIDDEN_ENV_PREFIXES.some(p => k.startsWith(p))
}

/** Serialise a scoped env bag to docker `--env-file` format (KEY=value, one per line). */
export function renderEnvFile(env: Record<string, string>): string {
  return Object.entries(env)
    .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
    .filter(([k]) => !isJailForbiddenEnv(k))
    // docker --env-file has no quoting/escaping; a newline would inject a var.
    .map(([k, v]) => `${k}=${String(v ?? '').replace(/[\r\n]+/g, ' ')}`)
    .join('\n') + '\n'
}

/** Injectable synchronous docker runner (tests substitute a fake). */
export type SyncDockerRunner = (argv: string[]) => string

const defaultSyncRunner: SyncDockerRunner = (argv) =>
  execFileSync('docker', argv, { encoding: 'utf8', timeout: 60_000 })

/**
 * Start the jail. FAIL-CLOSED: any docker failure throws. There is deliberately
 * no `catch` that falls back to unsandboxed tmux — a session that asked for a
 * sandbox and did not get one must not run.
 */
export function createSessionJailSync(
  opts: CreateJailOpts,
  runner: SyncDockerRunner = defaultSyncRunner,
): JailHandle {
  const image = opts.image || jailImage()
  const argv = buildJailRunArgv({
    ...opts,
    image,
    hostPathMap: opts.hostPathMap ?? resolveHostPathMap(),
    tmpSize: opts.tmpSize ?? resolveJailTmpSize(),
  })

  if (opts.env && opts.envFilePath) {
    fs.mkdirSync(path.dirname(opts.envFilePath), { recursive: true })
    fs.writeFileSync(opts.envFilePath, renderEnvFile(opts.env), { mode: 0o600 })
  }

  let out: string
  try {
    out = runner(argv)
  } catch (err) {
    // Fail closed. Surface docker's stderr so the operator sees *why*.
    const e = err as { stderr?: Buffer | string; message?: string }
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? ''
    throw new Error(
      `session-jail: docker run failed for ${jailName(opts.objectiveId)} — ` +
      `refusing to fall back to unsandboxed tmux (SESSION_ISOLATION=docker). ` +
      `${(stderr || e.message || '').trim()}`,
    )
  }

  const containerId = out.trim().split('\n').pop()?.trim() || ''
  if (!containerId) {
    throw new Error(
      `session-jail: docker run returned no container id for ${jailName(opts.objectiveId)} — ` +
      `refusing to fall back to unsandboxed tmux.`,
    )
  }
  return {
    containerId: containerId.slice(0, 12),
    containerName: jailName(opts.objectiveId),
    sessionId: opts.sessionId,
    attach: () => buildJailAttachCommand(opts.objectiveId, opts.sessionId),
  }
}

/** Async form of the PRD §6.8 contract. Same fail-closed semantics. */
export async function createSessionJail(opts: CreateJailOpts): Promise<JailHandle> {
  return createSessionJailSync(opts)
}

function run(argv: string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile('docker', argv, { encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
        ? ((err as unknown as { code: number }).code)
        : err
          ? 1
          : 0
      resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

export async function execInJail(id: string | number, command: string): Promise<ExecResult> {
  return run(buildJailExecArgv(id, command))
}

/**
 * Idempotent `docker rm -f ok-jail-<id>`.
 *
 * NO-OP when SESSION_ISOLATION is unset/tmux: on Operator's live droplet no jail was
 * ever created, and shelling out to `docker rm` on every session stop would be
 * both pointless and noisy. Returns whether it actually ran.
 */
export function destroyJailSync(
  id: string | number,
  env: NodeJS.ProcessEnv = process.env,
  runner: SyncDockerRunner = defaultSyncRunner,
): boolean {
  if (!jailEnabled(env)) return false
  try {
    runner(buildJailDestroyArgv(id))
  } catch {
    // Already gone / never existed — `docker rm -f` on a missing name is not an error we care about.
  }
  return true
}

export async function destroyJail(id: string | number): Promise<void> {
  if (!jailEnabled()) return
  await run(buildJailDestroyArgv(id))
}

/** Back-compat alias used by the proof-era tests/scripts. */
export const destroySessionJail = destroyJail
