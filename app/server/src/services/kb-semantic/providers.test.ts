import { describe, it, expect } from 'vitest'
import { createProvider, createHashProvider, EmbeddingUnavailableError, modelIdOf, normalize, resolveConfig, type FetchFn } from './providers.js'

describe('resolveConfig', () => {
  it('defaults to the local offline model', () => {
    const c = resolveConfig({}, {})
    expect(c).toMatchObject({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384 })
    expect(modelIdOf(c)).toBe('local:Xenova/all-MiniLM-L6-v2:384')
  })

  it('fills API defaults and keeps an explicit model / base / key NAME', () => {
    expect(resolveConfig({ provider: 'openai' }, {})).toMatchObject({ model: 'text-embedding-3-small', baseUrl: 'https://api.openai.com/v1', apiKeySecret: 'OPENAI_API_KEY', dimensions: 1536 })
    const c = resolveConfig({ provider: 'openai', model: 'nomic-embed-text', baseUrl: 'http://litellm:4000/v1/', apiKeySecret: 'LITELLM_KEY', dimensions: '768' }, {})
    expect(c).toMatchObject({ model: 'nomic-embed-text', baseUrl: 'http://litellm:4000/v1', apiKeySecret: 'LITELLM_KEY', dimensions: 768 })
    expect(modelIdOf(c)).toBe('openai:nomic-embed-text@http://litellm:4000/v1:768')
  })

  it('treats an unknown provider as local and honours off', () => {
    expect(resolveConfig({ provider: 'mystery' }, {}).provider).toBe('local')
    expect(resolveConfig({ provider: 'off' }, {})).toMatchObject({ provider: 'off' })
    expect(createProvider(resolveConfig({ provider: 'off' }, {}))).toBeNull()
  })

  it('a changed model or dimension is a different vector space', () => {
    const a = modelIdOf(resolveConfig({ provider: 'voyage' }, {}))
    const b = modelIdOf(resolveConfig({ provider: 'voyage', dimensions: '512' }, {}))
    expect(a).not.toBe(b)
  })
})

describe('API providers', () => {
  function fakeFetch(vectors: number[][]) {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = []
    const fn: FetchFn = async (url, init) => {
      calls.push({ url, headers: init.headers, body: JSON.parse(init.body) })
      return { ok: true, status: 200, json: async () => ({ data: vectors.map((embedding, index) => ({ embedding, index })).reverse() }), text: async () => '' }
    }
    return { fn, calls }
  }

  it('makes NO call when the key secret is not configured', async () => {
    const { fn, calls } = fakeFetch([[1, 0]])
    const p = createProvider(resolveConfig({ provider: 'openai' }, {}), { resolveKey: () => null, fetchFn: fn })!
    await expect(p.embed(['x'], 'query')).rejects.toBeInstanceOf(EmbeddingUnavailableError)
    expect(calls).toHaveLength(0)
  })

  it('OpenAI-compatible: bearer key from the resolver, ordered + normalised vectors', async () => {
    const { fn, calls } = fakeFetch([[3, 4], [0, 2]])
    const seen: string[] = []
    const p = createProvider(resolveConfig({ provider: 'openai', dimensions: '2' }, {}), {
      resolveKey: (name) => { seen.push(name); return 'test-value' },
      fetchFn: fn,
    })!
    const out = await p.embed(['a', 'b'], 'document')
    expect(seen).toEqual(['OPENAI_API_KEY'])
    expect(calls[0].url).toBe('https://api.openai.com/v1/embeddings')
    expect(calls[0].headers.Authorization).toBe('Bearer test-value')
    expect(calls[0].body).toMatchObject({ model: 'text-embedding-3-small', input: ['a', 'b'], dimensions: 2 })
    expect(Array.from(out[0])).toEqual([0.6000000238418579, 0.800000011920929])
    expect(Array.from(out[1])).toEqual([0, 1])
  })

  it('Voyage: sends input_type query vs document', async () => {
    const { fn, calls } = fakeFetch([[1, 0]])
    const p = createProvider(resolveConfig({ provider: 'voyage' }, {}), { resolveKey: () => 'k', fetchFn: fn })!
    await p.embed(['q'], 'query')
    expect(calls[0].url).toBe('https://api.voyageai.com/v1/embeddings')
    expect(calls[0].body).toMatchObject({ input_type: 'query', model: 'voyage-3.5-lite' })
  })

  it('an HTTP error names the status but never echoes the key', async () => {
    const fn: FetchFn = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'invalid api key' })
    const p = createProvider(resolveConfig({ provider: 'openai' }, {}), { resolveKey: () => 'super-secret-value', fetchFn: fn })!
    const err = await p.embed(['x'], 'query').then(() => new Error('no error'), (e: Error) => e)
    expect(err.message).toContain('HTTP 401')
    expect(err.message).not.toContain('super-secret-value')
  })
})

describe('helpers', () => {
  it('normalize returns a unit vector (and survives a zero vector)', () => {
    const v = normalize([3, 4])
    expect(Math.hypot(v[0], v[1])).toBeCloseTo(1, 6)
    expect(Array.from(normalize([0, 0]))).toEqual([0, 0])
  })

  it('the test hash provider is deterministic', async () => {
    const p = createHashProvider(32)
    const [a] = await p.embed(['same text'], 'document')
    const [b] = await p.embed(['same text'], 'query')
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
