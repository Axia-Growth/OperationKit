/**
 * Pre-fetch the default local embedding model (obj 900816).
 *
 * Run at IMAGE BUILD time (app/Dockerfile) so a fresh install can embed its
 * knowledge base fully offline: the model files land in CC_EMBED_MODEL_DIR
 * (default /app/models) and the server loads them from there with remote
 * downloads switched off.
 *
 *   CC_EMBED_MODEL_DIR=/app/models tsx server/src/scripts/fetch-embedding-model.ts [model]
 *
 * Exits non-zero if the model cannot be fetched AND embedded, so a broken
 * build fails loudly instead of shipping an image whose default search is dead.
 */
import { createLocalProvider, localModelDir, localModelPresent, PROVIDER_DEFAULTS } from '../services/kb-semantic/providers.js'

const model = process.argv[2] || PROVIDER_DEFAULTS.local.model
const dir = localModelDir()
const t0 = Date.now()
const provider = createLocalProvider({ provider: 'local', model, baseUrl: '', apiKeySecret: '', dimensions: PROVIDER_DEFAULTS.local.dimensions })
const [v] = await provider.embed(['knowledge base warm-up'], 'document')
if (!v || v.length === 0 || !localModelPresent(model)) {
  console.error(`[fetch-embedding-model] FAILED: ${model} not usable from ${dir}`)
  process.exit(1)
}
console.log(`[fetch-embedding-model] ${model} ready in ${dir} (${v.length} dims, ${Date.now() - t0} ms)`)
