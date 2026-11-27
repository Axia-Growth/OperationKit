import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Database from 'better-sqlite3'
import { validateKbFlagInput, type KbFlagInput } from '@operationkit/shared'
import { initKbFlagsSchema } from '../../db/schema/kb-flags.js'
import { fileKbFlag, setKbFlagStatus } from './flags.js'
import { curatorFlagsForWorkspace, kbFlagToCuratorFlag, openKbFlagsForCurator } from './curator-flags.js'
import { FLAGS_FILE, runCurator } from './curator.js'

let kb: string
let db: Database.Database
beforeEach(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kbwiki-curator-flags-'))
  db = new Database(':memory:')
  initKbFlagsSchema(db)
})
afterEach(() => { db.close(); fs.rmSync(kb, { recursive: true, force: true }) })

function file(b: KbFlagInput, workspace = 'ws-a') {
  const v = validateKbFlagInput(b)
  if (!v.input) throw new Error(v.errors.join('; '))
  return fileKbFlag(db, v.input, { workspace, source: 'worker', filedBy: 'Billing bot' }).flag
}
function put(rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(kb, rel)), { recursive: true })
  fs.writeFileSync(path.join(kb, rel), text)
}

describe('kb_flags → curator flags (obj 901767 × 901768)', () => {
  it('maps kind, page, topic, suggested fix and card link into the curator shape', () => {
    const wrong = kbFlagToCuratorFlag(file({ kind: 'wrong', subject: 'Invoice header', page: 'topics/invoice-header.md', detail: 'Changed in October.', suggested_fix: 'Green logo header', objective_id: 901600 }))
    expect(wrong).toMatchObject({ kind: 'wrong', page: 'topics/invoice-header.md', objective_id: 901600, by: 'Billing bot' })
    expect(wrong.id).toMatch(/^kbf-\d+$/)
    expect(wrong.detail).toContain('Invoice header: Changed in October.')
    expect(wrong.detail).toContain('Suggested fix: Green logo header')
    expect(Number.isFinite(Date.parse(wrong.at))).toBe(true)
    expect(wrong.at.endsWith('Z')).toBe(true)

    // stale → outdated; no page → the subject is the topic.
    const stale = kbFlagToCuratorFlag(file({ kind: 'stale', subject: 'Refund policy', detail: 'The window is now 30 days.' }))
    expect(stale).toMatchObject({ kind: 'outdated', topic: 'Refund policy' })
    expect(stale.page).toBeUndefined()
  })

  it('reads only OPEN flags of the workspace, oldest first, across pages', () => {
    for (let i = 0; i < 205; i++) file({ kind: 'missing', subject: `Topic ${i}`, detail: 'Not written down.' })
    const closed = file({ kind: 'wrong', subject: 'Closed one', detail: 'x' })
    setKbFlagStatus(db, 'ws-a', closed.id, 'resolved', 'Ana')
    file({ kind: 'missing', subject: 'Other workspace', detail: 'x' }, 'ws-b')

    const out = openKbFlagsForCurator(db, 'ws-a')
    expect(out).toHaveLength(205)
    expect(out[0].topic).toBe('Topic 0')
    expect(out[204].topic).toBe('Topic 204')
    expect(out.some(f => f.topic === 'Closed one' || f.topic === 'Other workspace')).toBe(false)
  })

  it('merges the flags file with the kb_flags rows', () => {
    put(FLAGS_FILE, JSON.stringify({ schema: 'kb-flag/1', id: 'f-file', kind: 'wrong', page: 'topics/a.md', detail: 'From the file.' }) + '\n')
    file({ kind: 'missing', subject: 'From the table', detail: 'From the tool.' })
    const ids = curatorFlagsForWorkspace(db, 'ws-a', kb).map(f => f.id)
    expect(ids[0]).toBe('f-file')
    expect(ids[1]).toMatch(/^kbf-/)
  })

  it('a flag filed through the tool becomes a curator proposal, and no page changes', async () => {
    const pageText = '---\ntitle: Invoice header\ntype: topic\nupdated: 2026-11-01\n---\n# Invoice header\n\nInvoices use the blue header.\n'
    put('topics/invoice-header.md', pageText)
    file({ kind: 'wrong', subject: 'Invoice header', page: 'topics/invoice-header.md', detail: 'The header is green since October.', objective_id: 901600 })
    file({ kind: 'missing', subject: 'Refund policy', detail: 'Looked for the refund window; found nothing.' })

    const r = await runCurator(kb, {
      now: new Date('2026-11-23T03:30:00Z'), staleDays: 180, aiDrafts: 0, workspace: 'ws-a',
      corrections: [], lint: null, flags: curatorFlagsForWorkspace(db, 'ws-a', kb),
    })
    expect(fs.readFileSync(path.join(kb, 'topics/invoice-header.md'), 'utf8')).toBe(pageText)
    const upd = r.proposed.find(p => p.kind === 'update' && p.pages[0] === 'topics/invoice-header.md')
    expect(upd?.evidence.some(e => e.type === 'flag' && e.objective_id === 901600)).toBe(true)
    expect(r.proposed.some(p => p.kind === 'create')).toBe(true)
  })
})
