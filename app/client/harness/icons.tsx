/**
 * Fixture harness for the one-icon-set pass (polish F9, obj 900810).
 *
 * Not part of the app bundle — `vite build` builds from index.html only. It
 * renders the card viewer transcript, the composer chrome and the Workflows
 * legends/canvas from fixtures so they can be screenshotted in light and dark
 * without a live board:
 *
 *   npx vite --port 5199  →  http://localhost:5199/harness/icons.html?theme=dark&view=transcript|workflows
 */
import { createRoot } from 'react-dom/client'
import { LucideProvider } from 'lucide-react'
import type { Objective, SessionMessage } from '@operationkit/shared'
import '../src/index.css'
import { BoardThemeProvider } from '../src/preview/BoardShell'
import { GroupedMessages } from '../src/components/SessionMessages'
import { Composer } from '../src/components/session-viewer/Composer'
import { WorkerRollup } from '../src/components/WorkerRollup'
import { FlowCanvas, FlowCanvasLegend } from '../src/components/jobs/FlowCanvas'
import { FlowDiagram, FlowDiagramLegend } from '../src/components/jobs/FlowDiagram'
import { definitionToMermaid } from '../../shared/flow/index'

const ts = '2026-11-14T10:00:00Z'
const MESSAGES: SessionMessage[] = [
  { type: 'system', timestamp: ts, text: 'Session started in /tmp/cc-worktree-900810 on branch cc/obj-900810-one-icon-set. Model claude-opus-5-5, tools: Bash, Read, Edit, Write, Grep, Glob, Agent.' },
  { type: 'assistant', timestamp: ts, text: '<thinking>The card wants one icon family. Start by listing every emoji and glyph used as an icon, then swap each for its lucide equivalent.</thinking>' },
  { type: 'assistant', timestamp: ts, text: 'Looking for emoji and glyph icons in the client.' },
  { type: 'tool', timestamp: ts, toolName: 'Bash', toolInput: 'grep -rn "icon" app/client/src | wc -l', toolResult: '412', duration: 820 },
  { type: 'tool', timestamp: ts, toolName: 'Read', toolInput: 'app/client/src/components/SessionMessages.tsx', toolResult: 'import { useEffect } from "react"\n…', duration: 40 },
  { type: 'tool', timestamp: ts, toolName: 'Grep', toolInput: 'pattern "▸" in app/client/src', toolResult: 'ThreadTimeline.tsx:62\nThreadTimeline.tsx:82\nSessionMessages.tsx:85', duration: 120 },
  { type: 'tool', timestamp: ts, toolName: 'Glob', toolInput: 'pattern "**/*Kanban*.tsx"', toolResult: 'KanbanBoard.tsx\nKanbanColumn.tsx', duration: 30 },
  { type: 'tool', timestamp: ts, toolName: 'Edit', toolInput: 'app/client/src/components/WorkerRollup.tsx', toolResult: '@@ -54 +54 @@\n- <span>● running</span>\n+ <span><Circle /> running</span>\n context line', duration: 60 },
  { type: 'tool', timestamp: ts, toolName: 'Write', toolInput: 'app/client/harness/icons.tsx', toolResult: 'ok', duration: 25 },
  { type: 'tool', timestamp: ts, toolName: 'Agent', toolInput: 'explore dead files', toolResult: 'done', duration: 9000 },
  { type: 'assistant', timestamp: ts, text: 'Swapped the transcript icons. Next: the Workflows legend.' },
  { type: 'result', timestamp: ts, text: 'Done: one icon family across the transcript.', cost: 0.42, duration: 61000 },
]

const worker = (id: number, title: string, o: Partial<Objective>) => ({ id, title, status: 'working', session_id: null, has_blockers: false, ...o }) as unknown as Objective
const WORKERS = [
  worker(1, 'Swap transcript icons', { status: 'working', session_id: 's1' }),
  worker(2, 'Workflows legend', { status: 'ai_review' }),
  worker(3, 'Delete dead Kanban files', { status: 'review' }),
  worker(4, 'Token alias codemod', { status: 'working', has_blockers: true }),
  worker(5, 'Screenshots', { status: 'done' }),
]

const DEFINITION = {
  version: 1,
  nodes: [
    { id: 'start', kind: 'trigger', on: 'schedule', schedule: { cron: '0 8 * * 1-5' } },
    { id: 'fetch', kind: 'tool', tool: 'calendar-bookings-list', effect: 'read' },
    { id: 'crm', kind: 'mcp', connector: 'crm', tool: 'upsert_contact', effect: 'write' },
    { id: 'classify', kind: 'llm', model: 'claude-opus-5-5', max_iterations: 2, budget_usd: 1 },
    { id: 'deep_dive', kind: 'agent', agent: 'general', budget_usd: 5 },
    { id: 'gate', kind: 'check', assert: [{ why: 'every booking has an owner' }] },
    { id: 'done', kind: 'end' },
  ],
}

const params = new URLSearchParams(location.search)
const view = params.get('view') ?? 'transcript'
const noop = () => {}

function Transcript() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Card viewer transcript</h1>
      <div className="flex flex-col"><GroupedMessages messages={MESSAGES} /></div>
      <WorkerRollup workers={WORKERS} onOpenWorker={noop} />
      <Composer
        attachedFiles={[{ originalName: 'screenshot.png', mimetype: 'image/png', path: '/tmp/a.png', size: 1200 } as never, { originalName: 'notes.md', mimetype: 'text/markdown', path: '/tmp/b.md', size: 300 } as never]}
        removeFile={noop}
        sendError="Send failed: the session is restarting"
        setSendError={noop}
        fileInputRef={{ current: null }}
        handleUpload={noop as never}
        uploading={false}
        message=""
        setMessage={noop as never}
        messageRef={{ current: null }}
        handleSendMessage={noop as never}
        inputDisabled={false}
        isActive
        handleStop={noop}
        interrupting={false}
        sending={false}
      />
    </div>
  )
}

function Workflows() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <h1 className="text-lg font-semibold">Workflows legend</h1>
      <section className="flex flex-col gap-2"><h2 className="text-sm font-medium text-fg-1">Canvas</h2><FlowCanvasLegend /></section>
      <section className="flex flex-col gap-2"><h2 className="text-sm font-medium text-fg-1">Diagram</h2><FlowDiagramLegend /></section>
      <FlowDiagram source={definitionToMermaid(DEFINITION as never, { status: { start: 'succeeded', fetch: 'succeeded', crm: 'running' } })} />
      <div style={{ height: 520 }}><FlowCanvas definition={DEFINITION} status={{ start: 'succeeded', fetch: 'succeeded', crm: 'running' }} className="h-full" /></div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <LucideProvider strokeWidth={1.75}>
    <BoardThemeProvider>{view === 'workflows' ? <Workflows /> : <Transcript />}</BoardThemeProvider>
  </LucideProvider>,
)
