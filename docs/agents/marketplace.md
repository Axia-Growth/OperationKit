# Sharing agents between installs (marketplace: paused)

**Status: paused, and re-scoped (obj 901765, 23 Nov 2026).** No shared marketplace
is being built. If one is ever built, it shares **whole agent templates** — one file
that already contains its instructions and way of working — and nothing else.
It is **not a skill store**: there is no plan to publish, sell or install packs of
`SKILL.md` files, and no marketplace catalogue, publish flow or ratings are in scope.

## Why it is paused

Skills used to be pitched as the way to add capability: curate a library of
`SKILL.md` files, wire them to agents in a skill graph, then share the packs. That
does not hold up:

- A skill behaves differently for each model and each harness, so a shared pack
  goes stale as soon as either changes, and nobody can maintain it.
- It made a new install feel empty until someone wrote or bought skills.
- It turned consultants into curators of files instead of people who get work done.

The harness now owns procedure. A session works out *how* to do a card from the
card itself, the repo's own living docs (README, CLAUDE.md/AGENTS.md, `docs/`) and
the workspace's Context (decisions, runbooks). Skill files stay only as an escape
hatch for a rare procedure that must be followed exactly (see
[Skills, Tools & Agents](../wiki/Skills-Tools-Agents.md)).

## What exists today (install side, unchanged)

- **One file per agent** with a `version` and an `author`
  ([agent-file-format.md](agent-file-format.md)). That file is the unit a person
  copies from one install to another.
- **A local Templates gallery** (avatar menu → **Bot setup** → **Templates**) listing:
  - *Available templates* — files the install can add, with version and author;
  - *Agents on this install* — what is installed, which version, where it came from.
  It shows **Update to vX** when an available template is newer than the
  installed copy.
- **Two template sources**, read in this order:
  1. the **local templates folder** (`agent-templates/` in the workspace folder,
     or `AGENT_TEMPLATES_DIR`) — anything dropped here appears in the gallery
     marked *Local*;
  2. the **starter templates** shipped with the app (marked *Starter*).
- **One install path.** The screen, the script and server start-up all call the
  same check-then-install step, which refuses invalid files and files containing
  secret values.

That is enough to reuse an agent you wrote for one client at the next one: export
it, drop the file into the next install's templates folder (or paste it on the
Templates tab), and press Add. No marketplace is needed for that.

## If sharing is ever built

It must keep to these rules. Anything that breaks one is out of scope:

- **Whole agents only.** The shared unit is one agent template file. No skill
  packs, no "install these skills to unlock this agent", no skill catalogue.
- **The client decides.** Nothing is installed or updated automatically; a person
  clicks Add or Update. Schedules arrive switched off.
- **No secrets in files.** The importer already rejects files that look like
  they contain a key. Agents reference secrets by name; each client stores their
  own values in Settings → Secrets.
- **Each install stays private.** Sharing sends files *to* an install; it never
  reads the client's Context, cards or secrets. An install works with no
  marketplace at all.
- **Generic agents only.** Agents should not depend on one client's folder names;
  `knowledge_folders` is the one place an installer adapts an agent to a client.
- **Versions only go up.** A newer `version` is offered as an update; the
  installed copy is replaced only when the person accepts.

Mechanically, anything that drops an agent file into the local templates folder
works with the gallery, update check, validation and install unchanged. Pricing,
reviews, who may publish and where a catalogue would live are not decided, and
are not being worked on.
