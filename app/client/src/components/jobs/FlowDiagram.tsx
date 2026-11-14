import { useEffect, useRef } from 'react'
import { renderMermaidIn } from '../../lib/mermaid'
import { EFFECT_STYLE, STATUS_STYLE } from './flow-colors'
import './flow-diagram.css'

/**
 * Read-only workflow diagram, viewer V1 (docs/design/WORKFLOWS.md §6.1): the
 * server renders `definitionToMermaid(definition, { status })` and this draws it
 * through the client's existing lazy Mermaid path. Nothing here is editable.
 */
export function FlowDiagram({ source, className }: { source: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const placeholder = el.querySelector<HTMLElement>('.mermaid-block')
    if (placeholder) {
      placeholder.removeAttribute('data-mermaid-rendered')
      placeholder.setAttribute('data-mermaid-source', source)
      placeholder.innerHTML = ''
    }
    void renderMermaidIn(el)
  }, [source])
  return (
    <div ref={ref} className={['ok-flow-diagram', className].filter(Boolean).join(' ')} data-testid="flow-diagram">
      <div
        className="mermaid-block flex justify-center overflow-x-auto rounded-lg border border-line bg-surface-1 p-4"
        data-mermaid-source={source}
      />
    </div>
  )
}

/** What the shapes and outlines mean — kept next to every diagram. */
export function FlowDiagramLegend() {
  const item = 'inline-flex items-center gap-1.5'
  const sw = 'inline-block h-3 w-3 rounded-sm border-2'
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-fg-2" data-testid="flow-diagram-legend">
      <span className={item}>⏰ trigger</span>
      <span className={item}>🔧 tool</span>
      <span className={item}>🔌 MCP connector</span>
      <span className={item}><span className={sw} style={{ background: 'color-mix(in srgb, var(--st-ai) 16%, var(--surface-1))', borderColor: 'var(--st-ai)' }} />🧠 LLM</span>
      {Object.entries(EFFECT_STYLE).map(([k, v]) => (
        <span key={k} className={item}><span className={sw} style={{ background: v.bg, borderColor: v.border }} />{v.text}</span>
      ))}
      <span className="text-fg-3">·</span>
      {(['succeeded', 'failed', 'running', 'waiting'] as const).map(k => (
        <span key={k} className={item}><span className={sw} style={{ borderColor: STATUS_STYLE[k].color, borderStyle: STATUS_STYLE[k].style }} />{STATUS_STYLE[k].label}</span>
      ))}
      <span className={item}><span className={sw} style={{ background: 'var(--surface-3)', borderColor: 'var(--line-strong)' }} />skipped</span>
    </div>
  )
}
