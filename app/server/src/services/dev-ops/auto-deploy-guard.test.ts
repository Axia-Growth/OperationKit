import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import {
  type AutoDeployFacts,
  type AutoDeployPolicy,
  type BatchCommit,
  decideDevAutoDeploy,
  inWindow,
  isMigrationPath,
  parseWindow,
  readDevAutoDeployPolicy,
} from './auto-deploy-guard.js'

const devCommit = (sha: string, files: string[] = ['app/client/src/x.tsx'], n = 100): BatchCommit => ({
  sha,
  files,
  pr: { repo: 'your-org/operationkit', number: n, card: { id: 900000 + n, dev_card: true, ai_review_verdict: 'pass' }, merged_via: 'dev_ops', ci_green: true },
})

const facts = (over: Partial<AutoDeployFacts> = {}): AutoDeployFacts => ({
  batch: [devCommit('a'.repeat(40), undefined, 101), devCommit('b'.repeat(40), ['app/server/src/routes/y.ts'], 102)],
  reserved: [{ repo: 'your-org/operationkit', number: 645 }],
  checkout_dirty: false,
  checkout_ahead: false,
  deploy_running: false,
  working_cards: [],
  last_auto: null,
  auto_deploys_last_24h: 0,
  now: new Date('2026-11-18T15:00:00Z'), // 10:00 in New York
  ...over,
})

const policy = (over: Partial<AutoDeployPolicy> = {}): AutoDeployPolicy => ({
  enabled: true, window: null, max_files: 0, daily_cap: 3, timeZone: 'America/New_York', ...over,
})

const code = (f: AutoDeployFacts, p: AutoDeployPolicy = policy()) => {
  const d = decideDevAutoDeploy(f, p)
  return d.deploy ? 'deploy' : d.code
}

describe('decideDevAutoDeploy', () => {
  it('deploys a clean batch of passed, green Dev merges to the newest commit', () => {
    const d = decideDevAutoDeploy(facts(), policy())
    expect(d).toMatchObject({ deploy: true, to_sha: 'b'.repeat(40), commits: 2, files: 2 })
  })

  it('switch off (the default) never deploys', () => {
    expect(code(facts(), policy({ enabled: false }))).toBe('switch_off')
  })

  it('nothing waiting = nothing to deploy', () => {
    expect(code(facts({ batch: [] }))).toBe('nothing_to_deploy')
  })

  describe('every commit must come from a Dev merge (not_dev_merge, names the commits)', () => {
    const bad: Array<[string, (c: BatchCommit) => BatchCommit]> = [
      ['pushed straight to main', c => ({ ...c, pr: null })],
      ['PR with no card', c => ({ ...c, pr: { ...c.pr!, card: null } })],
      ['not a Dev card', c => ({ ...c, pr: { ...c.pr!, card: { ...c.pr!.card!, dev_card: false } } })],
      ['merged by a person', c => ({ ...c, pr: { ...c.pr!, merged_via: 'person' } })],
      ['merged by background auto-merge', c => ({ ...c, pr: { ...c.pr!, merged_via: 'auto_merge' } })],
      ['merge path unknown', c => ({ ...c, pr: { ...c.pr!, merged_via: 'unknown' } })],
      ['no AI review', c => ({ ...c, pr: { ...c.pr!, card: { ...c.pr!.card!, ai_review_verdict: null } } })],
      ['AI review failed', c => ({ ...c, pr: { ...c.pr!, card: { ...c.pr!.card!, ai_review_verdict: 'fail' } } })],
      ['CI not green', c => ({ ...c, pr: { ...c.pr!, ci_green: false } })],
    ]
    for (const [name, spoil] of bad) {
      it(name, () => {
        const good = devCommit('c'.repeat(40), undefined, 103)
        const f = facts({ batch: [good, spoil(devCommit('d'.repeat(40), undefined, 104))] })
        const d = decideDevAutoDeploy(f, policy())
        expect(d.deploy).toBe(false)
        if (!d.deploy) {
          expect(d.code).toBe('not_dev_merge')
          expect(d.shas).toEqual(['d'.repeat(40)])
        }
      })
    }
    it('grant merge and standing merge count as Dev merges', () => {
      const g = devCommit('e'.repeat(40), undefined, 105); g.pr!.merged_via = 'grant_merge'
      const s = devCommit('f'.repeat(40), undefined, 106); s.pr!.merged_via = 'standing_merge'
      expect(code(facts({ batch: [g, s] }))).toBe('deploy')
    })
  })

  it('a database change anywhere in the batch refuses (migration_in_batch)', () => {
    const f = facts({ batch: [devCommit('a'.repeat(40)), devCommit('b'.repeat(40), ['app/server/src/db/schema/x.ts'])] })
    expect(code(f)).toBe('migration_in_batch')
    const sb = facts({ batch: [devCommit('a'.repeat(40), ['supabase/migrations/001.sql'])] })
    expect(code(sb)).toBe('migration_in_batch')
  })

  it('a test file under db/ is not a database change', () => {
    expect(code(facts({ batch: [devCommit('a'.repeat(40), ['app/server/src/db/schema/x.test.ts'])] }))).toBe('deploy')
  })

  it('a reserved (protected) PR in the batch refuses', () => {
    expect(code(facts({ batch: [devCommit('a'.repeat(40), undefined, 645)] }))).toBe('reserved_pr')
    // a repo-less reservation matches any repo
    expect(code(facts({ reserved: [{ repo: null, number: 101 }] }))).toBe('reserved_pr')
    // same number in another repo does not
    expect(code(facts({ reserved: [{ repo: 'your-org/other', number: 101 }] }))).toBe('deploy')
  })

  it('a dirty live checkout refuses', () => {
    expect(code(facts({ checkout_dirty: true }))).toBe('checkout_dirty')
  })

  it('a live checkout ahead of main refuses', () => {
    expect(code(facts({ checkout_ahead: true }))).toBe('checkout_ahead')
  })

  it('a deploy already running refuses', () => {
    expect(code(facts({ deploy_running: true }))).toBe('deploy_running')
  })

  it('cards working that a restart would break: waits, and names them', () => {
    const d = decideDevAutoDeploy(facts({ working_cards: [901466, 901467] }), policy())
    expect(d.deploy).toBe(false)
    if (!d.deploy) {
      expect(d.code).toBe('cards_working')
      expect(d.message).toContain('#901466')
    }
  })

  it('a previous automatic deploy that rolled back (or failed) stops everything until cleared', () => {
    for (const status of ['rolled_back', 'rollback_failed', 'failed']) {
      expect(code(facts({ last_auto: { id: 7, status, cleared: false } }))).toBe('rollback_not_cleared')
      expect(code(facts({ last_auto: { id: 7, status, cleared: true } }))).toBe('deploy')
    }
    expect(code(facts({ last_auto: { id: 7, status: 'deployed', cleared: false } }))).toBe('deploy')
  })

  it('daily cap', () => {
    expect(code(facts({ auto_deploys_last_24h: 3 }))).toBe('daily_cap')
    expect(code(facts({ auto_deploys_last_24h: 2 }))).toBe('deploy')
    expect(code(facts(), policy({ daily_cap: 0 }))).toBe('daily_cap')
  })

  it('deploy window (in the install time zone)', () => {
    // 15:00Z = 10:00 New York
    expect(code(facts(), policy({ window: { start: 9, end: 18 } }))).toBe('deploy')
    expect(code(facts(), policy({ window: { start: 11, end: 18 } }))).toBe('outside_window')
    expect(code(facts({ now: new Date('2026-11-18T03:00:00Z') }), policy({ window: { start: 9, end: 18 } }))).toBe('outside_window')
  })

  it('batch size limit', () => {
    expect(code(facts(), policy({ max_files: 1 }))).toBe('batch_too_large')
    expect(code(facts(), policy({ max_files: 2 }))).toBe('deploy')
  })

  it('reports provenance before migrations, so a foreign migration is named as foreign', () => {
    const c = devCommit('a'.repeat(40), ['app/server/src/db/x.ts']); c.pr = null
    expect(code(facts({ batch: [c] }))).toBe('not_dev_merge')
  })
})

describe('helpers', () => {
  it('isMigrationPath', () => {
    expect(isMigrationPath('app/server/src/db/index.ts')).toBe(true)
    expect(isMigrationPath('./supabase/migrations/1.sql')).toBe(true)
    expect(isMigrationPath('app/server/src/db/index.test.ts')).toBe(false)
    expect(isMigrationPath('app/client/src/db.ts')).toBe(false)
  })
  it('parseWindow / inWindow', () => {
    expect(parseWindow('9-18')).toEqual({ start: 9, end: 18 })
    expect(parseWindow('22-6')).toEqual({ start: 22, end: 6 })
    expect(parseWindow('')).toBeNull()
    expect(parseWindow('nonsense')).toBeNull()
    expect(parseWindow('25-3')).toBeNull()
    expect(inWindow(23, { start: 22, end: 6 })).toBe(true)
    expect(inWindow(7, { start: 22, end: 6 })).toBe(false)
  })
})

describe('readDevAutoDeployPolicy', () => {
  const mk = () => {
    const db = new Database(':memory:')
    db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
    return db
  }
  it('no row = off, with the default cap and no window', () => {
    expect(readDevAutoDeployPolicy(mk(), 'UTC')).toEqual({ enabled: false, window: null, max_files: 0, daily_cap: 3, timeZone: 'UTC' })
  })
  it('only the exact value 1 switches it on; the old auto_deploy_enabled does not', () => {
    const db = mk()
    db.prepare("INSERT INTO settings VALUES ('auto_deploy_enabled', '1')").run()
    expect(readDevAutoDeployPolicy(db, 'UTC').enabled).toBe(false)
    db.prepare("INSERT INTO settings VALUES ('dev_auto_deploy_enabled', 'true')").run()
    expect(readDevAutoDeployPolicy(db, 'UTC').enabled).toBe(false)
    db.prepare("UPDATE settings SET value = '1' WHERE key = 'dev_auto_deploy_enabled'").run()
    expect(readDevAutoDeployPolicy(db, 'UTC').enabled).toBe(true)
  })
  it('reads window, file limit and cap', () => {
    const db = mk()
    db.prepare("INSERT INTO settings VALUES ('dev_auto_deploy_window', '9-18'), ('dev_auto_deploy_max_files', '25'), ('dev_auto_deploy_daily_cap', '2')").run()
    expect(readDevAutoDeployPolicy(db, 'UTC')).toMatchObject({ window: { start: 9, end: 18 }, max_files: 25, daily_cap: 2 })
  })
  it('a database with no settings table reads as off', () => {
    expect(readDevAutoDeployPolicy(new Database(':memory:'), 'UTC').enabled).toBe(false)
  })
})
