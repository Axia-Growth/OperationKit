/**
 * Shared TypeScript contracts for Command Center.
 *
 * Split: core (objective/status/agent) in types-core.ts, platform surfaces in
 * types-surfaces.ts, runtime (WS/session/assistant) in types-runtime.ts.
 * Type-aware workflow helpers stay in workflow.ts. This file is the package
 * entry (`@operationkit/shared`) and re-exports everything.
 */

export * from './types-core.js'
export * from './types-surfaces.js'
export * from './types-runtime.js'
export * from './types-connectors.js'
export * from './types-mcp-servers.js'
export * from './types-integrations.js'
export * from './brand-color.js'
export * from './delegation.js'
export * from './full-access.js'
export * from './ownership.js'
export * from './board-triage.js'
export * from './tree-status.js'
export * from './spend-guard.js'
export * from './bot-work.js'
export * from './decision-briefing.js'
export * from './decision-queue.js'
export * from './decision-chat-action.js'
export * from './kb-flags.js'

// Type-aware transitions live in `./workflow.ts` to keep this file focused on
// the data shape. Re-exported here so `@operationkit/shared` callers can get
// them without a subpath import.
export {
  isTransitionAllowed,
  allowedTransitions,
  getInitialStatus,
  DEFAULT_EFFORT_BY_TYPE,
  TYPE_LABELS,
  STRATEGY_BADGE,
  ORIGIN_BADGES,
  IN_FLIGHT_STATUSES,
  isInFlightStatus,
} from './workflow.js'
