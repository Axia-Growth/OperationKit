#!/usr/bin/env bash
# jail-browser-proof.sh — LIVE proof for the opt-in worker browser in a jail
# (obj 901029). Every row is the exit code / output of a command run INSIDE a
# real jail container started with the PRODUCTION argv (buildJailRunArgv via
# scripts/jail-browser-proof-stage.ts). Nothing is mocked; if docker is not
# reachable the script fails loudly at PRECHECK.
#
#   usage: bash scripts/jail-browser-proof.sh [STOCK_IMAGE] [BROWSER_IMAGE]
#   default: ok-jail:proof  ok-jail-browser:proof  (build them first, see the
#            "Jail Browser Proof" workflow)
#
# Rows:
#   1  the stock jail image has no Chromium and no Playwright (an unmarked card
#      cannot launch a browser even by trying)
#   2  browser image + production flags + seccomp profile: `cc-browser check`
#      launches the pinned Chromium with its OS sandbox ON (renderers in their
#      own namespaces) behind the guard
#   3  the worker's OWN preview server on 127.0.0.1:8123 loads by default
#      (obj 901145: a jail's loopback is the card's own sandbox)
#  3b  with CARD_BROWSER_WORKER_OWN_LOOPBACK=off it is refused (obj 901051)
#   4  ... and with that off plus CARD_BROWSER_WORKER_LOOPBACK_PORTS=8123 it loads
#   5  the Command Center API port (127.0.0.1:3002, the jail's control-plane
#      forwarder) is refused by default AND even when an operator lists it
#   6  a site outside the allowlist is refused by the guard
#   7  the cloud metadata endpoint is refused by the guard
#   8  the launcher refuses --no-sandbox
#   9  with the guard not running, the launcher refuses to start a browser
#  10  INFO: the same jail WITHOUT the seccomp profile (Docker default) —
#      shows whether the profile is what makes the sandbox possible
set -uo pipefail

STOCK="${1:-ok-jail:proof}"
BROWSER="${2:-ok-jail-browser:proof}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
TSX="$REPO/app/node_modules/.bin/tsx"
PASS=0; FAIL=0

row() { printf '\n--- ROW %s: %s ---\n' "$1" "$2"; }
ok()  { PASS=$((PASS+1)); printf 'RESULT: PASS (%s)\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'RESULT: FAIL (%s)\n' "$1"; }

echo "=== PRECHECK ==="
if ! docker version --format '{{.Server.Version}}' 2>&1; then
  echo "BLOCKED: docker daemon not reachable. Do NOT report this proof as passing."; exit 2
fi
for img in "$STOCK" "$BROWSER"; do
  docker image inspect "$img" >/dev/null 2>&1 || { echo "BLOCKED: image $img not built"; exit 2; }
done
[ -x "$TSX" ] || { echo "BLOCKED: $TSX missing (npm ci in app/)"; exit 2; }
uname -a
sysctl kernel.unprivileged_userns_clone kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || true

# jail <image> <cmd> [extra stage args...] → runs one jail, prints output, returns its exit code
jail() {
  local img="$1" cmd="$2"; shift 2
  local root; root="$(mktemp -d /tmp/ok-jail-browser-proof.XXXXXX)"
  local argv
  argv="$("$TSX" "$HERE/jail-browser-proof-stage.ts" "$root" "$img" --name "bp$RANDOM" --cmd "$cmd" "$@")" || { echo "stage failed"; return 99; }
  local -a a
  mapfile -t a < <(node -e 'for (const x of JSON.parse(process.argv[1])) console.log(x)' "$argv")
  docker "${a[@]}" 2>&1
  local rc=$?
  rm -rf "$root"
  return $rc
}

PREVIEW='node -e "require(\"http\").createServer((q,s)=>s.end(\"<h1>card preview ok</h1>\")).listen(8123,\"127.0.0.1\")" & sleep 1; '
L='node /home/jailuser/.cc/cc-browser.mjs'

row 1 'stock jail image: no Chromium, no Playwright'
out=$(docker run --rm --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges --read-only "$STOCK" \
  bash -lc 'ls /usr/local/share/playwright 2>&1; ls /usr/local/lib/node_modules/playwright 2>&1; ldconfig -p | grep -c libnss3.so' 2>&1); rc=$?
echo "$out"
if printf '%s' "$out" | grep -q 'No such file' && ! printf '%s' "$out" | grep -q 'chromium-'; then ok 'unmarked jail has no browser'; else bad 'stock image carries browser bits'; fi

row 2 'browser jail: pinned Chromium launches with the OS sandbox ON, behind the guard'
out=$(jail "$BROWSER" "$L check"); rc=$?
echo "$out"
if [ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"ok": true' \
   && printf '%s' "$out" | grep -q '"sandbox_requested": true' \
   && printf '%s' "$out" | grep -Eq '"(user|pid)": true' \
   && printf '%s' "$out" | grep -q '"egress_guard": "http://127.0.0.1:3099"'; then
  ok 'sandboxed, guarded launch'
else
  bad 'browser did not launch sandboxed behind the guard'
fi

row 3 'the worker OWN preview server loads by default, no config (obj 901145)'
out=$(jail "$BROWSER" "$PREVIEW $L screenshot http://127.0.0.1:8123/ /tmp/p.png && test -s /tmp/p.png && echo PNG_OK"); rc=$?
echo "$out"
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"status":200' && printf '%s' "$out" | grep -q PNG_OK \
  && ok 'own preview reachable by default' || bad 'own preview not reachable through the guard by default'

row 3b 'CARD_BROWSER_WORKER_OWN_LOOPBACK=off: loopback refused (obj 901051 policy)'
out=$(jail "$BROWSER" "$PREVIEW $L screenshot http://127.0.0.1:8123/ /tmp/p.png; echo rc=\$?" --own-loopback off); echo "$out"
if printf '%s' "$out" | grep -q '"status":403'; then ok 'loopback refused by the guard (403)'; else bad 'loopback was not refused by the guard'; fi

row 4 'own-loopback off + listed preview port (CARD_BROWSER_WORKER_LOOPBACK_PORTS=8123) loads through the guard'
out=$(jail "$BROWSER" "$PREVIEW $L screenshot http://127.0.0.1:8123/ /tmp/p.png && test -s /tmp/p.png && echo PNG_OK" --own-loopback off --loopback-ports 8123); rc=$?
echo "$out"
[ "$rc" -eq 0 ] && printf '%s' "$out" | grep -q '"status":200' && printf '%s' "$out" | grep -q PNG_OK \
  && ok 'listed preview reachable' || bad 'listed preview not reachable through the guard'

row 5 'Command Center API port 3002 refused by default, and even when listed'
API='node -e "require(\"http\").createServer((q,s)=>s.end(\"cc api\")).listen(3002,\"127.0.0.1\")" & sleep 1; '
out=$(jail "$BROWSER" "$API $L screenshot http://127.0.0.1:3002/api/internal/objectives /tmp/a.png; echo rc=\$?"); echo "$out"
if printf '%s' "$out" | grep -q '"status":403'; then ok 'CC API port refused by default (403)'; else bad 'CC API port was not refused by default'; fi
out=$(jail "$BROWSER" "$API $L screenshot http://127.0.0.1:3002/api/internal/objectives /tmp/a.png; echo rc=\$?" --loopback-ports '8123;3002'); echo "$out"
if printf '%s' "$out" | grep -q '"status":403'; then ok 'CC API port refused even when listed (403)'; else bad 'CC API port was not refused when listed'; fi

row 6 'off-allowlist site refused'
out=$(jail "$BROWSER" "$L screenshot https://example.com/ /tmp/x.png; echo rc=\$?"); echo "$out"
printf '%s' "$out" | grep -q 'rc=0' && bad 'example.com was reachable' || ok 'example.com refused'

row 7 'cloud metadata refused'
out=$(jail "$BROWSER" "$L screenshot http://169.254.169.254/latest/meta-data/ /tmp/m.png; echo rc=\$?"); echo "$out"
if printf '%s' "$out" | grep -q '"status":200'; then bad 'metadata answered 200'; else ok 'metadata refused'; fi

row 8 'launcher refuses --no-sandbox'
out=$(jail "$BROWSER" "node -e 'import(process.env.CC_BROWSER_LAUNCHER).then(m=>m.launch({args:[\"--no-sandbox\"]})).then(()=>{console.log(\"LAUNCHED\");process.exit(0)},e=>{console.log(e.message);process.exit(3)})'"); rc=$?
echo "$out"
[ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q refused && ok '--no-sandbox refused' || bad '--no-sandbox not refused'

row 9 'no guard → no browser'
out=$(jail "$BROWSER" "pkill -f browser-guard/run.ts; sleep 1; CC_BROWSER_GUARD_WAIT_MS=1000 $L check"); rc=$?
echo "$out"
[ "$rc" -eq 3 ] && printf '%s' "$out" | grep -q 'not reachable' && ok 'refused without the guard' || bad 'launched without the guard'

row 10 'INFO: browser jail WITHOUT the seccomp profile (Docker default)'
out=$(jail "$BROWSER" "$L check" --no-seccomp); rc=$?
echo "$out" | tail -5
echo "INFO: exit $rc (non-zero = the profile is what enables the sandbox; it never falls back to --no-sandbox)"

echo
echo "=== SUMMARY: PASS=$PASS FAIL=$FAIL ==="
[ "$FAIL" -eq 0 ]
