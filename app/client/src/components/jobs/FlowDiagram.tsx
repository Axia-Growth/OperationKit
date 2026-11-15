import { useEffect, useRef } from 'react'
import { Brain } from 'lucide-react'
import { renderMermaidIn } from '../../lib/mermaid'
import { EFFECT_STYLE, STATUS_STYLE } from './flow-colors'
import { FLOW_KIND_ICON } from './flow-icons'
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
      {([['trigger', 'trigger'], ['tool', 'tool'], ['mcp', 'MCP connector']] as const).map(([k, label]) => {
        const Icon = FLOW_KIND_ICON[k]!
        return <span key={k} className={item}><Icon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-2" />{label}</span>
      })}
      <span className={item}>
        <span className={sw} style={{ background: 'color-mix(in srgb, var(--st-ai) 16%, var(--surface-1))', borderColor: 'var(--st-ai)' }} />
        <Brain aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-2" />LLM
      </span>
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
