# Security

OperationKit is **self-hosted, multi-tenant work infrastructure**. It runs AI coding agents as jobs on a machine you control, with workspace-level isolation between teams or business units. It is **not** a multi-tenant SaaS run by someone else. You run the instance, so you decide who shares it.

If you would not give someone SSH on this host, do not give them a login that can spawn sessions.

## Threat model (honest)

| Assumption | What it means |
| --- | --- |
| Trusted operators | Anyone who can spawn a session is trusted with the host. Agent CLIs run with auto-approval (`--dangerously-skip-permissions` / Grok `--always-approve`). |
| Docker socket | Client installs (`install/docker-compose.yml`) do **not** mount `/var/run/docker.sock` into the app. A policy sidecar (`install/docker-proxy/`) owns it and only lets the app create locked-down sandboxes and manage containers that carry the sandbox label; every call is logged. The repo-root `docker-compose.yml` (the upstream operator's own development layout) still mounts the socket, which is equivalent to host root. See "Docker socket" below. |
| Shared container | Claude/Codex/Grok home directories and host project mounts are visible inside the same container. Workspaces are a SQL filter, not a jail. |
| Disk trust | SQLite and session transcripts sit on disk. Encrypt the disk; there is no whole-database encryption. PATs, Google refresh tokens, and the secrets store use AES-256-GCM. |
| Single node | Login throttling and webhook dedupe are in-process. One Node process, one host. |

A later “PE diligence” pass is: dedicated tenant, MFA/SSO, socket-less member sessions, scoped spawn env, transcript encryption. None of that is this baseline.

## What this baseline does ship

- **Docker policy sidecar instead of the Docker socket** (client installs; public issue #97). The
  app container has no `/var/run/docker.sock`. `ok-docker-proxy` holds it and serves a filtered
  Docker API on a private network (`DOCKER_HOST=tcp://docker-proxy:2375`). Rules
  (`install/docker-proxy/policy.mjs`): only the endpoints the app uses; a create must be a
  sandbox (name `ok-jail-<id>`, label `ok.objective`, allow-listed image, non-root user,
  `CapDrop ALL`, `no-new-privileges`, read-only root); `Privileged`, `CapAdd`, host
  network / pid / ipc / uts / userns / cgroupns, devices, published ports, named volumes, unknown
  HostConfig fields and any bind outside `OK_STATE` (resolved through symlinks) are refused;
  exec / rm / logs / inspect / start and the rest need the `ok.objective` label on the target;
  `docker ps` lists only labelled containers. Docker reads JSON field names case-insensitively, so
  the sidecar refuses case-folded duplicate keys and forwards its own serialisation of the body it
  checked; every other call must have NO body (a GET/DELETE body would be parsed by Docker as the
  next request), API versions below 1.41 are refused, uid/gid 0 is refused in every spelling Go
  accepts (`0`, `00`, `+0`, `root`), the only seccomp profile a jail may carry is the one this
  checkout ships, an empty cgroupns mode is pinned to `private`, a jail starts only once, and the
  attach/exec stream is spliced only after Docker answers `101` (nothing pipelined behind it). One JSON audit line per call goes to `$INSTALL_DIR/logs/docker-proxy/audit.jsonl`,
  outside every app mount. Proofs: `install/test/docker-proxy-test.mjs` (rules, no Docker),
  `scripts/docker-proxy-proof.sh` (the real docker CLI against a real daemon, in the Session Jail
  Proof workflow), `install/verify.sh` check 11 (on every install).

- TLS at the edge (Caddy), HSTS, CSP, `X-Frame-Options: DENY`, `nosniff`, `Permissions-Policy`
- Express hides `X-Powered-By` and repeats those headers (so localhost / a stale Caddyfile still look respectable)
- httpOnly, `Secure` (production), `SameSite=strict` session cookies
- bcrypt passwords; missing-user 401s still run a dummy compare
- **No git-committed JWT fallback.** `JWT_SECRET` is required at boot (min 16 chars, not a placeholder)
- Login throttle: 10 failures / 15 min per IP+username, 30 / 15 min per IP
- GitHub webhook HMAC (`GITHUB_WEBHOOK_SECRET`)
- Optional UptimeRobot webhook token (`UPTIMEROBOT_WEBHOOK_TOKEN` as `?token=` on the webhook URL)
- Internal APIs (`/api/internal/*`): a request must be credentialled (`X-Internal-Secret` =
  `INTERNAL_API_SECRET`, or the scoped `OBJECTIVES_API_TOKEN`) **or** a genuine on-box caller
  (socket-based origin check; forwarding headers can only make a request less trusted). Set
  `INTERNAL_API_REQUIRE_SECRET=1` to drop the on-box allowance everywhere.
- Internal **board reads** (`GET /api/internal/objectives*`, `/strategies*`) additionally resolve an
  authenticated PRINCIPAL and authorize the rows (obj 900321): a card session presents the
  objective-scoped `X-CC-Session-Token` it is spawned with and is confined to its card's workspace,
  re-checking workspace AND user membership on every request; a sandboxed session peer with no token
  is refused even though it is network-local. `CC_INTERNAL_BOARD_REQUIRE_PRINCIPAL=1` (or settings
  `internal_board_require_principal`) additionally withdraws the bare on-box allowance for those reads.
- Automatic knowledge-base retrieval (the spawn-prompt path) is **filtered** to the card's workspace,
  not merely boosted toward it, and the retrieved text is injected inside an untrusted-content frame.
- **Card browser lockdown** (obj 900024). The Chromium that review/QA sessions drive runs
  **non-root** (`ccuser`) with its **OS sandbox ON** — `--no-sandbox` is passed only on an
  explicit, logged operator opt-out. Its network egress goes through a loopback guard
  (`services/browser-egress-proxy.ts`) that Chromium is pointed at with `--proxy-server`, so
  **only allowed origins** are reachable: by default this install's own domain plus localhost
  (preview servers), and nothing else. Cloud instance metadata (`169.254.169.254` and
  friends) and the private network are refused by host **and** by resolved address, so an
  allowlisted name that resolves into them is still blocked (DNS rebinding / SSRF). The guard
  re-checks every redirect hop and pins DNS; Playwright's own `--allowed-origins` is passed
  too but is explicitly *not* a security boundary per its own documentation, so it is
  defence-in-depth, not the control. Playwright and `@playwright/mcp` are **pinned**
  (`lib/browser-pins.ts`, asserted against `app/Dockerfile` in CI) instead of resolving
  `@latest` at every spawn. Configure per install with `BROWSER_*` in `client.conf`;
  `install/verify.sh` check 9 proves sandbox-on, non-root, blocked-off-allowlist and
  allowed-still-works on the live install. See
  [docs/wiki/Card-Browser-Lockdown.md](docs/wiki/Card-Browser-Lockdown.md).
  Current pins: Playwright **1.65.0** → Chromium **158.0.8127.18**, `@playwright/mcp` **0.0.85**.
  **Update path:** bump `PLAYWRIGHT_VERSION` / `PLAYWRIGHT_MCP_VERSION` in `app/Dockerfile` and
  `app/server/src/lib/browser-pins.ts`, then `sudo bash install/update.sh --config client.conf`
  (rebuilds the image and prints the versions now running) and `install/verify.sh`. Step-by-step:
  [Updating the card browser](docs/wiki/Card-Browser-Lockdown.md#updating-the-card-browser).
- **Cloudflare Access allow-list sync** (optional, off unless a token is present): when an admin
  adds, re-emails or deletes a user in Settings → Users, the server syncs that ONE email into or
  out of this install's own Access "Allowed people" policy. Scope is pinned at three levels — one
  account (`OK_CF_ACCOUNT_ID`), one application (matched on the AUD tag this install already
  verifies its sign-in JWTs against), one `allow` policy — and the verify-robot policy is refused
  by name AND by decision. Domain rules are never created, edited or removed; addresses from
  `ACCESS_ALLOWED_EMAILS` are never removed; a removal that would empty the policy is refused.
  The token is entered by an admin in Settings → Users → Cloudflare sign-in sync (stored
  AES-256-GCM in the secrets store under the server-only key `CC_SERVER_CF_ACCESS_SYNC_TOKEN`,
  write-only, cookie-admin only to set or remove, never hydrated into the process env, a session
  env or the secrets broker), with `OK_CF_ACCESS_API_TOKEN` in the environment as the fallback.
  Either way it is never logged, never returned by an API route, never put in an error message
  and never in the client bundle — asserted in `app/server/src/lib/cf-access-policy.test.ts`,
  `app/server/src/routes/admin-users.cf-sync-token.test.ts` and
  `app/client/src/components/config/CfAccessSyncCard.bundle.test.ts`. When
  `OK_CF_ACCOUNT_ID` is absent the account is resolved read-only from the token (the one account
  whose Access apps include this install's AUD). Re-running the installer MERGES client.conf
  into "Allowed people" rather than overwriting it, so it never drops app-added addresses. Least privilege for it is a single Cloudflare
  permission: **Account → Access: Apps and Policies → Edit**, scoped to that one account. Absent,
  wrong or under-scoped, the feature degrades to a per-user "blocked at Cloudflare" badge and
  changes nothing else.
- SSH for session git: `StrictHostKeyChecking=accept-new` and `IdentitiesOnly=yes`
- Workspace-scoped board APIs; WebSocket auth via the same cookie

## Production env

Set these before exposing the app. Compose maps `CC_JWT_SECRET` → `JWT_SECRET` inside the container.

| Variable | Required | Notes |
| --- | --- | --- |
| `CC_JWT_SECRET` / `JWT_SECRET` | yes | `openssl rand -base64 48` |
| `INTERNAL_API_SECRET` | yes in production | Credential for `/api/internal/*`. On its own it does NOT displace the on-box allowance — set `INTERNAL_API_REQUIRE_SECRET=1` for that |
| `GITHUB_WEBHOOK_SECRET` | if you use the GitHub webhook | HMAC-SHA256 |
| `UPTIMEROBOT_WEBHOOK_TOKEN` | recommended | Put `?token=…` on the UptimeRobot webhook URL. Unset = route stays open and the server logs a warning |
| `CORS_ORIGINS` | if your public origin is not the default | Comma-separated |
| `CARD_BROWSER_*` | no (safe defaults) | Card browser lockdown. `SANDBOX`/`EGRESS_GUARD` default on; `ALLOW_PRIVATE_NETWORK`/`ALLOW_METADATA` default off. Set from `client.conf` `BROWSER_*` by the installer — see [Card-Browser-Lockdown](docs/wiki/Card-Browser-Lockdown.md) |
| `OK_CF_ACCESS_API_TOKEN` | optional | Cloudflare token for the Access allow-list sync. Give it exactly ONE permission — Account → Access: Apps and Policies → Edit — scoped to the single account that hosts this install. Omit it and Settings → Users still works; it just cannot update Cloudflare |
| `OK_CF_ACCOUNT_ID`, `OK_CF_ACCESS_APP_ID`, `OK_CF_ACCESS_PROTECTED_EMAILS` | with the above | Not secrets. Written by `install/cloudflare.sh`; they pin the sync to one account, one app and the installer-owned addresses it must never remove |

See `.env.example`. Never commit `.env`.

## Reporting a vulnerability

Please **do not** open a public issue for an exploitable bug.

- GitHub: private vulnerability report on this repository
- Or email the maintainers listed on the repo

We will acknowledge, fix, and credit (unless you ask not to).

## Self-host checklist

1. Bind the app to localhost; put TLS in front (the Caddyfile in `config/caddy/` is the reference).
2. Generate `CC_JWT_SECRET` and `INTERNAL_API_SECRET`. Confirm the process will not boot without them.
3. Pre-populate `~/.ssh/known_hosts` on the host (`ssh-keyscan github.com`) — the `.ssh` mount is read-only, so `accept-new` cannot append.
4. Set `UPTIMEROBOT_WEBHOOK_TOKEN` and `GITHUB_WEBHOOK_SECRET` if those routes are reachable.
5. Change the seed password immediately (`changeme` in `app/server/src/db/seed.ts` is a first-boot default).
6. Do not publish the Docker socket to a network, and do not add untrusted session spawners. On a
   client install keep the app on the sidecar (no `docker.sock` mount; `install/verify.sh` check 11
   fails if one comes back) and leave `HOST_RUNNER="off"` unless you use the Dev bot's deploy and
   Cloudflare tools on that server.
7. Leave `BROWSER_SANDBOX` and the card browser egress guard on, and keep Playwright pinned to a release whose Chromium is at or above current Chrome stable (`install/update.sh` prints what you are running).
8. If you enable the Cloudflare Access allow-list sync, issue a **separate** token for it with the
   single Access: Apps and Policies → Edit permission. Do not reuse the installer's token: that one
   can also edit DNS, tunnels, identity providers and service tokens, and it only needs to exist for
   the length of the install.

## Known gaps (documented, not hidden)

- Docker socket: closed for the app on client installs (policy sidecar). What is left:
  - the sidecar itself holds the socket (= host root); it is ~700 lines of plain Node with no dependencies,
    runs from a read-only folder the app cannot write, and has no network but the private one
    to the app
  - `HOST_RUNNER="on"` re-opens ONE privileged path: the Dev bot's host runner, pinned to the
    shipped script bytes and this install's paths, and never an `exec` into it. Whoever controls the
    app can then run what that script offers (deploy `origin/main`, the scripted Cloudflare edits),
    not arbitrary code
  - a bind source is checked (symlinks resolved) at create and again right before `start`, where
    Docker resolves it, and a jail starts only once. The app can still write inside `OK_STATE`, so
    a symlink swapped in during the window between that last check and Docker's mount is a race
    the sidecar cannot close by itself (it only lowers the odds: each try costs a new jail, and
    the jail runs as a non-root uid/gid with no capabilities). Closing it needs the session
    folders on a path the app cannot rename (follow-up)
  - the repo-root `docker-compose.yml` (operator development layout) still mounts the socket
- The card browser is sandboxed and egress-restricted, but still shares the app container. Moving it to its own secret-free container is the structural fix and is not in this baseline
- The card browser may reach `localhost` by default (preview review needs it); set `BROWSER_ALLOW_LOOPBACK="off"` on installs that never preview locally
- Sibling OAuth homes in one container
- No MFA / SSO / passkeys
- Spawn env scoping for docker.sock / sibling homes is still the admin-only default (operator layout)
- UptimeRobot token is optional until you set it, because UR cannot HMAC
