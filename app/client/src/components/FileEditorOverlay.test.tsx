// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { cleanup, click, press, render } from '../test/render'

/* FileEditorOverlay on ui/Modal (UI SDK Dialog): a named modal dialog, Escape
   and the Close button close it, and focus goes back to the opener. */

vi.mock('../lib/api', () => ({
  api: {
    get: () => Promise.resolve({ path: '/home/operator/notes/plan.md', content: '# Plan', size: 6, modifiedAt: '', writable: true }),
    put: () => Promise.resolve({}),
  },
}))
vi.mock('@blocknote/react', () => ({ useCreateBlockNote: () => ({ onChange: () => () => {}, document: [], tryParseMarkdownToBlocks: async () => [], replaceBlocks: () => {} }) }))
vi.mock('@blocknote/mantine', () => ({ BlockNoteView: () => <div data-testid="editor" /> }))
vi.mock('@blocknote/core', () => ({ BlockNoteSchema: { create: () => ({}) }, defaultBlockSpecs: {} }))
vi.mock('@blocknote/mantine/style.css', () => ({}))
vi.mock('./docs-page.css', () => ({}))
vi.mock('./docs/MermaidBlock', () => ({ mermaidBlockSpec: () => ({}) }))

const { FileEditorOverlay } = await import('./FileEditorOverlay')

const settle = () => new Promise((r) => setTimeout(r, 0))

function opener() {
  const b = document.createElement('button')
  b.textContent = 'Open doc'
  document.body.appendChild(b)
  b.focus()
  return b
}

describe('FileEditorOverlay — modal dialog', () => {
  afterEach(async () => {
    await cleanup()
  })

  it('is a named modal dialog; Escape closes it and focus returns to the opener', async () => {
    const trigger = opener()
    const onClose = vi.fn()
    const view = await render(<FileEditorOverlay filePath="/home/operator/notes/plan.md" onClose={onClose} />)
    await settle()

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const name = document.getElementById(dialog.getAttribute('aria-labelledby')!)
    expect(name?.textContent).toBe('~/notes/plan.md')
    // Focus moved inside the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true)

    await press('Escape')
    expect(onClose).toHaveBeenCalledTimes(1)

    // The parent closes it by unmounting; focus goes back to the opener.
    await view.unmount()
    await settle()
    expect(document.activeElement).toBe(trigger)
  })

  it('the Close button closes it', async () => {
    opener()
    const onClose = vi.fn()
    await render(<FileEditorOverlay filePath="/home/operator/notes/plan.md" onClose={onClose} />)
    await click(document.querySelector('[role="dialog"] button[aria-label="Close"]'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
