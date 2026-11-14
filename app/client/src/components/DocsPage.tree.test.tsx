// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkPattern } from '@ui-sdk/core/testing'
import { byRole, cleanup, click, press, render } from '../test/render'

/* Knowledge base page tree on UI SDK Tree (obj 900819): roles, levels,
   arrows to open/close folders, and Enter/click to open a page. */

const gets: string[] = []
vi.mock('../lib/api', () => ({
  api: {
    get: (url: string) => {
      gets.push(url)
      if (url.startsWith('/docs/file')) {
        const path = decodeURIComponent(url.split('path=')[1])
        return Promise.resolve({ path, content: '# Hi', mtime: 1 })
      }
      return Promise.resolve({
        root: '/kb',
        label: 'Knowledge base',
        folders: [{ path: '/kb', label: 'Knowledge base' }],
        writeRoots: ['/kb'],
        tree: [
          {
            name: 'decisions', path: '/kb/decisions', type: 'dir',
            children: [
              { name: 'pricing.md', path: '/kb/decisions/pricing.md', type: 'file' },
              { name: 'roadmap.md', path: '/kb/decisions/roadmap.md', type: 'file' },
            ],
          },
          { name: 'index.md', path: '/kb/index.md', type: 'file' },
        ],
      })
    },
    put: () => Promise.resolve({}),
  },
}))
vi.mock('@blocknote/react', () => ({ useCreateBlockNote: () => ({ tryParseMarkdownToBlocks: async () => [], replaceBlocks: () => {}, document: [], onChange: () => () => {}, blocksToMarkdownLossy: async () => '' }) }))
vi.mock('@blocknote/mantine', () => ({ BlockNoteView: () => null }))
vi.mock('@blocknote/core', () => ({ BlockNoteSchema: { create: () => ({}) }, defaultBlockSpecs: {} }))
vi.mock('@blocknote/mantine/style.css', () => ({}))
vi.mock('./docs-page.css', () => ({}))
vi.mock('./docs/MermaidBlock', () => ({ mermaidBlockSpec: () => ({}) }))
vi.mock('./KnowledgeImport', () => ({ KnowledgeImportPanel: () => null, useKnowledgeImportEnabled: () => false }))
vi.mock('./kb-wiki/KnowledgeGraphPane', () => ({ KnowledgeGraphPane: () => null }))

const { DocsPage } = await import('./DocsPage')

afterEach(async () => { await cleanup(); gets.length = 0 })

async function mount() {
  const view = await render(<DocsPage workspace={'acme' as never} />)
  await vi.waitFor(() => expect(view.container.querySelector('[role="tree"]')).not.toBeNull())
  // The page shows twice (desktop sidebar + mobile drawer is closed), take the first tree.
  return view.container.querySelector('[role="tree"]') as HTMLElement
}
const items = (tree: HTMLElement) => byRole(tree, 'treeitem').filter((i) => !i.closest('[hidden]'))
const label = (el: Element | null) => (el?.querySelector('[data-slot="tree-item-label"]') ?? el)?.textContent?.trim()

describe('KB page tree on UI SDK Tree', () => {
  it('is a named tree; folders say whether they are open; rows carry their level', async () => {
    const tree = await mount()
    expect(tree.getAttribute('aria-label')).toBe('Pages')
    const [folder, page] = items(tree)
    expect(label(folder)).toBe('decisions')
    expect(folder.getAttribute('aria-expanded')).toBe('false')
    expect(folder.getAttribute('aria-level')).toBe('1')
    expect(label(page)).toBe('index')
    expect(page.hasAttribute('aria-expanded')).toBe(false)
  })

  it('passes the WAI-ARIA tree pattern check', async () => {
    const tree = await mount()
    await checkPattern(tree, 'tree')
  })

  it('→ opens a folder and enters it; ← goes back to the folder and closes it', async () => {
    const tree = await mount()
    const folder = items(tree)[0]
    folder.focus()
    await press('ArrowRight')
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    await press('ArrowRight')
    expect(label(document.activeElement)).toBe('pricing')
    expect(document.activeElement?.getAttribute('aria-level')).toBe('2')
    await press('ArrowLeft')
    expect(document.activeElement).toBe(folder)
    await press('ArrowLeft')
    expect(folder.getAttribute('aria-expanded')).toBe('false')
  })

  it('Enter on a page opens it and marks it selected', async () => {
    const tree = await mount()
    items(tree)[0].focus()
    await press('End')
    expect(label(document.activeElement)).toBe('index')
    await press('Enter')
    await vi.waitFor(() => expect(gets).toContain('/docs/file?path=%2Fkb%2Findex.md'))
    await vi.waitFor(() => expect(items(tree).find((i) => label(i) === 'index')!.getAttribute('aria-selected')).toBe('true'))
  })

  it('clicking a folder opens it without loading a page', async () => {
    const tree = await mount()
    const folder = items(tree)[0]
    await click(folder.querySelector('[data-slot="tree-item-label"]') ?? folder)
    expect(folder.getAttribute('aria-expanded')).toBe('true')
    expect(gets.some((g) => g.startsWith('/docs/file'))).toBe(false)
  })
})
