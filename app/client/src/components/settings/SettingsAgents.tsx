/**
 * Body of the Agents & skills and Assignments tabs on the Agents & Skills page
 * (/agents). Despite the file name it is no longer rendered under Settings
 * (obj 900684). obj 900807 removed its inner Roster / Assignments / Skill Graph
 * tab group: those are top-level tabs of the page now, so this renders ONE view.
 * obj 901765: the blurb no longer sells skills as a way to add capability.
 */
import { CopyButton } from '../ui'
import { AgentsSkillsTab } from '../config/AgentsSkillsTab'
import { AssignmentsTab } from '../config/AssignmentsTab'
import { SETUP_PROMPT } from '../agents/CreateAgentGuide'

// The setup prompt now lives with the Agents page's create guide (obj 900672).

export type RegistryView = 'roster' | 'assignments'

/** `showSetupPrompt` is off inside the Agents page, whose create guide already offers it (obj 900672). */
export function SettingsAgents({ showSetupPrompt = true, view = 'roster' }: { showSetupPrompt?: boolean; view?: RegistryView } = {}) {
  return (
    <div>
      {view === 'roster' && (
        <div className="mb-4 space-y-2">
          <p className="max-w-prose text-sm leading-relaxed text-fg-2">
            <span className="font-medium text-fg-1">Bots</span> are who does the work. They work out how to do a
            task from the card, your project’s docs and Context, so you do not need to write skill files.{' '}
            <span className="font-medium text-fg-1">Tools</span> are the integrations and MCP connections a bot
            can reach — manage those in{' '}
            <a
              href="/settings/integrations"
              className="text-accent underline-offset-2 hover:text-accent-hover hover:underline"
            >
              Settings → Integrations
            </a>
            . <span className="font-medium text-fg-1">Assignments</span> narrow a bot to one
            workspace, project, or user instead of it applying everywhere.
          </p>
          {showSetupPrompt && (
            <div className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface-1 p-3">
              <p className="max-w-prose text-xs leading-relaxed text-fg-3">
                Prefer to set this up by talking to an assistant instead of clicking through forms? Copy this prompt.
              </p>
              <CopyButton value={SETUP_PROMPT} label="Copy setup prompt" />
            </div>
          )}
        </div>
      )}
      {view === 'roster' ? <AgentsSkillsTab /> : <AssignmentsTab />}
    </div>
  )
}
