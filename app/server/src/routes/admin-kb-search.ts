/**
 * Knowledge base search — admin surface (obj 900816). Mounted under /api/admin
 * (requireAuth + requireAdmin).
 *
 *   GET  /api/admin/kb-search            provider config, availability, index stats, latest job
 *   PUT  /api/admin/kb-search/settings   change provider / model / base URL / key secret NAME
 *   POST /api/admin/kb-search/backfill   start a (resumable) backfill now
 *   POST /api/admin/kb-search/cancel     stop the running backfill
 *
 * The API key is referenced by SECRET NAME only. No route here ever reads a
 * secret value into a response; `api_key_configured` is a boolean.
 */
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { type AuthRequest } from '../middleware/auth.js'
import { isProviderKind, modelIdOf, PROVIDER_DEFAULTS, SETTING_KEYS } from '../services/kb-semantic/providers.js'
import { embeddingConfig, semanticStatus, startBackfill } from '../services/kb-semantic/service.js'
import { cancelJob } from '../services/kb-semantic/indexer.js'

const router = Router()

const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,127}$/

router.get('/kb-search', (_req: AuthRequest, res) => {
  res.json({ ...semanticStatus(), providers: { local: PROVIDER_DEFAULTS.local, openai: PROVIDER_DEFAULTS.openai, voyage: PROVIDER_DEFAULTS.voyage, off: null } })
})

router.put('/kb-search/settings', (req: AuthRequest, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  if (!isProviderKind(b.provider)) {
    res.status(400).json({ error: 'provider must be local, openai, voyage or off' })
    return
  }
  const str = (k: string, max: number): string | null => {
    const v = b[k]
    if (v === undefined || v === null) return ''
    if (typeof v !== 'string' || v.length > max) return null
    return v.trim()
  }
  const model = str('model', 200)
  const baseUrl = str('base_url', 500)
  const keyName = str('api_key_secret', 128)
  const dimsRaw = b.dimensions
  const dims = dimsRaw === undefined || dimsRaw === null || dimsRaw === '' ? '' : String(dimsRaw)
  if (model === null || baseUrl === null || keyName === null) {
    res.status(400).json({ error: 'model, base_url and api_key_secret must be strings' })
    return
  }
  if (baseUrl && !/^https?:\/\/[^\s]+$/i.test(baseUrl)) {
    res.status(400).json({ error: 'base_url must be an http(s) URL' })
    return
  }
  if (keyName && !SECRET_NAME.test(keyName)) {
    // A NAME, never a value: a pasted key would fail this shape check.
    res.status(400).json({ error: 'api_key_secret must be the NAME of a secret (e.g. OPENAI_API_KEY), not its value' })
    return
  }
  if (dims && !(/^\d{1,5}$/.test(dims) && Number(dims) > 0 && Number(dims) <= 8192)) {
    res.status(400).json({ error: 'dimensions must be a positive integer ≤ 8192' })
    return
  }
  const before = modelIdOf(embeddingConfig())
  const db = getDb()
  const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  db.transaction(() => {
    put.run(SETTING_KEYS.provider, b.provider as string)
    put.run(SETTING_KEYS.model, model)
    put.run(SETTING_KEYS.baseUrl, baseUrl)
    put.run(SETTING_KEYS.apiKeySecret, keyName)
    put.run(SETTING_KEYS.dimensions, dims)
  })()
  const after = modelIdOf(embeddingConfig())
  // A new model means a new vector space: re-embed everything in the background.
  const reembed = before !== after && after !== 'off' ? startBackfill('model_changed') : null
  res.json({ ...semanticStatus(), reembed })
})

router.post('/kb-search/backfill', (_req: AuthRequest, res) => {
  const r = startBackfill('manual')
  res.status(r.started ? 202 : 409).json({ ...r, ...semanticStatus() })
})

router.post('/kb-search/cancel', (_req: AuthRequest, res) => {
  res.json({ cancelled: cancelJob(getDb()), ...semanticStatus() })
})

export default router
