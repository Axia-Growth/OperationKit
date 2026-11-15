/**
 * Pluggable embedding providers for knowledge-base semantic search (obj 900816).
 *
 *   local   (default) — a small sentence-embedding model run IN-PROCESS through
 *                       transformers.js / onnxruntime. The model files are baked
 *                       into the Docker image at build time (scripts/fetch-embedding-model.mjs),
 *                       so a fresh install embeds fully offline and never calls a paid API.
 *   openai            — any OpenAI-compatible `POST {base}/embeddings` endpoint
 *                       (OpenAI, Azure-compatible gateways, LiteLLM, Ollama's /v1, …).
 *   voyage            — Voyage AI `POST {base}/embeddings` (input_type query/document).
 *   off               — semantic search disabled; hybrid degrades to keyword.
 *
 * API keys are referenced by secret NAME (Settings → Secrets). The value is
 * resolved server-side at call time and never returned by any route. An API
 * provider with no key configured is treated as unavailable — no call is made.
 *
 * Config lives in the `settings` table (keys below). The provider + model +
 * dimension form the "model id" stamped on every stored chunk; when it changes,
 * every chunk is stale and the backfill job re-embeds the knowledge base.
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createHash } from 'node:crypto'

export type EmbeddingProviderKind = 'local' | 'openai' | 'voyage' | 'off'
export type EmbedPurpose = 'query' | 'document'

export interface EmbeddingConfig {
  provider: EmbeddingProviderKind
  /** Model name. Local: a Hugging Face repo id; API: the provider's model name. */
  model: string
  /** API base URL (openai/voyage only). */
  baseUrl: string
  /** NAME of the secret holding the API key (openai/voyage only). Never the value. */
  apiKeySecret: string
  /** Output dimension; 0 = "whatever the model returns" (learned on first call). */
  dimensions: number
}

export interface EmbeddingProvider {
  readonly config: EmbeddingConfig
  /** Stable identity of the vector space. Changing it invalidates every stored vector. */
  readonly modelId: string
  /** Embeds a batch. Returned vectors are L2-normalised. */
  embed(texts: string[], purpose: EmbedPurpose): Promise<Float32Array[]>
}

export const SETTING_KEYS = {
  provider: 'kb_embed_provider',
  model: 'kb_embed_model',
  baseUrl: 'kb_embed_base_url',
  apiKeySecret: 'kb_embed_api_key_secret',
  dimensions: 'kb_embed_dimensions',
} as const

export const PROVIDER_DEFAULTS: Record<Exclude<EmbeddingProviderKind, 'off'>, { model: string; baseUrl: string; apiKeySecret: string; dimensions: number }> = {
  local: { model: 'Xenova/all-MiniLM-L6-v2', baseUrl: '', apiKeySecret: '', dimensions: 384 },
  openai: { model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', apiKeySecret: 'OPENAI_API_KEY', dimensions: 1536 },
  voyage: { model: 'voyage-3.5-lite', baseUrl: 'https://api.voyageai.com/v1', apiKeySecret: 'VOYAGE_API_KEY', dimensions: 1024 },
}

const PROVIDERS: EmbeddingProviderKind[] = ['local', 'openai', 'voyage', 'off']

export function isProviderKind(v: unknown): v is EmbeddingProviderKind {
  return typeof v === 'string' && (PROVIDERS as string[]).includes(v)
}

/** Build a full config from raw settings values; unknown/blank values fall back to the provider's defaults. */
export function resolveConfig(raw: Partial<Record<keyof typeof SETTING_KEYS, string | null | undefined>>, env: NodeJS.ProcessEnv = process.env): EmbeddingConfig {
  const envProvider = (env.CC_KB_EMBED_PROVIDER || '').trim()
  const providerRaw = (raw.provider || '').trim() || envProvider || 'local'
  const provider: EmbeddingProviderKind = isProviderKind(providerRaw) ? providerRaw : 'local'
  if (provider === 'off') return { provider, model: '', baseUrl: '', apiKeySecret: '', dimensions: 0 }
  const d = PROVIDER_DEFAULTS[provider]
  const dims = parseInt(String(raw.dimensions ?? ''), 10)
  return {
    provider,
    model: (raw.model || '').trim() || d.model,
    baseUrl: ((raw.baseUrl || '').trim() || d.baseUrl).replace(/\/+$/, ''),
    apiKeySecret: (raw.apiKeySecret || '').trim() || d.apiKeySecret,
    dimensions: Number.isFinite(dims) && dims > 0 ? dims : d.dimensions,
  }
}

export function modelIdOf(c: EmbeddingConfig): string {
  if (c.provider === 'off') return 'off'
  const base = c.provider === 'local' ? '' : `@${c.baseUrl}`
  return `${c.provider}:${c.model}${base}:${c.dimensions}`
}

export function normalize(v: ArrayLike<number>): Float32Array {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n
  return out
}

// ── local (transformers.js) ─────────────────────────────────────────────────

/**
 * Where model files live. The Dockerfile pre-fetches the default model into
 * this directory, so a fresh install never needs the network. Override with
 * CC_EMBED_MODEL_DIR (e.g. a mounted volume).
 */
export function localModelDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CC_EMBED_MODEL_DIR) return env.CC_EMBED_MODEL_DIR
  // The image bakes the model into /app/models. A dev checkout without it
  // downloads once into the user cache instead.
  if (fs.existsSync('/app/models')) return '/app/models'
  return path.join(os.homedir(), '.cache', 'command-center', 'models')
}

/** True when the model's files are already on disk (offline-capable). */
export function localModelPresent(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = path.join(localModelDir(env), ...model.split('/'))
  return fs.existsSync(path.join(dir, 'config.json')) && fs.existsSync(path.join(dir, 'onnx'))
}

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
const extractorCache = new Map<string, Promise<Extractor>>()

async function loadExtractor(model: string, env: NodeJS.ProcessEnv): Promise<Extractor> {
  let p = extractorCache.get(model)
  if (!p) {
    p = (async () => {
      // Dynamic import: the package is optional at runtime. A server that was
      // deployed without an image rebuild simply has no local provider.
      const mod = await import('@huggingface/transformers') as unknown as {
        pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<Extractor>
        env: { cacheDir: string; localModelPath: string; allowRemoteModels: boolean; allowLocalModels: boolean }
      }
      const dir = localModelDir(env)
      mod.env.localModelPath = dir
      mod.env.cacheDir = dir
      mod.env.allowLocalModels = true
      // Offline by default when the files are baked in. Downloading is allowed
      // only when they are missing (dev checkout) and not explicitly forbidden.
      mod.env.allowRemoteModels = !localModelPresent(model, env) && env.CC_EMBED_ALLOW_DOWNLOAD !== '0'
      // Cap inference threads: this runs inside the board server, next to live
      // sessions. CC_EMBED_THREADS raises it on a big box.
      const threads = Math.max(1, Math.min(32, parseInt(env.CC_EMBED_THREADS || '2', 10) || 2))
      return mod.pipeline('feature-extraction', model, { dtype: 'q8', session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } })
    })()
    extractorCache.set(model, p)
    p.catch(() => extractorCache.delete(model))
  }
  return p
}

export function createLocalProvider(config: EmbeddingConfig, env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  return {
    config,
    modelId: modelIdOf(config),
    async embed(texts) {
      if (texts.length === 0) return []
      const fe = await loadExtractor(config.model, env)
      const out = await fe(texts, { pooling: 'mean', normalize: true })
      return out.tolist().map(v => normalize(v))
    },
  }
}

// ── API providers ───────────────────────────────────────────────────────────

export type KeyResolver = (secretName: string) => string | null
export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

export class EmbeddingUnavailableError extends Error {}

function apiProvider(config: EmbeddingConfig, resolveKey: KeyResolver, fetchFn: FetchFn): EmbeddingProvider {
  return {
    config,
    modelId: modelIdOf(config),
    async embed(texts, purpose) {
      if (texts.length === 0) return []
      const key = config.apiKeySecret ? resolveKey(config.apiKeySecret) : null
      if (!key) throw new EmbeddingUnavailableError(`No API key: secret ${config.apiKeySecret || '(none set)'} is not configured`)
      const body: Record<string, unknown> = { model: config.model, input: texts }
      if (config.provider === 'voyage') {
        body.input_type = purpose
        if (config.dimensions) body.output_dimension = config.dimensions
      } else if (config.dimensions && /text-embedding-3/.test(config.model)) {
        body.dimensions = config.dimensions
      }
      const res = await fetchFn(`${config.baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) {
        // Never echo the request (it carries the key header); status + a short body is enough.
        const t = (await res.text().catch(() => '')).slice(0, 200)
        throw new Error(`${config.provider} embeddings HTTP ${res.status}: ${t}`)
      }
      const j = await res.json() as { data?: Array<{ embedding: number[]; index?: number }> }
      const data = [...(j.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      if (data.length !== texts.length) throw new Error(`${config.provider} returned ${data.length} vectors for ${texts.length} inputs`)
      return data.map(d => normalize(d.embedding))
    },
  }
}

export interface ProviderDeps {
  resolveKey?: KeyResolver
  fetchFn?: FetchFn
  env?: NodeJS.ProcessEnv
}

export function createProvider(config: EmbeddingConfig, deps: ProviderDeps = {}): EmbeddingProvider | null {
  const env = deps.env ?? process.env
  switch (config.provider) {
    case 'off': return null
    case 'local': return createLocalProvider(config, env)
    case 'openai':
    case 'voyage':
      return apiProvider(config, deps.resolveKey ?? (name => env[name] || null), deps.fetchFn ?? (globalThis.fetch as unknown as FetchFn))
  }
}

/**
 * Deterministic, dependency-free embedder for TESTS ONLY (hashing trick over
 * word + char-trigram features). It is not offered in Settings.
 */
export function createHashProvider(dimensions = 64): EmbeddingProvider {
  const config: EmbeddingConfig = { provider: 'local', model: 'test-hash', baseUrl: '', apiKeySecret: '', dimensions }
  return {
    config,
    modelId: `test:hash:${dimensions}`,
    async embed(texts) {
      return texts.map(t => {
        const v = new Float32Array(dimensions)
        const words = t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
        const feats = [...words, ...words.flatMap(w => w.length > 3 ? [w.slice(0, 4)] : [])]
        for (const f of feats) {
          const h = createHash('md5').update(f).digest()
          v[h.readUInt32LE(0) % dimensions] += (h[4] & 1) ? 1 : -1
        }
        return normalize(v)
      })
    },
  }
}
