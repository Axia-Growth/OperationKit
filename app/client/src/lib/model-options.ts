import type { ModelEngine, ModelRow } from '@operationkit/shared'

/* One model list, one format (obj 900863).

   Every model picker in the app (Settings → Models default/planner, the card
   create/edit modal, and each bot's "Default model" on the bot page) builds its
   options here from model-registry rows, so the choices and the way each one
   reads ("Claude Opus 5.5 (claude-opus-5-5)", grouped by provider) are the same
   everywhere. The rows themselves come from the server's model registry:
   GET /api/models (enabled rows), GET /api/models/all (admin, every row) and
   the bot list's `models` field (the same enabled rows). */

export const MODEL_ENGINE_GROUPS: { engine: ModelEngine; label: string }[] = [
  { engine: 'claude', label: 'Anthropic Models' },
  { engine: 'codex', label: 'OpenAI Models' },
  { engine: 'grok', label: 'xAI Models' },
]

/** The one way a model reads in every picker. */
export function modelOptionLabel(m: Pick<ModelRow, 'id' | 'label'>): string {
  return m.label && m.label !== m.id ? `${m.label} (${m.id})` : m.id
}

/** Registry rows grouped by provider, in the fixed provider order, empty groups dropped. */
export function modelOptionGroups(models: ModelRow[]): { engine: ModelEngine; label: string; rows: ModelRow[] }[] {
  return MODEL_ENGINE_GROUPS
    .map(g => ({ ...g, rows: models.filter(m => m.engine === g.engine) }))
    .filter(g => g.rows.length > 0)
}

/** Flat option list in display order (what a picker renders, minus any leading "default" entry). */
export function modelOptions(models: ModelRow[]): { value: string; label: string; engine: ModelEngine }[] {
  return modelOptionGroups(models).flatMap(g => g.rows.map(m => ({ value: m.id, label: modelOptionLabel(m), engine: m.engine })))
}

/** Bot chat providers (agent-chat ProviderId), kept structural so this file has no agent-chat import. */
type ChatProvider = 'claude' | 'anthropic' | 'openai' | 'xai' | 'openai-compatible' | 'demo'

const ENGINE_PROVIDERS: Record<ModelEngine, ChatProvider[]> = {
  claude: ['claude', 'anthropic'],
  codex: ['openai'],
  grok: ['xai'],
}

/**
 * A bot sees the whole registry, so an admin can pick a model its current
 * provider cannot run (an xAI model on Claude). Returns the provider the bot
 * should switch to for that model, or null when the current one already fits.
 * An OpenAI-compatible endpoint can serve any id, so it is never switched.
 */
export function providerForModel(engine: ModelEngine, current: ChatProvider): ChatProvider | null {
  if (current === 'openai-compatible') return null
  const fits = ENGINE_PROVIDERS[engine]
  return fits.includes(current) ? null : fits[0]
}
