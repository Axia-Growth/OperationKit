# shellcheck shell=bash
# install/jail-browser-lib.sh — the card-browser sandbox image (obj 901075).
#
# A card with `needs_browser` runs its worker in a SEPARATE jail image,
# `ok-jail-browser:local`, built from app/jail/Dockerfile with WITH_BROWSER=1
# and the pinned Playwright / @playwright/mcp versions (obj 901029). Before
# this file the installer only built the stock `ok-jail:local`, so a fresh
# install or an update left the browser image missing (or stale after a pin
# bump) and it had to be built by hand on the server.
#
# install.sh now builds it on every run (docker's layer cache makes an
# unchanged rebuild a few seconds), stamping the pins on the image as labels;
# update.sh re-runs install.sh, so an update rebuilds it whenever the pins in
# the checked-out code moved. verify.sh check 10 proves the image exists and
# that the versions INSIDE it equal the pins in the code.
#
# PURE except ok_jb_image_versions (which runs the image, network off).

OK_JB_IMAGE_DEFAULT=ok-jail-browser:local
OK_JB_LABEL_PLAYWRIGHT=ok.browser.playwright
OK_JB_LABEL_MCP=ok.browser.playwright-mcp

# ok_jb_dockerfile_pin DOCKERFILE ARGNAME — the default value of one `ARG NAME=…`.
ok_jb_dockerfile_pin() {
  local f=${1:?dockerfile} name=${2:?arg name}
  sed -n -E "s/^[[:space:]]*ARG[[:space:]]+${name}=\"?([^\"[:space:]]+)\"?[[:space:]]*$/\1/p" "$f" | head -1
}

# ok_jb_pins DOCKERFILE — "PLAYWRIGHT MCP" pinned in app/jail/Dockerfile. Fails
# (non-zero, nothing printed) when either is missing or floating.
ok_jb_pins() {
  local f=${1:?dockerfile} pw mcp
  [ -f "$f" ] || return 1
  pw=$(ok_jb_dockerfile_pin "$f" PLAYWRIGHT_VERSION)
  mcp=$(ok_jb_dockerfile_pin "$f" PLAYWRIGHT_MCP_VERSION)
  ok_jb_is_pinned "$pw" && ok_jb_is_pinned "$mcp" || return 1
  printf '%s %s\n' "$pw" "$mcp"
}

# ok_jb_is_pinned VERSION — an exact semver-ish version, never latest/next/a range.
ok_jb_is_pinned() { [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; }

# ok_jb_needed ISOLATION — the browser jail only exists in docker isolation.
ok_jb_needed() { [ "${1:-docker}" = docker ]; }

# ok_jb_image IMAGE_OVERRIDE — the tag the app selects (SESSION_JAIL_BROWSER_IMAGE
# wins, exactly as app/server/src/lib/card-browser.ts jailBrowserImage()).
ok_jb_image() { local o=${1:-}; [ -n "$o" ] && printf '%s\n' "$o" || printf '%s\n' "$OK_JB_IMAGE_DEFAULT"; }

# ok_jb_build_argv REPO_DIR PLAYWRIGHT MCP [IMAGE] — the docker build command, one word per line.
ok_jb_build_argv() {
  local repo=${1:?repo} pw=${2:?playwright} mcp=${3:?mcp} img=${4:-$OK_JB_IMAGE_DEFAULT}
  printf '%s\n' docker build -t "$img" \
    --build-arg WITH_BROWSER=1 \
    --build-arg "PLAYWRIGHT_VERSION=$pw" \
    --build-arg "PLAYWRIGHT_MCP_VERSION=$mcp" \
    --label "$OK_JB_LABEL_PLAYWRIGHT=$pw" \
    --label "$OK_JB_LABEL_MCP=$mcp" \
    -f "$repo/app/jail/Dockerfile" "$repo/app/jail"
}

# ok_jb_compare WANT_PW WANT_MCP HAVE_PW HAVE_MCP — "match" | "missing" | "stale: …".
# HAVE_* empty = the image is not there (or carries no browser at all).
ok_jb_compare() {
  local wpw=${1:-} wmcp=${2:-} hpw=${3:-} hmcp=${4:-}
  if [ -z "$hpw" ] && [ -z "$hmcp" ]; then echo missing; return; fi
  if [ "$wpw" = "$hpw" ] && [ "$wmcp" = "$hmcp" ]; then echo match; return; fi
  echo "stale: image has playwright ${hpw:-none} / @playwright/mcp ${hmcp:-none}, code pins ${wpw} / ${wmcp}"
}

# ok_jb_image_versions IMAGE — "PLAYWRIGHT MCP" actually installed INSIDE the
# image (read from its global node_modules, network off), or nothing when the
# image is missing or was built without the browser. Labels can lie (a hand
# build with no --label, a retag); the installed packages cannot.
ok_jb_image_versions() {
  local img=${1:?image}
  docker image inspect "$img" >/dev/null 2>&1 || return 0
  docker run --rm --network none --entrypoint node "$img" -e '
    const v = (p) => { try { return require("/usr/local/lib/node_modules/" + p + "/package.json").version } catch { return "" } };
    const a = v("playwright"), b = v("@playwright/mcp");
    if (a || b) console.log((a || "none") + " " + (b || "none"));
  ' 2>/dev/null || true
}
