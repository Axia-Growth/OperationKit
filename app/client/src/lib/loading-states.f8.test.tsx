// @vitest-environment jsdom
/**
 * Loading / empty states guard (polish F8, obj 900809).
 *
 * 1. Cold load never shows bare "Loading..." text: index.html's static shell and
 *    App.tsx's auth-pending render are both a neutral skeleton (no words, and
 *    not a fake board — the next frame may be the login card or /settings).
 * 2. The files the polish audit listed hold no plain-text loading strings any
 *    more; each renders a Skeleton instead. A regression re-adding e.g.
 *    `<div>Loading board…</div>` fails here.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AppShellSkeleton } from '../components/AppShellSkeleton'
import { SaveIndicator } from '../components/ui/SaveIndicator'
import { cleanup, render } from '../test/render'

const SRC = resolve(__dirname, '..')
const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8')

afterEach(cleanup)

describe('first load', () => {
  it('index.html paints a neutral shell, not a board, with no text', () => {
    const html = readFileSync(resolve(SRC, '../index.html'), 'utf8')
    const shell = html.slice(html.indexOf('<div id="app-shell"'), html.indexOf('<script type="module"'))
    expect(shell).toContain('as-topbar')
    expect(shell).toContain('as-page')
    expect(shell).not.toMatch(/as-board|as-col\b/)
    // Strip tags + comments: nothing readable is left.
    const text = shell.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, '').trim()
    expect(text).toBe('')
  })

  it('App.tsx renders the shell skeleton (not "Loading...") while auth resolves', () => {
    const app = read('App.tsx')
    expect(app).not.toMatch(/Loading\.\.\./)
    expect(app).toMatch(/if \(loading\) \{\s*(\/\/[^\n]*\n\s*)*return <AppShellSkeleton \/>/)
  })

  it('AppShellSkeleton has no visible text and no board columns', async () => {
    const { container } = await render(<AppShellSkeleton />)
    const root = container.querySelector('[data-testid="app-shell-skeleton"]')!
    expect(root.getAttribute('aria-busy')).toBe('true')
    expect(root.textContent?.trim()).toBe('')
    expect(root.querySelector('.cc-ws-col')).toBeNull()
  })
})

describe('no plain-text loaders in the audited files', () => {
  const FILES = [
    'preview/PreviewBoard.tsx',
    'preview/PreviewWorkspace.tsx',
    'preview/PreviewArchive.tsx',
    'preview/DesignCanvas.tsx',
    'components/DocsPage.tsx',
    'components/FileEditorOverlay.tsx',
    'components/StrategyGovernancePanel.tsx',
    'components/ThreadTimeline.tsx',
    'components/jobs/ExecutionsPanel.tsx',
  ]
  // JSX text or a string literal that starts with "Loading" / "Opening" and is
  // rendered as content. aria-label="Loading …" is fine (screen-reader only).
  const PLAIN = /(>\s*(Loading|Opening)\b[^<{]*<)|([?:]\s*['"`](Loading|Opening)\b[^'"`]*['"`])/

  it.each(FILES)('%s renders a Skeleton, not loading text', (rel) => {
    const src = read(rel)
    const hits = src.split('\n').filter(l => PLAIN.test(l) && !/aria-label=/.test(l))
    expect(hits).toEqual([])
    expect(src).toMatch(/Skeleton/)
  })

  it('ThreadTimeline no longer returns null while its first fetch is in flight', () => {
    expect(read('components/ThreadTimeline.tsx')).not.toMatch(/if \(!loaded && segments\.length === 0\) return null/)
  })

  it('ThreadPane has no "No session output" flash outside the loaded empty state', () => {
    expect(read('components/session-viewer/ThreadPane.tsx')).not.toMatch(/>\s*No session output\s*</)
  })
})

describe('SaveIndicator — one label, one colour family', () => {
  it.each([
    ['saving', false, 'Saving…', 'text-fg-3'],
    ['saved', false, 'Saved', 'text-success'],
    ['error', false, 'Save failed', 'text-danger'],
    ['idle', true, 'Unsaved', 'text-fg-3'],
  ] as const)('%s (dirty=%s) → %s', async (state, dirty, label, tone) => {
    const { container } = await render(<SaveIndicator state={state} dirty={dirty} error="disk full" />)
    const el = container.querySelector('[data-testid="save-indicator"]')!
    expect(el.textContent).toBe(label)
    expect(el.className).toContain(tone)
    expect(el.className).not.toMatch(/status-done|flag-blocked/)
    if (state === 'error') expect(el.getAttribute('title')).toBe('disk full')
  })

  it('idle + clean renders nothing visible', async () => {
    const { container } = await render(<SaveIndicator state="idle" />)
    expect(container.querySelector('[data-testid="save-indicator"]')!.textContent).toBe('')
  })

  it('DocsPage and FileEditorOverlay both use it instead of hand-rolled labels', () => {
    for (const rel of ['components/DocsPage.tsx', 'components/FileEditorOverlay.tsx']) {
      const src = read(rel)
      expect(src).toContain('<SaveIndicator')
      expect(src).not.toMatch(/text-status-done">Saved|text-flag-blocked[^>]*>\s*Save failed/)
    }
  })
})
