# Agent files: one file per agent

> **Advanced.** You do not need to write an agent file to get work done: state the outcome on a
> card, approve the plan, and the install handles the rest. The built-in setup bot can also draft a
> bot file for you from a plain description. This page is for consultants who want to shape an
> install by hand.

An **agent** is an AI helper with its own instructions, the knowledge-base folders
it may use, and the tools it may use. Every agent is described by **one file**.
Because it is just a file, you can copy it, email it, keep it in a shared drive,
and import it into another install.

This page explains the file, how to add starter agents, and how to import and
export. No programming is needed.

---

## Where agent files live

Each agent has its own folder on the server:

```
agents/<slug>/agent.yaml
```

`<slug>` is the agent's short id, such as `personal-assistant`. The `agents`
folder sits inside the server's workspace folder (set `AGENT_FILES_DIR` to move
it). You normally never touch these folders by hand — the **Templates** page and
the `agent-template.sh` script write them for you.

An agent can also be written as a Markdown file, `agents/<slug>/agent.md`. The
settings go between two `---` lines at the top, and everything below them is the
agent's instructions.

## What is in the file

| Field | Needed? | What it means |
|---|---|---|
| `name` | yes | The display name, e.g. `Personal assistant`. |
| `slug` | yes | A short id: lowercase letters, numbers and hyphens. Must match the folder name. |
| `description` | recommended | One or two sentences that help people pick the right agent. |
| `avatar` | no | One emoji or up to two letters shown on the agent's badge. |
| `colour` | no | `blue`, `pink`, `green`, `amber` or `grey`. (`color` also works.) |
| `system_prompt` | yes | The agent's instructions, in plain language. |
| `knowledge_folders` | no | The knowledge-base folders the agent may read and write, e.g. `clients/example-co`. Always a folder *inside* the knowledge base. |
| `tools` | no | The tools and connectors the agent may use, by name (see below). |
| `model` | no | A specific AI model. Leave it out to use the workspace default. |
| `provider` | no | `claude`, `anthropic`, `openai`, `xai`, `openai-compatible` or `demo`. Leave it out to use the workspace default. |
| `schedules` | no | Jobs the agent runs on a timetable (see below). |
| `version` | yes for sharing | The file's version, like `1.0.0`. Raise it when you change the agent. |
| `author` | yes for sharing | Who made it — a person or a company. |
| `how_to_use` | no | Text for the bot's **info panel** (the "i" button in its conversation): how to use it. Blank lines start a new paragraph; lines starting with `- ` are bullets. Up to 4,000 characters. |
| `example_prompts` | no | Up to 8 example prompts (300 characters each). The info panel and an empty conversation offer them; picking one puts it in the message box without sending it. |

### Tool names

| Tool | What it allows |
|---|---|
| `search`, `list_folders`, `read_file`, `write_doc`, `file_answer` | Search, browse, read and write the knowledge base, and save a useful answer as a wiki page — only inside `knowledge_folders`. |
| `flag_knowledge` | Report something in the knowledge base that is missing, wrong or out of date (with an optional fix). It lands on the Knowledge base **Cleanup** tab; no page is changed. Any bot that lists `search` or `read_file` gets it automatically. |
| `create_objective`, `get_objective`, `list_objectives`, `board_briefing` | Create board cards for the coding tools, check on them, and summarise what is waiting on the person. |
| `raise_decision` | Ask the person to decide something on a card, with a short briefing (question, options, recommendation). It only asks. A bot with `create_objective` gets it automatically. |
| `propose_outcome` | When the person states an outcome, propose the breakdown: one card, a checkable "done when", acceptance criteria, any child cards and any standing rule ("screenshots on every PR"). Nothing is filed: the person edits it in the chat and presses **Approve and start**. Any bot that lists `create_objective` gets it automatically. See `docs/wiki/Outcome-First-Intake.md`. |
| `followups` | Set itself a one-off follow-up in the chat it is in ("check back in 10 minutes") with `schedule_followup`, `list_followups` and `cancel_followup`. When it is due the bot runs an ordinary turn in that chat and posts its answer; the person sees a "Follow-up scheduled for HH:MM" line with **Cancel**. Any bot that lists `create_objective` gets it automatically. See `docs/wiki/Bot-Follow-Ups.md`. |
| `attach_image` | Attach a screenshot or image to a reply so it shows in the chat. |
| `bot_messages` | Message another bot that may work in the same workspace and get its reply on a shared thread. |
| `email`, `calendar` | Read mail and calendar and prepare **drafts**. Nothing is sent until a person presses Send. |
| `web_search`, `web_fetch` | Search the public web and read public pages. Search needs a search key on the install (see `docs/product/09-agent-chat.md`). |
| `app_routes` | Look up where a page, tab or setting is in this app right now, from the generated app map. Read-only and static. See `docs/wiki/App-Map.md`. |
| `mcp` | Use the tools of the MCP servers connected in the chat's workspace (Settings → Integrations). See `docs/connectors/MCP-SERVERS.md`. |
| `secrets` | Call an outside service with a named secret. The server adds the value; the bot never sees it. **Not included in `all`.** |
| `card_sandbox` | Look inside a card the bot owns: its files, log and transcript, and run a command in its sandbox. Every call is logged. **Not included in `all`.** |
| `card_browser` | Open a public web page in a sandboxed browser and take a screenshot. **Not included in `all`.** |
| `all` (or `*`) | Every built-in tool, including ones added in later releases, **except** `secrets`, `card_sandbox` and `card_browser`. Those three must be named as well, for example `tools: [all, secrets]`. |

The list lives in one file, `app/shared/bot-tools.ts`; a test fails if this table
misses a name.

Other names are allowed (for connectors a client adds), but the importer will
point out that they are not built in.

### Info panel (`how_to_use`, `example_prompts`)

Every bot's conversation has an **i** button that opens an info panel: what the
bot is for, how to use it, example prompts, and what it can reach (worked out from
`knowledge_folders` and `tools`), and the bot's **instructions** (its system
prompt) shown read-only. Add `description`, `how_to_use` and `example_prompts` to
give your bot its own words.

Any of those three that the file leaves out is **written for you** from the bot's
instructions, tools and folders (obj 900747), so a new bot's panel is filled in
the moment it appears:

- At once, a rules-based summary, how-to and example prompts that match the
  bot's current tools exactly.
- Shortly after, a better version written by the bot's own AI provider. It is
  rewritten whenever the bot changes: when it is created or replaced, when an
  admin changes its tools or model on the bot page, and when its file is edited
  (the bot list notices the next time it loads).

Text you write in the file always wins over generated text, field by field. To
switch off the AI-written version (the rules-based one still shows), set
`agent_chat_about_autogen` to `0` in the settings table, or
`AGENT_CHAT_ABOUT_AUTOGEN=0` in the server environment. The instructions are
never editable from the panel; change them in the agent file.

```yaml
example_prompts:
  - Who is waiting on a reply from me?
  - Draft a thank-you note to today's new client
how_to_use: |
  Ask me who needs a follow-up and I will draft the emails.

  - Nothing is sent until you press Send.
  - I only read the clients folder.
```

### Schedules

```yaml
schedules:
  - name: Morning briefing
    cron: "30 7 * * 1-5"      # 7:30 on weekdays
    prompt: |
      Write today's briefing and save it in personal/notes.
```

`cron` is the usual five-part timetable (minute, hour, day, month, weekday).
When an agent is added, each schedule is created **switched off**. Turn it on
when you are ready, so nothing runs by surprise.

### Secrets

Agent files are made to be shared, so they must **never** contain a password or
API key. If the file mentions a credential, mention it by **name only** (for
example "use the `CRM_API_KEY` secret") and store the value in
**Settings → Secrets**. The importer refuses a file that looks like it contains a
real key.

## A complete example

```yaml
name: Example helper
slug: example-helper
description: Answers questions about Example Co from its client folder.
avatar: "EH"
colour: pink
version: 1.0.0
author: Example Consulting
knowledge_folders:
  - clients/example-co
tools:
  - search
  - read_file
system_prompt: |
  You help the team with questions about Example Co.
  Only use what is in the client folder, and say which note each answer came from.
```

---

## Starter agents

Three general-purpose starters ship with every install:

| Starter | What it does |
|---|---|
| **Personal assistant** (`personal-assistant`) | Inbox, calendar and to-dos. Writes drafts only — never sends. |
| **Knowledge librarian** (`knowledge-librarian`) | Keeps the knowledge base organised and answers questions from it, citing the source note. |
| **Operator** (`operator`) | Turns requests into clear board cards for the coding tools, and reports progress. |

Add them from **Agents → Templates** (click **Add agent**), or from the server:

```bash
scripts/agent-template.sh install all              # all three starters
scripts/agent-template.sh install operator         # just one
```

**For installers:** set `STARTER_AGENT_TEMPLATES=all` (or a comma-separated list
such as `personal-assistant,operator`) in the app's environment and the starters
are added the next time the server starts. Running either again is safe: an agent
that already exists is left alone.

## Import an agent file

- **From the screen:** Agents → Templates → **Import agent file**, then pick the
  file. The file is checked first; any problem is listed by field with what to
  fix, and nothing changes until you click **Add agent**. If an agent with the
  same slug already exists you are asked before it is replaced.
- **Paste it:** Agents → Templates → **Paste agent file**, paste the whole file
  (for example one the **Operation Kit Dev** bot wrote for you in chat) and press
  **Check it**. The same checks run, and nothing is added until you click
  **Add agent**. The Agents page's "Paste a bot file" link opens this box.
- **From a folder on the server:** on the same page, type the path. For safety
  only a few folders are allowed (the page lists them) — copy the file into the
  `agent-imports` folder first.
- **From the command line:**

  ```bash
  scripts/agent-template.sh validate ./my-agent.yaml     # check only
  scripts/agent-template.sh import ./my-agent.yaml       # add it
  scripts/agent-template.sh import ./my-agent.yaml --overwrite   # replace an existing one
  ```

## Export an agent

- **From the screen:** Agents → Templates → **Export** next to any agent. You get
  a `<slug>.agent.yaml` file you can share.
- **From the command line:** `scripts/agent-template.sh export operator -o operator.agent.yaml`

Agents created before agent files existed can be exported too; their existing
instructions become the `system_prompt`, and the file is given version `1.0.0`.

## What happens when an agent is added

1. The file is checked. If anything is wrong, nothing changes.
2. The file is saved as `agents/<slug>/agent.yaml`.
3. The agent appears in every agent picker on the board.
4. Its schedules are created, switched off.
5. When a board card is assigned to the agent, the worker receives the agent's
   instructions plus its folder and tool limits. Workers that run in a sandbox
   (`SESSION_ISOLATION=docker`) never read the file themselves — the server reads
   it and passes the instructions in.

For developers: the format is implemented once, in
`app/server/src/services/agent-file.ts` (`parseAgentFile`, `serializeAgentYaml`),
and every entry point — the screen, the script, server start-up and the built-in
chat — goes through it.
