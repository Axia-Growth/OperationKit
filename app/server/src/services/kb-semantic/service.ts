/**
 * Knowledge-base semantic index — the server-wide wiring (obj 900816).
 *
 *   embeddingConfig()  Settings → Knowledge base search (settings table, see providers.ts)
 *   activeProvider()   the provider for that config (null = off / not configured)
 *   noteKbChanged(path)  THE write hook: every knowledge-base write, move and delete
 *                      path calls it. It runs both re-index hooks: semantic search
 *                      (noteKbWrite) and the link graph (noteKbFileWritten).
 *   noteKbWrite(path)  the semantic half only; call noteKbChanged instead
 *   startKbSemanticScheduler()  boot (host only): mark interrupted runs, backfill if
 *                      needed, then a reconcile pass every 15 min
 *
 * Everything here fails soft: a missing package, a missing model, a provider
 * without a key — semantic search reports `available: false` with the reason
 * and hybrid search degrades to keyword. No write path ever waits on, or fails
 * because of, embedding.
 */
import { getDb } from '../../db/index.js'
import { knowledgeBaseRoot } from '../../lib/knowledge-base-root.js'
import { getSecretValue } from '../secrets-store.js'
import {
  createProvider, localModelPresent, modelIdOf, resolveConfig, SETTING_KEYS,
  type EmbeddingConfig, type EmbeddingProvider, type ProviderDeps,
} from './providers.js'
import { loadVecExtension, ensureSchema, indexStats } from './store.js'
import { noteKbFileWritten } from '../kb-wiki/graph-sync.js'
import { latestJob, markInterruptedJobs, needsBackfill, runBackfill, runningJob, WriteQueue, type IndexerDeps } from './indexer.js'

const RECONCILE_MS = 15 * 60 * 1000

function readSetting(key: string): string | null {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  } catch { return null }
}

export function embeddingConfig(): EmbeddingConfig {
  return resolveConfig({
    provider: readSetting(SETTING_KEYS.provider),
    model: readSetting(SETTING_KEYS.model),
    baseUrl: readSetting(SETTING_KEYS.baseUrl),
    apiKeySecret: readSetting(SETTING_KEYS.apiKeySecret),
    dimensions: readSetting(SETTING_KEYS.dimensions),
  })
}

/**
 * Resolve an API key by secret NAME: the native store (global scope) first,
 * then the process env the store hydrated at boot. The value goes straight
 * into the provider's Authorization header and nowhere else.
 */
export function resolveKeyByName(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]{1,127}$/i.test(name)) return null
  try {
    const v = getSecretValue({ scopeType: 'global' }, name, null, 'server')
    if (v) return v
  } catch { /* store unavailable */ }
  return process.env[name] || null
}

let providerOverride: EmbeddingProvider | null | undefined
let cached: { id: string; provider: EmbeddingProvider | null } | null = null

/** Tests / evals: force a provider (null = off). `undefined` restores settings-driven behaviour. */
export function setProviderOverride(p: EmbeddingProvider | null | undefined): void {
  providerOverride = p
  cached = null
}

export function activeProvider(deps: ProviderDeps = {}): EmbeddingProvider | null {
  if (providerOverride !== undefined) return providerOverride
  const config = embeddingConfig()
  const id = modelIdOf(config)
  if (cached && cached.id === id) return cached.provider
  const provider = createProvider(config, { resolveKey: resolveKeyByName, ...deps })
  cached = { id, provider }
  return provider
}

export interface SemanticAvailability {
  available: boolean
  reason?: string
}

/** Can semantic search run right now? Cheap; does not load the model. */
export function semanticAvailability(): SemanticAvailability {
  const p = activeProvider()
  if (!p) return { available: false, reason: 'Semantic search is off (Settings → Knowledge base search).' }
  const vec = loadVecExtension(getDb())
  if (!vec.ok) return { available: false, reason: `sqlite-vec is not installed on this server (${vec.error ?? 'load failed'}). Rebuild the image.` }
  if (p.config.provider !== 'local' && p.config.apiKeySecret && !resolveKeyByName(p.config.apiKeySecret)) {
    return { available: false, reason: `No API key: add the secret ${p.config.apiKeySecret} in Settings → Secrets.` }
  }
  return { available: true }
}

function indexerDeps(): IndexerDeps | null {
  const provider = activeProvider()
  if (!provider) return null
  if (!loadVecExtension(getDb()).ok) return null
  return { db: getDb(), provider, root: knowledgeBaseRoot(), log: (m) => console.warn(m) }
}

const queue = new WriteQueue(indexerDeps)

/**
 * The semantic half of the write hook. Write paths call noteKbChanged, not
 * this. Fire-and-forget; never throws; a path outside the knowledge base or
 * a non-markdown file is ignored by the indexer.
 */
export function noteKbWrite(...paths: Array<string | null | undefined>): void {
  // Unit tests never load a model from a write path unless they opt in.
  if (providerOverride === undefined && process.env.VITEST) return
  try {
    for (const p of paths) if (typeof p === 'string' && p) queue.enqueue(p)
  } catch { /* never break a write */ }
}

/**
 * THE write hook (obj 900965). Call after any knowledge-base file is written,
 * moved or deleted, with every path that changed (a move passes the old and the
 * new path). It queues the file for the semantic index and, after the current
 * tick so the write never waits, reindexes it in its workspace's link graph.
 * Never throws; a path outside the knowledge base is ignored by both.
 *
 * kb-write-hook.guard.test.ts fails when a write path calls one half directly
 * or a listed module writes a file without calling this.
 */
export function noteKbChanged(...paths: Array<string | null | undefined>): void {
  const changed = paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
  if (!changed.length) return
  noteKbWrite(...changed)
  setImmediate(() => {
    for (const p of changed) {
      try { noteKbFileWritten(p) } catch { /* never break a write */ }
    }
  })
}

/** Tests: wait for queued writes to be embedded. */
export function kbWriteQueueIdle(): Promise<void> {
  return queue.idle()
}

let activeRun: Promise<unknown> | null = null

/** Start a backfill in the background. Returns false when one is already running or semantic is off. */
export function startBackfill(trigger = 'manual'): { started: boolean; reason?: string } {
  const deps = indexerDeps()
  if (!deps) return { started: false, reason: semanticAvailability().reason ?? 'semantic search unavailable' }
  if (runningJob(deps.db) || activeRun) return { started: false, reason: 'already running' }
  activeRun = runBackfill(deps, { trigger })
    .catch(err => console.warn('[kb-semantic] backfill failed:', (err as Error).message))
    .finally(() => { activeRun = null })
  return { started: true }
}

export function semanticStatus() {
  const config = embeddingConfig()
  const db = getDb()
  ensureSchema(db)
  const modelId = modelIdOf(config)
  return {
    config: {
      provider: config.provider,
      model: config.model,
      base_url: config.baseUrl,
      api_key_secret: config.apiKeySecret,
      // Whether the named secret resolves. Never the value.
      api_key_configured: config.provider === 'openai' || config.provider === 'voyage' ? !!resolveKeyByName(config.apiKeySecret) : null,
      dimensions: config.dimensions,
      model_id: modelId,
      local_model_present: config.provider === 'local' ? localModelPresent(config.model) : null,
    },
    availability: semanticAvailability(),
    index: indexStats(db, modelId),
    job: latestJob(db),
    queue: queue.size,
  }
}

let timer: NodeJS.Timeout | null = null

/** Boot hook (host instance only — never on a scratch server). Idempotent. */
export function startKbSemanticScheduler(): void {
  if (timer) return
  try {
    const db = getDb()
    ensureSchema(db)
    markInterruptedJobs(db)
  } catch { return }
  const tick = (trigger: string) => {
    try {
      const deps = indexerDeps()
      if (!deps) return
      if (trigger === 'boot' && !needsBackfill(deps.db, deps.provider.modelId)) trigger = 'reconcile'
      startBackfill(trigger)
    } catch (err) {
      console.warn('[kb-semantic] scheduler tick failed:', (err as Error).message)
    }
  }
  // Give the server a minute to settle before the first pass.
  setTimeout(() => tick('boot'), 60_000).unref()
  timer = setInterval(() => tick('reconcile'), RECONCILE_MS)
  timer.unref()
}
