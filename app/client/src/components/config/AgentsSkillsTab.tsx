/**
 * Roster of every bot and skill — the Registry tab of the Bots & skills page
 * (/agents). Extracted from ConfigPage.tsx.
 *
 * obj 900684: GET /admin/agents now returns every source of agents the app knows
 * about, not just flat persona files — built-in chat agents (Knowledge Base
 * Setup), folder-format chat agents, registry rows with no file, and starter-pack
 * agents that are not switched on — plus sub-skills. Each row says where it comes
 * from and, when it is not usable yet, why. See server services/agent-roster.ts.
 */
import { useState, useEffect, useCallback } from 'react'
import { ExternalLink, FileCode2, Sparkles } from 'lucide-react'
import {
  Card, Button, Badge, EmptyState, Skeleton, SegmentedControl, cn,
} from '../ui'
import { api } from '../../lib/api'
import { formatBytes, formatName } from './config-form'

type AgentSource = 'persona' | 'chat' | 'builtin' | 'registry' | 'starter-pack'

export interface AgentInfo {
  /** `${source}:${slug}`; older servers omit it, so fall back to the slug. */
  id?: string
  name: string
  filename: string
  slug: string
  size: number
  modifiedAt: string | null
  assignable: boolean
  kind: 'executive' | 'routing-only'
  label: string
  source?: AgentSource
  description?: string
  file_path?: string | null
  definition?: string | null
  open_href?: string | null
  pack?: { id: string; name: string; enabled: boolean } | null
  note?: string | null
}

interface SkillInfo {
  name: string
  description: string
  dirname: string
  size: number
  fileCount: number
  parent?: string | null
}

export const SOURCE_LABEL: Record<AgentSource, string> = {
  persona: 'Instructions file',
  chat: 'Chat bot',
  builtin: 'Built-in',
  registry: 'No file',
  'starter-pack': 'Starter pack',
}

export const agentId = (a: AgentInfo) => a.id ?? a.slug

/** The agent a slug cross-link means: the persona file first, then any other source. */
export function agentForSlug(agents: AgentInfo[], slug: string): AgentInfo | undefined {
  return agents.find(a => a.slug === slug && (a.source ?? 'persona') === 'persona') ?? agents.find(a => a.slug === slug)
}

// Subset of GET /admin/skill-graph — the okit-validated agent -> skill -> tool
// layer graph, read from `skills:`/`tools:` frontmatter (obj-2387, re-sourced in
// obj 707012). It replaces registry.json's hand-maintained `graph` block, which
// described the same edges from stale, unvalidated data.
//
// The frontmatter layer declares no skill->skill dependency, no `tier` and no
// `handoffs_to`, so this tab shows none of them: those affordances were dropped
// with the block rather than kept alive on data nothing validates.
interface GraphSkill {
  parent: string | null
  subskills: string[]
  tools: string[]
  agents_always: string[]
  agents_available: string[]
  // Retained registry.json stats (facts about a node, not edges).
  description?: string
  usage_count?: number
  failure_count?: number
  needs_improvement?: boolean
}
interface GraphAgent {
  always: string[]
  available: string[]
}
interface SkillGraphData {
  source?: string
  generated_at?: string
  skills?: Record<string, GraphSkill>
  agents?: Record<string, GraphAgent>
}

export function AgentsSkillsTab() {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [registry, setRegistry] = useState<SkillGraphData>({})
  const [selected, setSelected] = useState<{ type: 'agent' | 'skill'; key: string } | null>(null)
  const [fileContent, setFileContent] = useState('')
  const [showFile, setShowFile] = useState(false)
  const [loading, setLoading] = useState(true)
  const [viewMode, setViewMode] = useState<'agents' | 'skills'>('agents')

  useEffect(() => {
    Promise.all([
      api.get<{ agents: AgentInfo[]; skills: SkillInfo[] }>('/admin/agents')
        .then(data => { setAgents(data.agents || []); setSkills(data.skills || []) })
        .catch(() => {}),
      // The okit-validated layer graph — single source of truth for agent↔skill
      // wiring, plus the retained usage stats. Same endpoint the SkillGraph tab consumes.
      api.get<SkillGraphData>('/admin/skill-graph')
        .then(data => setRegistry(data || {}))
        .catch(() => {}),
    ]).finally(() => setLoading(false))
  }, [])

  const loadFile = useCallback(async (filePath: string) => {
    setFileContent('')
    try {
      const data = await api.get<{ content: string }>(`/admin/file?path=${encodeURIComponent(filePath)}`)
      setFileContent(data.content)
    } catch {}
  }, [])

  function selectAgent(id: string) {
    setSelected({ type: 'agent', key: id })
    setShowFile(false)
    const a = agents.find(x => agentId(x) === id)
    if (a?.definition) setFileContent(a.definition)
    else if (a?.file_path) loadFile(a.file_path)
    else if (a && a.source && a.source !== 'persona') setFileContent('There is no definition file for this bot on this install.')
    else loadFile(`agents/${a?.slug ?? id}.md`)
  }
  function selectAgentBySlug(slug: string) {
    const a = agentForSlug(agents, slug)
    selectAgent(a ? agentId(a) : slug)
  }

  function selectSkill(name: string) {
    setSelected({ type: 'skill', key: name })
    setShowFile(false)
    loadFile(`skills/${name}/SKILL.md`)
  }

  // ── Derived agent↔skill cross-links from the frontmatter layer graph ──
  const graph = registry.agents || {}
  const regSkills = registry.skills || {}

  // Skills an agent declares (always ∪ available) in its `skills:` frontmatter.
  function skillsForAgent(slug: string): string[] {
    const node = graph[slug]
    if (!node) return []
    return Array.from(new Set([...(node.always || []), ...(node.available || [])])).sort()
  }
  // Agents that consume a skill — the reverse edge, precomputed server-side from
  // the same declarations, so both directions are one validated graph.
  function agentsForSkill(name: string): string[] {
    const rs = regSkills[name]
    if (!rs) return []
    return Array.from(new Set([...(rs.agents_always || []), ...(rs.agents_available || [])])).sort()
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <Card inset>
          <div className="flex border-b border-line">
            <Skeleton className="m-2 h-7 flex-1" />
            <Skeleton className="m-2 h-7 flex-1" />
          </div>
          <div className="space-y-1.5 p-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </div>
        </Card>
        <Card>
          <Skeleton className="h-5 w-40" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className={cn('h-3', i % 3 === 2 ? 'w-2/5' : 'w-full')} />
            ))}
          </div>
        </Card>
      </div>
    )
  }

  const items = viewMode === 'agents' ? agents : skills

  // A clickable cross-link chip that switches the selection to another node.
  const LinkChip = ({ label, title, onClick, tone = 'neutral' as const }: { label: string; title?: string; onClick: () => void; tone?: 'neutral' | 'info' | 'accent' }) => (
    <button
      onClick={onClick}
      title={title}
      className="transition-transform hover:scale-[1.03] focus:outline-none focus:ring-1 focus:ring-accent rounded-full"
    >
      <Badge tone={tone}>{label}</Badge>
    </button>
  )
  const agentLabel = (slug: string) => {
    const a = agentForSlug(agents, slug)
    return a ? a.label || formatName(a.name) : formatName(slug)
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
      {/* Browser column */}
      <Card inset>
        {/* Agents / Skills filters this one list (obj 900807): the page's
            single tab row is above, so this is a SegmentedControl, not a
            third tab style. */}
        <div className="border-b border-line p-2">
          <SegmentedControl
            label="Show"
            value={viewMode}
            onChange={k => setViewMode(k === 'skills' ? 'skills' : 'agents')}
            className="flex w-full [&>*]:flex-1 [&>*]:justify-center"
            items={[
              { key: 'agents', label: 'Bots', count: agents.length },
              { key: 'skills', label: 'Skills', count: skills.length },
            ]}
          />
        </div>
        <div className="max-h-[60vh] space-y-0.5 overflow-y-auto p-2">
          {items.length === 0 && (
            <EmptyState compact icon={<FileCode2 className="h-5 w-5" />} title={viewMode === 'agents' ? 'No bots' : 'No skills'} />
          )}
          {viewMode === 'agents' && agents.map(agent => (
            <button
              key={agentId(agent)}
              onClick={() => selectAgent(agentId(agent))}
              className={cn(
                'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                selected?.type === 'agent' && selected.key === agentId(agent)
                  ? 'bg-surface-selected font-medium text-fg-0 shadow-[inset_2px_0_0_var(--accent-text)]'
                  : 'text-fg-1 hover:bg-surface-3',
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{agent.label || formatName(agent.name)}</span>
                {agent.source && agent.source !== 'persona' ? (
                  <Badge tone={agent.source === 'registry' ? 'verify' : 'info'}>{SOURCE_LABEL[agent.source]}</Badge>
                ) : (
                  <Badge tone={agent.kind === 'executive' ? 'accent' : 'neutral'}>
                    {agent.kind === 'executive' ? 'Executive' : 'Routing only'}
                  </Badge>
                )}
              </div>
              {agent.source && agent.source !== 'persona' && agent.description && (
                <div className="mt-0.5 line-clamp-2 text-xs text-fg-3">{agent.description}</div>
              )}
              <div className="mt-0.5 flex items-center gap-2 text-xs text-fg-3">
                {agent.size > 0 && <span>{formatBytes(agent.size)}</span>}
                <span>· {skillsForAgent(agent.slug).length} {skillsForAgent(agent.slug).length === 1 ? 'skill' : 'skills'}</span>
                {!agent.assignable && <span className="text-flag-blocked">· not assignable</span>}
              </div>
            </button>
          ))}
          {viewMode === 'skills' && skills.map(skill => {
            const rs = regSkills[skill.name]
            const consumers = agentsForSkill(skill.name)
            return (
              <button
                key={skill.dirname}
                onClick={() => selectSkill(skill.dirname)}
                className={cn(
                  'w-full rounded-md px-3 py-2.5 text-left transition-colors',
                  skill.parent && 'pl-6',
                  selected?.type === 'skill' && selected.key === skill.dirname
                    ? 'bg-surface-selected font-medium text-fg-0 shadow-[inset_2px_0_0_var(--accent-text)]'
                    : 'text-fg-1 hover:bg-surface-3',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{formatName(skill.parent ? skill.name.slice(skill.parent.length + 1) : skill.name)}</span>
                  {skill.parent && <Badge tone="neutral">Sub-skill</Badge>}
                  {rs?.needs_improvement && <Badge tone="verify">Needs work</Badge>}
                </div>
                {skill.description && (
                  <div className="mt-0.5 line-clamp-2 text-xs text-fg-3">{skill.description}</div>
                )}
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-3">
                  <span>{consumers.length} bot{consumers.length !== 1 ? 's' : ''}</span>
                  {typeof rs?.usage_count === 'number' && <span>· {rs.usage_count} uses</span>}
                  {!!rs?.failure_count && <span className="text-flag-blocked">· {rs.failure_count} fails</span>}
                </div>
              </button>
            )
          })}
        </div>
      </Card>

      {/* Detail column — interactive metadata + cross-links (obj-2387) */}
      <Card inset>
        {!selected ? (
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title="Nothing selected"
            description="Pick a bot or skill to see its skills, usage, and links."
          />
        ) : selected.type === 'agent' ? (
          (() => {
            const agent = agents.find(a => agentId(a) === selected.key)
            const agentSkills = skillsForAgent(agent?.slug ?? selected.key)
            return (
              <div className="p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="info">Bot</Badge>
                  {agent?.source && agent.source !== 'persona' && (
                    <Badge tone={agent.source === 'registry' ? 'verify' : 'info'}>{SOURCE_LABEL[agent.source]}</Badge>
                  )}
                  <Badge tone={agent?.kind === 'executive' ? 'accent' : 'neutral'}>
                    {agent?.kind === 'executive' ? 'Executive' : 'Routing only / helper'}
                  </Badge>
                  <Badge tone={agent?.assignable ? 'accent' : 'neutral'}>
                    {agent?.assignable ? 'Assignable' : 'Not assignable'}
                  </Badge>
                  <h3 className="font-display text-lg font-semibold text-fg-0">
                    {agent?.label || formatName(selected.key)}
                  </h3>
                </div>
                {agent?.description && <p className="text-xs leading-relaxed text-fg-2">{agent.description}</p>}
                {agent?.note && (
                  <p className="rounded-md border border-line bg-surface-1 p-2.5 text-xs leading-relaxed text-fg-2" data-testid="agent-note">
                    {agent.note}
                  </p>
                )}
                {agent?.open_href && (
                  <a
                    href={agent.open_href}
                    className="inline-flex items-center gap-1 text-xs text-accent underline-offset-2 hover:text-accent-hover hover:underline"
                  >
                    Open in Bots <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                {agent?.kind === 'routing-only' && (agent.source ?? 'persona') === 'persona' && (
                  <p className="text-xs text-fg-3">
                    Normally called by another bot as a helper.
                    You can still pick it as the main bot on a card.
                  </p>
                )}
                <div>
                  <div className="mb-1.5 text-xs font-medium uppercase tracking-eyebrow text-fg-3">
                    Skills used ({agentSkills.length})
                  </div>
                  {agentSkills.length === 0 ? (
                    <p className="text-xs text-fg-3">
                      This bot lists no skills in its file.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {agentSkills.map(s => (
                        <LinkChip key={s} label={formatName(s)} title={s} tone="accent" onClick={() => {
                          const match = skills.find(sk => sk.dirname === s || sk.name === s)
                          selectSkill(match ? match.dirname : s)
                          setViewMode('skills')
                        }} />
                      ))}
                    </div>
                  )}
                </div>
                <FileToggle showFile={showFile} setShowFile={setShowFile} content={fileContent} />
              </div>
            )
          })()
        ) : (
          (() => {
            const rs = regSkills[selected.key]
            const consumers = agentsForSkill(selected.key)
            return (
              <div className="p-4 space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="accent">Skill</Badge>
                  {rs?.parent && <Badge tone="neutral">Sub-skill of {formatName(rs.parent)}</Badge>}
                  {rs?.needs_improvement && <Badge tone="verify">Needs work</Badge>}
                  <h3 className="font-display text-lg font-semibold text-fg-0">{formatName(selected.key)}</h3>
                </div>
                {rs?.description && <p className="text-xs leading-relaxed text-fg-2">{rs.description}</p>}
                <div className="flex flex-wrap gap-4 text-xs text-fg-2">
                  <span><span className="text-fg-0">{rs?.usage_count ?? 0}</span> uses</span>
                  <span><span className={cn(rs?.failure_count ? 'text-flag-blocked' : 'text-fg-0')}>{rs?.failure_count ?? 0}</span> failures</span>
                </div>
                <div>
                  <div className="mb-1.5 text-xs font-medium uppercase tracking-eyebrow text-fg-3">
                    Bots using it ({consumers.length})
                  </div>
                  {consumers.length === 0 ? (
                    <p className="text-xs text-fg-3">
                      No bot lists this skill — it is picked by name or reached through a parent skill.
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {consumers.map(a => (
                        <LinkChip key={a} label={agentLabel(a)} title={a} tone="info" onClick={() => { selectAgentBySlug(a); setViewMode('agents') }} />
                      ))}
                    </div>
                  )}
                </div>
                {/* Tools the skill declares — the skill -> tool layer edge. This
                    replaces the old "Depends on"/"Depended on by" chips, which were
                    fed by an unvalidated skill->skill block the frontmatter layer
                    does not declare (obj 707012). */}
                <div>
                  <div className="mb-1.5 text-xs font-medium uppercase tracking-eyebrow text-fg-3">
                    Tools reached ({rs?.tools?.length ?? 0})
                  </div>
                  {!rs?.tools?.length ? (
                    <p className="text-xs text-fg-3">Uses no tools.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {rs.tools.map(t => (
                        <span key={t} title={t}><Badge tone="neutral">{formatName(t)}</Badge></span>
                      ))}
                    </div>
                  )}
                </div>
                {!!rs?.subskills?.length && (
                  <div>
                    <div className="mb-1.5 text-xs font-medium uppercase tracking-eyebrow text-fg-3">
                      Sub-skills ({rs.subskills.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {rs.subskills.map(s => (
                        <LinkChip key={s} label={formatName(s)} title={s} tone="accent" onClick={() => selectSkill(s)} />
                      ))}
                    </div>
                  </div>
                )}
                <FileToggle showFile={showFile} setShowFile={setShowFile} content={fileContent} />
              </div>
            )
          })()
        )}
      </Card>
    </div>
  )
}

// Collapsible raw-definition viewer — preserves the old read-only file reader
// under a toggle so the tab is interactive-first but still shows the source md.
function FileToggle({ showFile, setShowFile, content }: { showFile: boolean; setShowFile: (v: boolean) => void; content: string }) {
  return (
    <div className="border-t border-line pt-3">
      <Button size="sm" variant="ghost" onClick={() => setShowFile(!showFile)}>
        {showFile ? 'Hide definition' : 'View definition'}
      </Button>
      {showFile && (
        <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-surface-1 p-4 font-mono text-xs leading-relaxed text-fg-1">
          {content || 'Loading…'}
        </pre>
      )}
    </div>
  )
}
