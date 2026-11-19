/**
 * obj 901493 — the app map chat bots read (`shared/app-map.generated.json`) must
 * match the client's real router, navigation and pages.
 *
 * The first test regenerates the map from the source and compares it with the
 * committed file, so adding, moving, renaming or removing a route, a tab or a
 * settings panel fails CI until `npm run gen:app-map --workspace=client` is run
 * and the new map is committed. The "catches a change" tests prove that guard
 * works by editing a COPY of the source.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AVATAR_MENU, ROUTE_NOTES, generateAppMap, renderAppMapFile } from './generate'
import type { AppMap } from '../../../../shared/app-map'

const SRC = join(__dirname, '..', '..')
const GENERATED = join(SRC, '..', '..', 'shared', 'app-map.generated.json')

const live = generateAppMap({ srcDir: SRC })
const page = (map: AppMap, path: string) => map.pages.find(p => p.path === path)

describe('app map: the committed file is current', () => {
  it('matches what the generator produces from the source', () => {
    const committed = readFileSync(GENERATED, 'utf8')
    const fresh = renderAppMapFile(live)
    expect(
      committed === fresh,
      'shared/app-map.generated.json is out of date: a route, tab or panel changed. Run `npm run gen:app-map --workspace=client` and commit the result.',
    ).toBe(true)
  })
})

describe('app map: what it says', () => {
  it('puts Queue auto-start under Workflows > Runs, admin only, with the job time limit field', () => {
    const jobs = page(live, '/jobs')!
    expect(jobs.click_path).toEqual(['Workflows'])
    expect(jobs.audience).toBe('admin')
    const panel = jobs.panels.find(p => p.name === 'Queue auto-start')!
    expect(panel.trail).toEqual(['Runs'])
    expect(panel.audience).toBe('admin')
    expect(panel.settings).toContain('Job time limit (minutes)')
    expect(jobs.tabs.find(t => t.label === 'Runs')?.url).toBe('?view=runs')
  })

  it('has no Settings > Platform page: the old URL is a redirect to Workflows', () => {
    expect(page(live, '/settings/platform')).toBeUndefined()
    expect(live.redirects).toContainEqual({ from: '/settings/platform', to: '/jobs#host-cron' })
    for (const p of live.pages) expect(p.click_path.join(' > ')).not.toMatch(/Platform/)
  })

  it('reads the Settings tabs and who sees them from SettingsPage', () => {
    expect(page(live, '/settings/secrets')).toMatchObject({ click_path: [AVATAR_MENU, 'Settings', 'Secrets'], audience: 'everyone' })
    expect(page(live, '/settings/branding')).toMatchObject({ click_path: [AVATAR_MENU, 'Settings', 'Branding'], audience: 'admin' })
    const secrets = page(live, '/settings/secrets')!
    expect(secrets.tabs.map(t => `${t.label}:${t.audience}`)).toEqual(['Mine:everyone', 'Shared:admin', 'Test credentials:admin'])
  })

  it('reads the main menu and the avatar menu from Layout', () => {
    expect(page(live, '/')!.click_path).toEqual(['Board'])
    expect(page(live, '/chat')!.click_path).toEqual(['Bots'])
    expect(page(live, '/knowledge')!.click_path).toEqual(['Context'])
    expect(page(live, '/agents')).toMatchObject({ click_path: [AVATAR_MENU, 'Bots & skills'], audience: 'admin' })
  })

  it('every page says how to reach it', () => {
    for (const p of live.pages) {
      expect(p.click_path.length > 0 || !!p.how, `${p.path} has neither a menu path nor a ROUTE_NOTES entry`).toBe(true)
    }
  })

  it('every ROUTE_NOTES entry names a real page and real menu labels', () => {
    const menuLabels = new Set(live.pages.filter(p => !ROUTE_NOTES[p.path]?.click.length).flatMap(p => p.click_path))
    for (const [path, note] of Object.entries(ROUTE_NOTES)) {
      expect(page(live, path), `ROUTE_NOTES has ${path}, which is no longer a page`).toBeDefined()
      for (const label of note.click) expect(menuLabels.has(label), `ROUTE_NOTES ${path}: "${label}" is not a menu label`).toBe(true)
    }
  })

  it('no path is both a page and a redirect, and none is listed twice', () => {
    const paths = live.pages.map(p => p.path)
    expect(new Set(paths).size).toBe(paths.length)
    for (const r of live.redirects) expect(paths).not.toContain(r.from)
  })

  it('holds static text only: no values that look like credentials or addresses', () => {
    const text = JSON.stringify(live)
    expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}|cc_live_|ghp_[A-Za-z0-9]{10,}|[\w.+-]+@[\w-]+\.[a-z]{2,}/)
  })
})

describe('app map: the generator catches a change', () => {
  let copy: string
  const edit = (file: string, fn: (text: string) => string) => {
    const p = join(copy, file)
    const before = readFileSync(p, 'utf8')
    const after = fn(before)
    expect(after, `the edit to ${file} did not apply`).not.toBe(before)
    writeFileSync(p, after)
    return () => writeFileSync(p, before)
  }
  const regenerated = () => renderAppMapFile(generateAppMap({ srcDir: copy }))
  const committed = renderAppMapFile(live)

  beforeAll(() => {
    copy = mkdtempSync(join(tmpdir(), 'app-map-'))
    cpSync(SRC, copy, { recursive: true, filter: src => !/\.test\.tsx?$/.test(src) && !/[\\/](assets|fonts)$/.test(src) })
  })
  afterAll(() => rmSync(copy, { recursive: true, force: true }))

  it('an untouched copy gives the same map', () => {
    expect(regenerated()).toBe(committed)
  })

  it('a new route', () => {
    const undo = edit('App.tsx', t => t.replace('<Route path="/login"', '<Route path="/billing" element={<SystemPage />} />\n          <Route path="/login"'))
    const map = generateAppMap({ srcDir: copy })
    expect(page(map, '/billing')).toBeDefined()
    expect(regenerated()).not.toBe(committed)
    undo()
  })

  it('a removed route', () => {
    const undo = edit('App.tsx', t => t.replace('<Route path="knowledge-search" element={<SettingsKnowledgeSearch />} />', ''))
    expect(page(generateAppMap({ srcDir: copy }), '/settings/knowledge-search')).toBeUndefined()
    expect(regenerated()).not.toBe(committed)
    undo()
  })

  it('a panel moved to another tab', () => {
    // Queue auto-start out of the Runs branch, above the Workflows | Runs switch.
    const undo = edit('components/JobsBoard.tsx', t =>
      t.replace("{kindFilter !== 'flow' && isAdmin && <QueueAutostartPanel />}", '')
        .replace("{view === 'workflows' ? (", "{isAdmin && <QueueAutostartPanel />}\n      {view === 'workflows' ? ("))
    const panel = page(generateAppMap({ srcDir: copy }), '/jobs')!.panels.find(p => p.name === 'Queue auto-start')!
    expect(panel.trail).toEqual([])
    expect(regenerated()).not.toBe(committed)
    undo()
  })

  it('a removed panel', () => {
    const undo = edit('components/JobsBoard.tsx', t => t.replace("{kindFilter !== 'flow' && isAdmin && <QueueAutostartPanel />}", ''))
    expect(page(generateAppMap({ srcDir: copy }), '/jobs')!.panels.find(p => p.name === 'Queue auto-start')).toBeUndefined()
    undo()
  })

  it('a renamed panel, a renamed setting and a renamed menu entry', () => {
    const undo1 = edit('components/settings/QueueAutostartPanel.tsx', t => t.replace('>Queue auto-start</h3>', '>Auto-start</h3>').replace('>Job time limit (minutes)</label>', '>Time limit</label>'))
    const undo2 = edit('components/Layout.tsx', t => t.replace("label: 'Workflows',", "label: 'Automations',"))
    const jobs = page(generateAppMap({ srcDir: copy }), '/jobs')!
    expect(jobs.click_path).toEqual(['Automations'])
    expect(jobs.panels.find(p => p.name === 'Auto-start')?.settings).toContain('Time limit')
    undo1(); undo2()
    expect(regenerated()).toBe(committed)
  })

  it('a new Settings tab', () => {
    const undo1 = edit('App.tsx', t => t.replace('<Route path="email" element={<SettingsEmail />} />', '<Route path="email" element={<SettingsEmail />} />\n            <Route path="billing" element={<SettingsEmail />} />'))
    const undo2 = edit('components/settings/SettingsPage.tsx', t => t.replace("{ key: EMAIL, label: 'Email' },", "{ key: EMAIL, label: 'Email' },\n          { key: 'billing', label: 'Billing' },"))
    expect(page(generateAppMap({ srcDir: copy }), '/settings/billing')).toMatchObject({ click_path: [AVATAR_MENU, 'Settings', 'Billing'], audience: 'admin' })
    undo1(); undo2()
  })
})
