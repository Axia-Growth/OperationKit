/**
 * Session-side halves of the GitHub connector broker (obj 901743, issue #136).
 *
 * Two STATIC scripts — neither contains a credential, a session id or a token:
 *
 *   git-credential-cc   git's credential helper for https://github.com. On `get`
 *                       it forwards protocol/host/path to the host broker with
 *                       the session's CC_SESSION_TOKEN and prints the broker's
 *                       answer, which git uses for that one request.
 *   gh                  a shim ahead of the real `gh` on PATH. It asks the broker
 *                       for a credential for the repo in play (`--repo`/`-R`, else
 *                       GH_REPO, else the `origin` remote) and starts the real
 *                       `gh` with it in THAT child's env only. If the broker
 *                       refuses, the real `gh` runs without one (an install's own
 *                       bot login, if it has one, still applies).
 *
 * The agent's own process env never holds a GitHub token. Each request is
 * decided on the live card, the repo and the owner's connector rules.
 *
 * Where they live: in tmux mode a shared dir under /tmp/cc-scripts (the content
 * is static, so sessions can share it); in jail mode the jail's own HOME bind.
 * `connectorBrokerSessionEnv` returns the env that wires them in.
 */
import fs from 'fs'
import path from 'path'
import { CONNECTOR_BROKER_URL_ENV, GITHUB_BROKER_ENV, connectorBrokerBaseUrl } from '../lib/connector-credential-env.js'

export const GIT_HELPER_NAME = 'git-credential-cc'
export const GH_SHIM_NAME = 'gh'
export const BROKER_BIN_DIRNAME = 'cc-broker-bin'

/**
 * git credential helper. Reads git's request on stdin and answers only `get` for
 * github.com over https. Every value goes through curl's --data-urlencode, so a
 * crafted path cannot change the request.
 */
export const GIT_HELPER_SCRIPT = `#!/bin/sh
# Command Center GitHub credential helper (obj 901743). Contains no secret:
# the host broker decides each request from this card's CC_SESSION_TOKEN.
[ "$1" = "get" ] || exit 0
protocol=""; host=""; cpath=""
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    protocol=*) protocol="\${line#protocol=}" ;;
    host=*) host="\${line#host=}" ;;
    path=*) cpath="\${line#path=}" ;;
  esac
done
[ "$host" = "github.com" ] || exit 0
[ -n "$CC_SESSION_TOKEN" ] && [ -n "$${CONNECTOR_BROKER_URL_ENV}" ] || exit 0
out=$(curl -sS --fail --noproxy '*' --max-time 20 -G \\
  -H "X-CC-Session-Token: $CC_SESSION_TOKEN" \\
  --data-urlencode "protocol=$protocol" \\
  --data-urlencode "host=$host" \\
  --data-urlencode "path=$cpath" \\
  "$${CONNECTOR_BROKER_URL_ENV}/github/git-credential" 2>/dev/null) || {
  echo "git-credential-cc: the GitHub broker refused $cpath (is the repo linked to this card's workspace?)" >&2
  exit 0
}
[ -n "$out" ] && printf '%s\\n' "$out"
exit 0
`

/**
 * gh shim. Finds the real gh further down PATH, asks the broker for a credential
 * for the repo in play, and execs gh with it set on that process only.
 * `CC_GH_BROKER=0 gh …` skips the broker (falls back to an install bot login).
 */
export const GH_SHIM_SCRIPT = `#!/bin/sh
# Command Center gh shim (obj 901743). Contains no secret.
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
real=""
old_ifs=$IFS; IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$d" = "$self_dir" ] && continue
  [ "$(CDPATH= cd -- "$d" 2>/dev/null && pwd)" = "$self_dir" ] && continue
  if [ -x "$d/gh" ] && [ ! -d "$d/gh" ]; then real="$d/gh"; break; fi
done
IFS=$old_ifs
[ -n "$real" ] || { echo "gh: not installed" >&2; exit 127; }
if [ "$CC_GH_BROKER" = "0" ] || [ -z "$CC_SESSION_TOKEN" ] || [ -z "$${CONNECTOR_BROKER_URL_ENV}" ]; then
  exec "$real" "$@"
fi
repo=""; prev=""
for a in "$@"; do
  case "$prev" in -R|--repo) repo="$a" ;; esac
  case "$a" in --repo=*) repo="\${a#--repo=}" ;; esac
  prev="$a"
done
[ -n "$repo" ] || repo="$GH_REPO"
[ -n "$repo" ] || repo=$(git remote get-url origin 2>/dev/null)
tok=""
if [ -n "$repo" ]; then
  tok=$(curl -sS --fail --noproxy '*' --max-time 20 -G \\
    -H "X-CC-Session-Token: $CC_SESSION_TOKEN" \\
    --data-urlencode "repo=$repo" \\
    "$${CONNECTOR_BROKER_URL_ENV}/github/token" 2>/dev/null) || tok=""
fi
if [ -n "$tok" ]; then
  GH_TOKEN="$tok" exec "$real" "$@"
fi
exec "$real" "$@"
`

/** Atomic (write a temp file, then rename): a gh call never runs a half-written script. */
function writeIfChanged(file: string, content: string, mode: number): void {
  let current: string | null = null
  try { current = fs.readFileSync(file, 'utf8') } catch { /* absent */ }
  if (current !== content) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, content, { mode })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  }
  fs.chmodSync(file, mode)
}

/** Write (idempotently) both scripts into `dir`; returns the dir. */
export function ensureConnectorBrokerShims(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  writeIfChanged(path.join(dir, GIT_HELPER_NAME), GIT_HELPER_SCRIPT, 0o755)
  writeIfChanged(path.join(dir, GH_SHIM_NAME), GH_SHIM_SCRIPT, 0o755)
  return dir
}

/** git config key for the github.com https credential helper (obj 900208). */
export const GITHUB_HELPER_CONFIG_KEY = 'credential.https://github.com.helper'

/**
 * Env that wires the scripts into a session whose GitHub is brokered, given the
 * scripts' dir AS SEEN FROM INSIDE THE SESSION. {} when the broker is off for it.
 *
 * Env-scoped git config (GIT_CONFIG_COUNT/KEY_n/VALUE_n, git ≥ 2.31 — the env
 * form of `git -c`), so nothing is written to HOME or the checkout:
 *   credential.https://github.com.helper = ''          reset any lower helper
 *                                                       (e.g. a repo-local
 *                                                       `gh auth git-credential`)
 *   credential.https://github.com.helper = !sh <dir>/git-credential-cc
 *   credential.https://github.com.useHttpPath = true    so git sends owner/repo
 * The values contain no `$` (the tmux wrapper exports inside double quotes).
 */
export function connectorBrokerSessionEnv(
  env: Record<string, string>,
  binDirGuest: string,
  brokerUrl = connectorBrokerBaseUrl(),
): Record<string, string> {
  if (env[GITHUB_BROKER_ENV] !== '1') return {}
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10)
  const n = Number.isFinite(existing) && existing > 0 ? existing : 0
  const entries: [string, string][] = [
    [GITHUB_HELPER_CONFIG_KEY, ''],
    // `!sh <file>`: works even where the dir is mounted noexec (no `$` in it).
    [GITHUB_HELPER_CONFIG_KEY, `!sh ${path.posix.join(binDirGuest, GIT_HELPER_NAME)}`],
    ['credential.https://github.com.useHttpPath', 'true'],
  ]
  const out: Record<string, string> = {
    [CONNECTOR_BROKER_URL_ENV]: brokerUrl,
    PATH: `${binDirGuest}:${env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
    GIT_CONFIG_COUNT: String(n + entries.length),
  }
  entries.forEach(([k, v], i) => {
    out[`GIT_CONFIG_KEY_${n + i}`] = k
    out[`GIT_CONFIG_VALUE_${n + i}`] = v
  })
  return out
}
