import { describe, it, expect } from 'vitest'
import {
  countGitPushes,
  countPushesInTranscript,
  pushBatchWarning,
  PUSH_BATCHING_RULES,
  PUSH_ONCE_FIX_LINE,
} from './push-batching.js'

function bash(command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
}

describe('countGitPushes', () => {
  it('counts real pushes', () => {
    expect(countGitPushes('git push -u origin cc/obj-1-x')).toBe(1)
    expect(countGitPushes('git add -A && git commit -m "wip" && git push')).toBe(1)
    expect(countGitPushes('git -C /tmp/cc-worktree-1 push origin HEAD')).toBe(1)
    expect(countGitPushes('git push; sleep 1; git push --force-with-lease')).toBe(2)
    expect(countGitPushes('env -u GH_TOKEN git push 2>&1 | tail -3')).toBe(1)
  })

  it('ignores commands that only mention push', () => {
    expect(countGitPushes('git status --porcelain')).toBe(0)
    expect(countGitPushes('git commit -m "remember to git push later"')).toBe(0)
    expect(countGitPushes("echo 'git push'")).toBe(0)
    expect(countGitPushes('git push-hook-thing')).toBe(0)
    expect(countGitPushes('grep -n "git push" prompt-builder.ts')).toBe(0)
    expect(countGitPushes('')).toBe(0)
  })

  it('ignores git push written into a file via heredoc', () => {
    const cmd = "cat > deploy.sh <<'EOF'\ngit push origin main\nEOF\nchmod +x deploy.sh"
    expect(countGitPushes(cmd)).toBe(0)
  })
})

describe('countPushesInTranscript + pushBatchWarning', () => {
  it('counts Bash tool_use pushes across a stream-json transcript', () => {
    const transcript = [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      bash('git commit -m one'),
      bash('git push -u origin cc/obj-1-x'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'git push ok' }] } }),
      bash('git commit -m two && git push'),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'I will git push now' }] } }),
      'not json',
    ].join('\n')
    expect(countPushesInTranscript(transcript)).toBe(2)
  })

  it('warns only when a session pushed more than once', () => {
    expect(pushBatchWarning(0)).toBeNull()
    expect(pushBatchWarning(1)).toBeNull()
    expect(pushBatchWarning(3)).toContain('3 times')
  })
})

describe('rule text', () => {
  it('keeps the final push (required checks must run on the merged head)', () => {
    const text = PUSH_BATCHING_RULES.join('\n')
    expect(text).toContain('Do NOT `git push` after each commit.')
    expect(text).toContain('Do not skip the final push')
    expect(PUSH_ONCE_FIX_LINE).toContain('push ONCE')
  })
})
