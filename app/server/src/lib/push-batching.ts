/**
 * Push batching for card workers (obj 901348).
 *
 * Why: on the private repo every push to a branch with an open PR starts the
 * whole `gate` workflow (~16 jobs, one on Windows; three sampled green runs
 * billed 39-42 minutes for 5-6 wall-clock minutes). Measured over 30 days
 * (18 Oct - 17 Nov 2026): 796 gate runs over 316 PRs, 480 of them were not the
 * last run on their PR (3,027.6 wall-clock minutes, 54% of gate). Counting only
 * pushes that landed within 30 minutes of the next push on the same PR, 354
 * runs / 2,123.4 minutes were superseded inside one working burst. `gate`
 * already cancels an in-flight run on a new push, but cancelling does not stop
 * the next full suite from starting — only fewer pushes do.
 *
 * Card workers push because their prompt tells them to; there is no server-side
 * push. So the rule lives here as prompt text (one source for the worker prompt
 * and every "fix CI and push" nudge), plus a warn-only transcript counter that
 * flags a session that pushed more than once.
 *
 * What it must NOT do: weaken required checks. The final push still happens, so
 * the PR head that will merge is the one `gate` ran on.
 */

/** Worker-prompt block: commit often, push once. Rendered by buildPrompt. */
export const PUSH_BATCHING_RULES: readonly string[] = [
  '### Push once per session (CI cost — obj 901348)',
  '',
  'Every push to a branch that has an open PR starts the full `gate` CI suite (about 16 jobs, ~40 billed minutes). Commits are free; pushes are not.',
  '- **Commit locally as often as you like** (the "keep a gradeable commit" rule still applies — a local commit survives a killed session, it is in your worktree).',
  '- **Do NOT `git push` after each commit.** Push ONCE, at the end of this session, after your local typecheck/tests pass — the single push right before `gh pr create` (or, on a follow-up to an open PR, one push when every fix in this turn is done).',
  '- **Never push to "see what CI says".** Run the failing check locally first (typecheck, the vitest file, the script). One red CI run per push is ~40 minutes of spend.',
  '- If you must checkpoint a long session before the PR exists, one mid-session push is fine (with no PR open, `gate` does not run). Once the PR is open, batch.',
  '- Do not skip the final push: required checks must run on the exact head that will merge.',
]

/** One-line rule for automated "your CI is red, fix it" nudges. */
export const PUSH_ONCE_FIX_LINE =
  'Fix EVERY failing check in one pass, re-run them locally, then push ONCE — each push re-runs the full CI suite (~40 billed minutes), so do not push one fix at a time.'

// A `git push` that the shell actually runs. `git -C <dir> push` and
// `git -c k=v push` count too. Heredoc bodies (a file being WRITTEN that merely
// mentions "git push") are stripped first, same as branch-scope.ts.
const HEREDOC_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?^[ \t]*\2[ \t]*$/gm
const GIT_PUSH_RE = /(?:^|[\s;&|(`$])git(?:\s+-[Cc]\s+\S+)*\s+push\b(?![-\w])/g

/** Number of `git push` invocations in one Bash command string. */
export function countGitPushes(command: string): number {
  if (!command) return 0
  const scan = command.replace(HEREDOC_RE, '')
  // Quoted strings that merely MENTION git push (echo "run git push", a commit
  // message) are not pushes: blank out single- and double-quoted spans.
  const unquoted = scan.replace(/'[^'\n]*'/g, "''").replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
  const m = unquoted.match(GIT_PUSH_RE)
  return m ? m.length : 0
}

type StreamLine = {
  type?: string
  parent_tool_use_id?: string | null
  message?: { content?: Array<{ type?: string; name?: string; input?: { command?: unknown } }> }
}

/**
 * Count `git push` commands the MAIN loop ran in a stream-json transcript.
 * Sub-agent (sidechain) turns are counted too — they push the same branch.
 */
export function countPushesInTranscript(content: string): number {
  let total = 0
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || !line.includes('push')) continue
    let ev: StreamLine
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) continue
    for (const block of ev.message!.content!) {
      if (block.type !== 'tool_use' || block.name !== 'Bash') continue
      const cmd = block.input?.command
      if (typeof cmd === 'string') total += countGitPushes(cmd)
    }
  }
  return total
}

/** Warn-only: a session that pushed more than this many times gets a transcript warning. */
export const PUSH_BATCH_WARN_AFTER = 1

export function pushBatchWarning(pushes: number): string | null {
  if (pushes <= PUSH_BATCH_WARN_AFTER) return null
  return `⚠️ CI cost: this session ran \`git push\` ${pushes} times. Each push to a branch with an open PR starts the full gate suite (~40 billed minutes). Commit locally and push once at the end of the session.`
}
