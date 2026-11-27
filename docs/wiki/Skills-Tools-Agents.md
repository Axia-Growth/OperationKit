# Skills, Tools & Agents (advanced)

> **You do not need this page to get work done.** The everyday loop is: state the outcome on a card, approve the plan, and the harness owns the plumbing (context, sandboxes, accounts, memory, review). This page is an appendix for consultants who want to shape an install by hand.

Under the hood, agents, tools and context are plain, versioned files:

- **Agents** — `agents/<slug>.md` (worker) or `agents/<slug>/agent.md` (chat bot) — a role and a way of working, in one file.
- **Tools** — the underlying capabilities an agent can reach (an API integration, a CLI, an MCP server).
- **Skills** — `skills/<slug>/SKILL.md` — an *optional* written procedure. Most installs need none (see below).

These are plain markdown with a defined frontmatter schema — not a database row inside one vendor's product, which is what makes them portable across models (see [Model Portability](./Model-Portability)) and across installs.

## Procedure comes from the harness, not from skill files

**You do not need to write or assign a single `SKILL.md` to get work done.** Every worker session is told where its procedure comes from, in this order (`buildProcedureSourcesBlock` in `app/server/src/lib/procedure-sources.ts`, rendered by `buildPrompt`):

1. **The card** — description, approved plan, acceptance criteria and the owner's messages.
2. **The living docs of the repo it works in** — README, `CLAUDE.md` / `AGENTS.md`, `docs/`. They describe how the code is built, tested and shipped *today*.
3. **The workspace's Context** (knowledge base) — decisions, runbooks and earlier cards.

Why skills stopped being the way to add capability (obj 901765, 23 Nov 2026):

- A skill behaves differently on each model and each harness, so a library of them goes stale and becomes unmaintainable.
- It made a new install feel empty until someone curated a library, and it turned consultants into file curators.
- Docs that live next to the code and decisions in Context are read by every session and kept current by the work itself; a separate skill file is not.

When a procedure keeps going wrong, write it down where everyone reads it: in the card brief, in the repo's docs (on a card), or as a page in Context.

## Skill files: the escape hatch

Skill files still work and are not going away. Use one only for a rare procedure that must be followed exactly, step by step, and that none of the places above can hold.

- An agent that already declares `skills:` in its frontmatter keeps them; nothing about existing installs changes.
- A session uses a skill only when the card, its agent file or a skill assignment names it, and it does not write new skill files as a side effect of a card.
- The harness's own internal procedures (for example the planner's instructions) may be skill files; that is an implementation detail, not something a person curates.

## How it's surfaced in the product

Avatar menu → **Bot setup** (`/agents`, global-admin only). Its tabs, in order: **Bots** (the roster), **Templates**, **By project**, **Assignments**, and last **Skills (advanced)** — the skill graph, a visual map of which agents declare which skills and tools. The "Make a new bot" guide at the top offers bots only; skill files are a one-line advanced link under it. In code: `app/client/src/components/agents/AgentsHub.tsx`, `app/client/src/components/SkillGraph.tsx` (the graph UI) and `app/server/src/services/skill-graph.ts` (the server-side graph builder).

Two example skills ship at `examples/workspace/skills/` (`draft-update/SKILL.md`, `summarize-notes/SKILL.md`). They are a **prompting library to read**, not a pack to install: they show how to write a clear brief (outcome first, what a finished answer contains, what to do when the input is thin), which is the same habit that makes a good card. Two example Tool definitions ship at `examples/workspace/tools/` (`github/TOOL.md`, `google-workspace/TOOL.md`), each naming the real session env var(s) its connector contributes (`auth.secrets[].env`) — see [Tools-layer wiring](../connectors/TOOLS-LAYER-WIRING.md) for how a Tool's declared env var reaches a session through the existing connector credential path.

## Sharing agents

There is no skill marketplace, and none is planned. Reusing work between installs means copying a whole agent template file; see [Sharing agents between installs](../agents/marketplace.md) (marketplace paused).

## Writing your own

Write an agent file under `agents/` following the frontmatter schema the examples use, and put its way of working in the file's own instructions. Add it on **Bot setup → Templates** (paste or import), or assign a worker agent to a workspace on **Bot setup → Assignments**. Only reach for `skills/<slug>/SKILL.md` for the escape-hatch case above. There's no compiled build step — the graph picks up a new file on the next load.
