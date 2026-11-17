/**
 * Jailed card sessions on /api/internal (card #901195, audit finding PA-8).
 *
 * Browser-free, like api.spec.ts. run.sh starts the scratch server with
 * INTERNAL_TRUSTED_PEER_CIDRS set to THIS machine's own non-loopback address
 * (/32) and exports E2E_JAIL_BASE_URL pointing at that address, so a request
 * sent there reaches the server exactly the way a call from inside a card's
 * jail does: a sandbox-network peer, not loopback.
 *
 * Before the fix every call here answered 403 "a sandboxed session peer must
 * present X-Internal-Secret…", so a jailed card could not save NOTES/ARTIFACT,
 * post progress or file child cards. After: its own card's routes work with its
 * own session token, and everything else is still refused.
 */
import crypto from 'node:crypto'
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { test, seed } from './helpers'

const REFUSAL = 'Internal API: a sandboxed session peer must present X-Internal-Secret or the objectives token — reachability on the jail network is not authority.'

/** A card session token, minted the way lib/session-trust.ts does (the scratch server's JWT_SECRET is a throwaway). */
function sessionToken(objectiveId: number, workspace: string): string {
  const secret = process.env.E2E_JWT_SECRET
  if (!secret) throw new Error('E2E_JWT_SECRET is missing — run the suite through run.sh')
  const key = crypto.createHmac('sha256', secret).update('cc-session-token-v1').digest()
  const payload = Buffer.from(JSON.stringify({ o: objectiveId, w: workspace, u: null, e: Date.now() + 3_600_000 })).toString('base64url')
  return `ccs_${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`
}

async function jail(): Promise<APIRequestContext> {
  const baseURL = process.env.E2E_JAIL_BASE_URL
  if (!baseURL) throw new Error('E2E_JAIL_BASE_URL is missing — run the suite through run.sh (it needs a non-loopback local IPv4)')
  return pwRequest.newContext({ baseURL })
}

test('jail: a card session uses its OWN card memory, progress and child cards', async () => {
  const api = await jail()
  const s = seed()
  const card = s.cards.working
  const H = { 'X-CC-Session-Token': sessionToken(card, s.workspace) }

  const put = await api.put(`/api/internal/objectives/${card}/memory/file`, { headers: H, data: { path: 'NOTES.md', content: 'saved from the jail\n' } })
  expect(put.status(), await put.text()).toBe(200)
  const get = await api.get(`/api/internal/objectives/${card}/memory/file?path=NOTES.md`, { headers: H })
  expect(get.status()).toBe(200)
  expect((await get.json()).content).toBe('saved from the jail\n')

  const progress = await api.post(`/api/internal/objectives/${card}/progress`, { headers: H, data: { step: 1, total_steps: 2, label: 'jail e2e' } })
  expect(progress.status(), await progress.text()).toBe(201)

  const child = await api.post('/api/internal/objectives', { headers: H, data: [{ title: `jail e2e child ${Date.now()}`, type: 'task' }] })
  expect(child.status(), await child.text()).toBe(201)
  const id = (await child.json()).objectives[0].id as number
  // The jail may not read the child's row (no cross-card reads); check it from loopback instead.
  expect((await api.get(`/api/internal/objectives/${id}`, { headers: H })).status()).toBe(403)
  const local = await pwRequest.newContext({ baseURL: process.env.E2E_BASE_URL })
  const row = await (await local.get(`/api/internal/objectives/${id}`)).json() as { parent_id: number; workspace: string }
  expect({ parent_id: row.parent_id, workspace: row.workspace }).toEqual({ parent_id: card, workspace: s.workspace })
  await local.dispose()
  await api.dispose()
})

test('jail: the same token on another card, an off-list route, or no token is refused', async () => {
  const api = await jail()
  const s = seed()
  const H = { 'X-CC-Session-Token': sessionToken(s.cards.working, s.workspace) }

  const otherCard = await api.post(`/api/internal/objectives/${s.cards.queue}/progress`, { headers: H, data: { step: 1, label: 'x' } })
  expect(otherCard.status()).toBe(403)
  const otherMemory = await api.get(`/api/internal/objectives/${s.cards.queue}/memory/file?path=NOTES.md`, { headers: H })
  expect(otherMemory.status()).toBe(403)
  for (const url of [
    '/api/internal/strategies',
    '/api/internal/briefing',
    '/api/internal/pr-health',
    // No board reads or Full access from a jail (operator review of PR 847).
    '/api/internal/objectives',
    `/api/internal/objectives/${s.cards.queue}`,
    `/api/internal/objectives/${s.cards.working}/siblings`,
    `/api/internal/objectives/${s.cards.queue}/output`,
    '/api/internal/supervisor/flags',
    '/api/internal/full-access',
  ]) {
    const r = await api.get(url, { headers: H })
    expect(r.status(), url).toBe(403)
    expect((await r.json()).error, url).toBe(REFUSAL)
  }
  // No cross-card writes either, on its own id or another card's.
  for (const id of [s.cards.working, s.cards.queue]) {
    const st = await api.patch(`/api/internal/objectives/${id}/status`, { headers: H, data: { status: 'cancelled' } })
    expect(st.status(), `status ${id}`).toBe(403)
    const msg = await api.post(`/api/internal/objectives/${id}/message`, { headers: H, data: { message: 'hi' } })
    expect(msg.status(), `message ${id}`).toBe(403)
    const take = await api.post(`/api/internal/full-access/cards/${id}/take-over`, { headers: H, data: {} })
    expect(take.status(), `take-over ${id}`).toBe(403)
  }
  const noToken = await api.post(`/api/internal/objectives/${s.cards.working}/progress`, { data: { step: 1, label: 'x' } })
  expect(noToken.status()).toBe(403)
  expect((await noToken.json()).error).toBe(REFUSAL)
  await api.dispose()
})

test('jail: an AI reviewer locks and reads ITS card rubric, and is refused on another card', async () => {
  const api = await jail()
  const s = seed()
  const card = s.cards.aiReview // the reviewer's token is minted for the card it reviews
  const H = { 'X-CC-Session-Token': sessionToken(card, s.workspace) }
  const criteria = [{ id: 'jail-e2e', criterion: 'A jailed reviewer can lock its rubric', type: 'functional', method: 'api' }]

  const post = await api.post(`/api/internal/reviews/${card}/criteria`, { headers: H, data: { criteria } })
  expect([201, 409], await post.text()).toContain(post.status()) // 409 = already locked by an earlier run
  const get = await api.get(`/api/internal/reviews/${card}/criteria`, { headers: H })
  expect(get.status(), await get.text()).toBe(200)
  expect(Array.isArray((await get.json()).criteria)).toBe(true)

  for (const other of [s.cards.reviewFail, s.cards.working]) {
    const p = await api.post(`/api/internal/reviews/${other}/criteria`, { headers: H, data: { criteria } })
    expect(p.status(), `POST ${other}`).toBe(403)
    expect((await p.json()).error).toBe(REFUSAL)
    const g = await api.get(`/api/internal/reviews/${other}/criteria`, { headers: H })
    expect(g.status(), `GET ${other}`).toBe(403)
  }
  await api.dispose()
})
