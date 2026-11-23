// A bot can say what the owner chose on a card (obj 901277).
//
// Incident: the owner answered decision #17 on card #901231 (option A), then
// asked the owning bot (Full access) to confirm the card was fine. card_read
// returned the stale "queued and held" description and nothing about the
// decision, the card thread or the hold, so the bot said it could not see the
// choice. These tests pin, through the real chat tools and a real temp DB:
//   1. card_read carries every decision (briefing, choice + label, note, who,
//      when, result), the recent thread incl. the follow-up that applied the
//      choice, queue_hold / blocked_by, the owner bot and its ACTIVE grants;
//   2. get_objective (no Full access) carries enough to answer the same question;
//   3. the bot's system prompt lists the cards it owns with their open
//      decisions and recent answers — and never a card it does not own.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.JWT_SECRET = 'test-secret-card-decision-context-xx'
const TMP_DB = path.join(os.tmpdir(), `cc-card-decision-ctx-${process.pid}-${Date.now()}.db`)
process.env.DB_PATH = TMP_DB
const TMP_KB = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-decision-ctx-kb-'))
const TMP_TRANSCRIPTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-decision-ctx-tx-'))
process.env.TRANSCRIPT_DIR = TMP_TRANSCRIPTS
const TMP_AGENTS = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-card-decision-ctx-agents-'))
process.env.AGENT_FILES_DIR = TMP_AGENTS
process.env.AGENT_CHAT_BUILTINS = '0'
for (const [slug, name] of [['dev', 'Operation Kit Dev'], ['cos', 'General']]) {
  fs.mkdirSync(path.join(TMP_AGENTS, slug), { recursive: true })
  fs.writeFileSync(path.join(TMP_AGENTS, slug, 'agent.yaml'), `name: ${name}\ndescription: x\ntools: [get_objective, list_objectives]\nknowledge_folders: []\nsystem_prompt: You help.\n`)
}

const { initDb, getDb } = await import('../../db/index.js')
const { runChatTool } = await import('./tools.js')
const { grantBotWorkspace } = await import('./bot-workspaces.js')
const { setFullAccess } = await import('./bot-full-access.js')
const { createGrant, revokeGrant } = await import('../delegated-approvals.js')
const { createWorkspace } = await import('../workspaces.js')
const { raiseDecision, recordChoice, setOutcome } = await import('../decisions.js')
const { systemPromptFor } = await import('./engine.js')
const { decisionFollowUpText, decisionOutcomeText } = await import('@operationkit/shared')
type Agent = import('./agent-defs.js').ChatAgent

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

const ADMIN = 1
const GROWTH = 'growth'
const OTHER = 'other-co'
const NOW = new Date()
const IN_A_WEEK = new Date(NOW.getTime() + 7 * 86_400_000).toISOString()

function bot(slug: string, name: string): Agent {
  return {
    slug, name, description: '', avatar: '', colour: 'blue', system_prompt: 'You help.', knowledge_folders: [],
    tools: ['get_objective', 'list_objectives'], model: null, provider: null, schedules: [], version: null, author: null,
    how_to_use: '', example_prompts: [], source: 'file', file: '/dev/null',
  }
}
const DEV = bot('dev', 'Operation Kit Dev')
const COS = bot('cos', 'General')

function ctx(a: Agent) {
  return { userId: ADMIN, username: 'operator', workspace: GROWTH, agent: a, kbRoot: TMP_KB, connectors: { mail: null, calendar: null }, now: () => NOW }
}

const BRIEFING = {
  context: 'Grant-approved squash merge is built behind a flag. Turning it on lets a bot merge a green PR under an owner grant.',
  question: 'Ship grant-approved merge as designed?',
  options: [
    { key: 'A', label: 'Yes, as designed in #901231', pros: ['Fewer clicks'], cons: ['New merge path'], next: 'I start #901231 (PR only).' },
    { key: 'B', label: 'Not yet', pros: ['No change'], cons: ['Merges stay manual'], next: 'I park the card.' },
  ],
  recommended: 'A',
  recommended_why: 'It is gated by an expiring grant.',
}
const HOLD = "Waiting for Operator's decision. Do not start until Operator approves this grant-approved squash-merge behavior. auto_merge_enabled stays off."

let devCard = 0
let openCard = 0
let otherBotCard = 0
let decidedId = 0
let openDecisionId = 0
let grantId = 0

function insertCard(title: string, extra: { agent?: string; owner_bot?: string | null; status?: string; hold?: string | null; blocked_by?: number | null; session_id?: string | null; workspace?: string }) {
  return Number(getDb().prepare(
    `INSERT INTO objectives (title, description, workspace, status, type, category, created_by, assigned_user_id, agent_context, owner_bot, queue_hold, blocked_by, session_id, updated_at)
     VALUES (?, 'STATUS: queued and held. Do not start until Operator approves.', ?, ?, 'task', 'general', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(title, extra.workspace ?? GROWTH, extra.status ?? 'working', ADMIN, ADMIN, extra.agent ?? 'general', extra.owner_bot ?? null, extra.hold ?? null, extra.blocked_by ?? null, extra.session_id ?? null).lastInsertRowid)
}

beforeAll(() => {
  if (fs.existsSync(TMP_DB)) fs.unlinkSync(TMP_DB)
  initDb()
  const db = getDb()
  db.prepare(`INSERT INTO users (id, username, password_hash, role) VALUES (?, 'operator', 'x', 'admin')`).run(ADMIN)
  createWorkspace({ slug: GROWTH, name: 'Growth', default_agent_pool: ['general'] })
  createWorkspace({ slug: OTHER, name: 'Other', default_agent_pool: ['general'] })
  grantBotWorkspace('dev', GROWTH, 'operator')
  grantBotWorkspace('cos', GROWTH, 'operator')

  const SESSION = 'sess-901231-a'
  devCard = insertCard('Grant-approved merge', { agent: 'dev', owner_bot: 'Operation Kit Dev', hold: HOLD, blocked_by: 901200, session_id: SESSION })
  openCard = insertCard('Pricing page copy', { agent: 'dev', status: 'review' })
  otherBotCard = insertCard('General weekly digest', { agent: 'cos', status: 'review' })

  // Decision on the dev card: raised, answered A with a note, applied (sent).
  const raised = raiseDecision(db, { objective_id: devCard, workspace: GROWTH, source: 'bot', agent_slug: 'dev', briefing: BRIEFING })
  if (!raised.ok) throw new Error(raised.errors.join('; '))
  decidedId = raised.decision.id
  const decided = recordChoice(db, decidedId, { choice: 'A', by: 'admin', note: 'keep auto_merge_enabled off' })
  setOutcome(db, decidedId, 'sent', decisionOutcomeText({ objectiveId: devCard, briefing: decided.briefing, chosen: 'A', outcome: 'sent', note: decided.decision_note }))

  // An open decision on another card the bot owns.
  const open = raiseDecision(db, { objective_id: openCard, workspace: GROWTH, source: 'bot', agent_slug: 'dev', briefing: { ...BRIEFING, question: 'Which headline should the pricing page use?' } })
  if (!open.ok) throw new Error(open.errors.join('; '))
  openDecisionId = open.decision.id
  // A decision on a card another bot owns: must never show in Dev's prompt.
  raiseDecision(db, { objective_id: otherBotCard, workspace: GROWTH, source: 'bot', agent_slug: 'cos', briefing: { ...BRIEFING, question: 'Send the COS digest early?' } })

  // The card thread: the follow-up that applied the choice, then the worker's reply.
  const follow = decisionFollowUpText({ decisionId: decidedId, briefing: decided.briefing, chosen: 'A', note: decided.decision_note })
  fs.writeFileSync(path.join(TMP_TRANSCRIPTS, `${SESSION}.jsonl`), [
    JSON.stringify({ type: 'followup', text: follow, timestamp: '2026-11-17T12:22:07Z', sender: { kind: 'owner', verified: true, label: 'Operator', username: 'admin' } }),
    JSON.stringify({ type: 'result', subtype: 'success', result: 'Started on the grant-approved merge, PR to follow.', total_cost_usd: 0.1, duration_ms: 1000 }),
  ].join('\n') + '\n')

  // An active merge grant for the owner bot here, plus a revoked one and one in another workspace.
  grantId = createGrant(db, { grantor: { id: ADMIN, username: 'operator' }, botName: 'Operation Kit Dev', agentSlug: 'dev', workspace: GROWTH, actions: ['merge'], expiresAt: IN_A_WEEK, allowedWorkspaces: [GROWTH, OTHER], now: NOW }).id
  const revoked = createGrant(db, { grantor: { id: ADMIN, username: 'operator' }, botName: 'Operation Kit Dev', agentSlug: 'dev', workspace: GROWTH, actions: ['deploy'], expiresAt: IN_A_WEEK, allowedWorkspaces: [GROWTH, OTHER], now: NOW })
  revokeGrant(db, revoked.id, 'Operation Kit Dev', 'operator', NOW)
  createGrant(db, { grantor: { id: ADMIN, username: 'operator' }, botName: 'Operation Kit Dev', agentSlug: 'dev', workspace: OTHER, actions: ['deploy'], expiresAt: IN_A_WEEK, allowedWorkspaces: [GROWTH, OTHER], now: NOW })
})

afterAll(() => {
  try { getDb().close() } catch { /* closed */ }
  for (const s of ['', '-wal', '-shm']) { const f = `${TMP_DB}${s}`; if (fs.existsSync(f)) fs.unlinkSync(f) }
  for (const d of [TMP_KB, TMP_TRANSCRIPTS, TMP_AGENTS]) fs.rmSync(d, { recursive: true, force: true })
})

describe('card_read (Full access) carries the decision, thread, holds, owner and grants', () => {
  it('returns the full shape for a card with a decided decision', async () => {
    setFullAccess('dev', GROWTH, { enabled: true }, { id: ADMIN, username: 'operator' }, NOW)
    const r = (await runChatTool(ctx(DEV), 'card_read', { id: devCard })).result as Loose

    expect(r.queue_hold).toBe(HOLD)
    expect(r.blocked_by).toBe(901200)
    expect(r.owner_bot).toBe('Operation Kit Dev')
    // Only the ACTIVE grant in THIS workspace; ids and action names, nothing else.
    expect(r.owner_grants).toEqual([{ grant_id: grantId, actions: ['merge'], granted_by: 'operator', expires_at: expect.stringMatching(/UTC$/) }])
    expect(JSON.stringify(r.owner_grants)).not.toMatch(/token|secret/i)

    const d = r.decisions.find((x: Loose) => x.id === decidedId)
    expect(d).toMatchObject({
      state: 'decided',
      question: 'Ship grant-approved merge as designed?',
      chosen: 'A',
      chosen_label: 'Yes, as designed in #901231',
      answer: 'Chose A: Yes, as designed in #901231',
      decision_note: 'keep auto_merge_enabled off',
      decided_by: 'admin',
      outcome: 'sent',
      recommended: 'A',
    })
    expect(d.decided_at).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC$/)
    expect(d.outcome_text).toMatch(/You chose A: Yes, as designed in #901231\. Card #\d+ restarted with your choice/)
    // The full form also carries the briefing itself.
    expect(d.context).toMatch(/Grant-approved squash merge/)
    expect(d.options.map((o: Loose) => o.label)).toEqual(['Yes, as designed in #901231', 'Not yet'])
    expect(d.recommended_why).toMatch(/expiring grant/)

    // The thread shows the follow-up that applied the choice, stamped as the owner's.
    const msg = r.recent_thread.find((t: Loose) => t.kind === 'message')
    expect(msg.text).toMatch(new RegExp(`Decision #${decidedId}: Ship grant-approved merge`))
    expect(msg.text).toMatch(/Answer: option A — Yes, as designed in #901231/)
    expect(msg.from).toBe('Operator (owner, verified)')
    expect(r.recent_thread.some((t: Loose) => t.kind === 'summary' && /PR to follow/.test(t.text))).toBe(true)
  })
})

describe('get_objective (no Full access) answers "what did Operator choose on #N"', () => {
  it('includes the choice, who, when, result, holds and owner', async () => {
    const r = (await runChatTool(ctx(COS), 'get_objective', { id: devCard })).result as Loose
    expect(r.queue_hold).toBe(HOLD)
    expect(r.blocked_by).toBe(901200)
    expect(r.owner_bot).toBe('Operation Kit Dev')
    const d = r.decisions.find((x: Loose) => x.id === decidedId)
    expect(d).toMatchObject({ chosen: 'A', chosen_label: 'Yes, as designed in #901231', decided_by: 'admin', outcome: 'sent', decision_note: 'keep auto_merge_enabled off' })
    expect(d.decided_at).toMatch(/UTC$/)
    expect(d.outcome_text).toMatch(/restarted with your choice/)
    // The short form leaves the briefing context out.
    expect(d.context).toBeUndefined()
    expect(r.recent_thread.length).toBeGreaterThan(0)
  })
})

describe('the bot system prompt lists the cards it owns', () => {
  it('shows owned cards with their hold, open decisions and recent answers — and not another bot\'s card', () => {
    const prompt = systemPromptFor(DEV, { username: 'operator', now: NOW, connectors: [], workspace: GROWTH, userId: ADMIN })
    expect(prompt).toMatch(/Cards you own right now/)
    expect(prompt).toContain(`#${devCard} Grant-approved merge [working, growth]`)
    expect(prompt).toContain('hold: "Waiting for Operator\'s decision.')
    expect(prompt).toContain(`waits on #901200`)
    expect(prompt).toContain(`#${openCard} Pricing page copy [review, growth]`)
    expect(prompt).toContain(`Open decision #${openDecisionId} waiting on the owner: Which headline should the pricing page use?`)
    expect(prompt).toMatch(new RegExp(`#${devCard}, decision #${decidedId} "Ship grant-approved merge as designed\\?": Chose A: Yes, as designed in #901231 \\(note: "keep auto_merge_enabled off"\\) — by admin`))
    // Never a card the bot does not own, nor its decision.
    expect(prompt).not.toContain(`#${otherBotCard} `)
    expect(prompt).not.toContain('Send the COS digest early?')
    // No descriptions in the prompt.
    expect(prompt).not.toContain('STATUS: queued and held')
  })

  it('the other bot sees only its own card', () => {
    const prompt = systemPromptFor(COS, { username: 'operator', now: NOW, connectors: [], workspace: GROWTH, userId: ADMIN })
    expect(prompt).toContain(`#${otherBotCard} General weekly digest`)
    expect(prompt).toContain('Send the COS digest early?')
    expect(prompt).not.toContain(`#${devCard} `)
  })
})
