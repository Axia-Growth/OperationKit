/**
 * Settings / Secrets / sign-in primitives guard (polish F5, obj 900806).
 *
 * Every screen under Settings (all tabs and what they render), Secrets, Test
 * credentials, Setup and the signed-out screens is built on the shared
 * primitives. This fails when one drifts back to:
 *   - a native <select>            → use ui/Select
 *   - a hand-rolled alarm banner   → use ui/Alert tone="alarm"
 *   - a raw <table>                → use ui/DataTable
 *   - a local input class string   → use ui/Field + Input / Textarea
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = path.resolve(__dirname, '..')
const C = path.join(SRC, 'components')

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p)
    return /\.tsx$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : []
  })
}

/** What Settings, Secrets and the signed-out screens are made of. */
export const SETTINGS_AND_AUTH_FILES: string[] = [
  ...walk(path.join(C, 'settings')),
  ...walk(path.join(C, 'secrets')),
  ...walk(path.join(C, 'account-settings')),
  ...walk(path.join(C, 'connectors')),
  ...walk(path.join(C, 'email')),
  ...walk(path.join(C, 'setup')),
  ...walk(path.join(C, 'login')),
  ...['WorkspacesTab', 'UsersTab'].map(n => path.join(C, 'config', `${n}.tsx`)),
  ...[
    'AccountSettings',
    'SecretsPage',
    'TestCredentialsPage',
    'ModelsModule',
    'LoginPage',
    'ChangePasswordPage',
    'NoAccountPage',
  ].map(n => path.join(C, `${n}.tsx`)),
].filter(f => fs.existsSync(f))

const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')

const RULES: { name: string; re: RegExp }[] = [
  { name: 'native <select>', re: /<select[\s>]/g },
  { name: 'hand-rolled alarm banner', re: /(?:bg-signal-alarm\/(?:5|10|15|20)|bg-danger\/(?:5|10|15)\s[^"'`]*(?:px-|p-\d|rounded)|border-signal-alarm(?![\w/-]))/g },
  { name: 'raw <table>', re: /<table[\s>]/g },
  { name: 'local input class string', re: /\b(?:const|let)\s+(?:inputCls|inputClass|INPUT_CLASS|inputClasses)\s*=/g },
]

export function violations(src: string): string[] {
  const hits: string[] = []
  stripComments(src).split('\n').forEach((line, i) => {
    for (const r of RULES) for (const m of line.matchAll(r.re)) hits.push(`${i + 1}: ${r.name}: ${m[0]}`)
  })
  return hits
}

describe('Settings / auth primitives guard', () => {
  it('the matcher catches each drift and allows the primitives', () => {
    expect(violations('<select value={v}>')).toHaveLength(1)
    expect(violations('<div className="rounded bg-signal-alarm/10 px-3 py-2 text-signal-alarm">')).toHaveLength(1)
    expect(violations('<div className="rounded-md border border-signal-alarm px-3">')).toHaveLength(1)
    expect(violations('<table className="w-full">')).toHaveLength(1)
    expect(violations("const inputCls = 'w-full rounded'")).toHaveLength(1)
    expect(violations('<Alert tone="alarm" title={e} /> <Select value={v} /> <DataTable rows={r} />')).toHaveLength(0)
    expect(violations('<span className="text-signal-alarm">!</span>')).toHaveLength(0)
  })

  it('covers every Settings tab, Secrets, Setup and the signed-out screens', () => {
    const rel = SETTINGS_AND_AUTH_FILES.map(f => path.relative(C, f))
    for (const must of [
      'settings/SettingsPage.tsx',
      'settings/SettingsSeats.tsx',
      'settings/BrandingPanel.tsx',
      'SecretsPage.tsx',
      'TestCredentialsPage.tsx',
      'secrets/SecretModal.tsx',
      'account-settings/ApiKeySection.tsx',
      'config/WorkspacesTab.tsx',
      'LoginPage.tsx',
      'ChangePasswordPage.tsx',
      'login/EmailSignInLink.tsx',
      'login/AuthCard.tsx',
    ]) expect(rel).toContain(must)
    expect(rel.length).toBeGreaterThan(50)
  })

  it('no native select, alarm banner, raw table or local input class in those files', () => {
    const bad: string[] = []
    for (const f of SETTINGS_AND_AUTH_FILES) {
      for (const v of violations(fs.readFileSync(f, 'utf8'))) bad.push(`${path.relative(SRC, f)}:${v}`)
    }
    expect(bad).toEqual([])
  })
})
