#!/usr/bin/env bash
# docker-proxy-proof.sh — LIVE proof for the Docker policy sidecar
# (obj 901741, public issue #97).
#
# Runs install/docker-proxy/server.mjs in a container that owns the real host
# Docker socket — the same flags as install/docker-compose.yml — and drives it
# with the REAL docker CLI through DOCKER_HOST, exactly as the app does. Every
# row is a docker command's real outcome against a real daemon; nothing is
# mocked. (The rules are also unit tested, without Docker, by
# install/test/docker-proxy-test.mjs.)
#
#   A. rejected: privileged, CapAdd, host network / pid / ipc, a device, a bind
#      of /, a bind of the socket, a bind through a symlink to /, a named volume,
#      no-new-privileges missing, a root user, an unlisted image, no jail label,
#      pulls/builds, and the Dev host runner while HOST_RUNNER is off.
#   B. unlabelled containers: exec / rm / logs / start are refused and the
#      container is untouched; `docker ps` does not list it.
#   C. allowed jail operations still work: the REAL jail argv from
#      app/server/src/services/session-jail.ts (buildJailRunArgv, plus the
#      browser jail's seccomp profile), exec (plain, sandbox_run's --user + env -i,
#      a hijacked stdin stream), ps, logs, an attached `run --rm`, rm -f.
#   D. the audit log holds one line per call, refusals included.
#   E. with HOST_RUNNER=on, the Dev host runner runs only as shipped: the exact
#      script bytes and this install's paths; another script, another source
#      folder or an added bind of / is still refused.
#
#   usage: bash scripts/docker-proxy-proof.sh
# Needs: docker, node 22 (type stripping for the session-jail.ts import).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
REPO=$(pwd)

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n' "$1"; }

PROXY=ok-proof-docker-proxy
PORT=23750
JAIL_NET=ok-proof-jails
WORK=$(mktemp -d /tmp/ok-docker-proxy-proof.XXXXXX)
STATE=$WORK/state
LOGDIR=$WORK/logs
VICTIM=ok-proof-victim
NODE_IMAGE=node:22-bookworm-slim

cleanup() {
  docker rm -f "$PROXY" "$VICTIM" ok-jail-proof1 ok-jail-proof2 ok-jail-proof3 ok-jail-proofb >/dev/null 2>&1 || true
  docker network rm "$JAIL_NET" >/dev/null 2>&1 || true
  sudo rm -rf "$WORK" 2>/dev/null || rm -rf "$WORK"
}
trap cleanup EXIT

echo "=== PRECHECK: docker reachable? ==="
docker version --format 'server {{.Server.Version}}, client {{.Client.Version}}' || { echo "docker unreachable — FAIL"; exit 1; }

# A stand-in jail image under the name the policy allows. Debian, so it has a
# shell, coreutils `timeout` and `env` like the real ok-jail image.
docker pull -q debian:bookworm-slim >/dev/null && docker tag debian:bookworm-slim ok-jail:local
docker pull -q "$NODE_IMAGE" >/dev/null
docker network create "$JAIL_NET" >/dev/null

mkdir -p "$STATE/tmp/cc-worktree-1" "$STATE/home/sandboxes/1" "$STATE/tmp/cc-worktree-3" "$STATE/home/sandboxes/3" "$LOGDIR"
chmod 1777 "$STATE/tmp/cc-worktree-1" "$STATE/tmp/cc-worktree-3" "$STATE/home/sandboxes/1" "$STATE/home/sandboxes/3"
ln -s / "$STATE/tmp/escape"
# The sidecar runs as root with every capability dropped but DAC_READ_SEARCH: it
# can only write a log folder it owns or one open to it (install.sh makes it root:root 0750).
chmod 0777 "$LOGDIR"
echo '{"defaultAction":"SCMP_ACT_LOG"}' > "$WORK/allow-log.json"
echo SECRET-HOST-FILE | sudo tee /etc/ok-proof-host-secret >/dev/null

# The sidecar, with the flags install/docker-compose.yml gives it.
docker run -d --name "$PROXY" -p "127.0.0.1:$PORT:2375" \
  --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=16m \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO/install/docker-proxy:/opt/ok-docker-proxy:ro" \
  -v "$REPO/app/server/src/lib/jail-browser-seccomp.json:/opt/ok-docker-proxy-seccomp/jail-browser.json:ro" \
  -e DOCKER_PROXY_SECCOMP_PROFILES=/opt/ok-docker-proxy-seccomp/jail-browser.json \
  -v "$STATE:$STATE:ro" -v "$LOGDIR:/var/log/ok-docker-proxy" \
  -e DOCKER_PROXY_LISTEN=0.0.0.0:2375 -e DOCKER_PROXY_UPSTREAM=/var/run/docker.sock \
  -e DOCKER_PROXY_AUDIT_LOG=/var/log/ok-docker-proxy/audit.jsonl \
  -e DOCKER_PROXY_BIND_ROOTS="$STATE" -e DOCKER_PROXY_IMAGES=ok-jail:local,ok-jail-browser:local \
  -e DOCKER_PROXY_NETWORKS="$JAIL_NET" -e DOCKER_PROXY_NAME_PREFIX=ok-jail- -e DOCKER_PROXY_HOST_RUNNER=off \
  --entrypoint node "$NODE_IMAGE" /opt/ok-docker-proxy/server.mjs >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/_ping" >/dev/null 2>&1 && break; sleep 1; done
docker logs "$PROXY" 2>&1 | head -3

# Every call through the sidecar is time-boxed: a hang is a FAIL row, not a stuck job.
D() { DOCKER_HOST="tcp://127.0.0.1:$PORT" timeout -k 5 90 docker "$@"; }
# The jail contract flags (session-jail.ts buildJailRunArgv), minus the mounts.
# shellcheck disable=SC2054  # the commas belong to the --tmpfs option string
JAIL=(--label ok.objective=proof --label ok.session=s-proof --restart no --user 1000:1000 --cap-drop ALL
      --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m)
# Expect a refusal BY THE SIDECAR (its message prefix), not some other error.
refused() { # label, docker args...
  local label=$1; shift
  local out; out=$(D "$@" 2>&1); local rc=$?
  if [ "$rc" -ne 0 ] && grep -q 'docker-proxy:' <<<"$out"; then ok "refused: $label  ($(grep -o 'docker-proxy:.*' <<<"$out" | head -1 | cut -c1-110))"
  else bad "NOT refused: $label (rc=$rc): $(tail -2 <<<"$out")"; fi
}

echo; echo "=== A. container creates the sidecar must refuse ==="
refused "--privileged"                 run --rm --name ok-jail-proofx "${JAIL[@]}" --privileged ok-jail:local true
refused "--cap-add SYS_ADMIN"          run --rm --name ok-jail-proofx "${JAIL[@]}" --cap-add SYS_ADMIN ok-jail:local true
refused "--network host"               run --rm --name ok-jail-proofx "${JAIL[@]}" --network host ok-jail:local true
refused "--pid host"                   run --rm --name ok-jail-proofx "${JAIL[@]}" --pid host ok-jail:local true
refused "--ipc host"                   run --rm --name ok-jail-proofx "${JAIL[@]}" --ipc host ok-jail:local true
refused "--uts host"                   run --rm --name ok-jail-proofx "${JAIL[@]}" --uts host ok-jail:local true
refused "--device /dev/null"           run --rm --name ok-jail-proofx "${JAIL[@]}" --device /dev/null:/dev/xnull ok-jail:local true
refused "-v /:/host"                   run --rm --name ok-jail-proofx "${JAIL[@]}" -v /:/host ok-jail:local cat /host/etc/ok-proof-host-secret
refused "--mount bind source=/"        run --rm --name ok-jail-proofx "${JAIL[@]}" --mount type=bind,source=/,target=/host ok-jail:local true
refused "bind of the docker socket"    run --rm --name ok-jail-proofx "${JAIL[@]}" -v /var/run/docker.sock:/var/run/docker.sock ok-jail:local true
refused "bind of /etc"                 run --rm --name ok-jail-proofx "${JAIL[@]}" --mount type=bind,source=/etc,target=/e ok-jail:local true
refused "bind through a symlink to / inside OK_STATE" run --rm --name ok-jail-proofx "${JAIL[@]}" --mount "type=bind,source=$STATE/tmp/escape,target=/host" ok-jail:local true
refused "named volume over /"          run --rm --name ok-jail-proofx "${JAIL[@]}" --mount 'type=volume,source=okproofv,target=/v,volume-driver=local,volume-opt=type=none,volume-opt=o=bind,volume-opt=device=/' ok-jail:local true
refused "seccomp=unconfined"           run --rm --name ok-jail-proofx "${JAIL[@]}" --security-opt seccomp=unconfined ok-jail:local true
refused "systempaths=unconfined"       run --rm --name ok-jail-proofx "${JAIL[@]}" --security-opt systempaths=unconfined ok-jail:local true
refused "no no-new-privileges"         run --rm --name ok-jail-proofx --label ok.objective=proof --user 1000:1000 --cap-drop ALL --read-only ok-jail:local true
refused "root user"                    run --rm --name ok-jail-proofx --label ok.objective=proof --user 0:0 --cap-drop ALL --security-opt no-new-privileges --read-only ok-jail:local true
refused "no jail label"                run --rm --name ok-jail-proofx --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only ok-jail:local true
refused "not named ok-jail-<id>"       run --rm --name not-a-jail "${JAIL[@]}" ok-jail:local true
refused "unlisted image"               run --rm --name ok-jail-proofx "${JAIL[@]}" "$NODE_IMAGE" true
refused "-p 2222:22"                   run --rm --name ok-jail-proofx "${JAIL[@]}" -p 127.0.0.1:2222:22 ok-jail:local true
refused "docker pull"                  pull busybox:latest
DOCKER_BUILDKIT=0 refused "docker build (classic builder: POST /build)" build -t ok-proof-build - <<<'FROM scratch'
refused "docker network create"        network create ok-proof-evil
refused "docker volume create"         volume create ok-proof-evil
refused "Dev host runner while HOST_RUNNER is off" run --rm -i --label ok.host-runner=1 --privileged --pid=host --network=host --entrypoint nsenter ok-jail:local -t 1 -m -u -i -n -p -- bash -c 'id' ok-dev-ops src-info /opt/operationkit-src /opt/operationkit-src/client.conf
refused "root as \"00\" (Go Atoi)"           run --rm --name ok-jail-proofx --label ok.objective=proof --user 00:1000 --cap-drop ALL --security-opt no-new-privileges --read-only ok-jail:local true
refused "a port with no host binding (-p 22)" run --rm --name ok-jail-proofx "${JAIL[@]}" -p 22 ok-jail:local true
refused "an anonymous volume (-v /data)"      run --rm --name ok-jail-proofx "${JAIL[@]}" -v /data ok-jail:local true
refused "a seccomp profile this install does not ship" run --rm --name ok-jail-proofx "${JAIL[@]}" --security-opt "seccomp=$WORK/allow-log.json" ok-jail:local true
refused "preview-spool host kick (privileged nsenter)" run --rm --privileged --pid=host ok-jail:local nsenter -t 1 -m -u -i -n -p -- id
docker volume rm okproofv >/dev/null 2>&1 || true

out=$(curl -s -o /dev/null -w '%{http_code}' -X GET "http://127.0.0.1:$PORT/_ping" -H 'Content-Type: application/json' \
  --data-binary $'POST /containers/create?name=x HTTP/1.1\r\nHost: d\r\nContent-Type: application/json\r\nContent-Length: 58\r\n\r\n{"Image":"ok-jail:local","HostConfig":{"Privileged":true}}')
[ "$out" = 400 ] && ! docker ps -a --format '{{.Names}}' | grep -qx x && ok "refused: a request hidden in a GET body (400, nothing created)" || bad "a request hidden in a GET body: HTTP $out"
out=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/v1.23/containers/ok-jail-proof1/start")
[ "$out" = 403 ] && ok "refused: Docker API below 1.41 (old start took a HostConfig)" || bad "old API version: HTTP $out"

echo; echo "=== B. unlabelled containers are off limits ==="
docker run -d --name "$VICTIM" debian:bookworm-slim sleep 600 >/dev/null   # straight to the real daemon, no label
refused "exec into an unlabelled container"   exec "$VICTIM" true
refused "exec -i into an unlabelled container" exec -i "$VICTIM" cat </dev/null
refused "rm -f an unlabelled container"       rm -f "$VICTIM"
refused "logs of an unlabelled container"     logs "$VICTIM"
refused "stop an unlabelled container"        stop "$VICTIM"
refused "inspect an unlabelled container"     inspect --type container "$VICTIM"
refused "exec into the sidecar itself"        exec "$PROXY" true
[ "$(docker inspect -f '{{.State.Running}}' "$VICTIM")" = true ] && ok "the unlabelled container is still running" || bad "the unlabelled container was stopped or removed"
if D ps -a --format '{{.Names}}' | grep -qx "$VICTIM"; then bad "docker ps lists an unlabelled container"; else ok "docker ps does not list unlabelled containers"; fi

echo; echo "=== C. allowed jail operations still work ==="
# The REAL argv the app builds (session-jail.ts), so this is the app's own shape.
gjs() { node --experimental-strip-types --no-warnings --input-type=module -e "$1"; }
argv_of() { # objectiveId sessionId wt home [seccomp]
  gjs "const j=await import('./app/server/src/services/session-jail.ts');
       const o={objectiveId:'$1',sessionId:'$2',worktreePath:'$3',homePath:'$4',network:'$JAIL_NET',tmpSize:'64m',command:['sleep','600']};
       if ('${5:-}') o.seccompProfile='${5:-}';
       process.stdout.write(JSON.stringify(j.buildJailRunArgv(o)))"
}
run_argv() { [ -n "$1" ] || { echo "empty argv"; return 1; }; local A; mapfile -d '' -t A < <(node -e 'for (const a of JSON.parse(process.argv[1])) process.stdout.write(a + "\0")' "$1"); D "${A[@]}"; }
ARGV1=$(argv_of proof1 s1 "$STATE/tmp/cc-worktree-1" "$STATE/home/sandboxes/1") || bad "could not build the jail argv from session-jail.ts"
echo "jail argv: docker $(node -e 'console.log(JSON.parse(process.argv[1]).join(" "))' "$ARGV1")"
if out=$(run_argv "$ARGV1" 2>&1); then ok "the real card jail (buildJailRunArgv) starts through the sidecar"; else bad "the real card jail was refused: $out"; fi
SECCOMP="$REPO/app/server/src/lib/jail-browser-seccomp.json"
ARGV3=$(argv_of proof3 s3 "$STATE/tmp/cc-worktree-3" "$STATE/home/sandboxes/3" "$SECCOMP")
if out=$(run_argv "$ARGV3" 2>&1); then ok "the browser jail shape (seccomp profile) starts through the sidecar"; else bad "the browser jail shape was refused: $out"; fi

out=$(D exec ok-jail-proof1 sh -lc 'id -u; echo from-jail > /workspace/proof.txt' 2>&1)
[ "$(head -1 <<<"$out")" = 1000 ] && [ "$(cat "$STATE/tmp/cc-worktree-1/proof.txt" 2>/dev/null)" = from-jail ] \
  && ok "exec into a jail (runs as 1000, writes its own worktree)" || bad "exec into a jail failed: $out"
out=$(D exec --user 65000:65000 ok-jail-proof1 timeout -k 5 10s env -i PATH=/usr/bin:/bin HOME=/home/jailuser LANG=C.UTF-8 sh -c 'id -u' 2>&1)
[ "$out" = 65000 ] && ok "sandbox_run's exec shape (--user 65000, env -i)" || bad "sandbox_run exec failed: $out"
out=$(printf 'over-the-stream\n' | D exec -i ok-jail-proof1 cat 2>&1)
[ "$out" = over-the-stream ] && ok "a hijacked exec stream (stdin through the sidecar)" || bad "hijacked exec failed: $out"
refused "exec as root into a jail"             exec --user 0 ok-jail-proof1 id
refused "privileged exec into a jail"          exec --privileged ok-jail-proof1 id
if D ps --filter label=ok.session --filter status=running --format '{{.Names}}' | grep -qx ok-jail-proof1; then ok "docker ps lists the jail (session-tmux.ts JAIL_PS_ARGV filters)"; else bad "docker ps does not list the jail"; fi
D logs ok-jail-proof1 >/dev/null 2>&1 && ok "docker logs on a jail" || bad "docker logs on a jail failed"
D inspect -f '{{.Config.Labels}}' ok-jail-proof1 >/dev/null 2>&1 && ok "docker inspect on a jail" || bad "docker inspect on a jail failed"
D image inspect --format '{{.Id}}' ok-jail:local >/dev/null 2>&1 && ok "docker image inspect (card-browser-spawn.ts)" || bad "docker image inspect failed"
out=$(D run --rm --name ok-jail-proof2 "${JAIL[@]}" --mount "type=bind,source=$STATE/tmp/cc-worktree-1,target=/workspace" ok-jail:local cat /workspace/proof.txt 2>&1)
[ "$out" = from-jail ] && ok "an attached run --rm (attach + wait + auto-remove through the sidecar)" || bad "attached run --rm failed: $out"
D rm -f ok-jail-proof1 >/dev/null 2>&1 && ok "docker rm -f on a jail" || bad "docker rm -f on a jail failed"
D rm -f ok-jail-proof3 >/dev/null 2>&1 || true
out=$(D rm -f ok-jail-proof-missing 2>&1); grep -q 'No such container' <<<"$out" && ok "rm -f of a missing jail gets the daemon's own 'No such container'" || bad "rm -f of a missing jail: $out"

echo; echo "=== E. the Dev host runner, HOST_RUNNER=on: only the shipped call ==="
# Same sidecar with the opt-in on and this checkout's host-runner.sh mounted.
# The stand-in helper image is the debian one (util-linux has nsenter).
docker rm -f "$PROXY" >/dev/null
docker run -d --name "$PROXY" -p "127.0.0.1:$PORT:2375" \
  --user 0:0 --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges --read-only \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$REPO/install/docker-proxy:/opt/ok-docker-proxy:ro" \
  -v "$REPO/app/server/src/lib/jail-browser-seccomp.json:/opt/ok-docker-proxy-seccomp/jail-browser.json:ro" \
  -e DOCKER_PROXY_SECCOMP_PROFILES=/opt/ok-docker-proxy-seccomp/jail-browser.json \
  -v "$REPO/app/server/src/services/dev-ops/host-runner.sh:/opt/ok-docker-proxy-host-runner.sh:ro" \
  -v "$STATE:$STATE:ro" -v "$LOGDIR:/var/log/ok-docker-proxy" \
  -e DOCKER_PROXY_AUDIT_LOG=/var/log/ok-docker-proxy/audit.jsonl \
  -e DOCKER_PROXY_BIND_ROOTS="$STATE" -e DOCKER_PROXY_NETWORKS="$JAIL_NET" \
  -e DOCKER_PROXY_HOST_RUNNER=on -e DOCKER_PROXY_HOST_RUNNER_IMAGE=ok-jail:local \
  -e DOCKER_PROXY_HOST_RUNNER_SCRIPT=/opt/ok-docker-proxy-host-runner.sh \
  -e DOCKER_PROXY_HOST_RUNNER_SRC=/opt/ok-proof-src -e DOCKER_PROXY_HOST_RUNNER_CONF=/opt/ok-proof-src/client.conf \
  -e DOCKER_PROXY_HOST_RUNNER_DATA="$STATE/data" \
  --entrypoint node "$NODE_IMAGE" /opt/ok-docker-proxy/server.mjs >/dev/null
for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$PORT/_ping" >/dev/null 2>&1 && break; sleep 1; done
# The script bytes exactly as host-exec.ts reads them (keep the trailing newline).
HR_SCRIPT=$(cat app/server/src/services/dev-ops/host-runner.sh; echo x); HR_SCRIPT=${HR_SCRIPT%x}
HR=(run --rm -i --label ok.host-runner=1 --privileged --pid=host --network=host --entrypoint nsenter ok-jail:local -t 1 -m -u -i -n -p -- bash -c)
out=$(D "${HR[@]}" "$HR_SCRIPT" ok-dev-ops src-info /opt/ok-proof-src /opt/ok-proof-src/client.conf </dev/null 2>&1)
if grep -q 'docker-proxy:' <<<"$out"; then bad "the shipped host runner call was refused: $out"
else ok "the shipped host runner call runs (src-info; its own answer: $(tail -1 <<<"$out" | cut -c1-90))"; fi
refused "host runner with another script"       "${HR[@]}" 'id' ok-dev-ops src-info /opt/ok-proof-src /opt/ok-proof-src/client.conf
refused "host runner with another source folder" "${HR[@]}" "$HR_SCRIPT" ok-dev-ops deploy "$STATE/tmp" /opt/ok-proof-src/client.conf 1 https://ok.example.test/api/health "$STATE/data"
refused "host runner plus a bind of /"          run --rm -i -v /:/host --label ok.host-runner=1 --privileged --pid=host --network=host --entrypoint nsenter ok-jail:local -t 1 -m -u -i -n -p -- bash -c "$HR_SCRIPT" ok-dev-ops src-info /opt/ok-proof-src /opt/ok-proof-src/client.conf
refused "privileged without the host runner label (still)" run --rm --privileged --pid=host ok-jail:local nsenter -t 1 -m -u -i -n -p -- id

echo; echo "=== D. audit trail ==="
# The sidecar writes it as root, mode 0640 (as on an install); read a copy.
LOG=$WORK/audit.copy.jsonl
# shellcheck disable=SC2024  # sudo is for READING the root file; the copy is ours
sudo cat "$LOGDIR/audit.jsonl" > "$LOG" 2>/dev/null || : > "$LOG"
ls -l "$LOGDIR/audit.jsonl" 2>/dev/null || sudo ls -l "$LOGDIR/audit.jsonl"
n=$(wc -l < "$LOG" 2>/dev/null || echo 0)
deny=$(grep -c '"decision":"deny"' "$LOG" 2>/dev/null || echo 0)
allow=$(grep -c '"decision":"allow"' "$LOG" 2>/dev/null || echo 0)
echo "audit lines: $n (allow $allow, deny $deny)"
[ "$n" -gt 0 ] && node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")) { const j=JSON.parse(l); if(!j.ts||!j.method||!j.path||!/^(allow|deny)$/.test(j.decision)) { console.error(l); process.exit(1) } }' "$LOG" \
  && ok "every audit line is JSON with ts / method / path / decision" || bad "audit log missing or malformed"
grep '"decision":"deny"' "$LOG" | grep -q 'Privileged\|privileged' && ok "the refused privileged create is in the audit log" || bad "no privileged refusal in the audit log"
grep '"decision":"deny"' "$LOG" | grep -q "\"container\":\"$VICTIM\"" && ok "the refused unlabelled exec/rm is in the audit log" || bad "no unlabelled refusal in the audit log"
grep '"decision":"allow"' "$LOG" | grep -q '"op":"container.create"' && ok "the allowed jail create is in the audit log" || bad "no allowed create in the audit log"
echo "--- last 5 audit lines ---"; tail -5 "$LOG"

echo
echo "=== SUMMARY: $PASS pass, $FAIL fail ==="
[ "$FAIL" -eq 0 ]
