import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanStreamTelemetry } from './session-telemetry.js'

// obj 901348 — a session that pushed more than once gets a warn-only CI-cost
// warning in its own transcript (same surfacing as worktree violations).
function bash(command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } })
}

function run(lines: string[], sessionId: string): string[] {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-batch-'))
  const jsonl = path.join(dir, 's.jsonl')
  const log = path.join(dir, 's.log')
  fs.writeFileSync(jsonl, lines.join('\n') + '\n')
  scanStreamTelemetry(sessionId, jsonl, log, null)
  return fs.readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'warning').map((e) => e.text)
}

describe('scanStreamTelemetry — push batching (obj 901348)', () => {
  it('warns once when a session pushed three times', () => {
    const warnings = run([bash('git push -u origin cc/obj-1-x'), bash('git commit -m b && git push'), bash('git push')], 'push-batch-3')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('`git push` 3 times')
  })

  it('stays quiet for a single final push', () => {
    expect(run([bash('git commit -m a'), bash('git commit -m b'), bash('git push -u origin cc/obj-1-x')], 'push-batch-1')).toEqual([])
  })
})
