# Connector credential broker — GitHub and Google stay on the host (obj 901743)

Public issue #136 pointed out that the README says GitHub and Google Workspace
credentials are stored encrypted and never shown to agents, while `buildSpawnEnv`
decrypted the owner's GitHub PAT and Google refresh token / OAuth client and put
them in the spawned agent's process env (Claude Code, Codex or Grok). That is no
longer the case.

## What a session holds now

| Before | Now |
|---|---|
| `GH_TOKEN`, `GITHUB_TOKEN` (the owner's PAT, or a Secrets-store copy) | `CC_GITHUB_BROKER=1` + the git identity (`GIT_AUTHOR_*`) |
| `GOOGLE_REFRESH_TOKEN`, `GOOGLE_OAUTH_CLIENT_ID/SECRET`, a creds dir with the refresh token in it | `GOOGLE_WORKSPACE_CONNECTION=user`, `USER_GOOGLE_EMAIL`, `CC_GOOGLE_BROKER=1`; the creds dir is always empty |
| `CC_MCP_TOKEN_<id>` per workspace MCP server | nothing; the server's MCP config points at the relay |

The only credential a session has is its own `CC_SESSION_TOKEN`: card-scoped,
expiring, and refused once the card ends, moves workspace or changes owner.

The list of withheld names is `lib/connector-credential-env.ts`. Three layers use it:
`buildSpawnEnv` deletes them whatever their source, `spawnInTmux` strips them again
and the tmux wrapper `unset`s copies inherited from the tmux server env, and the jail
`--env-file` filter (`JAIL_FORBIDDEN_ENV` + the `CC_MCP_TOKEN_` prefix) drops them.
The tmux wrapper script is `0700`, owned by `ccuser` (it was `0777`).

## The broker: `/api/session-broker`

`routes/session-broker.ts`, logic in `services/connector-broker.ts`. Auth is the
`X-CC-Session-Token` header only, and only from an on-box caller (loopback, the docker
bridge gateway or the jail network, with no forwarding headers): a token that leaks into
a transcript does not work through the public proxy. Every request re-reads the live card.

- **GitHub** — `GET /github/git-credential` (git credential-helper format) and
  `GET /github/token?repo=owner/repo` (for the `gh` wrapper). The repo must be linked
  to the card's own workspace (Settings → Workspaces → repos); the card's free-text
  `project` does not widen that. The owner's connector rules (agent-key list, Who can use it, delegated-card
  opt-in, scoped-bot pack) are re-checked and audited on each call, so a tightened rule
  or a revoked key applies at once. A Settings → Secrets `GH_TOKEN` still overrides the
  connection, through the broker.
- **Google** — `POST /google/mcp`, a stateless MCP server registered as the session's
  `google-workspace` server. Tools: `gmail_list_inbox`, `gmail_read_message`,
  `gmail_create_draft`, `calendar_list_events`. The card's mode is enforced before any
  Google request: `drafts_only` (scoped bots that say so) lists and runs only
  `gmail_create_draft`; everyone else is `read_and_drafts`. A read-only (AI reviewer) session gets no Google
  tools. No send, no event insert. A JSON-RPC batch is capped at 20 messages.
  Mail and calendar text comes back inside an untrusted-content frame (boundary 19).
- **Workspace MCP** — `POST|DELETE /mcp/:slug` relays to a server connected in the
  card's workspace and adds its token on the host. `GET` is 405 (no SSE stream through
  the relay). Legacy-SSE servers cannot be relayed and are not offered to sessions.

## Inside the session

`services/connector-broker-shims.ts` writes two static scripts (no secret in either):
in tmux mode to `/tmp/cc-scripts/cc-broker-bin/`, in jail mode to the jail HOME
(`~/.cc/cc-broker-bin/`).

- `git-credential-cc`, wired with env-scoped git config
  (`credential.https://github.com.helper` reset, then `!sh …/git-credential-cc`, plus
  `useHttpPath=true` so git sends `owner/repo`).
- `gh`, first on `PATH`. It asks the broker for the repo in play (`--repo`/`-R`,
  `GH_REPO`, else the `origin` remote) and runs the real `gh` with the credential on
  that one child process. `CC_GH_BROKER=0 gh …` skips the broker and uses an install
  bot login, if there is one.

## Behaviour changes

- A card's session can push and open PRs only for repos linked to its workspace. Any
  other private repo gets a clear refusal, not a token (public clones still work: git
  only asks for a credential on a 401). If the broker refuses, `gh` falls back to an
  install bot login when one exists, as it did before for cards with no connection.
- Tools that read `GH_TOKEN` directly (GitHub Packages `.npmrc`, octokit scripts, a
  GitHub MCP server) no longer find it, and a project's own `GOOGLE_OAUTH_CLIENT_*`
  secret is not exported to sessions either.
- Sessions no longer run the local `workspace-mcp` with the owner's grant. Gmail
  read and drafts plus Calendar read go through the broker; Drive, Docs, Sheets and
  sending mail are not offered to sessions until the broker grows a tool for them.
- Jailed sessions get Google and workspace MCP servers (they had neither before,
  because the old configs lived on host paths the jail cannot see).

## Residual risk

There is no GitHub App, so nothing can mint a short-lived, repo-scoped installation
token. The git and `gh` credential is still the owner's PAT, handed out per request
for one repo, audited, and never in the env, but a session that calls the broker
itself can read it. The follow-up is a GitHub App installation token
(`contents` + `pull_requests`, one repo, one hour).

## Tests

`routes/session-broker.test.ts` (auth, repo scope, connector rules, Google mode,
relay), `services/connector-broker-shims.test.ts` (real `git credential fill` and the
`gh` wrapper against a fake broker), `session-spawn-env.test.ts` and
`session-jail.test.ts` (no credential name or value in the env or the jail env file),
`session-jail-wiring.test.ts` (wrapper `0700`, the unset line, shims wired),
`workspace-mcp-servers.test.ts` (relay descriptor) and section O of
`untrusted-boundaries.test.ts`.
