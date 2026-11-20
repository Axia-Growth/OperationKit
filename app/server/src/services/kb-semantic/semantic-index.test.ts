/**
 * obj 900816 — indexer + store + hybrid search, end to end on a temp knowledge
 * base and an in-memory DB. Embeddings come from a tiny deterministic "concept"
 * provider so the test can construct a true paraphrase (a query that shares no
 * word with the note it should find) without loading a model.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { normalize, type EmbeddingProvider } from './providers.js'
import { indexFile, isEmbeddable, markInterruptedJobs, needsBackfill, runBackfill, walkKnowledgeBase, WriteQueue, workspaceLabel } from './indexer.js'
import { ensureSchema, ensureVecTable, indexStats, knnChunks, loadVecExtension, replaceDocChunks } from './store.js'
import { searchKnowledgeBase, relatedDocs, parseSearchMode } from './search.js'
import { resetVaultIndexCache } from '../vault-index.js'

/** Each concept is one dimension; any of its words in the text lights it up. */
const CONCEPTS: string[][] = [
  ['car', 'automobile', 'vehicle', 'sedan'],
  ['outage', 'downtime', 'offline', 'unreachable'],
  ['invoice', 'billing', 'payment', 'charge'],
  ['garden', 'tomato', 'plant', 'soil'],
  ['deploy', 'release', 'rollout', 'ship'],
]

function conceptProvider(id = 'test:concept:6', extraDim = 1): EmbeddingProvider {
  const dims = CONCEPTS.length + extraDim
  return {
    config: { provider: 'local', model: 'concept', baseUrl: '', apiKeySecret: '', dimensions: dims },
    modelId: id,
    async embed(texts) {
      return texts.map(t => {
        const words = t.toLowerCase().split(/[^a-z0-9]+/)
        const v = new Array(dims).fill(0)
        CONCEPTS.forEach((c, i) => { for (const w of words) if (c.includes(w)) v[i] += 1 })
        v[dims - 1] = 0.05 // never a zero vector
        return normalize(v)
      })
    },
  }
}

let root: string
let db: Database.Database
const write = (rel: string, text: string) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, text)
  return abs
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-sem-')))
  process.env.SECOND_BRAIN_ROOT = root
  resetVaultIndexCache()
  db = new Database(':memory:')
  db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)')
  ensureSchema(db)
})

afterEach(() => {
  db.close()
  resetVaultIndexCache()
  delete process.env.SECOND_BRAIN_ROOT
  fs.rmSync(root, { recursive: true, force: true })
})

describe('sqlite-vec', () => {
  it('loads into better-sqlite3', () => {
    expect(loadVecExtension(db)).toEqual({ ok: true })
  })
})

describe('eligibility', () => {
  it('never embeds env / credential / key files or excluded folders', () => {
    const yes = ['notes/a.md', 'workspaces/acme/decisions/secrets-store-design.md', 'workspaces/acme/token-waste.md']
    const no = ['.env.md', 'notes/prod.env.md', 'notes/credentials.md', 'notes/secrets.md', 'notes/api-keys.md', 'notes/passwords.md',
      '.obsidian/x.md', '_system/x.md', 'notes/index.md', 'notes/a.txt', 'secrets/x.md', '.ssh/notes.md', '../outside.md']
    for (const r of yes) expect(isEmbeddable(root, path.join(root, r)), r).toBe(true)
    for (const r of no) expect(isEmbeddable(root, path.join(root, r)), r).toBe(false)
  })

  it('labels the workspace from either knowledge-base layout', () => {
    expect(workspaceLabel(root, path.join(root, 'workspaces/acme/a.md'))).toBe('acme')
    expect(workspaceLabel(root, path.join(root, 'acme/a.md'))).toBe('acme')
    expect(workspaceLabel(root, path.join(root, 'a.md'))).toBe('')
  })
})

describe('backfill + incremental', () => {
  it('embeds every eligible note, is resumable, and re-embeds only what changed', async () => {
    const provider = conceptProvider()
    write('notes/car.md', '# Fleet\nOur car fleet gets serviced every spring.')
    write('notes/garden.md', '# Allotment\nTomato plants need rich soil.')
    write('notes/credentials.md', '# Creds\nnothing to see')
    const deps = { db, provider, root }

    expect(needsBackfill(db, provider.modelId)).toBe(true)
    const job = await runBackfill(deps)
    expect(job).toMatchObject({ status: 'done', kind: 'backfill', total: 2, embedded: 2, failed: 0 })
    expect(indexStats(db, provider.modelId)).toMatchObject({ docs: 2, docsCurrentModel: 2, dim: 6 })
    expect(needsBackfill(db, provider.modelId)).toBe(false)

    // Resume / re-run: nothing changed → nothing embedded.
    const again = await runBackfill(deps)
    expect(again).toMatchObject({ embedded: 0, skipped: 2 })

    // Touch without content change → skipped (hash match). Real change → embedded.
    const garden = path.join(root, 'notes/garden.md')
    fs.utimesSync(garden, new Date(), new Date(Date.now() + 5000))
    expect((await indexFile(deps, garden)).outcome).toBe('skipped')
    write('notes/garden.md', '# Allotment\nTomato plants need rich soil and a vehicle to haul it.')
    expect((await indexFile(deps, garden)).outcome).toBe('embedded')

    // Deleted file → pruned by the next pass.
    fs.rmSync(path.join(root, 'notes/car.md'))
    const pruned = await runBackfill(deps)
    expect(pruned.removed).toBe(1)
    expect(indexStats(db, provider.modelId).docs).toBe(1)
  })

  it('a model change re-embeds everything (and a new dimension rebuilds the vector table)', async () => {
    write('a.md', '# A\ncar')
    write('b.md', '# B\ninvoice')
    await runBackfill({ db, provider: conceptProvider('test:concept:6'), root })
    const next = conceptProvider('test:concept:8', 3)
    expect(needsBackfill(db, next.modelId)).toBe(true)
    const job = await runBackfill({ db, provider: next, root })
    expect(job).toMatchObject({ status: 'done', embedded: 2 })
    expect(indexStats(db, next.modelId)).toMatchObject({ docs: 2, docsCurrentModel: 2, dim: 8 })
  })

  it('marks a run left running by a restart as interrupted, and the next run resumes', async () => {
    write('a.md', '# A\ncar')
    db.prepare("INSERT INTO kb_embed_jobs (status, model_id, total) VALUES ('running', 'x', 1)").run()
    expect(markInterruptedJobs(db)).toBe(1)
    expect(needsBackfill(db, 'test:concept:6')).toBe(true)
    const job = await runBackfill({ db, provider: conceptProvider(), root })
    expect(job.status).toBe('done')
  })

  it('refuses a second concurrent run and stops a provider that fails every file', async () => {
    for (let i = 0; i < 25; i++) write(`n${i}.md`, `# N${i}\ncar`)
    const broken: EmbeddingProvider = { ...conceptProvider(), async embed() { throw new Error('no key') } }
    const job = await runBackfill({ db, provider: broken, root })
    expect(job.status).toBe('failed')
    expect(job.error).toContain('no key')
    expect(job.processed).toBeLessThan(25)
  })

  it('redacts credential-shaped values before storing or embedding chunk text', async () => {
    const fakeKey = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-')
    const seen: string[] = []
    const provider: EmbeddingProvider = { ...conceptProvider(), async embed(texts, purpose) { seen.push(...texts); return conceptProvider().embed(texts, purpose) } }
    write('notes/setup.md', `# Setup\nThe key we used was ${fakeKey} for the car integration.`)
    await runBackfill({ db, provider, root })
    const stored = (db.prepare('SELECT text FROM kb_embed_chunks').all() as { text: string }[]).map(r => r.text).join('\n')
    expect(stored).not.toContain(fakeKey)
    expect(stored).toContain('[REDACTED')
    expect(seen.join('\n')).not.toContain(fakeKey)
  })

  it('the write queue embeds a note shortly after it is written', async () => {
    const provider = conceptProvider()
    const q = new WriteQueue(() => ({ db, provider, root }))
    const abs = write('notes/new.md', '# New\nA release went out today.')
    q.enqueue(abs)
    q.enqueue(abs) // coalesced
    await q.idle()
    expect(indexStats(db, provider.modelId).docs).toBe(1)
    fs.rmSync(abs)
    q.enqueue(abs)
    await q.idle()
    expect(indexStats(db, provider.modelId).docs).toBe(0)
  })

  it('walks the knowledge base with the same exclusions', () => {
    write('a.md', 'x')
    write('.obsidian/b.md', 'x')
    write('sub/index.md', 'x')
    write('sub/c.md', 'x')
    expect(walkKnowledgeBase(root).map(f => path.relative(root, f))).toEqual(['a.md', path.join('sub', 'c.md')])
  })
})

describe('hybrid search', () => {
  async function seed() {
    const provider = conceptProvider()
    write('workspaces/acme/decisions/2026-01-01-fleet.md', '# Fleet policy\nEvery car in the fleet is leased for three years.')
    write('workspaces/acme/decisions/2026-01-02-obj123456-billing.md', '# Billing fix\nThe invoice job charged twice; fixed the payment retry.')
    write('workspaces/acme/notes/garden.md', '# Garden\nTomato plants and soil notes.')
    write('workspaces/acme/notes/release.md', '# Release train\nWe ship every Tuesday.')
    write('workspaces/other/notes/car-secret-plans.md', '# Other workspace car notes\nautomobile automobile automobile car.')
    await runBackfill({ db, provider, root })
    return provider
  }

  it('finds a paraphrase that keyword search cannot (no shared words)', async () => {
    const provider = await seed()
    const kw = await searchKnowledgeBase('automobile rental', { mode: 'keyword', db, provider, root, workspace: 'acme' })
    expect(kw.results.map(r => path.basename(r.path))).not.toContain('2026-01-01-fleet.md')
    const hy = await searchKnowledgeBase('automobile rental', { mode: 'hybrid', db, provider, root, workspace: 'acme' })
    expect(hy.mode_used).toBe('hybrid')
    const top = hy.results[0]
    expect(path.basename(top.path)).toBe('2026-01-01-fleet.md')
    expect(top.match === 'semantic' || top.match === 'both').toBe(true)
    expect(top.heading).toBe('Fleet policy')
    expect(top.similarity).toBeGreaterThan(0.5)
    expect(typeof top.score).toBe('number')
    expect(top.snippet).toContain('fleet')
  })

  it('puts an exact ID match first even when it is semantically unrelated', async () => {
    const provider = await seed()
    const r = await searchKnowledgeBase('obj123456 car fleet automobile', { mode: 'hybrid', db, provider, root, workspace: 'acme' })
    expect(path.basename(r.results[0].path)).toBe('2026-01-02-obj123456-billing.md')
    expect(r.results[0].match).toBe('exact')
    expect(r.results[0].score).toBeGreaterThanOrEqual(1)
    expect(r.results.slice(1).every(h => h.match !== 'exact')).toBe(true)
  })

  it('treats the workspace as a wall for both rankers', async () => {
    const provider = await seed()
    for (const mode of ['hybrid', 'semantic', 'keyword'] as const) {
      const r = await searchKnowledgeBase('automobile car', { mode, db, provider, root, workspace: 'acme' })
      expect(r.results.some(h => h.path.includes(`${path.sep}other${path.sep}`)), mode).toBe(false)
    }
    const all = await searchKnowledgeBase('automobile car', { mode: 'semantic', db, provider, root })
    expect(all.results.some(h => h.path.includes(`${path.sep}other${path.sep}`))).toBe(true)
  })

  it('applies the caller\'s visibility predicate before the limit', async () => {
    const provider = await seed()
    const allow = (p: string) => !p.endsWith('fleet.md')
    const r = await searchKnowledgeBase('automobile rental', { mode: 'hybrid', db, provider, root, workspace: 'acme', allow, limit: 2 })
    expect(r.results.some(h => h.path.endsWith('fleet.md'))).toBe(false)
  })

  // obj 900962: the caller's scope is applied INSIDE each ranker. Before, the top 50
  // keyword rows and 150 nearest chunks were taken across the whole knowledge base and
  // only then filtered, so 200 better-ranked notes outside the scope hid the one inside.
  describe('caller scope with 200 better-ranked decoys outside it', () => {
    const DECOYS = 200
    async function seedDecoys(decoyDir: string) {
      const provider = conceptProvider()
      for (let i = 0; i < DECOYS; i++) {
        // Stronger than the in-scope note on both rankers: the terms in the title and
        // repeated (bm25), and nothing but the query's concepts (cosine).
        write(`${decoyDir}/decoy-${String(i).padStart(3, '0')}.md`, `---\ntitle: "invoice outage"\n---\n# Invoice outage\ninvoice outage invoice outage invoice outage ${i}`)
      }
      const mine = write('workspaces/acme/mine/the-one.md', '# Weekly notes\nThe garden needs soil. One invoice was late after the outage. We ship on Tuesday.')
      await runBackfill({ db, provider, root })
      const allow = (p: string) => p.startsWith(path.join(root, 'workspaces/acme/mine') + path.sep)
      return { provider, mine, allow }
    }

    for (const [name, decoyDir, workspace] of [
      ['in another workspace, caller predicate only', 'workspaces/other/notes', undefined],
      ['in the same workspace, outside the caller\'s folder', 'workspaces/acme/elsewhere', 'acme'],
    ] as const) {
      it(`returns the one in-scope note in keyword, semantic and hybrid modes (decoys ${name})`, async () => {
        const { provider, mine, allow } = await seedDecoys(decoyDir)
        // The decoys really do fill the unscoped top results in every mode.
        for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
          const open = await searchKnowledgeBase('invoice outage', { mode, db, provider, root, limit: 50 })
          expect(open.results.length, mode).toBe(50)
          expect(open.results.some(h => h.path === mine), mode).toBe(false)
        }
        for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
          const r = await searchKnowledgeBase('invoice outage', { mode, db, provider, root, workspace, allow })
          expect(r.mode_used, mode).toBe(mode)
          expect(r.results.map(h => h.path), mode).toEqual([mine])
        }
      })
    }

    it('pins an exact ID match that sits behind decoys naming the same ID', async () => {
      const provider = conceptProvider()
      for (let i = 0; i < DECOYS; i++) write(`workspaces/other/notes/obj777123-decoy-${i}.md`, '# obj777123\nobj777123 obj777123 obj777123 invoice')
      const mine = write('workspaces/acme/mine/log.md', '# Log\nA long log about the garden, soil and plants. Somewhere it mentions obj777123 once.')
      write('workspaces/acme/mine/invoice.md', '# Invoice\ninvoice invoice invoice')
      await runBackfill({ db, provider, root })
      const allow = (p: string) => p.startsWith(path.join(root, 'workspaces/acme/mine') + path.sep)
      const r = await searchKnowledgeBase('obj777123 invoice', { mode: 'hybrid', db, provider, root, allow })
      expect(r.results[0].path).toBe(mine)
      expect(r.results[0].match).toBe('exact')
      expect(r.results.every(h => allow(h.path))).toBe(true)
    })

    it('finds in-scope chunks behind more out-of-scope chunks than one vector query can return', () => {
      const dim = 4
      expect(ensureVecTable(db, dim)).toBe(true)
      const vec = (a: number[]) => new Float32Array(normalize(a))
      const doc = (p: string, v: Float32Array) => replaceDocChunks(db,
        { path: p, workspace: 'acme', mtimeMs: 1, size: 1, contentHash: p, modelId: 'm' },
        [{ index: 0, heading: 'h', line: 1, text: p, vector: v }])
      db.transaction(() => {
        for (let i = 0; i < 4200; i++) doc(`/kb/out/${i}.md`, vec([1, 0, 0, 0]))
        doc('/kb/in/near.md', vec([0.9, 0.4, 0, 0]))
        doc('/kb/in/far.md', vec([0, 0, 1, 0]))
      })()
      const q = vec([1, 0, 0, 0])
      const accept = (p: string) => p.startsWith('/kb/in/')
      // sqlite-vec caps k at 4096, so the deepest query alone still holds only decoys.
      expect(knnChunks(db, q, 4096, 'm').some(c => accept(c.path))).toBe(false)
      const hits = knnChunks(db, q, 150, 'm', undefined, accept)
      expect(hits.map(c => c.path)).toEqual(['/kb/in/near.md', '/kb/in/far.md'])
      expect(hits[0].distance).toBeLessThan(hits[1].distance)
      expect(knnChunks(db, q, 150, 'm', ['acme'], accept).map(c => c.path)).toEqual(['/kb/in/near.md', '/kb/in/far.md'])
      // Unscoped is the plain nearest-K it always was.
      expect(knnChunks(db, q, 150, 'm')).toHaveLength(150)
    })
  })

  it('degrades to keyword when semantic is unavailable, and says so', async () => {
    await seed()
    const r = await searchKnowledgeBase('tomato soil', { mode: 'hybrid', db, provider: null, root, workspace: 'acme' })
    expect(r.mode_used).toBe('keyword')
    expect(r.semantic.available).toBe(false)
    expect(path.basename(r.results[0].path)).toBe('garden.md')
    const s = await searchKnowledgeBase('tomato soil', { mode: 'semantic', db, provider: null, root })
    expect(s.results).toEqual([])
  })

  it('semantic mode returns only vector hits with similarity', async () => {
    const provider = await seed()
    const r = await searchKnowledgeBase('rollout schedule', { mode: 'semantic', db, provider, root, workspace: 'acme' })
    expect(path.basename(r.results[0].path)).toBe('release.md')
    expect(r.results.every(h => h.match === 'semantic')).toBe(true)
  })

  // issue #134: semantic hits below the similarity floor must not appear, so
  // search can say "nothing relevant" instead of returning the KNN's nearest junk.
  it('drops semantic hits below the similarity floor (#134)', async () => {
    const provider = await seed()
    // "quantum" lights no concept dimension: every chunk is far from the query.
    const r = await searchKnowledgeBase('quantum flux capacitor', { mode: 'semantic', db, provider, root, workspace: 'acme' })
    expect(r.results).toEqual([])
    // Hybrid with no keyword match either → empty, not nearest-junk.
    const hy = await searchKnowledgeBase('quantum flux capacitor', { mode: 'hybrid', db, provider, root, workspace: 'acme' })
    expect(hy.results).toEqual([])
    // minSimilarity: 0 disables the floor and brings the nearest chunks back —
    // and even those are below 0.2, which is what makes the floor a real filter here
    // (the concept provider gives every vector a 0.05 residual dimension).
    const off = await searchKnowledgeBase('quantum flux capacitor', { mode: 'semantic', db, provider, root, workspace: 'acme', minSimilarity: 0 })
    expect(off.results.length).toBeGreaterThan(0)
    expect(off.results.every(h => (h.similarity ?? 1) < 0.2)).toBe(true)
    // Keyword hits are unaffected by the floor.
    const kw = await searchKnowledgeBase('tomato soil', { mode: 'hybrid', db, provider, root, workspace: 'acme' })
    expect(path.basename(kw.results[0].path)).toBe('garden.md')
  })

  it('relatedDocs skips notes below the similarity floor (#134)', async () => {
    const provider = await seed()
    const fleet = path.join(root, 'workspaces/acme/decisions/2026-01-01-fleet.md')
    const rel = await relatedDocs(fleet, { db, provider, root, workspace: 'acme' })
    // garden.md shares no concept with the fleet note: below the 0.2 floor.
    expect(rel.some(r => r.path.endsWith('garden.md'))).toBe(false)
    expect(rel.every(r => r.similarity >= 0.2)).toBe(true)
  })

  it('lists related notes by similarity, excluding the note itself', async () => {
    const provider = await seed()
    write('workspaces/acme/notes/vehicles.md', '# Vehicles\nThe sedan and the car are both due for service.')
    await runBackfill({ db, provider, root })
    const fleet = path.join(root, 'workspaces/acme/decisions/2026-01-01-fleet.md')
    const rel = await relatedDocs(fleet, { db, provider, root, workspace: 'acme' })
    expect(rel[0].path.endsWith('vehicles.md')).toBe(true)
    expect(rel.some(r => r.path === fleet)).toBe(false)
    expect(rel.some(r => r.path.includes(`${path.sep}other${path.sep}`))).toBe(false)
  })

  it('parses the mode parameter', () => {
    expect(parseSearchMode(undefined)).toBe('hybrid')
    expect(parseSearchMode('')).toBe('hybrid')
    expect(parseSearchMode('semantic')).toBe('semantic')
    expect(parseSearchMode('vector')).toBeNull()
  })
})
