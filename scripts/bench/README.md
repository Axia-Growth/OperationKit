# scripts/bench — Context / Graph load benchmark (obj 900867)

Manual tools. Nothing here runs in CI or `npm test`, and Playwright is **not** a repo
dependency — install it in a scratch directory.

| file | what it does |
|---|---|
| `gen-kb-vault.mjs <dir> [scale]` | deterministic synthetic vault: ~6,840 markdown files, two workspace knowledge folders (the bigger one is over the 2,000-node graph cap), daily notes and a deep archive |
| `seed-scratch.mts` | seeds a **scratch** DB (refuses `/app/data`): admin user `1`, the knowledge-import pack on, the two workspaces pointed at the vault |
| `context-load.mjs` | real Chromium, median ms to each milestone (`shell`, `skeleton`, `tree`, `graph`, main-thread `blocking`) for a cold visit, an in-app return visit (Board → Context) and a reload; `--cpu 4 --net 12000,40` throttles |
| `context-filmstrip.mjs` | before/after filmstrips (Chrome screencast frames, as painted) of the cold and return visits |

```bash
node scripts/bench/gen-kb-vault.mjs /tmp/kb-bench-vault
cd app/server
D=$(mktemp -d)
DB_PATH=$D/cc.db SECOND_BRAIN_ROOT=/tmp/kb-bench-vault JWT_SECRET=scratch-only npx tsx ../../scripts/bench/seed-scratch.mts
CC_SCRATCH_SERVER=1 PORT=3913 DB_PATH=$D/cc.db SECOND_BRAIN_ROOT=/tmp/kb-bench-vault JWT_SECRET=<secret> npx tsx src/index.ts &
TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({id:1,username:'bench',role:'admin'},'<secret>',{expiresIn:'12h'}))")
NODE_PATH=<scratch>/node_modules node ../../scripts/bench/context-load.mjs --base http://localhost:3913 --token $TOKEN --runs 5
```

Follow CLAUDE.md "Scratch server for screenshots": `CC_SCRATCH_SERVER=1`, never port 3002, never the
live DB, and kill only your own server's process tree.
