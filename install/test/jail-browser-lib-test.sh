#!/usr/bin/env bash
# Prove install/jail-browser-lib.sh (obj 901075): the installer reads the
# browser pins from app/jail/Dockerfile, refuses a floating pin, builds the
# card-browser image with exactly those pins (and stamps them as labels), and
# verify.sh tells a matching image from a missing or a stale one.
#   bash install/test/jail-browser-lib-test.sh
# No root, no docker, no network (ok_jb_image_versions runs against a stub).
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
LIB=$HERE/..
REPO=$(cd "$LIB/.." && pwd)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT

fails=0
check() { if [ "$2" = "$3" ]; then echo "  PASS  $1"; else echo "  FAIL  $1 (got '$2', want '$3')"; fails=$((fails+1)); fi; }
# b FN ARGS… — run one library function in a fresh shell.
b() { bash -c 'set -uo pipefail; source "$0/lib.sh"; source "$0/jail-browser-lib.sh"; f=$1; shift; "$f" "$@"' "$LIB" "$@" 2>"$WORK/err"; }

echo "== pins come from app/jail/Dockerfile and equal the app's browser-pins.ts"
PINS=$(b ok_jb_pins "$REPO/app/jail/Dockerfile")
read -r PW MCP <<<"$PINS"
ts_pw=$(sed -n -E "s/^export const PLAYWRIGHT_VERSION = '([^']+)'.*/\1/p" "$REPO/app/server/src/lib/browser-pins.ts")
ts_mcp=$(sed -n -E "s/^export const PLAYWRIGHT_MCP_VERSION = '([^']+)'.*/\1/p" "$REPO/app/server/src/lib/browser-pins.ts")
check "Playwright pin read from the jail Dockerfile = browser-pins.ts" "$PW" "$ts_pw"
check "@playwright/mcp pin read from the jail Dockerfile = browser-pins.ts" "$MCP" "$ts_mcp"

echo "== a floating or missing pin is refused"
printf 'FROM node\nARG PLAYWRIGHT_VERSION=latest\nARG PLAYWRIGHT_MCP_VERSION=0.0.85\n' > "$WORK/latest.Dockerfile"
printf 'FROM node\nARG PLAYWRIGHT_VERSION=1.65.0\n' > "$WORK/nomcp.Dockerfile"
printf 'FROM node\nARG PLAYWRIGHT_VERSION="1.66.0"\nARG PLAYWRIGHT_MCP_VERSION=^0.0.85\n' > "$WORK/range.Dockerfile"
printf 'FROM node\n  ARG PLAYWRIGHT_VERSION="1.66.0"\nARG PLAYWRIGHT_MCP_VERSION=0.0.86-alpha.1\n' > "$WORK/good.Dockerfile"
b ok_jb_pins "$WORK/latest.Dockerfile" >/dev/null; check "PLAYWRIGHT_VERSION=latest refused" "$?" 1
b ok_jb_pins "$WORK/nomcp.Dockerfile"  >/dev/null; check "missing PLAYWRIGHT_MCP_VERSION refused" "$?" 1
b ok_jb_pins "$WORK/range.Dockerfile"  >/dev/null; check "a ^range refused" "$?" 1
b ok_jb_pins "$WORK/missing.Dockerfile" >/dev/null; check "no Dockerfile refused" "$?" 1
check "quoted / indented / prerelease pins accepted" "$(b ok_jb_pins "$WORK/good.Dockerfile")" "1.66.0 0.0.86-alpha.1"

echo "== the build command: WITH_BROWSER=1, the exact pins, the pins as labels, the jail context"
mapfile -t ARGV < <(b ok_jb_build_argv /srv/ok "$PW" "$MCP")
joined=" ${ARGV[*]} "
check "tag is ok-jail-browser:local" "$(grep -c -- ' -t ok-jail-browser:local ' <<<"$joined")" 1
check "WITH_BROWSER=1"                "$(grep -c -- '--build-arg WITH_BROWSER=1 ' <<<"$joined")" 1
check "PLAYWRIGHT_VERSION build arg"  "$(grep -c -- "--build-arg PLAYWRIGHT_VERSION=$PW " <<<"$joined")" 1
check "PLAYWRIGHT_MCP_VERSION build arg" "$(grep -c -- "--build-arg PLAYWRIGHT_MCP_VERSION=$MCP " <<<"$joined")" 1
check "playwright label"              "$(grep -c -- "--label ok.browser.playwright=$PW " <<<"$joined")" 1
check "mcp label"                     "$(grep -c -- "--label ok.browser.playwright-mcp=$MCP " <<<"$joined")" 1
check "Dockerfile + context are app/jail" "${ARGV[*]: -3}" "-f /srv/ok/app/jail/Dockerfile /srv/ok/app/jail"
check "never a floating tag in the argv" "$(grep -c -E 'latest|@next' <<<"$joined")" 0

echo "== only docker isolation needs the browser jail"
b ok_jb_needed docker; check "docker → build" "$?" 0
b ok_jb_needed tmux;   check "tmux → skip"    "$?" 1
b ok_jb_needed "";     check "unset (default docker) → build" "$?" 0

echo "== which image verify checks (SESSION_JAIL_BROWSER_IMAGE wins, like card-browser.ts)"
check "default" "$(b ok_jb_image "")" ok-jail-browser:local
check "override" "$(b ok_jb_image 'ok-jail-browser@sha256:abc')" 'ok-jail-browser@sha256:abc'
check "card-browser.ts default is the same tag" \
  "$(sed -n -E "s/^export const DEFAULT_JAIL_BROWSER_IMAGE = '([^']+)'.*/\1/p" "$REPO/app/server/src/lib/card-browser.ts")" ok-jail-browser:local

echo "== verify: match / missing / stale"
check "same versions → match"   "$(b ok_jb_compare 1.65.0 0.0.85 1.65.0 0.0.85)" match
check "no image → missing"      "$(b ok_jb_compare 1.65.0 0.0.85 '' '')" missing
check "old playwright → stale"  "$(b ok_jb_compare 1.66.0 0.0.85 1.65.0 0.0.85 | cut -c1-6)" stale:
check "old mcp → stale"         "$(b ok_jb_compare 1.65.0 0.0.86 1.65.0 0.0.85 | cut -c1-6)" stale:
check "built without browser → stale, names it" "$(b ok_jb_compare 1.65.0 0.0.85 none none)" \
  "stale: image has playwright none / @playwright/mcp none, code pins 1.65.0 / 0.0.85"

echo "== verify reads the versions INSIDE the image (docker stubbed)"
# A function, not a file on PATH: /tmp may be mounted noexec. Exported so the
# fresh shell b() starts sees it ahead of any real docker.
# `image inspect` succeeds only for images listed in $STUB_IMAGES; `run` must
# be network-off and prints $STUB_VERSIONS.
docker() {
  case "$1 $2" in
    "image inspect") grep -qxF "$3" <<<"${STUB_IMAGES:-}" ;;
    "run --rm") [[ " $* " == *" --network none "* ]] || { echo "network not off" >&2; return 9; }; [ -z "${STUB_VERSIONS:-}" ] || echo "$STUB_VERSIONS" ;;
    *) return 2 ;;
  esac
}
export -f docker
check "image present → its versions" \
  "$(STUB_IMAGES=ok-jail-browser:local STUB_VERSIONS='1.65.0 0.0.85' b ok_jb_image_versions ok-jail-browser:local)" "1.65.0 0.0.85"
check "image absent → nothing (verify says missing)" \
  "$(STUB_IMAGES='' STUB_VERSIONS='1.65.0 0.0.85' b ok_jb_image_versions ok-jail-browser:local)" ""

unset -f docker

echo "== install.sh and verify.sh are wired to the library"
check "install.sh builds the browser image with the library's argv" "$(grep -c 'ok_jb_build_argv "\$OK_REPO_DIR"' "$REPO/install.sh")" 1
check "install.sh skips it outside docker isolation" "$(grep -c 'ok_jb_needed "$(conf SESSION_ISOLATION docker)"' "$REPO/install.sh")" 2
check "verify.sh check 10 compares the image to the pins" "$(grep -c 'ok_jb_compare "\$jb_pw"' "$LIB/verify.sh")" 1
check "update.sh keeps a rollback tag of the browser image" "$(grep -c '^for img in .*ok-jail-browser' "$LIB/update.sh")" 1

echo
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
