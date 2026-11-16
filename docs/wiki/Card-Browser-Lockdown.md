# Card browser lockdown (Playwright / Chromium)

Review and QA sessions drive a real Chromium through
[Playwright MCP](https://github.com/microsoft/playwright-mcp) to look at pages —
"open the preview and tell me whether the button renders". That browser runs
**inside the app's own container**, next to the secrets store, the AI seat
logins and the SQLite database. So the browser is a boundary: whatever a page
can do to Chromium, it starts out being able to do to that container.

This page is what that boundary is, how to configure it, and how to move the
browser forward when a Chromium advisory lands.

## Why it matters, concretely

A bundled browser is always behind the browser you use. Playwright ships a
Chromium build with each release and that build ages until the next one:

| Playwright | bundles Chromium (revision) | notes |
| --- | --- | --- |
| 1.64.1 | 156.0.8078.4 (1248) | behind Chrome 156 Extended Stable (156.0.8078.88) and the whole 157 stable line |
| 1.65.0 (2026-11-05) | 158.0.8127.18 (1254) | **pinned** — a newer major than current stable 157 |
| 1.65.1 | 159.0.8154.6 (1255) | not pinned: no `@playwright/mcp` release yet bundles a playwright-core that expects this revision |

What was verified, and where (2026-11-13):

* **Bundled builds** — read from the `package/browsers.json` inside each official
  `playwright-core` npm tarball (`npm pack playwright-core@<v>`), not from any
  third-party summary.
* **Chrome stable** — Google's version-history API
  (`versionhistory.googleapis.com/v1/chrome/platforms/linux/channels/stable/versions`)
  lists 157.0.8103.38 → .50 → .78 (serving since 2026-11-11). The Chrome Releases
  blog announced 157.0.8103.38 on 2026-11-03 as the stable promotion with a large
  batch of security fixes, and Extended Stable 156.0.8078.88 the same day. So
  Playwright 1.64.1's 156.0.8078.4 is behind **both** supported channels and lacks
  every security fix shipped in them since that build was cut.
* **Not verified** — the individual CVE IDs named in the social-media post that
  prompted this work (the post was not retrievable), and a per-CVE mapping for
  158.0.8127.18 (it is a pre-stable build; fixes land on trunk first, but no
  advisory states which ones it carries). The load-bearing fact is the version
  comparison above, and the defence that does not depend on it is the sandbox +
  egress guard below.

Historically this install made that much worse in two ways:

* Chromium was launched with **`--no-sandbox`**, unconditionally. The OS sandbox
  is the thing that turns "the renderer was compromised" into "the renderer was
  compromised, and that is where it stops". Without it, a renderer exploit is
  immediately code execution as the session user.
* There was **no origin policy at all**. The browser could reach the cloud
  instance-metadata endpoint (`169.254.169.254`), every service on the private
  network, and anything else it was pointed at — including by a redirect from a
  page that looked harmless.

## What it does now

**The OS sandbox stays on.** `--no-sandbox` is passed only if an operator
explicitly sets `BROWSER_SANDBOX="off"`, and that choice is logged at boot and
reported by `install/verify.sh`. The image makes Chromium's `chrome_sandbox`
helper setuid-root so the sandbox works for the unprivileged session account.

**The browser is not root.** Sessions — and therefore the browser — run as the
unprivileged `ccuser` account (`runuser -u ccuser`), never as uid 0.

**Egress is restricted, by a real boundary.** Two layers, and the distinction
matters:

| Layer | What it is | Why it is not enough on its own |
| --- | --- | --- |
| Playwright's `--allowed-origins` / `--blocked-origins` | route interception inside the page | Playwright's own help text says it "*does not* serve as a security boundary and *does not* affect redirects" |
| The **egress guard** (`app/server/src/services/browser-egress-proxy.ts`) | a loopback HTTP/CONNECT proxy Chromium is pointed at with `--proxy-server` | — it is the boundary |

Chromium cannot open an http/https socket without going through the guard, and
the guard re-checks **every** hop, including each hop of a redirect chain. It
also pins DNS: the name is resolved once, the decision is made against those
addresses, and the socket is opened to *that address* — so a name that answers
a public address on the first lookup and `169.254.169.254` on the second cannot
win the race.

The guard fails **closed**. An unresolvable name, an unparseable request, a
policy error — all end in a refusal. And if the guard is supposed to be running
and is not, the server declines to register Playwright for the session at all
rather than handing it an unrestricted browser.

**Versions are pinned.** `@playwright/mcp@latest` used to be re-resolved at
every single session spawn. Both versions now live in exactly two places —
`app/server/src/lib/browser-pins.ts` and the `ARG` lines in `app/Dockerfile` —
and `browser-pins.test.ts` fails CI if those two disagree.

## Worker cards that ask for a browser (`needs_browser`, obj 901029)

By default a **worker** session (the one that builds the card) still gets no
browser — only reviewer and design-arena sessions do. A card that needs its
worker to take screenshots or run an end-to-end check sets
`needs_browser: true` (`POST/PUT /api/objectives`, or an item of
`POST /api/internal/objectives`; a non-boolean is a `400`). It takes effect
from the card's next spawn, and follow-ups keep it. Planner sessions never get it.

A marked worker gets the **same** browser this page describes, under a
**stricter** egress policy, and only in a jail by default:

**Jail only by default (obj 901051).** On the tmux path the worker would run
Chromium inside the app container, next to the secrets store, the DB and the
seat logins. So tmux mode **refuses**: the card gets `CC_CARD_BROWSER_REFUSED`
saying the browser is only available in jailed sessions
(`SESSION_ISOLATION=docker`). An operator can allow it with
`CARD_BROWSER_WORKER_IN_APP_CONTAINER=on`, which is logged as a warning at boot
and starts a second, worker-only guard on `CARD_BROWSER_WORKER_PROXY_PORT`
(default `3098`) under the worker policy below — never the reviewer's guard.

**Worker policy: no loopback (obj 901051).** `resolveWorkerBrowserPolicy()` is
`resolveBrowserPolicy()` with `allowLoopback` forced **off**, whatever
`CARD_BROWSER_ALLOW_LOOPBACK` says. Loopback is not harmless for a worker: in a
jail, `127.0.0.1:3002` is the forwarder to the control-plane API
(`JAIL_CC_LOOPBACK_PORT`), and in the app container loopback is the app itself.
Chromium is always started with `--proxy-bypass <-loopback>`, so loopback still
goes through the guard and is refused there. A worker that needs its own preview
server opens only explicit ports with `CARD_BROWSER_WORKER_LOOPBACK_PORTS`
(`;`-separated). That list can never include the API port `3002`, the guard
ports (`3099`, `3098`, `CARD_BROWSER_PROXY_PORT`, `CARD_BROWSER_WORKER_PROXY_PORT`)
or the app's `PORT`: those are dropped with a warning and blocked by origin and
by port even under a `*` allowlist. Private networks, link-local, ULA and cloud
metadata stay refused. The reviewer policy is unchanged.

| | tmux mode (`SESSION_ISOLATION` unset) — only with `CARD_BROWSER_WORKER_IN_APP_CONTAINER=on` | jail mode (`SESSION_ISOLATION=docker`) |
| --- | --- | --- |
| Chromium | the app image's pinned install | a **separate** jail image, `ok-jail-browser:local`, built from `app/jail/Dockerfile` with `WITH_BROWSER=1` and the same pins. The stock `ok-jail:local` has no Chromium and no libs. |
| OS sandbox | on (setuid helper, as for reviewers) | on, via Chromium's **user-namespace** sandbox. The jail keeps `--cap-drop ALL` and `no-new-privileges`; it adds only the seccomp profile `app/server/src/lib/jail-browser-seccomp.json` = Docker's default profile **plus clone / unshare / setns, and chroot** (Chromium's zygote chroots inside its own new user namespace; the kernel still refuses chroot to the capless jail outside one) (generated from a pinned moby commit by `scripts/gen-jail-browser-seccomp.mjs`). `mount`, `bpf` etc. stay blocked. |
| Egress guard | a worker-only guard on `127.0.0.1:3098`, worker policy (loopback refused) | the guard runs **inside the jail** (a verbatim copy of `browser-egress-proxy.ts` + `browser-policy.ts`, started by `tsx` before the session) with the worker policy embedded; loopback, including the jail's `127.0.0.1:3002` API forwarder, is refused |
| Playwright MCP | the reviewer's config (`--mcp-config`) | the same args, in the jail HOME |
| Fail closed | flag not set → **no browser**; worker guard not running → **no browser** | profile missing → **no browser** |
| Secrets | none: the MCP server is started with `env -i` and only `PATH`, `HOME`, `LANG`, `PLAYWRIGHT_BROWSERS_PATH` | same |

Every marked session also gets a launcher, `$CC_BROWSER_LAUNCHER`
(`cc-browser.mjs`), for scripts and the shell:

```sh
node "$CC_BROWSER_LAUNCHER" check                      # launches; reports sandbox namespaces + guard
node "$CC_BROWSER_LAUNCHER" screenshot <url> <out.png> # 1440x900 by default; --full, --width, --height
# or: const { launch } = await import(process.env.CC_BROWSER_LAUNCHER)
```

`launch()` fixes the binary, `headless`, `chromiumSandbox` and the proxy, and
**refuses** `--no-sandbox`, `--disable-setuid-sandbox`, `--no-zygote`, any
`--proxy-*` switch, and overrides of `executablePath` / `proxy` /
`chromiumSandbox` / `env`. Chromium gets only a fixed non-secret env
(`BROWSER_ENV_ALLOWLIST`: `PATH`, `HOME`, `LANG`, `LC_ALL`, `TZ`, `TMPDIR`,
`XDG_RUNTIME_DIR`, `FONTCONFIG_PATH`), never the session env and its secrets
(Playwright would otherwise pass `process.env` through). It waits up to 10 s for the guard and then refuses to start
an unguarded browser. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` keeps a worker from
quietly installing an unpinned Chromium of its own.

When the server cannot keep the lockdown it gives the card **no** browser and
sets `CC_CARD_BROWSER_REFUSED=<reason>`; the worker prompt tells the session to
report that as a blocker instead of working around it.

Enabling the jail half on an install: build the browser image once
(`docker build -t ok-jail-browser:local --build-arg WITH_BROWSER=1 -f app/jail/Dockerfile app/jail`)
and pin it by digest with `SESSION_JAIL_BROWSER_IMAGE`. A marked card on an
install that has not built it fails to start its jail (docker cannot find the
image) — loud, never a browser-less fallback that pretends.

**Honest limit.** The guard fences the *browser* — what a hostile page can
reach. It does not fence the worker's own shell, which already has whatever
network the card was given.

**Proof.** `.github/workflows/jail-browser-proof.yml` builds both jail images
and runs `scripts/jail-browser-proof.sh`: a stock jail has no Chromium; a
browser jail started with the production argv launches Chromium with its
renderers in their own namespaces, is refused a loopback preview by default,
loads it once its port is in `CARD_BROWSER_WORKER_LOOPBACK_PORTS`, is refused
`127.0.0.1:3002` even when that port is listed, and is refused `example.com`,
the metadata endpoint, `--no-sandbox` and a missing guard. Hosts that block unprivileged user namespaces
(`kernel.apparmor_restrict_unprivileged_userns=1` on Ubuntu 23.10+, or
`kernel.unprivileged_userns_clone=0`) make `check` fail with "No usable
sandbox" — fix it on the host; never turn the sandbox off to get past it.

## What the browser may reach, out of the box

* this install's own site (`DOMAIN` in `client.conf`)
* anything on `localhost` / `127.0.0.1` / `[::1]` — the preview servers sessions
  start, which is what preview review depends on. **Reviewer and arena browsers
  only**: a worker card's browser refuses loopback (see "Worker policy" above).

Everything else is refused, including the cloud metadata endpoint and the whole
private network, and every refusal is logged as
`[card-browser] BLOCKED <target>: <reason>`.

## Configuring it (`client.conf`)

```sh
# Extra sites your reviews need. ";"-separated; a leading *. matches sub-domains.
BROWSER_ALLOWED_ORIGINS="https://*.vercel.app;https://staging.example.com"

# Refused even if a rule above would allow them. Checked first, so it always wins.
BROWSER_BLOCKED_ORIGINS=""

# Reach other machines on this server's private network (10.x / 192.168.x / 172.16-31.x).
BROWSER_ALLOW_PRIVATE_NETWORK="off"

# Open http://localhost:… — needed for preview review.
BROWSER_ALLOW_LOOPBACK="on"

# Chromium's operating-system sandbox. Do not turn this off.
BROWSER_SANDBOX="on"
```

Re-run `sudo ./install.sh --config client.conf` (or `install/update.sh`) to
apply. The cloud metadata endpoint has **no** `client.conf` switch: it is
blocked by host AND by resolved address, and the only override is the
`CARD_BROWSER_ALLOW_METADATA` environment variable, which exists so the block
is testable, not so it is convenient.

### The full environment surface

| Variable | Default | Effect |
| --- | --- | --- |
| `CARD_BROWSER_SANDBOX` | `on` | keep Chromium's OS sandbox |
| `CARD_BROWSER_EGRESS_GUARD` | `on` | run the loopback proxy and point Chromium at it |
| `CARD_BROWSER_ALLOWED_ORIGINS` | *(empty)* | extra allowed origin patterns, `;`-separated |
| `CARD_BROWSER_BLOCKED_ORIGINS` | *(empty)* | extra blocked origin patterns |
| `CARD_BROWSER_ALLOW_LOOPBACK` | `on` | allow `localhost`/loopback destinations |
| `CARD_BROWSER_ALLOW_PRIVATE_NETWORK` | `off` | allow RFC1918 / CGNAT / link-local |
| `CARD_BROWSER_ALLOW_METADATA` | `off` | allow cloud instance metadata |
| `CARD_BROWSER_PROXY_PORT` | `3099` | loopback port the guard binds |
| `CARD_BROWSER_WORKER_IN_APP_CONTAINER` | `off` | let a `needs_browser` worker on the tmux path run Chromium in the app container (warned at boot) |
| `CARD_BROWSER_WORKER_PROXY_PORT` | `3098` | port of the worker-only guard (tmux opt-in) |
| `CARD_BROWSER_WORKER_LOOPBACK_PORTS` | *(empty)* | loopback preview ports a worker browser may reach; never 3002 or a guard port |

`CARD_BROWSER_ALLOW_LOOPBACK` applies to reviewer and arena browsers only; a
worker browser ignores it.

## Proving it

```sh
sudo bash install/verify.sh --config client.conf
```

Check 9 asserts, live and through the same proxy Chromium uses, that:

* the OS sandbox is on
* the browser's user is `ccuser`, not root
* the guard is listening
* `http://169.254.169.254/` is refused (**403**)
* an off-allowlist site is refused (**403**)
* an **allowed** origin still loads (**200**) — the other direction matters just
  as much; a policy that breaks preview review has not secured anything
* Playwright is pinned to a version, not `latest`

The same rules are unit-tested, with real sockets, in
`app/server/src/services/browser-egress-proxy.test.ts`, and the policy itself in
`app/server/src/lib/browser-policy.test.ts`.

Ad hoc, on a running install:

```sh
docker exec command-center curl -s -H "X-Internal-Secret: $INTERNAL_API_SECRET" \
  http://127.0.0.1:3002/api/internal/install/browser-status | jq
```

## Updating the card browser

Pinning makes the update an explicit act. When a Chromium advisory lands:

1. See what is out:
   ```sh
   npm view playwright version
   npm view @playwright/mcp version
   ```
2. See which Chromium a Playwright release bundles — read it from the release's
   own tarball, not from a summary:
   ```sh
   npm pack playwright-core@<version> --pack-destination /tmp >/dev/null
   tar -xzOf /tmp/playwright-core-<version>.tgz package/browsers.json \
     | jq -r '.browsers[] | select(.name=="chromium") | .browserVersion'
   ```
3. Compare that against the Chrome stable version in the advisory
   ([Chrome Releases](https://chromereleases.googleblog.com/)). You want a build
   **at or above** the fixed Chrome stable version.
4. Pick the `@playwright/mcp` release whose OWN `playwright-core` dependency
   expects the same Chromium revision — that copy is what speaks CDP to the
   browser, and it ships as an alpha of the next Playwright minor:
   ```sh
   npm view @playwright/mcp@<version> dependencies          # → playwright-core@<x>
   npm pack playwright-core@<x> --pack-destination /tmp >/dev/null
   tar -xzOf /tmp/playwright-core-<x>.tgz package/browsers.json \
     | jq -r '.browsers[] | select(.name=="chromium") | .revision'
   ```
   If no MCP release matches yet, stay on the previous Playwright pin.
5. Bump the versions in **all three** places — CI fails the PR if you miss one:
   * `app/Dockerfile` → `ARG PLAYWRIGHT_VERSION` / `ARG PLAYWRIGHT_MCP_VERSION`
   * `app/jail/Dockerfile` → the same two `ARG`s (the browser jail image)
   * `app/server/src/lib/browser-pins.ts` → `PLAYWRIGHT_VERSION`,
     `PLAYWRIGHT_MCP_VERSION`, `CHROMIUM_VERSION`, `CHROMIUM_REVISION`
6. Ship it, then rebuild and re-verify on the install:
   ```sh
   sudo bash install/update.sh --config client.conf
   sudo bash install/verify.sh --config client.conf
   ```
   `update.sh` prints the versions the install is now actually running.

## Residual risk (not hidden)

* **Loopback is allowed by default for reviewer and arena browsers** (not for
  worker browsers, which refuse it), because preview review needs it. A
  compromised browser can therefore reach the app on `127.0.0.1:3002` — which
  still has to get past the app's own auth, but is a bigger surface than the
  public internet. An install that never previews locally should set
  `BROWSER_ALLOW_LOOPBACK="off"`; the guard then forces loopback back through
  itself (`--proxy-bypass <-loopback>`) rather than letting Chromium's default
  bypass apply.
* **The browser still shares the app's container.** The sandbox and the egress
  guard are the controls; container separation is not. Moving the browser into
  its own secret-free container is the structural fix and is a separate change —
  it needs a `docker-compose.yml` mount change, which is a rebuild.
* **Non-proxied protocols.** The guard covers http/https, which is what
  Playwright MCP navigates. WebRTC and raw DNS are not proxied by Chromium's
  `--proxy-server`.
* **Sandboxed (`SESSION_ISOLATION=docker`) sessions have no browser** unless
  the card set `needs_browser` (see above). A marked jail runs a separate image
  and a seccomp profile that allows user namespaces; the user-namespace sandbox
  widens the kernel surface a renderer can touch compared with a jail that has
  no browser at all. That is the trade the opt-in buys, and why it is per card.
* **In-jail guard runs as the session's uid.** The session can kill it — the
  launcher then refuses to start a browser — but it is not protected from the
  session itself (see "Honest limit" above).
