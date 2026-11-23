/**
 * kb-access-prompt (obj 900204) — the knowledge-base paragraph of a spawn
 * prompt, told the truth about what THIS session can actually reach.
 *
 * In `tmux` mode a session runs inside the app container and `~/second-brain`
 * is right there, so the text is byte-identical to what it always was.
 *
 * In `docker` mode (`SESSION_ISOLATION=docker`) the session is a sibling
 * container with only its worktree and its own HOME mounted — `~/second-brain`
 * does not exist, and neither does any host vault path it could guess. Telling
 * it to look there is what made cards report "Connections.csv is not in the
 * KB" for a file that was plainly there. In that mode the prompt points at the
 * permission-checked HTTP interface the session CAN reach: the control plane on
 * its loopback forwarder, authenticated with `$CC_SESSION_TOKEN`, scoped by the
 * server to this card's own workspace.
 */
import type { Objective } from '@operationkit/shared'
import { jailEnabled } from './session-jail.js'
import { resolveWriteWorkspace } from './workspaces.js'
import { captureDir, captureLayout, captureSubdir, decisionsDir, MONTH_PLACEHOLDER, type CaptureLayout } from '../lib/vault-layout.js'

export const CC_API = 'http://localhost:3002'

/** The vault's decisions folder as a NON-jailed session sees it (unchanged). */
export function vaultDecisionsPath(workspace: string | null | undefined): string {
  return `~/second-brain/${decisionsDir(workspace)}/`
}

/**
 * The vault folder a NON-jailed session writes its decision capture to. Same
 * as `vaultDecisionsPath` unless `settings.kb_capture_layout` says otherwise
 * (lib/vault-layout.ts); the month is left as a `YYYY-MM` placeholder.
 */
export function vaultCapturePath(workspace: string | null | undefined, layout: CaptureLayout = captureLayout()): string {
  return `~/second-brain/${captureDir(workspace, MONTH_PLACEHOLDER, layout)}/`
}

/**
 * The "where is the knowledge base" block.
 * @param jailed pass the resolved isolation mode; defaults to this process's env.
 */
export function buildKbAccessBlock(
  objective: Pick<Objective, 'id' | 'workspace'>,
  jailed: boolean = jailEnabled(),
): string[] {
  const ws = resolveWriteWorkspace(objective.workspace)
  if (!jailed) {
    return ['', 'Knowledge base is at ~/second-brain/ for reference.']
  }
  return [
    '',
    '## Knowledge base (READ THIS BEFORE LOOKING FOR A FILE)',
    '',
    `This session is sandboxed: the ONLY paths on disk are your worktree (\`/workspace\`) and your own HOME (\`/home/jailuser\`). **There is no \`~/second-brain\`, no \`/home/operator\`, and no vault mount — do not look for one, and never guess a host path.**`,
    '',
    `The knowledge base reaches you over the control plane instead, already scoped to your workspace (\`${ws}\`). Authenticate every call with \`$CC_SESSION_TOKEN\`; you cannot see any other workspace, and you do not need to pass a workspace parameter.`,
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    '',
    '# 1. Find a NON-markdown file (csv, xlsx, pdf, pptx, images):',
    `curl -sG "${CC_API}/api/files/search" -H "$H" --data-urlencode 'q=connections' --data-urlencode 'ext=csv'`,
    '',
    '# 2. Check it before you pull it (size, mtime, mime):',
    `curl -sG "${CC_API}/api/files/stat" -H "$H" --data-urlencode 'path=<absolute path from the search hit>'`,
    '',
    '# 3. Download it into your workspace (Range works, so do a head first on big files):',
    `curl -s "${CC_API}/api/files/download?path=<path>" -H "$H" -o /workspace/local-copy.csv`,
    `curl -s "${CC_API}/api/files/download?path=<path>" -H "$H" -H 'Range: bytes=0-20000' -o /workspace/head.csv`,
    '',
    '# 4. Markdown notes — search, read, list:',
    `curl -sG "${CC_API}/api/docs/search" -H "$H" --data-urlencode 'q=linkedin export'`,
    `curl -sG "${CC_API}/api/docs/file" -H "$H" --data-urlencode 'path=<absolute .md path>'`,
    `curl -s "${CC_API}/api/docs/tree" -H "$H"`,
    '```',
    '',
    'Reading the error correctly matters:',
    '- **404** — the path is inside your workspace and genuinely does not exist. Stop looking; it is not there.',
    '- **403** — the path exists outside what this card may see (another workspace, a system file, a denied path). It is NOT evidence about whether the file exists. Never report "not in the knowledge base" on a 403 — say it is out of scope for this card.',
    '- **401** — your token is missing or stale. `echo "${CC_SESSION_TOKEN:+set}"`; if it is empty, say so rather than guessing paths.',
    '',
    'A file you pulled is a COPY in your sandbox. Editing it changes nothing in the knowledge base.',
  ]
}

/**
 * The vault-capture instruction, likewise mode-aware. A jailed session writes
 * its decision doc through `PUT /api/docs/file` — the same permission-checked
 * surface — instead of a path it cannot see.
 */
export function buildVaultCaptureBlock(
  objective: Pick<Objective, 'id' | 'workspace'>,
  jailed: boolean = jailEnabled(),
  layout: CaptureLayout = captureLayout(),
): string[] {
  const ws = objective.workspace
  // `decisions`, or `log/YYYY-MM` — the one folder name this block spells out.
  const sub = captureSubdir(MONTH_PLACEHOLDER, layout)
  // Jailed: the folder as a JS expression over the file name (argv[2] starts YYYY-MM-DD).
  const subExpr = layout === 'log-by-month' ? '"/log/"+process.argv[2].slice(0,7)+"/"' : `"/${sub}/"`
  const head = [
    '',
    '## Vault Capture (MANDATORY before you finish)',
    '',
    'If this session produced any architectural decision, evaluation outcome, research finding,',
    'tradeoff resolved, or non-obvious learning that future sessions would benefit from, you MUST',
  ]
  const tail = [
    '',
    'If nothing in this session qualifies (e.g. routine bug fix, mechanical cleanup, no choices',
    'made), explicitly state in your final response: "No vault capture: <one-line reason>".',
    'Do NOT silently skip — the orchestrator now flags `capture-gap` when decisions are claimed',
    `in the summary but no \`/${sub}/*.md\` write occurred.`,
  ]
  if (!jailed) {
    return [
      ...head,
      `write a decision doc to ${vaultCapturePath(ws, layout)}YYYY-MM-DD-<slug>.md before ending the session.`,
      '',
      'Use the template at ~/ai-workspace/protocols/vault-capture.md (frontmatter + Decision /',
      'Context / Rationale / Alternatives / Implications sections).',
      ...tail,
    ]
  }
  return [
    ...head,
    `write a decision doc before ending the session. You are sandboxed, so write it through the`,
    `control plane — there is no \`~/second-brain\` on this filesystem. Ask the API where your`,
    `workspace's knowledge folder is, then PUT the file into its \`${sub}/\` subfolder:`,
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    `KB=$(curl -s "${CC_API}/api/docs/tree" -H "$H" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).root')`,
    `curl -s -X PUT "${CC_API}/api/docs/file" -H "$H" -H 'Content-Type: application/json' \\`,
    `  -d "$(node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1]+${subExpr}+process.argv[2],content:fs.readFileSync(process.argv[3],"utf8"),create_dirs:true}))' "$KB" "$(date -u +%F)-<slug>.md" /workspace/decision.md)"`,
    '```',
    '',
    'Write the doc body to `/workspace/decision.md` first (frontmatter + Decision / Context /',
    'Rationale / Alternatives / Implications sections), then PUT it as above. A `{"ok":true,...}`',
    'response is your evidence that the capture landed; anything else means it did NOT.',
    ...tail,
  ]
}

// ── Objective memory + live progress for a sandboxed session (obj 900955) ───

/** The live-progress helper as a jailed session sees it: inside its own worktree. */
export const SANDBOX_LIVE_SCRIPT = '/workspace/scripts/cc-live.mjs'

export function memoryFileRoute(objectiveId: number): string {
  return `${CC_API}/api/internal/objectives/${objectiveId}/memory/file`
}

/**
 * The "Objective Memory" block for a jailed session. The host memory folder is
 * not mounted in the jail, so this names the route that IS reachable and never
 * a host path. (The non-jailed block stays in `buildPrompt`, unchanged.)
 */
export function buildSandboxedObjectiveMemoryBlock(objectiveId: number): string[] {
  return [
    '',
    '## Objective Memory',
    '',
    'This objective has two persistent memory files, kept by the server for this card. This session is sandboxed, so there is NO memory folder on disk — do not look for one. Read and write the files through the control plane with your own session token (it works for this card only):',
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    `M="${memoryFileRoute(objectiveId)}"`,
    'mkdir -p ~/cc-memory/live',
    '',
    '# Read your notes from an earlier session (prints nothing if there are none yet):',
    `curl -sG "$M" -H "$H" --data-urlencode 'path=NOTES.md' | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).content ?? ""' > ~/cc-memory/NOTES.md`,
    '',
    '# Save a file: edit the local copy, then PUT the whole file (it replaces the server copy; 1 MB max):',
    `put() { node -e 'const fs=require("fs");process.stdout.write(JSON.stringify({path:process.argv[1],content:fs.readFileSync(process.argv[2],"utf8")}))' "$1" "$2" | curl -s -X PUT "$M" -H "$H" -H 'Content-Type: application/json' --data-binary @-; }`,
    'put NOTES.md ~/cc-memory/NOTES.md',
    'put ARTIFACT.md ~/cc-memory/ARTIFACT.md',
    '```',
    '',
    'The only paths the route accepts are `NOTES.md`, `ARTIFACT.md` and `live/<name>`. A `{"ok":true,...}` response is your evidence the file landed; anything else means it did NOT. The local copy in `~/cc-memory/` is a working copy only — the server copy is the one that persists and the one that gets read.',
    '',
    'Read NOTES.md before starting. As you work, write durable state, decisions, and progress to NOTES.md and PUT it — follow-up and future sessions on this objective will read it.',
    '',
    'The two files have different audiences — keep them separate:',
    '- `NOTES.md` — YOUR private scratch. Hypotheses, dead ends, restart state, self-narration. Write freely; nobody grades it. The AI reviewer is deliberately masked off this file, so nothing you need judged may live only here.',
    '- `ARTIFACT.md` — YOUR final artifact, and the thing consumers actually read. PUT it before you finish: what you delivered, where it lives (branch / PR / file paths), and the evidence for each acceptance criterion. This is what the reviewer reads in place of your scratch, so an unstated deliverable is an ungraded deliverable. If your brief names a different artifact file in another card\'s folder, you cannot write it from this sandbox: put that deliverable in your own ARTIFACT.md and say so in your summary.',
  ]
}

/**
 * The reviewer's knowledge-base block (obj 901525).
 *
 * `buildReviewerPrompt` never carried any instruction for reaching the vault —
 * only the WORKER prompt (`buildPrompt`, via `buildKbAccessBlock` above) did.
 * A reviewer's spawn env already gets the exact same control-plane credential
 * a worker gets (`applySessionTrustEnv` is called for every `sessionKind`,
 * `session-spawn-env.ts`), minted read-only (`readOnly: sessionKind ===
 * 'reviewer'`) — so `GET /api/docs/file` / `/api/docs/search` already answer a
 * reviewer's token scoped to the card's own workspace exactly like a worker's
 * (`sessionFileAuth`, `middleware/session-file-access.ts`). With no prompt
 * instruction telling it so, a reviewer whose rubric names a file under
 * `workspaces/<ws>/...` had no way to know that route exists: in jail mode the
 * vault is not on disk at all (empty `find`/`ls`), and in tmux mode it is
 * right there read-write for everyone ELSE but the reviewer never thought to
 * look through the one path that is actually its own. Both read as "the file
 * does not exist" and FAILED a real deliverable (#901494, #901499, #901519).
 *
 * Always emitted (regardless of jail/tmux mode) — the HTTP route is the one
 * surface guaranteed to behave the same in both, and it is READ-ONLY by
 * construction for a reviewer's token, so steering the reviewer onto it can
 * never let it write the knowledge base it is grading.
 */
export function buildReviewerKbAccessBlock(objective: Pick<Objective, 'id' | 'workspace'>): string[] {
  const ws = resolveWriteWorkspace(objective.workspace)
  return [
    '',
    '## Knowledge-base deliverables (READ-ONLY — use this before concluding a file is missing)',
    '',
    `When a criterion names a file under \`workspaces/${ws}/...\` (a runbook, a report, a decision doc,`,
    'any vault page), do NOT rely on finding it on local disk — your sandbox may have no vault mount at',
    'all, and even where one exists it is not where this card\'s deliverable necessarily lives. Read it',
    `through the control plane instead, scoped to this card's own workspace (\`${ws}\`) exactly the way`,
    'the worker that wrote it was scoped:',
    '',
    '```bash',
    'H="X-CC-Session-Token: $CC_SESSION_TOKEN"',
    `curl -sG "${CC_API}/api/docs/search" -H "$H" --data-urlencode 'q=<words from the criterion>'`,
    `curl -sG "${CC_API}/api/docs/file" -H "$H" --data-urlencode 'path=<absolute path, e.g. workspaces/${ws}/...>'`,
    '```',
    '',
    'Your token is READ-ONLY here (a write attempt is refused) — that is expected, you are grading, not',
    'editing. Reading the status code correctly matters MORE than usual, because it changes your VERDICT:',
    '- **404** — the path is inside your workspace and genuinely does not exist. This IS a real miss:',
    '  grade the criterion `[FAIL]` (or `[BLOCKED]` only if you need a different file to confirm it).',
    '- **403, a connection error, or any other failed call** — this is NOT evidence the file is missing.',
    '  It means you could not reach it from here. Mark that criterion `[BLOCKED]` with the reason',
    '  "could not check — <status/error>", never `[FAIL]` and never "the deliverable does not exist".',
    '  If every criterion you can otherwise verify passes and the ONLY open item is a `[BLOCKED]` access',
    '  problem like this, your OVERALL `<verdict>` is `blocked`, not `fail` — a `fail` here respawns a',
    '  worker to redo work that was never missing, and burns a review iteration on an access problem',
    '  that is not the worker\'s fault.',
    '- **401** — your own token is missing or stale (`echo "${CC_SESSION_TOKEN:+set}"`). Treat the same',
    '  as a 403: `[BLOCKED]`, not `[FAIL]`.',
  ]
}

/** Where a jailed session puts partial outputs, and what to do when the helper is not in its repo. */
export function sandboxedLiveOutputLines(objectiveId: number): string[] {
  return [
    '- Partial outputs: PUT them as `live/<name>` through the memory route above (`put live/partial.csv ~/cc-memory/live/partial.csv`) — listed and readable through the API while you run (secret-redacted). Your scratch file is never served.',
    `- \`${SANDBOX_LIVE_SCRIPT}\` exists when this card's repo is the app's own. In any other repo, post the same snapshot with curl: \`curl -s -X POST ${CC_API}/api/internal/objectives/${objectiveId}/progress -H 'Content-Type: application/json' -H "X-CC-Session-Token: $CC_SESSION_TOKEN" -d '{"step":2,"total_steps":5,"label":"…","note":"…"}'\``,
  ]
}
