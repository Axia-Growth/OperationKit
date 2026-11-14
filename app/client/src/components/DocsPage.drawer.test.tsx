// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, click, press, render } from '../test/render'

/* The phone page-list drawer on ui/Modal (UI SDK Dialog): a left sheet dialog
   named "Pages"; Escape closes it and focus returns to the menu button. */

vi.mock('../lib/api', () => ({
  api: {
    get: () => Promise.resolve({
      root: '/kb',
      folders: [{ path: '/kb', label: 'Knowledge base' }],
      tree: [{ name: 'index.md', path: '/kb/index.md', type: 'file' }],
    }),
    put: () => Promise.resolve({}),
  },
}))
vi.mock('@blocknote/react', () => ({ useCreateBlockNote: () => ({}) }))
vi.mock('@blocknote/mantine', () => ({ BlockNoteView: () => null }))
vi.mock('@blocknote/core', () => ({ BlockNoteSchema: { create: () => ({}) }, defaultBlockSpecs: {} }))
vi.mock('@blocknote/mantine/style.css', () => ({}))
vi.mock('./docs-page.css', () => ({}))
vi.mock('./docs/MermaidBlock', () => ({ mermaidBlockSpec: () => ({}) }))
vi.mock('./KnowledgeImport', () => ({ KnowledgeImportPanel: () => null, useKnowledgeImportEnabled: () => false }))
vi.mock('./kb-wiki/KnowledgeGraphPane', () => ({ KnowledgeGraphPane: () => null }))

const { DocsPage } = await import('./DocsPage')

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }

describe('DocsPage — mobile page-list drawer', () => {
  afterEach(async () => {
    await cleanup()
  })

  it('opens a modal dialog named "Pages"; Escape closes it and focus returns to the menu button', async () => {
    const view = await render(<DocsPage workspace="all" />)
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()

    const menu = view.container.querySelector<HTMLButtonElement>('button[aria-label="Open the page list"]')!
    await click(menu)
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe('Pages')
    expect(dialog.contains(document.activeElement)).toBe(true)
    // The drawer holds the page tree.
    expect(dialog.querySelector('[aria-label="Pages"]')).toBeTruthy()

    await press('Escape')
    await settle()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(menu)
  })
})
