# Operation Kit

**Describe the outcome. Approve the breakdown. The install handles the rest.**

> One install per client, on the client's own server. They own it. You spend your time on their problem.

An AI implementation consultant's scarce time goes on understanding a client's problem and breaking
it into pieces. It should not go on writing agent files, wiring context, building verification, or
babysitting sessions. Operation Kit is a capable harness that does that work so you don't have to.

The work loop is three steps:

1. **State the problem.** Open a card (or tell a bot in Chat) what outcome you want, in plain words:
   "every new lead from the website lands in the CRM with a follow-up drafted", not "write a skill
   that calls the CRM API".
2. **Approve the breakdown.** For a bigger job, a planner reads the card and the client's knowledge
   base, asks you questions, and drafts a plan with checkable acceptance criteria. You change it until
   it is right, then press **Approve plan**. Large work splits into child cards that run side by side.
3. **The harness owns the plumbing.** Each card runs a coding agent (Claude Code by default; Codex and
   Grok supported) in its own sandbox, with the client's knowledge, connected accounts and secrets
   already in reach. It writes progress as it goes, keeps memory across restarts, and an independent
   AI reviewer checks the result against the criteria before a person signs it off. When it needs
   you, it asks one clear question in **Needs you**; otherwise it gets on with it.

A consultant installs one copy per client in under an hour and starts every engagement 80 to 90
percent of the way there.

**Website:** [operationkit.com](https://operationkit.com) · **Guides and articles:** [operationkit.com/blog](https://operationkit.com/blog/)

## What the harness takes care of

You should not have to manage any of this by hand. It is built in:

| | What it does for you |
|---|---|
| **Context** | A knowledge base (**Context** in the top bar) of the client's own files (Excel, CSV, PDF, Word, chat exports, call transcripts) compiled into linked notes, with every answer citing its source. Each card gets the relevant part of it automatically. Plain markdown, so it opens in Obsidian or any editor. |
| **Breakdown and orchestration** | The Planning stage turns a stated outcome into a plan and acceptance criteria for you to approve. A card can fan out into child cards that run in parallel and roll their results back up. |
| **Verification** | An independent AI reviewer grades every finished card against its criteria, and code changes ship as pull requests behind the client's CI checks. "Done" means checked, not "the agent said so". |
| **Memory** | Each card keeps working notes across restarts and a final deliverable for the reviewer. Bots can keep their own notes, open loops and a journal. |
| **Automations** | Recurring work runs on a schedule from **Workflows**; every run is a card with the same review and history. |
| **Connections** | Link GitHub and Google Workspace once in Settings, add remote MCP servers, and store API keys in an encrypted secrets store. Agents use them by name and never see the values. |
| **Decisions** | When a job needs a person, it raises one short briefing (context, one question, options, a recommendation) in **Needs you**, not a wall of text. |
| **Any AI app** | Claude, ChatGPT, Grok, Codex, Cursor and other MCP apps connect with a named, limited key and reach the same knowledge base, bots and board. [Connect your AI](./docs/CONNECT-YOUR-AGENT.md). |
| **Workspaces** | Separate teams or business units inside one install, each with its own board and knowledge folders. |

**Bots (optional).** Chat is one ongoing conversation per bot, like a personal assistant. Bots read
and update their own notes, draft emails and calendar invites for a person to send (never on their
own), and hand bigger jobs to the board as cards. A built-in setup bot helps with integrations,
email and branding, and drafts a new bot for you from a plain description of what it is for.

## Why the client owns the install

- **Their server, their data.** Every client has its own copy on its own server. There is no shared
  Operation Kit cloud and no central database holding several clients' data.
- **Their AI accounts.** Work runs on the client's own Claude subscription or API key (OpenAI and
  Gemini optional). No pooled or resold seats.
- **Fewer vendor-risk questions.** Because client data never sits on a vendor's systems, the usual
  "is your vendor SOC 2 audited?" question mostly becomes "is our own server set up well?". To be
  plain about it: **Operation Kit has no SOC 2 attestation**, and we do not claim one. See the
  [security overview](./docs/SECURITY-OVERVIEW.md) for what is protected and what is not done yet.
- **No lock-in to a model.** The knowledge base, the board history and any agent instructions are
  plain files on the server. Switch the AI provider and none of it moves.

## Install

**Check your setup before downloading dependencies.** From this checkout, run
`node scripts/setup-check.mjs` for source development, or
`node scripts/setup-check.mjs --mode server` on the target installation host.
The check needs no npm packages and reports host, Node and Docker problems with
next steps. Node is needed to run this optional check, but is not a prerequisite
for the Ubuntu server installer itself. See [setup checks](./INSTALL.md#check-your-environment-first).

A fresh Ubuntu 24.04 server, the client's domain on Cloudflare, and a Claude account. Claude Code on
your laptop follows [INSTALL.md](./INSTALL.md) and does the work; you answer a few questions and do two
short sign-ins. About 30 to 45 minutes, most of it waiting for the build.

The code: <https://github.com/Axia-Growth/OperationKit> (updates come from the same place, and are
applied by hand: [Updating](./INSTALL.md#updating)).

**Recommended stack** (what we run and test): an **OVHcloud Rise** dedicated server, **Backblaze B2**
for encrypted off-site backups, and **Cloudflare** (Free) for the domain, the tunnel and the sign-in.
[docs/RECOMMENDED-STACK.md](./docs/RECOMMENDED-STACK.md) walks through it end to end, from ordering
the server to GitHub tokens and updates. Any Ubuntu 24.04 server works.

**How big a server.** Plan **6 GB of memory plus 3 GB per AI session running at once**, 2 CPU threads
plus 1.5 per session, and 60 GB of disk plus about 3 GB per session plus the client's files:

| Sessions at once | Server | Example (prices checked 2026-11-01) |
|---|---|---|
| 1-2 (solo) | 8+ threads, 16 GB, 150 GB | OVH RISE-1 from $64/month |
| 3-5 (small team) | 12+ threads, 32 GB, 250 GB | OVH RISE-2 from $72/month |
| 6-10+ (heavy) | 24-32 threads, 64-128 GB, 500 GB+ | OVH RISE-4 from about EUR 160/month |

Measured numbers, alternatives and the reasoning: [choosing a server](./docs/RECOMMENDED-STACK.md#1-choose-a-server-size).

```
 Person ──► Cloudflare Access ──► Cloudflare Tunnel ──► client's server (no open web ports)
            who are you?          private connection    ├─ Operation Kit app
                                                        └─ one sandbox per AI job

 Bot ─────► (API routes only) ──► Cloudflare Tunnel ──► Operation Kit checks the key
            Access steps aside
```

A bot sends one thing — its Operation Kit key — so the installer gives the bot-facing API routes
their own Cloudflare Access application set to *bypass*, and the key becomes the check. Operator
routes (`/api/internal`, `/api/admin`, `/api/secrets`, `/api/webhooks`, sign-in) are never in that
list and keep both locks:
[Letting bots reach the API with their key](./INSTALL.md#letting-bots-reach-the-api-with-their-key).

## Docs

| For | Read |
|---|---|
| Guides and articles on running AI inside a business | [operationkit.com/blog](https://operationkit.com/blog/) |
| Setting up from nothing: server size, OVH, Cloudflare, B2 backups, seats, GitHub, updates | [docs/RECOMMENDED-STACK.md](./docs/RECOMMENDED-STACK.md) |
| Installing for a client | [INSTALL.md](./INSTALL.md) |
| Connecting Claude, ChatGPT, Grok or another AI app | [docs/CONNECT-YOUR-AGENT.md](./docs/CONNECT-YOUR-AGENT.md) |
| A bot gets a Cloudflare sign-in page or error 1010 instead of an answer | [docs/CLOUDFLARE-API-ACCESS.md](./docs/CLOUDFLARE-API-ACCESS.md) |
| "Where does our data go?" (plain-language, one page) | [docs/SECURITY-OVERVIEW.md](./docs/SECURITY-OVERVIEW.md) |
| Running a live demo | [docs/DEMO-RUNBOOK.md](./docs/DEMO-RUNBOOK.md) |
| Using it day to day | [docs/product/README.md](./docs/product/README.md) |
| Bots | [docs/product/09-agent-chat.md](./docs/product/09-agent-chat.md) |
| Agent / HTTP / MCP API reference | [docs/api/README.md](./docs/api/README.md) |
| Model choice and portability | [docs/product/08-model-portability.md](./docs/product/08-model-portability.md) |
| Engineers: how the code is laid out (start here) | [docs/architecture/OVERVIEW.md](./docs/architecture/OVERVIEW.md) |
| Engineers: architecture and threat model | [docs/architecture/README.md](./docs/architecture/README.md) · [SECURITY.md](./SECURITY.md) |

## Advanced: writing your own agents and skills

You do not need this to get work done. Cards run on a default worker agent, and the setup bot
writes a bot file for you when you ask for one. It is here for consultants who want to shape a
client's install by hand:

- **Agent and bot files.** Each bot or worker agent is one markdown file (instructions, knowledge
  folders, tools, schedules). Starter templates ship in the box under **Bot setup → Templates** (account menu).
  Format: [docs/agents/agent-file-format.md](./docs/agents/agent-file-format.md). A shared
  marketplace is paused; reuse is copying whole agent files, never skill packs
  ([why](./docs/agents/marketplace.md)).
- **Skills are an escape hatch, not a way to add capability.** Each card's session works out how to
  do the job from the card, the project's own docs and the knowledge base. A skill file is only for
  a rare procedure that must be pinned word for word; the **Skills (advanced)** tab on **Bot setup**
  shows which agents load which skills. See [Skills, Tools & Agents](./docs/wiki/Skills-Tools-Agents.md).
- **Example skills are a prompting library, not a pack to install.** The few in
  [`examples/workspace/skills/`](./examples/workspace/skills/) show how to write a clear brief
  (lead with the outcome, say what done looks like, name the stop conditions). Read them to sharpen
  how you state a problem on a card; you do not need to install them.

## Status

Built to be a solid self-hosted install: Cloudflare in front, no open web ports, sandboxed AI jobs,
encrypted secrets, a forced password change for the first admin, encrypted off-site backups with a
restore test, and automatic security updates for the operating system (Ubuntu's patches; Operation
Kit itself is updated by hand, see [Updating](./INSTALL.md#updating)). It is not an audited SaaS. Known gaps (no SOC 2, no built-in two-factor or SSO beyond Cloudflare Access,
transcripts not encrypted at rest) are listed in the [security overview](./docs/SECURITY-OVERVIEW.md).

## License

Apache-2.0, see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

Copyright 2026 Axia Growth LLC and contributors.

## Contributing

Contributions are welcome. A signed Contributor License Agreement is required before a pull request
can be merged; see [CONTRIBUTING.md](./CONTRIBUTING.md) for local setup, the checks CI runs and the
test rules, and the [architecture overview](./docs/architecture/OVERVIEW.md) for a map of the code.
