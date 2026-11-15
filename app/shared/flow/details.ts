// Workflow Notes + Tools (obj 900868). Pure, dependency-free; shared by the
// server routes (validation) and the Jobs → Workflows UI (the editor).
//
// Notes and Tools describe a workflow to the people and agents working on it.
// They are NOT part of the versioned okflow/1 definition: editing them never
// creates a version, never needs a self-test and never needs a re-publish. They
// live on `flow_definitions.notes` / `flow_definitions.tools_json`.

export const FLOW_NOTES_MAX_CHARS = 4000
export const FLOW_TOOLS_MAX = 25
export const FLOW_TOOL_MAX_CHARS = 80

/**
 * Normalise a tools list: trim, drop empties, collapse inner whitespace, and drop
 * case-insensitive duplicates (first spelling wins). Order is kept.
 */
export function normalizeFlowTools(list: readonly string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of list) {
    const t = raw.replace(/\s+/g, ' ').trim()
    if (!t) continue
    const k = t.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(t)
  }
  return out
}

/** Split typed text into tool names: one per line or comma. */
export function splitFlowTools(text: string): string[] {
  return normalizeFlowTools(text.split(/[\n,]/))
}

export type FlowDetailsPatch = { notes?: string | null; tools?: string[] }

/**
 * Validate the `notes` / `tools` fields of a request body. Absent fields stay
 * absent (leave the stored value alone); `notes: ''` or `null` clears it;
 * `tools: []` clears the list.
 */
export function parseFlowDetails(body: { notes?: unknown; tools?: unknown }):
  | { ok: true; value: FlowDetailsPatch }
  | { ok: false; error: string } {
  const value: FlowDetailsPatch = {}
  if (body.notes !== undefined) {
    if (body.notes !== null && typeof body.notes !== 'string') return { ok: false, error: 'notes must be a string' }
    const n = typeof body.notes === 'string' ? body.notes.trim() : ''
    if (n.length > FLOW_NOTES_MAX_CHARS) return { ok: false, error: `notes is longer than ${FLOW_NOTES_MAX_CHARS} characters` }
    value.notes = n || null
  }
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.some((t) => typeof t !== 'string')) {
      return { ok: false, error: 'tools must be a list of tool or integration names (strings)' }
    }
    const tools = normalizeFlowTools(body.tools as string[])
    if (tools.length > FLOW_TOOLS_MAX) return { ok: false, error: `at most ${FLOW_TOOLS_MAX} tools` }
    const long = tools.find((t) => t.length > FLOW_TOOL_MAX_CHARS)
    if (long) return { ok: false, error: `a tool name is longer than ${FLOW_TOOL_MAX_CHARS} characters` }
    value.tools = tools
  }
  return { ok: true, value }
}

/** Read `flow_definitions.tools_json` defensively: anything malformed reads as no tools. */
export function readFlowTools(json: string | null | undefined): string[] {
  if (!json) return []
  try {
    const v = JSON.parse(json) as unknown
    return Array.isArray(v) ? normalizeFlowTools(v.filter((t): t is string => typeof t === 'string')) : []
  } catch {
    return []
  }
}
