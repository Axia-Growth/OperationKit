// The Context page editor (BlockNote + mermaid). Split out of DocsPage (obj 900867):
// it is ~1.5 MB of JavaScript (BlockNote, ProseMirror, Mantine, mermaid) that
// opening Context never needs until a page is opened, so it now loads on
// demand — and in the background once Context has painted — instead of
// blocking the page tree and the graph.
import { useEffect, useRef } from 'react'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import '@blocknote/mantine/style.css'
import { useBoardTheme } from '../../preview/BoardShell'
import { mermaidBlockSpec } from './MermaidBlock'
import { RelatedDocs } from '../kb-search/RelatedDocs'

/** The page being edited (GET /api/docs/file). */
export interface DocsFile {
  path: string
  content: string
  size: number
  modifiedAt: string
  writable: boolean
}

// Custom schema: defaults + a mermaid block. Code fences with `language: mermaid`
// are swapped into mermaid blocks on load (see EditorPane), and converted back
// into ```mermaid code blocks before save so markdown round-trips cleanly.
const docsSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    mermaid: mermaidBlockSpec(),
  },
})

type DocsBlock = PartialBlock<typeof docsSchema.blockSchema, typeof docsSchema.inlineContentSchema, typeof docsSchema.styleSchema>

/** Walk parsed blocks; replace codeBlock(language=mermaid) with our mermaid block. */
function blocksMermaidIn(blocks: DocsBlock[]): DocsBlock[] {
  return blocks.map(b => {
    if (b.type === 'codeBlock' && (b.props as { language?: string } | undefined)?.language === 'mermaid') {
      const source = extractCodeText(b)
      return { type: 'mermaid', props: { source } } as DocsBlock
    }
    if (b.children && b.children.length > 0) {
      return { ...b, children: blocksMermaidIn(b.children as DocsBlock[]) }
    }
    return b
  })
}

/** Walk live blocks; replace mermaid blocks with codeBlock(language=mermaid) for serialization. */
function blocksMermaidOut(blocks: DocsBlock[]): DocsBlock[] {
  return blocks.map(b => {
    if (b.type === 'mermaid') {
      const source = (b.props as { source?: string } | undefined)?.source ?? ''
      return {
        type: 'codeBlock',
        props: { language: 'mermaid' },
        content: [{ type: 'text', text: source, styles: {} }],
      } as DocsBlock
    }
    if (b.children && b.children.length > 0) {
      return { ...b, children: blocksMermaidOut(b.children as DocsBlock[]) }
    }
    return b
  })
}

function extractCodeText(block: DocsBlock): string {
  const content = (block as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c.text || '').join('')
  }
  return ''
}

// ── Editor pane ──

export interface EditorPaneProps {
  file: DocsFile
  onContentChange: (markdown: string) => void
  onOpenPath: (path: string) => void
}

export default function EditorPane({ file, onContentChange, onOpenPath }: EditorPaneProps) {
  const editor = useCreateBlockNote({ schema: docsSchema })
  // The editor follows the app theme (polish F3 #900804); docs-page.css maps both schemes to tokens.
  const { theme } = useBoardTheme()
  const loadingRef = useRef(true)

  // Load file content into the editor whenever the file path changes.
  useEffect(() => {
    let cancelled = false
    loadingRef.current = true
    ;(async () => {
      try {
        const parsed = await editor.tryParseMarkdownToBlocks(file.content)
        if (cancelled) return
        const blocks = blocksMermaidIn(parsed as DocsBlock[])
        const safeBlocks = blocks.length > 0 ? blocks : [{ type: 'paragraph' as const }]
        editor.replaceBlocks(editor.document, safeBlocks as Parameters<typeof editor.replaceBlocks>[1])
      } finally {
        // Allow the change emitted by replaceBlocks to flush before re-enabling.
        setTimeout(() => {
          loadingRef.current = false
        }, 50)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [file.path, file.content, editor])

  // Subscribe to edits and forward markdown back up. Convert mermaid blocks
  // back to ```mermaid code fences so the markdown serializer handles them.
  useEffect(() => {
    const handle = editor.onChange(() => {
      if (loadingRef.current) return
      const serializable = blocksMermaidOut(editor.document as DocsBlock[])
      const md = editor.blocksToMarkdownLossy(serializable as Parameters<typeof editor.blocksToMarkdownLossy>[0])
      Promise.resolve(md).then(onContentChange)
    })
    return () => {
      if (typeof handle === 'function') handle()
    }
  }, [editor, onContentChange])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="docs-editor flex-1 overflow-y-auto bg-surface-0">
        <BlockNoteView editor={editor} theme={theme} />
      </div>
      <RelatedDocs path={file.path} onOpen={onOpenPath} />
    </div>
  )
}
