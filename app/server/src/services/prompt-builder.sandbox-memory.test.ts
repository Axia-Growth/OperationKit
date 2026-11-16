/**
 * obj 900955 — a sandboxed (docker-isolated) session has no objective-memory
 * folder on disk and no host checkout. Its prompt must name the session-token
 * memory route and a helper path inside its own worktree; a non-sandboxed
 * prompt must read exactly as it did before.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import os from 'os'
import path from 'path'

process.env.DB_PATH = path.join(os.tmpdir(), `cc-prompt-sandbox-memory-${process.pid}-${Date.now()}.db`)
delete process.env.SESSION_ISOLATION

import type { Objective } from '@operationkit/shared'
import { initDb, getDb } from '../db/index.js'
import { seedLegacyWorkspaces } from '../__fixtures__/legacy-workspaces.js'
import { buildLiveProgressBlock, buildPrompt, CC_LIVE_SCRIPT, objectiveMemoryDir } from './prompt-builder.js'
import { buildSandboxedObjectiveMemoryBlock, memoryFileRoute, SANDBOX_LIVE_SCRIPT } from './kb-access-prompt.js'

const ID = 424242
const ROUTE = `http://localhost:3002/api/internal/objectives/${ID}/memory/file`
// Any spelling of the host folder: the default root, a relocated root, or the bare segment.
const HOST_MEMORY = /objective-memory|ai-workspace\/objective/

function objective(overrides: Partial<Objective> = {}): Objective {
  return {
    id: ID,
    title: 'Sandbox memory sample',
    description: 'A sample objective.',
    status: 'working',
    agent_context: 'cto',
    workspace: 'operator',
    project: null,
    category: 'build',
    parent_id: null,
    depth: 0,
    session_count: 0,
    delegate_mode: false,
    create_pr: false,
    effort: 'medium',
    model: 'default',
    type: 'task',
    acceptance_criteria: null,
    created_at: '2026-06-16T00:00:00Z',
    updated_at: '2026-06-16T00:00:00Z',
    ...overrides,
  } as Objective
}

function prompt(isolation: 'docker' | null, overrides: Partial<Objective> = {}): string {
  if (isolation) process.env.SESSION_ISOLATION = isolation
  else delete process.env.SESSION_ISOLATION
  return buildPrompt(objective(overrides))
}

beforeAll(async () => {
  initDb()
  await seedLegacyWorkspaces(getDb())
})

afterEach(() => {
  delete process.env.SESSION_ISOLATION
})

describe('sandboxed prompt', () => {
  it('names the memory route with a curl example and the session token', () => {
    const text = prompt('docker')
    expect(memoryFileRoute(ID)).toBe(ROUTE)
    expect(text).toContain(`M="${ROUTE}"`)
    expect(text).toContain('curl -s -X PUT "$M" -H "$H"')
    expect(text).toContain('H="X-CC-Session-Token: $CC_SESSION_TOKEN"')
    expect(text).toContain('put ARTIFACT.md ~/cc-memory/ARTIFACT.md')
    expect(text).toContain('put NOTES.md ~/cc-memory/NOTES.md')
    expect(text).toContain('`live/<name>`')
  })

  it('contains no host objective-memory path, for a worker and for a delegator', () => {
    for (const overrides of [{}, { delegate_mode: true }] as Partial<Objective>[]) {
      const text = prompt('docker', overrides)
      expect(text).not.toMatch(HOST_MEMORY)
      expect(text).not.toContain(objectiveMemoryDir(ID))
    }
  })

  it('gives the live-progress helper as a path inside the worktree, never the host checkout', () => {
    const text = prompt('docker')
    expect(SANDBOX_LIVE_SCRIPT).toBe('/workspace/scripts/cc-live.mjs')
    expect(text).toContain(`node ${SANDBOX_LIVE_SCRIPT} progress ${ID} --step`)
    expect(text).toContain(`node ${SANDBOX_LIVE_SCRIPT} fanout ${ID}`)
    expect(text).not.toContain(CC_LIVE_SCRIPT)
    // A repo without the helper still has a working way to post a snapshot.
    expect(text).toContain(`/api/internal/objectives/${ID}/progress`)
  })

  it('keeps the two-audience rule: scratch is private, the artifact is what gets graded', () => {
    const text = buildSandboxedObjectiveMemoryBlock(ID).join('\n')
    expect(text).toContain('## Objective Memory')
    expect(text).toMatch(/`NOTES\.md` — YOUR private scratch/)
    expect(text).toMatch(/`ARTIFACT\.md` — YOUR final artifact/)
    expect(text).toContain('an unstated deliverable is an ungraded deliverable')
  })

  it('the sandboxed live-progress lines never name the scratch file', () => {
    expect(buildLiveProgressBlock(ID, '/mem/x', true).join('\n')).not.toMatch(/NOTES\.md/)
  })
})

describe('non-sandboxed prompt is unchanged', () => {
  it('still names the host memory folder, both files and the host helper, and not the route', () => {
    const text = prompt(null)
    const dir = objectiveMemoryDir(ID)
    expect(text).toContain(`This objective has a persistent memory directory: ${dir}/`)
    expect(text).toContain('If NOTES.md exists there, read it before starting.')
    expect(text).toContain(`- \`${dir}/NOTES.md\` — YOUR private scratch.`)
    expect(text).toContain(`- \`${dir}/ARTIFACT.md\` — YOUR final artifact`)
    expect(text).toContain(`node ${CC_LIVE_SCRIPT} progress ${ID} --step`)
    expect(text).toContain(`- Partial outputs go in \`${dir}/live/\``)
    expect(text).not.toContain('/memory/file')
    expect(text).not.toContain(SANDBOX_LIVE_SCRIPT)
    expect(text).not.toContain('cc-memory')
  })

  it('the live-progress block with no flag is the same as with jailed=false', () => {
    expect(buildLiveProgressBlock(ID, '/mem/x')).toEqual(buildLiveProgressBlock(ID, '/mem/x', false))
  })

  it('a delegator still gets its host save-file path', () => {
    expect(prompt(null, { delegate_mode: true })).toContain(`(/home/operator/ai-workspace/objective-memory/${ID}/NOTES.md)`)
  })
})
