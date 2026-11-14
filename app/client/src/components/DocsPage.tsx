// Context — the knowledge base (served at /knowledge; /docs redirects here; labelled Context since obj 900675). Reads and edits the
// markdown folders the server exposes through /api/docs.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Menu, Network, Save, Upload } from 'lucide-react'
import { Tree, TreeGroup, TreeItem, TreeItemIndicator, TreeItemLabel } from '@ui-sdk/react/tree'
import { api } from '../lib/api'
import { Button, EmptyState, SkeletonText } from './ui'
import { Modal } from './ui/Modal'
import { KnowledgeImportPanel, useKnowledgeImportEnabled } from './KnowledgeImport'
import { KbSetupStep } from './kb-setup/KbSetupStep'
import { KnowledgeGraphPane } from './kb-wiki/KnowledgeGraphPane'
import { useNavigate } from '../context/nav'
import { useBoardTheme } from '../preview/BoardShell'
import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/mantine'
import { BlockNoteSchema, defaultBlockSpecs, type PartialBlock } from '@blocknote/core'
import '@blocknote/mantine/style.css'
import './docs-page.css'
import { mermaidBlockSpec } from './docs/MermaidBlock'
import { KbSearchPanel } from './kb-search/KbSearchPanel'
import { RelatedDocs } from './kb-search/RelatedDocs'

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

// ── Types ──

interface TreeNode {
  name: string
  path: string
  type: 'dir' | 'file'
  children?: TreeNode[]
}

interface KnowledgeFolder {
  path: string
  label: string
}

/** GET /api/docs/tree — the one knowledge base (obj 720348); there is no source picker. */
interface TreeResponse {
  root: string
  folders?: KnowledgeFolder[]
  writeRoots: string[]
  tree: TreeNode[]
}

interface FileResponse {
  path: string
  content: string
  size: number
  modifiedAt: string
  writable: boolean
}

/**
 * Where a page sits in the knowledge base, for the breadcrumb: the path below
 * the knowledge base folder that holds it (longest match wins, so a folder
 * nested in the tree labels its own pages).
 */
export function pageLocation(filePath: string, root: string, folders: KnowledgeFolder[]): string {
  const byDepth = [...folders].sort((a, b) => b.path.length - a.path.length)
  for (const f of byDepth) {
    if (filePath.startsWith(f.path + '/')) {
      const rel = filePath.slice(f.path.length + 1)
      // The knowledge base root itself needs no prefix; an extra folder keeps its label.
      return f.path === root ? rel : `${f.label}/${rel}`
    }
  }
  return filePath
}

// ── Page tree ──
// On the UI SDK tree behavior (obj 900819): role=tree/treeitem with
// aria-level and aria-expanded, one Tab stop, ↑/↓ move, → opens a folder or
// enters it, ← closes it or goes to its parent, Home/End, typeahead, and
// Enter/click opens a page. The open page is the tree's selected item.

const TREE_ROW =
  'flex w-full cursor-pointer select-none items-center gap-1.5 py-1 pr-2 text-left text-xs outline-none transition-colors duration-fast'

function TreeNodes({ nodes, selectedPath }: { nodes: TreeNode[]; selectedPath: string | null }) {
  return (
    <>
      {nodes.map(node => {
        const isDir = node.type === 'dir'
        const isSelected = !isDir && selectedPath === node.path
        return (
          <TreeItem key={node.path} value={node.path} className="group/ti outline-none">
            <TreeItemLabel
              className={`${TREE_ROW} group-focus-visible/ti:ring-2 group-focus-visible/ti:ring-inset group-focus-visible/ti:ring-accent/60 ${
                isSelected
                  ? 'bg-surface-selected font-semibold text-fg-0 shadow-[inset_3px_0_0_var(--accent-text)]'
                  : isDir
                    ? 'text-fg-1 hover:bg-surface-3'
                    : 'text-fg-2 hover:bg-surface-3 hover:text-fg-0'
              }`}
              style={{ paddingLeft: `calc(8px + (var(--tree-level, 1) - 1) * 12px + ${isDir ? 0 : 16}px)` }}
            >
              {isDir ? (
                <>
                  <TreeItemIndicator className="grid shrink-0 place-items-center text-fg-3 transition-transform duration-fast data-[expanded]:rotate-90">
                    <ChevronRight className="h-3 w-3" aria-hidden="true" />
                  </TreeItemIndicator>
                  <Folder className="h-3.5 w-3.5 shrink-0 text-fg-2 group-data-[expanded]/ti:hidden" aria-hidden="true" />
                  <FolderOpen className="hidden h-3.5 w-3.5 shrink-0 text-fg-2 group-data-[expanded]/ti:block" aria-hidden="true" />
                  <span className="truncate font-medium">{node.name}</span>
                </>
              ) : (
                <>
                  <FileText className={`h-3.5 w-3.5 shrink-0 ${isSelected ? 'text-accent' : 'text-fg-3'}`} aria-hidden="true" />
                  <span className="truncate">{node.name.replace(/\.md$/i, '')}</span>
                </>
              )}
            </TreeItemLabel>
            {isDir && node.children && node.children.length > 0 && (
              <TreeGroup>
                <TreeNodes nodes={node.children} selectedPath={selectedPath} />
              </TreeGroup>
            )}
          </TreeItem>
        )
      })}
    </>
  )
}

// ── Editor pane ──

interface EditorPaneProps {
  file: FileResponse
  onContentChange: (markdown: string) => void
  onOpenPath: (path: string) => void
}

function EditorPane({ file, onContentChange, onOpenPath }: EditorPaneProps) {
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

// ── Main ──

export function DocsPage({ workspace = 'all' }: { workspace?: string }) {
  const [kbRoot, setKbRoot] = useState<string>('')
  const [folders, setFolders] = useState<KnowledgeFolder[]>([])
  const [treeData, setTreeData] = useState<TreeNode[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [treeLoading, setTreeLoading] = useState(true)

  const [file, setFile] = useState<FileResponse | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [pendingMarkdown, setPendingMarkdown] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [saveError, setSaveError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  // File import (starter pack `knowledge-import`, obj 719936) lives on this page.
  const importOn = useKnowledgeImportEnabled()
  const [importing, setImporting] = useState(false)
  const [treeVersion, setTreeVersion] = useState(0)
  // The graph of how every page connects (obj 900674) is the page's default
  // view: shown until a page is opened, and again from the toolbar's Graph toggle.
  const [graphOn, setGraphOn] = useState(true)
  const showGraph = importOn && graphOn && !importing
  const drawerTitleId = useId()

  // The page-list drawer is a phone-only modal. If the window grows past the
  // md breakpoint while it is open, close it: the desktop sidebar takes over,
  // and a hidden modal would leave the page inert.
  useEffect(() => {
    if (!drawerOpen || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(min-width: 768px)')
    if (mq.matches) { setDrawerOpen(false); return }
    const onChange = () => { if (mq.matches) setDrawerOpen(false) }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [drawerOpen])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const navigate = useNavigate()

  // One knowledge base, one tree (obj 720348). Reloads after an import.
  useEffect(() => {
    setTreeLoading(true)
    api.get<TreeResponse>('/docs/tree')
      .then(data => {
        setTreeData(data.tree || [])
        setKbRoot(data.root || '')
        setFolders(data.folders || [])
      })
      .catch(() => setTreeData([]))
      .finally(() => setTreeLoading(false))
  }, [treeVersion])

  // Which tree values are pages (the rest are folders).
  const filePaths = useMemo(() => {
    const out = new Set<string>()
    const walk = (ns: TreeNode[]) => ns.forEach(n => (n.type === 'file' ? out.add(n.path) : walk(n.children ?? [])))
    walk(treeData)
    return out
  }, [treeData])

  const selectFile = useCallback(async (p: string) => {
    setFileLoading(true)
    setSaveState('idle')
    setSaveError(null)
    setPendingMarkdown(null)
    setDrawerOpen(false)
    setImporting(false)
    setGraphOn(false)
    try {
      const data = await api.get<FileResponse>(`/docs/file?path=${encodeURIComponent(p)}`)
      setFile(data)
    } catch {
      setFile(null)
    } finally {
      setFileLoading(false)
    }
  }, [])

  const performSave = useCallback(async (markdown: string) => {
    if (!file || !file.writable) return
    setSaveState('saving')
    setSaveError(null)
    try {
      await api.put('/docs/file', { path: file.path, content: markdown })
      setSaveState('saved')
      setPendingMarkdown(null)
      // Update file with new content so reloads start from saved state
      setFile(prev => (prev ? { ...prev, content: markdown } : prev))
      setTimeout(() => setSaveState(s => (s === 'saved' ? 'idle' : s)), 1500)
    } catch (err) {
      setSaveState('error')
      setSaveError(err instanceof Error ? err.message : 'Save failed')
    }
  }, [file])

  // Forward markdown updates from the editor; debounce auto-save to 3s.
  const handleContentChange = useCallback((markdown: string) => {
    setPendingMarkdown(markdown)
    setSaveState('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      performSave(markdown)
    }, 3000)
  }, [performSave])

  const handleManualSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (pendingMarkdown !== null) performSave(pendingMarkdown)
  }, [pendingMarkdown, performSave])

  // Cleanup pending timer when file changes / unmount.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current)
    }
  }, [file?.path])

  const breadcrumb = useMemo(() => {
    if (!file) return null
    return { rootLabel: 'Context', rel: pageLocation(file.path, kbRoot, folders) }
  }, [file, kbRoot, folders])

  const sidebar = (
    <div className="flex h-full w-64 flex-col border-r border-line bg-surface-1">
      {/* One knowledge base — no source picker (obj 720348) */}
      <div className="flex items-center justify-between gap-2 border-b border-line-soft p-3">
        <h1 className="px-0.5 text-lg font-semibold tracking-tight text-fg-0">Context</h1>
        {/* Knowledge Base Setup (obj 900556) */}
        <a
          href="/knowledge/setup"
          onClick={e => { if (!e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); navigate('/knowledge/setup') } }}
          className="inline-flex h-7 items-center rounded-md border border-line px-2 text-xs font-medium text-fg-1 transition-colors hover:border-line-strong hover:text-fg-0"
        >
          Set up
        </a>
      </div>

      {/* Search (hybrid keyword + semantic); results replace the tree while a query is active */}
      <KbSearchPanel workspace={workspace} root={kbRoot} selectedPath={file?.path ?? null} onOpen={p => { void selectFile(p) }}>
        {treeLoading ? (
          <div className="p-3" aria-label="Loading pages"><SkeletonText lines={6} /></div>
        ) : treeData.length === 0 ? (
          <div className="space-y-3 p-3 text-xs text-fg-3">
            <p>{importOn ? 'No pages yet. Import files to start your knowledge base.' : 'No pages yet.'}</p>
            <KbSetupStep index={1} workspace={workspace} className="p-3" />
          </div>
        ) : (
          <Tree
            aria-label="Pages"
            value={file?.path ?? null}
            expanded={[...expanded]}
            onExpandedChange={next => setExpanded(new Set(next))}
            onAction={value => {
              if (filePaths.has(value)) void selectFile(value)
            }}
          >
            <TreeNodes nodes={treeData} selectedPath={file?.path ?? null} />
          </Tree>
        )}
      </KbSearchPanel>
    </div>
  )

  return (
    <div className="flex h-full bg-surface-0">
      {/* Desktop sidebar */}
      <div className="hidden md:flex">{sidebar}</div>

      {/* Mobile drawer */}
      {/* A left sheet on ui/Modal (UI SDK Dialog): page behind inert, focus
          trapped, Escape or a press on the scrim closes, focus returns to the
          menu button. */}
      {drawerOpen && (
        <Modal
          open
          onClose={() => setDrawerOpen(false)}
          labelledBy={drawerTitleId}
          panelClassName="inset-y-0 left-0 right-auto m-0 h-full max-h-none w-64 max-w-none rounded-none border-0 overflow-x-hidden overflow-y-hidden bg-transparent shadow-none md:hidden"
          className="md:hidden"
        >
          <span id={drawerTitleId} hidden>Pages</span>
          {sidebar}
        </Modal>
      )}

      {/* Editor area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Toolbar / breadcrumb */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface-1 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <button
              onClick={() => setDrawerOpen(true)}
              className="rounded-sm p-1.5 text-fg-2 transition hover:bg-surface-3 hover:text-fg-0 md:hidden"
              aria-label="Open the page list"
            >
              <Menu className="h-4 w-4" />
            </button>
            {importing ? (
              <div className="text-xs font-medium text-fg-0">Import files</div>
            ) : showGraph ? (
              <div className="text-xs font-medium text-fg-0">Graph</div>
            ) : breadcrumb ? (
              <div className="min-w-0 truncate text-xs">
                <span className="text-fg-2">{breadcrumb.rootLabel}</span>
                <span className="mx-1.5 text-fg-3">/</span>
                <span className="font-mono text-fg-0">{breadcrumb.rel}</span>
              </div>
            ) : (
              <div className="text-xs text-fg-3">No page selected</div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {importOn && (
              <Button
                size="sm"
                variant={showGraph ? 'primary' : 'secondary'}
                aria-pressed={showGraph}
                onClick={() => { setImporting(false); setGraphOn(g => (file ? !g : true)) }}
                leftIcon={<Network className="h-3.5 w-3.5" aria-hidden="true" />}
                title={showGraph && file ? 'Back to the open page' : 'See how every page connects'}
              >
                Graph
              </Button>
            )}
            {importOn && !importing && (
              <Button size="sm" onClick={() => setImporting(true)} leftIcon={<Upload className="h-3.5 w-3.5" aria-hidden="true" />}>
                Import files
              </Button>
            )}
            {file && !file.writable && (
              <span className="rounded-xs bg-status-review/15 px-2 py-0.5 text-xs font-medium uppercase tracking-eyebrow text-status-review">
                Read-only
              </span>
            )}
            {saveState === 'saving' && (
              <span className="text-xs text-fg-3">Saving…</span>
            )}
            {saveState === 'saved' && (
              <span className="text-xs text-status-done">Saved</span>
            )}
            {saveState === 'error' && (
              <span className="text-xs text-flag-blocked" title={saveError ?? ''}>
                Save failed
              </span>
            )}
            {pendingMarkdown !== null && saveState === 'idle' && file?.writable && (
              <span className="text-xs text-fg-3">Unsaved</span>
            )}
            {!importing && !showGraph && <button
              onClick={handleManualSave}
              disabled={!file?.writable || pendingMarkdown === null || saveState === 'saving'}
              className="inline-flex items-center gap-1.5 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-accent-fg transition hover:bg-accent-hover active:bg-accent-press disabled:cursor-not-allowed disabled:bg-surface-3 disabled:text-fg-3"
            >
              <Save className="h-3 w-3" />
              Save
            </button>}
          </div>
        </div>

        {/* Body */}
        {importing ? (
          <KnowledgeImportPanel
            workspace={workspace}
            onClose={() => { setImporting(false); setTreeVersion(v => v + 1) }}
          />
        ) : fileLoading ? (
          <div className="flex flex-1 items-center justify-center text-base text-fg-3">
            Loading file…
          </div>
        ) : showGraph ? (
          <KnowledgeGraphPane workspace={workspace} onOpenPath={p => { void selectFile(p) }} refreshKey={treeVersion} />
        ) : file ? (
          <EditorPane key={file.path} file={file} onContentChange={handleContentChange} onOpenPath={p => { void selectFile(p) }} />
        ) : (
          <div className="flex flex-1 items-center justify-center px-4">
            <EmptyState
              icon={<FileText className="h-5 w-5" />}
              title="No page open"
              description={importOn
                ? 'Pick a page from the list to read or edit it, or import spreadsheets, PDFs and Word files to turn them into pages.'
                : 'Pick a page from the list to read or edit it.'}
              action={importOn ? (
                <Button variant="primary" onClick={() => setImporting(true)} leftIcon={<Upload className="h-4 w-4" aria-hidden="true" />}>
                  Import files
                </Button>
              ) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  )
}
