# Example workspace

This is a **generic, self-contained example** of the directory tree Command Center
expects a workspace to live in. It exists so a fresh self-hosted install has
something to point at out of the box, and so you can see the shape before wiring
up your own.

Point the relevant env vars at this tree (or copy it somewhere and edit):

```
AI_WORKSPACE_DIR=/path/to/examples/workspace
SECOND_BRAIN_DIR=/path/to/examples/workspace
```

Layout:

```
examples/workspace/
  agents/                      # agent personas the orchestrator can adopt
    engineer.md
    ops.md
    general.md
  skills/                      # a short prompting library to read (not a pack to install)
    summarize-notes/SKILL.md
    draft-update/SKILL.md
  tools/                       # raw capability a skill calls (API, MCP, CLI)
    github/TOOL.md
    google-workspace/TOOL.md
  workspaces/
    acme/context.md            # per-workspace business context (placeholder)
```

Everything here is fictional ("Acme"). Replace it with your own personas and context.

The two `skills/` files are a **prompting library to read**, not a pack to install. They
show how to write a clear brief: lead with the outcome, say what a finished answer contains,
and say what to do when the input is thin. The same habits make a good card on the board.
You do not need to write skills to get work done: state the outcome on a card, approve the
plan, and the harness owns the plumbing. A session works out how to do a card from the card,
the repo's own docs and the knowledge base. Write a skill file only for a rare procedure that
must be followed exactly; see [`docs/wiki/Skills-Tools-Agents.md`](../../docs/wiki/Skills-Tools-Agents.md).

The rest of this tree is fictional too. Nothing in this tree references any real person, company, or host.
The two `tools/` entries are an exception: they document two connectors that
really do ship in this repo (`app/server/src/connectors/defs/github.ts`,
`google-workspace.ts`), so you can see a Tool definition wired to a real
credential before writing your own — see
[`docs/connectors/TOOLS-LAYER-WIRING.md`](../../docs/connectors/TOOLS-LAYER-WIRING.md).
