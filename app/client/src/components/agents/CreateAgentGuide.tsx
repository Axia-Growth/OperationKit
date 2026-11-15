import { useEffect, useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../../lib/api'
import { CopyButton, cn } from '../ui'
import { agentsTabRoute } from '../../lib/routes'

/**
 * "Make a new bot or skill" (obj 900672; nouns per docs/glossary.md since F7). Before this, the Agents page
 * had no create path at all — only a copy-paste prompt — and three different
 * things were all called "agent". This panel names the three nouns in one line
 * each and gives three ways in, easiest first:
 *
 *   1. Ask the Dev bot (the built-in `operation-kit-dev` chat bot) — a deep link that
 *      opens its conversation with the request already typed, never sent.
 *   2. Start from a template (the Templates tab).
 *   3. Paste or import a file (the Templates tab, paste box open).
 *
 * The Dev bot is a built-in an install can switch off (AGENT_CHAT_BUILTINS=0),
 * so path 1 is existence-gated on the live bot list. Without it, the panel
 * offers the copy-paste prompt for an outside assistant instead.
 */

export const DEV_BOT_SLUG = 'operation-kit-dev'

export const CREATE_PROMPTS = {
  bot: 'Help me create a new bot I can chat with and assign cards to. Ask me what it is for, then write its file for me and tell me how to add it.',
  skill: 'Help me create a new skill for a task we repeat. Ask me what the task is, then write the SKILL.md and tell me how to add it.',
} as const

export const SETUP_PROMPT =
  `Configure a new bot, skill, and (if it needs non-default scoping) an assignment on this platform, for me:\n\n` +
  `- Bot: an AI teammate people chat with and assign cards to — a named profile with a model, effort level, and default workspace.\n` +
  `- Skill: how-to steps a bot follows for a kind of task.\n` +
  `- Tool: an integration a bot can reach (see Settings → Integrations) — connect it there, then reference ` +
  `it from the skill or bot.\n` +
  `- Assignment (only if needed): scopes a bot or skill to one workspace, project, or user instead of ` +
  `applying globally.\n\n` +
  `Ask me what the bot or skill is for, then use the platform API (docs/api/README.md, GET /api/openapi.json) ` +
  `to set it up rather than describing steps for me to click through.`

export function devBotLink(kind: keyof typeof CREATE_PROMPTS): string {
  return `/chat/${DEV_BOT_SLUG}?prompt=${encodeURIComponent(CREATE_PROMPTS[kind])}`
}

const NOUNS: Array<{ term: string; text: string }> = [
  { term: 'Bot', text: 'an AI teammate you chat with and assign cards to.' },
  { term: 'Skill', text: 'how-to steps a bot follows for one recurring task.' },
  { term: 'Tool', text: 'a connection to another app or service that a skill lets a bot use.' },
  { term: 'Outside agent', text: 'a third-party AI program that uses this board through an agent key.' },
]

const tile = 'flex flex-col gap-2 rounded-lg border border-line bg-surface-1 p-4'
const linkBtn = cn(
  'inline-flex min-h-[40px] items-center rounded-md border border-line bg-surface-0 px-3 text-sm font-medium text-fg-1',
  'transition-colors duration-fast hover:border-line-strong hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
)

/** Remembers a collapsed guide (obj 900807): it sat full-size above every tab on every visit. */
export const GUIDE_COLLAPSED_KEY = 'ok-agents-create-guide-collapsed'

function readCollapsed(): boolean {
  try { return localStorage.getItem(GUIDE_COLLAPSED_KEY) === '1' } catch { return false }
}

export function CreateAgentGuide() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const bodyId = useId()
  const toggle = () => {
    setCollapsed(c => {
      const next = !c
      try { if (next) localStorage.setItem(GUIDE_COLLAPSED_KEY, '1'); else localStorage.removeItem(GUIDE_COLLAPSED_KEY) } catch { /* private mode */ }
      return next
    })
  }
  // null = still checking; the Dev bot tile waits rather than flashing the fallback.
  const [hasDevBot, setHasDevBot] = useState<boolean | null>(null)
  // Its name comes from the live bot list, never a literal: an install can
  // rename it (a same-slug agent file), and the client stays white-label.
  const [devBotName, setDevBotName] = useState('the Dev bot')

  useEffect(() => {
    let live = true
    api
      .get<{ agents?: Array<{ slug: string; name?: string }> }>('/agent-chat/agents')
      .then(r => {
        if (!live) return
        const dev = r?.agents?.find(a => a.slug === DEV_BOT_SLUG)
        setHasDevBot(!!dev)
        if (dev?.name) setDevBotName(dev.name)
      })
      .catch(() => { if (live) setHasDevBot(false) })
    return () => { live = false }
  }, [])

  return (
    <section aria-labelledby="create-agent-guide" className={cn('mb-6 rounded-xl border border-line bg-surface-0', collapsed ? 'px-4 py-2.5 sm:px-5' : 'p-4 sm:p-5')}>
      <div className="flex items-center justify-between gap-3">
        <h2 id="create-agent-guide" className="font-display text-lg font-semibold text-fg-0">Make a new bot or skill</h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          data-testid="create-guide-toggle"
          className="inline-flex min-h-[32px] shrink-0 items-center gap-1 rounded-md px-2 text-sm font-medium text-fg-2 transition-colors duration-fast hover:bg-surface-3 hover:text-fg-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {collapsed ? 'Show' : 'Hide'}
          <ChevronDown className={cn('h-4 w-4 transition-transform duration-fast', !collapsed && 'rotate-180')} aria-hidden="true" />
        </button>
      </div>
      {!collapsed && <div id={bodyId}>
      <ul className="mt-2 space-y-0.5 text-sm leading-relaxed text-fg-2">
        {NOUNS.map(n => (
          <li key={n.term}><span className="font-medium text-fg-0">{n.term}</span> — {n.text}</li>
        ))}
      </ul>

      <ol className="mt-4 grid gap-3 md:grid-cols-3">
        <li className={tile}>
          <p className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">1 · Easiest</p>
          {hasDevBot === false ? (
            <>
              <h3 className="text-base font-semibold text-fg-0">Ask an assistant</h3>
              <p className="text-sm leading-relaxed text-fg-2">
                Copy this prompt into your coding assistant. It asks what you need and sets it up through the platform API.
              </p>
              <div><CopyButton value={SETUP_PROMPT} label="Copy setup prompt" /></div>
            </>
          ) : (
            <>
              <h3 className="text-base font-semibold text-fg-0">Ask {devBotName}</h3>
              <p className="text-sm leading-relaxed text-fg-2">
                It asks a few questions, writes the file for you, and tells you exactly where it goes.
              </p>
              <div className="flex flex-wrap gap-2" aria-busy={hasDevBot === null}>
                <Link to={devBotLink('bot')} className={linkBtn}>Create a bot</Link>
                <Link to={devBotLink('skill')} className={linkBtn}>Create a skill</Link>
              </div>
            </>
          )}
        </li>
        <li className={tile}>
          <p className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">2 · Start from a template</p>
          <h3 className="text-base font-semibold text-fg-0">Add a starter bot</h3>
          <p className="text-sm leading-relaxed text-fg-2">Pick a ready-made bot, add it, then change its instructions to fit.</p>
          <div><Link to={agentsTabRoute('templates')} className={linkBtn}>Browse templates</Link></div>
        </li>
        <li className={tile}>
          <p className="text-xs font-semibold uppercase tracking-eyebrow text-fg-3">3 · Already have the file</p>
          <h3 className="text-base font-semibold text-fg-0">Paste or import it</h3>
          <p className="text-sm leading-relaxed text-fg-2">Paste a bot file {devBotName} wrote, or upload one someone sent you. It is checked before it is added.</p>
          <div><Link to={`${agentsTabRoute('templates')}&paste=1`} className={linkBtn}>Paste a bot file</Link></div>
        </li>
      </ol>
      {hasDevBot && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-fg-3">
          <span>Using an outside assistant instead? Copy the setup prompt.</span>
          <CopyButton value={SETUP_PROMPT} label="Copy setup prompt" />
        </div>
      )}
      </div>}
    </section>
  )
}
