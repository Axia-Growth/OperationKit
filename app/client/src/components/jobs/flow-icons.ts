import { Bot, Brain, CircleCheck, CircleStop, Clock, GitBranch, Hourglass, Plug, Repeat, Wrench, type LucideIcon } from 'lucide-react'

/**
 * One lucide icon per workflow node kind (polish F9, #900810). Shared by the
 * canvas nodes and both legends so a kind looks the same everywhere. These
 * replaced emoji prefixes (⏰ 🔧 🔌 🧠 🤖 …) that were baked into node titles.
 */
export const FLOW_KIND_ICON: Record<string, LucideIcon> = {
  trigger: Clock,
  tool: Wrench,
  mcp: Plug,
  llm: Brain,
  agent: Bot,
  branch: GitBranch,
  loop: Repeat,
  wait: Hourglass,
  check: CircleCheck,
  end: CircleStop,
}
