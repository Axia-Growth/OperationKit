# GitHub webhooks → the live server (obj 901408)

**Date:** 2026-11-18 · **Live host:** `https://ai.exampleai.com` (OVH, behind Cloudflare Access)
· **Old host (dead):** `cc.example.com` (DigitalOcean droplet, deliveries failed `502 failed to connect to host`)

The server has ONE receiver, `POST /api/webhooks/github` (`app/server/src/routes/github-webhook.ts`,
mounted in `app/server/src/index.ts` with a raw body for HMAC). It drives the changelog, PR state on
cards, preview spool, external remediation, dev-items, and **auto-deploy on merge**
(`services/auto-deploy.ts`, see [auto-deploy.md](./auto-deploy.md)).

## 1. What is wired today (after this card)

| Hook | Scope | Events | URL (before → after) | Secret |
|---|---|---|---|---|
| `654232949` "web" | repo `your-org/operationkit` | `check_run`, `pull_request`, `status`, `workflow_run` | `https://cc.example.com/api/webhooks/github` → `https://ai.exampleai.com/api/webhooks/github` | unchanged (set, not rotated) |
| `645001817` | **org** `your-org` (every repo, incl. `OperationKit`) | `pull_request` | same move | unchanged (set, not rotated) |

Only `config.url` was changed, through `PATCH …/hooks/<id>/config`, which leaves `secret`,
`content_type` (json), `insecure_ssl` (0), events and `active` as they were. Path kept: the code
still mounts `/api/webhooks/github`.

Public repo `m1keluka/OperationKit` has **no** repo-level hook (`GET /repos/m1keluka/OperationKit/hooks` → `[]`),
but the org hook above already delivers its `pull_request` events.

## 2. Delivery status — HTTP 200, but the app does NOT receive it yet

| Delivery | Before | After |
|---|---|---|
| repo hook, `check_run` 2026-11-18T03:44:37Z | `502 failed to connect to host` | — |
| repo hook, `ping` 2026-11-18T03:44:42Z | — | `200 OK` |
| repo hook, `check_run` / `workflow_run` 03:45:02Z / 03:45:03Z | — | `200` |
| org hook, `pull_request` 2026-11-18T03:44:12Z | `502` | — |
| org hook, `ping` 2026-11-18T03:45:14Z | — | `200` |

**The 200 is from Cloudflare Access, not from the app.** The response body of the 03:45:03Z
delivery is `Server: cloudflare`, `Content-Type: text/html`,
`<title>Sign in ・ Cloudflare Access</title>`. A plain `curl -X POST https://ai.exampleai.com/api/webhooks/github`
gets `302 → https://<team>.cloudflareaccess.com/cdn-cgi/access/login/…`. The app replies
`{"ok":true}` (JSON) to a ping; that is not what came back.

So the 502 is gone, but **merges still do not reach the server** until Access lets this one path
through. That is a Cloudflare change, out of scope for this card (no DNS / Cloudflare / secret
changes). It also cannot go through the installer: `install/cloudflare.sh api-bypass` refuses
any `/api/webhooks` path by design (`docs/CLOUDFLARE-API-ACCESS.md`, "operator surface").

### 2a. The fix that needs the owner (Cloudflare Access)

A separate Access application, **not** the installer's "API (key auth)" app:

- Name: `Operation Kit GitHub webhook`
- Path: exactly `ai.exampleai.com/api/webhooks/github`
- Policy: **Bypass**, include **IP ranges** = GitHub's webhook ranges from
  `https://api.github.com/meta` → `hooks` (on 2026-11-18: `192.30.252.0/22`, `185.199.108.0/22`,
  `140.82.112.0/20`, `143.55.64.0/20`, `9.234.106.48/28`, `9.234.98.160/28`, `9.234.98.176/28`,
  `2a0a:a440::/29`, `2606:50c0::/32`). Use "Everyone" instead only if keeping the IP list current
  is too much work; the HMAC check is the real lock either way.

**Precondition, check BEFORE adding the bypass:** `GITHUB_WEBHOOK_SECRET` must be set on the live
host and equal the hooks' secret. If it is unset, the route accepts **unsigned** requests ("dev
mode", `verifySignature` in `github-webhook.ts`), and a bypassed path would let anyone post a fake
merge. After the bypass, redeliver the last ping:

- `{"ok":true}` JSON → done.
- `401 {"ok":false,"error":"invalid signature"}` → secret mismatch. Rotating needs the owner's
  approval (set the same new value in the hooks AND in Settings → Secrets, then restart).

## 3. Proposal: public `m1keluka/OperationKit` webhook

**The live server runs public code.** `/api/health` on the live host reports commit
`eb19e1a74581`, which is `m1keluka/OperationKit` public sync #125
("chore: sync from upstream (gated)") and does not exist in `operationkit`. So the merge that
should move production is the **public** sync merge, not the private one.

Recommendation:

1. **Do not add a second, repo-level hook on OperationKit.** The org hook `645001817` already sends
   OperationKit `pull_request` events to the same URL. A repo hook would deliver every merge twice
   (different `X-GitHub-Delivery` ids, so the dedupe in `github-webhook.ts` would not catch it).
   Add a repo hook only if the org hook is ever removed; then use events `pull_request` only, JSON,
   the same URL and secret.
2. **Notify by default, auto-deploy only with Operator's approval.** `shouldAutoDeploy` fires only when
   the merged PR's repo equals `selfRepo()` (`HARNESS_REPO` env → `settings.install_harness_repo`,
   seeded as `your-org/operationkit` in `lib/install-defaults.ts`) and the
   base is `main`, and only deploys when `settings.auto_deploy_enabled='1'`. With the flag `0` a
   public merge is logged as `WOULD auto-deploy` (a notification), nothing runs.
   - Notify only (recommended first step): set `HARNESS_REPO=m1keluka/OperationKit` on the live
     host if it is not already, leave `auto_deploy_enabled='0'`. Each public sync merge shows in the
     log and on the changelog.
   - Auto-deploy (needs Operator's explicit OK): flip `auto_deploy_enabled='1'`. Also check
     `CC_REPO_DIR` points at the live public checkout (default is the old droplet path
     `/home/operator/projects/operationkit`; the OVH source lives under `/opt/operationkit-src`),
     otherwise the spawned `self-deploy.sh` will not be found.
3. Private `operationkit` merges keep feeding card/PR state, CI remediation and the
   changelog through the same hooks. They should not self-deploy the live host; their code reaches
   it through the public sync PR. **Watch out:** if the live host still has the seeded harness repo
   (`your-org/operationkit`), a PRIVATE merge is the one that matches `selfRepo()`, and
   with auto-deploy armed it would redeploy the public checkout at the wrong moment (before the public
   sync merges). Setting `HARNESS_REPO=m1keluka/OperationKit` fixes both this and step 2.

## 4. How to re-check

```bash
gh api repos/your-org/operationkit/hooks/654232949 -q '[.config.url,.last_response]'
gh api orgs/your-org/hooks/645001817 -q '[.config.url,.last_response]'
gh api 'repos/your-org/operationkit/hooks/654232949/deliveries?per_page=5' \
  -q '.[]|[.delivered_at,.event,.status_code]|@tsv'
# Then open one delivery and check the response body is JSON from the app, not the Access page.
```
