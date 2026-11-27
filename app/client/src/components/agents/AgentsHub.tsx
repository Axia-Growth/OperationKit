/**
 * The one Agents page (obj 900495). There used to be three surfaces:
 *
 *   /settings/agents   — registry admin: roster, assignments, skill graph
 *   /agents            — board-layer view (which markdown a project runs on)
 *   /agent-templates   — template gallery, import / export
 *
 * They are now tabs of /agents (`?tab=registry|board|templates`); the two old
 * URLs redirect here (App.tsx). The tab bodies are the same components, so no
 * behaviour moved — only where you find them.
 *
 * obj 900684 finished the job: Settings still carried its own "Agents & Skills"
 * tab rendering the same registry, so there were two places to manage agents.
 * That tab is gone (/settings/agents-skills redirects here) and this page is
 * titled "Agents & Skills" in the nav and header — the one place.
 *
 * obj 900807 flattened it: there were three nested tab groups in three styles
 * (Registry | Board layer | Templates → Roster | Assignments | Skill Graph →
 * an Agents / Skills underline pair). Now there is ONE tab row; the roster's
 * Agents / Skills choice is a filter (SegmentedControl), and the create guide
 * can be collapsed.
 *
 * obj 901765 demoted skills to a harness internal: the page is "Bot setup", the
 * roster tab is "Bots", and the skill graph is the LAST tab, labelled advanced.
 * A new install gets work done with no SKILL.md at all — sessions take their
 * procedure from the card, the repo's own docs and Context. Skill files stay as
 * an escape hatch, so `?tab=graph` still opens the same graph.
 */
import type { Workspace } from '@operationkit/shared'
import { SkillGraphTab } from '../SkillGraph'
import { useSearchParams } from 'react-router-dom'
import { Card, PageContainer, PageHeader, Tabs, type TabItem } from '../ui'
import { AgentsPage } from '../AgentsPage'
import { AgentTemplatesPage } from '../AgentTemplatesPage'
import { SettingsAgents } from '../settings/SettingsAgents'
import { AGENTS_TABS, type AgentsTab } from '../../lib/routes'
import { CreateAgentGuide } from './CreateAgentGuide'

/** Order is the order of importance: skill files are the advanced, last tab (obj 901765). */
export const TABS: TabItem[] = [
  { key: 'registry', label: 'Bots' },
  { key: 'templates', label: 'Templates' },
  { key: 'board', label: 'By project' },
  { key: 'assignments', label: 'Assignments' },
  { key: 'graph', label: 'Skills (advanced)' },
]

const COPY: Record<AgentsTab, string> = {
  registry: 'Every bot on this install — including built-in and starter-pack bots — and who can use them.',
  assignments: 'Narrow a bot to one workspace, project or user instead of it applying everywhere.',
  graph: 'Advanced. Skill files are optional: bots work out how to do a task from the card, your project’s docs and Context. Add a skill file only for a rare procedure that must be followed exactly.',
  board: 'Which bot and tool files a project’s cards actually run on.',
  templates: 'Add a starter bot, or import and export bot files.',
}

/** Resolve the active tab. Old `/agents?project=…` links meant the board-layer view. */
export function resolveAgentsTab(params: URLSearchParams): AgentsTab {
  const t = params.get('tab')
  if (t && (AGENTS_TABS as readonly string[]).includes(t)) return t as AgentsTab
  return params.has('project') ? 'board' : 'registry'
}

export function AgentsHub({ workspace }: { workspace: Workspace }) {
  const [params, setParams] = useSearchParams()
  const tab = resolveAgentsTab(params)

  const select = (next: string) => {
    // Each tab owns its own query params; switching starts that tab clean.
    setParams(next === 'registry' ? {} : { tab: next }, { replace: true })
  }

  return (
    <PageContainer width="wide">
      <PageHeader title="Bot setup" description={COPY[tab]} />
      {/* One clear way in to creating something, on every tab (obj 900672). */}
      <CreateAgentGuide />
      <Tabs items={TABS} value={tab} onChange={select} label="Bot setup sections" panelClassName="mt-5">
        {tab === 'registry' && <SettingsAgents showSetupPrompt={false} view="roster" />}
        {tab === 'assignments' && <SettingsAgents showSetupPrompt={false} view="assignments" />}
        {tab === 'graph' && (
          <Card inset className="h-[70vh] overflow-hidden">
            <SkillGraphTab />
          </Card>
        )}
        {tab === 'board' && <AgentsPage workspace={workspace} embedded />}
        {tab === 'templates' && <AgentTemplatesPage embedded />}
      </Tabs>
    </PageContainer>
  )
}
