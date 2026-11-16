#!/usr/bin/env bash
# session-jail-proof.sh — LIVE fail-closed proof for the per-session sibling jail.
#
# obj 709072 (parent 708982). Runs real sibling containers (jail A and jail B)
# and asserts the isolation matrix: rows 1-7 are the original contract; rows
# 8-10 (obj 900038) are the no-project-card mount rules — a bare 0750 operator
# home is unusable as /workspace, a 0700 per-card scratch dir works, and that
# scratch dir is unreadable by any other uid. Rows 11-13 (obj 900113): a jail on
# the default bridge cannot reach the app at localhost:3002; on the shared jail
# network with the generated forwarder it can, and the app trusts it only via
# INTERNAL_TRUSTED_PEER_CIDRS. Rows 14-17 (obj 900829): git works inside a jailed
# worktree (its .git pointer resolves), and config/hooks stay read-only. This is evidence, not a mock: every row
# is the exit code of a command executed INSIDE a jail. Nothing here is stubbed —
# if docker is unreachable the script fails LOUDLY at PRECHECK and prints the raw
# daemon error rather than reporting a pass.
#
#   usage: bash scripts/session-jail-proof.sh [IMAGE]
#   default IMAGE: debian:bookworm-slim
#
# It deliberately uses a stock base image so the result is about mounts and caps,
# not about our application image.

set -uo pipefail

IMAGE="${1:-debian:bookworm-slim}"
A_DIR=/tmp/ok-jail-proof-a
B_DIR=/tmp/ok-jail-proof-b
A=ok-jail-w8a
B=ok-jail-w8b
PASS=0; FAIL=0

row()  { printf '\n--- ROW %s: %s ---\n' "$1" "$2"; }
ok()   { PASS=$((PASS+1)); printf 'RESULT: PASS (%s)\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'RESULT: FAIL (%s)\n' "$1"; }

cleanup() { docker rm -f "$A" "$B" "${C:-ok-jail-w8c}" >/dev/null 2>&1 || true; }

echo "=== PRECHECK: docker reachable? ==="
if ! docker version --format '{{.Server.Version}}' 2>&1; then
  echo
  echo "BLOCKED: the docker daemon is not reachable from this account. Raw error above."
  echo "id: $(id)"
  ls -ln /var/run/docker.sock 2>&1 || true
  echo "This is a hard blocker for the live proof. Do NOT report the matrix as passing."
  exit 2
fi

trap cleanup EXIT
cleanup

echo
echo "=== SETUP: host stand-in worktrees ==="
rm -rf "$A_DIR" "$B_DIR"; mkdir -p "$A_DIR" "$B_DIR"
echo "secret-A-$(date -u +%s)" > "$A_DIR/A.txt"
echo "secret-B-$(date -u +%s)" > "$B_DIR/B.txt"
chmod -R 0777 "$A_DIR" "$B_DIR"
ls -la "$A_DIR" "$B_DIR"

echo
echo "=== IMAGE: $IMAGE ==="
docker pull "$IMAGE"
docker image inspect "$IMAGE" --format 'RepoDigests: {{join .RepoDigests ","}}{{"\n"}}Id: {{.Id}}'

run_jail() {  # $1=name $2=hostdir
  set -x
  docker run -d \
    --name "$1" \
    --user 1000:1000 \
    --cap-drop ALL \
    --security-opt no-new-privileges \
    --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -v "$2:/workspace:rw" \
    -w /workspace \
    "$IMAGE" sleep infinity
  set +x
}

echo
echo "=== CREATE JAILS ==="
run_jail "$A" "$A_DIR" || { echo "jail A failed to start"; exit 3; }
run_jail "$B" "$B_DIR" || { echo "jail B failed to start"; exit 3; }
docker ps --filter "name=ok-jail-" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

jexec() { docker exec "$1" sh -lc "$2"; }

row 1 'test -e /var/run/docker.sock inside jail A must FAIL'
jexec "$A" 'test -e /var/run/docker.sock; echo "exit=$?"'
jexec "$A" 'test -e /var/run/docker.sock'; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok "docker.sock absent" || bad "docker.sock VISIBLE inside jail"

row 2 'docker ps inside jail A must not list host containers'
jexec "$A" 'docker ps 2>&1; echo "exit=$?"'
jexec "$A" 'docker ps' >/dev/null 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok "no docker client / no daemon access" || bad "jail listed host containers"

row 3 '/home/operator must not exist inside jail A (incl DECOY-ok-jail.txt)'
jexec "$A" 'ls -la /home/operator 2>&1; echo "exit=$?"'
jexec "$A" 'test -e /home/operator'; rc=$?
echo "exit code (test -e /home/operator): $rc"
jexec "$A" 'cat /home/operator/DECOY-ok-jail.txt 2>&1; echo "exit=$?"'
jexec "$A" 'cat /home/operator/DECOY-ok-jail.txt' >/dev/null 2>&1; rc2=$?
echo "exit code (cat DECOY): $rc2"
[ "$rc" -ne 0 ] && [ "$rc2" -ne 0 ] && ok "operator home unmounted (dir absent + decoy inaccessible)" || bad "operator home VISIBLE or decoy leaked"

row 4 'jail A can read its own /workspace/A.txt'
jexec "$A" 'cat /workspace/A.txt; echo "exit=$?"'
jexec "$A" 'cat /workspace/A.txt' >/dev/null 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -eq 0 ] && ok "own worktree readable" || bad "own worktree NOT readable"

row 5 'jail A can write /workspace/from-jail.txt and the host sees it'
jexec "$A" 'echo jailed > /workspace/from-jail.txt; echo "exit=$?"'
echo "host view:"; cat "$A_DIR/from-jail.txt" 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -eq 0 ] && ok "own worktree writable, visible on host" || bad "write did not reach host"

row 6 "jail A must NOT read jail B's worktree ($B_DIR / B.txt)"
jexec "$A" "cat $B_DIR/B.txt 2>&1; echo exit=\$?"
jexec "$A" "cat $B_DIR/B.txt" >/dev/null 2>&1; rc1=$?
jexec "$A" "ls -la $B_DIR 2>&1; echo exit=\$?"
jexec "$A" "ls $B_DIR" >/dev/null 2>&1; rc2=$?
jexec "$A" 'ls -la /workspace; echo "--- B.txt in own mount? ---"; test -e /workspace/B.txt; echo "exit=$?"'
jexec "$A" 'test -e /workspace/B.txt' >/dev/null 2>&1; rc3=$?
echo "exit codes: cat=$rc1 ls=$rc2 own-mount-has-B=$rc3"
if [ "$rc1" -ne 0 ] && [ "$rc2" -ne 0 ] && [ "$rc3" -ne 0 ]; then
  ok "cross-jail read denied"
else
  bad "jail A could see jail B"
fi
echo "control: jail B CAN read its own B.txt ->"
jexec "$B" 'cat /workspace/B.txt; echo "exit=$?"'

row 18 "obj 901027 sandbox_run round 2: --user \$SANDBOX_EXEC_USER cannot read PID 1's /proc/environ"
C=ok-jail-w8c
docker rm -f "$C" >/dev/null 2>&1 || true
CANARY="canary-secret-$(date -u +%s)"
ENVFILE=$(mktemp)
printf 'GH_TOKEN=%s\n' "$CANARY" > "$ENVFILE"
set -x
docker run -d \
  --name "$C" \
  --user 1000:1000 \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --env-file "$ENVFILE" \
  -v "$A_DIR:/workspace:rw" \
  -w /workspace \
  "$IMAGE" sleep infinity
set +x
echo "control: docker exec --user 1000:1000 (same uid as PID 1) CAN read it ->"
docker exec --user 1000:1000 "$C" sh -c 'cat /proc/1/environ | tr "\0" "\n"' 2>&1
SAME_UID_OUT=$(docker exec --user 1000:1000 "$C" sh -c 'cat /proc/1/environ' 2>&1)
echo "the fix: docker exec --user 65000:65000 (SANDBOX_EXEC_USER, session-jail.ts) ->"
docker exec --user 65000:65000 "$C" sh -c 'cat /proc/1/environ' 2>&1
DIFF_UID_OUT=$(docker exec --user 65000:65000 "$C" sh -c 'cat /proc/1/environ' 2>&1)
rm -f "$ENVFILE"; docker rm -f "$C" >/dev/null 2>&1 || true
if printf '%s' "$SAME_UID_OUT" | grep -q "$CANARY" && ! printf '%s' "$DIFF_UID_OUT" | grep -q "$CANARY"; then
  ok "a different uid cannot read PID 1's environ; the same uid still can (control passed)"
else
  bad "either the same-uid control did not see the canary, or the different uid DID — the fix does not hold"
fi

row 7 'teardown leaves no ok-jail-* containers'
cleanup
docker ps -a --filter 'name=ok-jail-' --format 'table {{.Names}}\t{{.Status}}\t{{.CreatedAt}}'
LEFT=$(docker ps -a --filter 'name=ok-jail-' --quiet | wc -l)
echo "leftover count: $LEFT"
[ "$LEFT" -eq 0 ] && ok "no leftovers" || bad "$LEFT leftover container(s)"

echo
# ─────────────────────────────────────────────────────────────────────────────
# obj 900038 — a card with NO project. Rows 8-10 are the LIVE half of that fix:
# row 8 reproduces the original death, row 9 proves the replacement works, and
# row 10 proves the replacement is not readable by anyone but the jail uid.
# ─────────────────────────────────────────────────────────────────────────────
C=ok-jail-w8c
HOME_LIKE=/tmp/ok-jail-proof-operator-home     # stand-in for the 0750 operator home
SCRATCH=/tmp/ok-jail-proof-scratch/900038      # stand-in for the per-card scratch dir

echo
echo '=== SETUP: obj 900038 stand-ins ==='
sudo rm -rf "$HOME_LIKE" "$SCRATCH" 2>/dev/null || rm -rf "$HOME_LIKE" "$SCRATCH"
mkdir -p "$HOME_LIKE" "$(dirname "$SCRATCH")" "$SCRATCH"
# These rows are ABOUT ownership, so they need chown — i.e. root. Without it we
# cannot build the 0750-root-owned directory that caused the bug, and a jail
# would happily cd into a dir this user owns. SKIP loudly rather than report a
# meaningless PASS or a false FAIL.
OBJ900038_READY=1
sudo -n true 2>/dev/null || OBJ900038_READY=0
if [ "$OBJ900038_READY" = 1 ]; then
  # The exact permissions of the real failure: 0750 root:root.
  sudo chown root:root "$HOME_LIKE" && sudo chmod 0750 "$HOME_LIKE" || OBJ900038_READY=0
  # The replacement: 0700 owned by the jail uid.
  sudo chown 1000:1000 "$SCRATCH" && sudo chmod 0700 "$SCRATCH" || OBJ900038_READY=0
fi
ls -ld "$HOME_LIKE" "$SCRATCH"
if [ "$OBJ900038_READY" != 1 ]; then
  echo
  echo 'SKIP rows 8-10 (obj 900038): passwordless sudo/chown unavailable, so the'
  echo '0750 root-owned stand-in cannot be built. Not a pass and not a failure.'
fi

run_jail_cmd() {  # $1=name $2=hostdir $3=user -> runs 'cd /workspace && echo ok'
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run --rm --name "$1" --user "$3" --cap-drop ALL --security-opt no-new-privileges \
    --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    -v "$2:/workspace:rw" -w / "$IMAGE" sh -lc 'cd /workspace && echo TRIVIAL-COMMAND-RAN'
}

if [ "$OBJ900038_READY" = 1 ]; then
row 8 'REGRESSION: binding the bare 0750 operator home makes cd /workspace FAIL (the original bug)'
run_jail_cmd "$C" "$HOME_LIKE" 1000:1000; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok 'bare operator home is unusable as /workspace — which is why we never bind it' \
                 || bad 'expected cd /workspace to fail on a 0750 root-owned bind'

row 9 'FIX: a per-card scratch dir (0700, jail uid) lets a no-project card run a trivial command'
out=$(run_jail_cmd "$C" "$SCRATCH" 1000:1000 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q TRIVIAL-COMMAND-RAN; then
  ok 'no-project card starts and runs a command in the sandbox'
else
  bad 'no-project card could not run in its scratch workspace'
fi

row 10 'the 0700 scratch dir is NOT readable by any other uid'
docker run --rm --user 1234:1234 --cap-drop ALL --security-opt no-new-privileges \
  -v "$(dirname "$SCRATCH"):/peek:ro" "$IMAGE" sh -lc 'ls -la /peek/900038 2>&1; echo exit=$?'
docker run --rm --user 1234:1234 --cap-drop ALL --security-opt no-new-privileges \
  -v "$(dirname "$SCRATCH"):/peek:ro" "$IMAGE" sh -lc 'ls /peek/900038' >/dev/null 2>&1; rc=$?
echo "exit code: $rc"
[ "$rc" -ne 0 ] && ok 'another uid cannot list the per-card scratch dir' \
                 || bad 'per-card scratch dir is readable by a foreign uid'
fi

# ── obj 900113: a jailed session must reach the app at localhost:3002 ─────────
# Real containers on a real user-defined bridge. The forwarder program is the one
# the server generates (session-jail.ts, loaded with Node's type stripping), and
# the trust decision is the server's own isTrustedPeerAddress(), so these rows
# exercise the shipped code rather than a copy of it.
NIMG=node:22-bookworm-slim
NET=ok-jails-proof
NSUB=172.30.251.0/24
CCN=ok-proof-cc
J1=ok-jail-w8n
J0=ok-jail-w8d
docker rm -f "$CCN" "$J1" "$J0" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true
docker network create --driver bridge --subnet "$NSUB" "$NET" >/dev/null
# Stand-in app: answers with the TCP peer address it saw.
docker run -d --name "$CCN" --network "$NET" --network-alias command-center "$NIMG" \
  node -e 'require("http").createServer((q,r)=>r.end("CC-OK peer="+q.socket.remoteAddress.replace(/^::ffff:/,""))).listen(3002,"0.0.0.0")' >/dev/null
PREFIX=$(node --experimental-strip-types --no-warnings -e \
  "import('./app/server/src/services/session-jail.ts').then(m=>process.stdout.write(m.buildJailCcForwarderPrefix(m.resolveJailCcUpstream({}))))")
echo "forwarder prefix: $PREFIX"
PROBE='sleep 2; node -e '"'"'require("http").get("http://localhost:3002/",r=>{let b="";r.on("data",d=>b+=d);r.on("end",()=>{console.log(b);process.exit(0)})}).on("error",e=>{console.log("ERR "+e.code);process.exit(7)})'"'"''

row 11 'BUG REPRO: a jail on the default bridge cannot reach the app at localhost:3002'
out=$(docker run --rm --name "$J0" --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m "$NIMG" bash -lc "$PROBE" 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q ECONNREFUSED && ok 'default bridge: localhost:3002 refused (the reported bug)' \
  || bad 'expected ECONNREFUSED on the default bridge'

row 12 'FIX: same hardened jail on the shared network + forwarder reaches the app at localhost:3002'
out=$(docker run --rm --name "$J1" --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --network "$NET" "$NIMG" bash -lc "${PREFIX}${PROBE}" 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
PEER=$(printf '%s' "$out" | sed -n 's/.*CC-OK peer=\([0-9.]*\).*/\1/p' | head -1)
[ "$rc" -eq 0 ] && [ -n "$PEER" ] && ok "jail reached the app via localhost:3002 (app saw peer $PEER)" \
  || bad 'jail could not reach the app through the forwarder'

row 13 'the app classifies that jail peer as on-box only when its subnet is configured'
T=$(INTERNAL_TRUSTED_PEER_CIDRS="$NSUB" node --experimental-strip-types --no-warnings -e \
  "import('./app/server/src/lib/is-localhost.ts').then(m=>process.stdout.write(String(m.isTrustedPeerAddress('$PEER'))))")
U=$(node --experimental-strip-types --no-warnings -e \
  "import('./app/server/src/lib/is-localhost.ts').then(m=>process.stdout.write(String(m.isTrustedPeerAddress('$PEER',{}))))")
echo "trusted with CIDR=$T  without=$U"
[ "$T" = true ] && [ "$U" = false ] && ok 'jail peer trusted only via INTERNAL_TRUSTED_PEER_CIDRS' \
  || bad 'jail peer trust decision wrong'
docker rm -f "$CCN" "$J1" "$J0" >/dev/null 2>&1 || true
docker network rm "$NET" >/dev/null 2>&1 || true


# ── obj 900829: git must work inside a jailed card's worktree ─────────────────
# A worktree's .git is a POINTER into <project>/.git/worktrees/<name>. The jail
# used to mount only the worktree, so that pointer dangled and every git command
# failed. Same layout as prod: project outside /tmp, worktree under /tmp (which
# is a tmpfs in the jail). The mounts come from the SHIPPED buildJailRunArgv /
# buildJailGitMountArgs (loaded with Node type stripping), not a copy.
GIMG=buildpack-deps:bookworm-scm
GROOT="${RUNNER_TEMP:-$HOME}/ok-jail-proof-git"
GPROJ="$GROOT/projects/repo"
GWT=/tmp/cc-worktree-900829proof
GWT2=/tmp/cc-worktree-900829sibling
GHOME=/tmp/ok-jail-proof-git-home
GJ=ok-jail-900829proof
GIT_READY=1
sudo -n true 2>/dev/null || GIT_READY=0
docker rm -f "$GJ" >/dev/null 2>&1 || true
for d in "$GROOT" "$GWT" "$GWT2" "$GHOME"; do sudo rm -rf "$d" 2>/dev/null || rm -rf "$d"; done
mkdir -p "$GPROJ" "$GHOME"
gx() { git -c user.name=proof -c user.email=proof@example.com "$@"; }
gx -C "$GPROJ" init -q -b main && echo hi > "$GPROJ/README.md" && gx -C "$GPROJ" add . && gx -C "$GPROJ" commit -qm init
gx -C "$GPROJ" worktree add -q -b cc/obj-900829-proof "$GWT" main
# Stand-in for GitHub: a bare remote the jail can reach (prod pushes over https).
# It sits inside the worktree, so it is /workspace/.proof-remote.git in the jail.
git init -q --bare "$GWT/.proof-remote.git"
echo .proof-remote.git >> "$GPROJ/.git/info/exclude"
gx -C "$GPROJ" remote add origin /workspace/.proof-remote.git
gx -C "$GPROJ" worktree add -q -b cc/obj-900829-sibling "$GWT2" main
# What ensureWorktree does: pre-set the upstream from the control plane.
gx -C "$GPROJ" config branch.cc/obj-900829-proof.remote origin
gx -C "$GPROJ" config branch.cc/obj-900829-proof.merge refs/heads/cc/obj-900829-proof
GCOMMON="$GPROJ/.git"
gjs() { node --experimental-strip-types --no-warnings --input-type=module -e "$1"; }
MOUNT_JSON=$(gjs "const m=await import('./app/server/src/services/worktree-gitdir.ts');const r=m.resolveJailGitMount('$GWT','$GCOMMON');if(!r.mount){console.error(r.reason);process.exit(3)};process.stdout.write(JSON.stringify(r.mount))")
echo "git mount: $MOUNT_JSON"
[ -n "$MOUNT_JSON" ] || GIT_READY=0
# argv for a jail running $SCRIPT; $1 = with|without the git mount
jail_git_argv() {
  gjs "const j=await import('./app/server/src/services/session-jail.ts');
const o={objectiveId:'900829proof',sessionId:'s900829',worktreePath:'$GWT',homePath:'$GHOME',image:'$GIMG',tmpSize:'64m',
 command:['bash','-c',process.env.SCRIPT]};
if('$1'==='with') o.gitMount=$MOUNT_JSON;
process.stdout.write(JSON.stringify(j.buildJailRunArgv(o)))"
}
run_jail_git() {  # $1=with|without ; SCRIPT env = bash run inside the jail
  docker rm -f "$GJ" >/dev/null 2>&1 || true
  local argv; argv=$(jail_git_argv "$1") || return 99
  local A; mapfile -d '' -t A < <(node -e 'for (const a of JSON.parse(process.argv[1])) process.stdout.write(a + "\0")' "$argv")
  docker "${A[@]}" >/dev/null || return 98
  local rc; rc=$(docker wait "$GJ"); docker logs "$GJ" 2>&1; docker rm -f "$GJ" >/dev/null 2>&1
  return "$rc"
}

if [ "$GIT_READY" = 1 ]; then
# What ensureWorktree + ensureJailGitWritable do as root: hand the worktree, its
# admin dir and objects/refs/logs to the jail uid; config and hooks/ stay put.
WRITABLE=$(gjs "const m=await import('./app/server/src/services/worktree-gitdir.ts');process.stdout.write(m.jailGitWritablePaths($MOUNT_JSON).join('\n'))")
echo "jail-writable paths:"; echo "$WRITABLE"
mapfile -t WP <<< "$WRITABLE"
sudo chown -R 1000:1000 "$GWT" "${WP[@]}"
docker pull -q "$GIMG" >/dev/null

row 14 'BUG REPRO (obj 900829): worktree-only jail — the .git pointer dangles and git fails'
out=$(SCRIPT='cat /workspace/.git; git -C /workspace status' run_jail_git without 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
[ "$rc" -ne 0 ] && printf '%s' "$out" | grep -q 'not a git repository' && ok 'git dead in the jail without the gitdir mount (the reported bug)' \
  || bad 'expected "not a git repository" without the gitdir mount'

row 15 'FIX: with the git mount the jail can status, commit and push -u; the commit lands on the host branch'
out=$(SCRIPT='set -e; cd /workspace; git status --short; echo change > proof.txt; git add proof.txt
git -c user.name=jail -c user.email=jail@example.com commit -qm "jail commit"
git push -q -u origin HEAD; echo PUSH-EXIT=$?; git log --oneline -1' run_jail_git with 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
HOSTLOG=$(git -C "$GPROJ" log --format=%s -1 cc/obj-900829-proof 2>&1)
REMOTELOG=$(git -C "$GWT/.proof-remote.git" log --format=%s -1 cc/obj-900829-proof 2>&1)
echo "host branch tip: $HOSTLOG | remote branch tip: $REMOTELOG"
[ "$rc" -eq 0 ] && [ "$HOSTLOG" = 'jail commit' ] && [ "$REMOTELOG" = 'jail commit' ] && ok 'jailed commit + push -u landed on the host branch and the remote' \
  || bad 'git commit/push did not work inside the jail'

row 16 'git config, hooks/ and the admin redirect files are READ-ONLY in the jail'
out=$(SCRIPT="cd /workspace; git config core.fsmonitor 'touch /tmp/pwn' && echo CONFIG-WRITTEN; touch '$GCOMMON/hooks/post-checkout' && echo HOOK-WRITTEN; echo x > '$GCOMMON/worktrees/cc-worktree-900829proof/commondir' && echo COMMONDIR-WRITTEN; true" run_jail_git with 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
if printf '%s' "$out" | grep -qE 'CONFIG-WRITTEN|HOOK-WRITTEN|COMMONDIR-WRITTEN' || git -C "$GPROJ" config core.fsmonitor >/dev/null || [ -e "$GCOMMON/hooks/post-checkout" ]; then
  bad 'jail could write git config / hooks / commondir'
else
  ok 'no hook, fsmonitor or commondir redirect can be planted for the control plane'
fi

row 17 'sibling cards are invisible, and an in-jail git worktree prune keeps this worktree'
out=$(SCRIPT="ls '$GCOMMON/worktrees'; cd /workspace && git worktree prune && git status --short >/dev/null && echo STILL-OK" run_jail_git with 2>&1); rc=$?
echo "$out"; echo "exit code: $rc"
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q STILL-OK && ! printf '%s' "$out" | grep -q 'cc-worktree-900829sibling' \
   && [ -d "$GCOMMON/worktrees/cc-worktree-900829proof" ] && [ -d "$GCOMMON/worktrees/cc-worktree-900829sibling" ]; then
  ok 'only its own admin dir is visible; prune inside the jail removed nothing'
else
  bad 'sibling admin dir visible, or prune removed an admin dir'
fi
docker rm -f "$GJ" >/dev/null 2>&1 || true
else
  echo
  echo 'SKIP rows 14-17 (obj 900829): passwordless sudo unavailable (or no git mount), so the'
  echo 'worktree cannot be handed to the jail uid the way the root control plane does.'
fi


echo "==================== SUMMARY ===================="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
