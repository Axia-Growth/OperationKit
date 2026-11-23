import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

// One rule for which bot owns a card (obj 900956). The point of these tests is
// that the three places that used to answer the question three ways now give
// the SAME answer: the daily High Agency supervisor, bot approval's "own work"
// check, and the wake brief's "your cards" filter (?owned_by_bot=).
// Private in-memory DB per test; every function gets the handle explicitly.

const { cardIdsOwnedByBot, cardOwnerBot } = await import('./card-owner.js')
const { reviewHighAgencyWork } = await import('../high-agency-supervisor.js')
const { botApprovalEligibility } = await import('../bot-close-eligibility.js')
const { setObjectiveCeiling, recordSpend } = await import('../job-accounting.js')

const NOW = new Date('2026-11-14T15:00:00.000Z')
const RECENT = new Date(NOW.getTime() - 60_000).toISOString()
// Two registered bots, each with one chat slug, both with High Agency on.
const BOTS = [
  { id: 'Sales Bot', slug: 'sales-bot' },
  { id: 'Ops Bot', slug: 'ops-bot' },
]
const CHAT_BOTS = BOTS.map((b) => ({ slug: b.slug, name: b.id }))
let db: Database.Database

beforeEach(() => {
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL DEFAULT 'member');
    CREATE TABLE routines (
      id INTEGER PRIMARY KEY, name TEXT, cron_expr TEXT, objective_template TEXT, enabled INTEGER NOT NULL DEFAULT 1,
      max_queue_depth INTEGER, kind TEXT, last_run_at TEXT, auto_paused_at TEXT, auto_pause_reason TEXT
    );
    CREATE TABLE agent_chat_high_agency (
      slug TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, workspace TEXT, run_as_user_id INTEGER, routine_id INTEGER
    );
    CREATE TABLE agent_chat_cards (objective_id INTEGER PRIMARY KEY, user_id INTEGER, agent_slug TEXT NOT NULL);
    CREATE TABLE objectives (
      id INTEGER PRIMARY KEY, title TEXT, description TEXT, status TEXT NOT NULL DEFAULT 'review', workspace TEXT,
      agent_context TEXT, owner_bot TEXT, parent_id INTEGER, routine_id INTEGER, source_job_id INTEGER, session_id TEXT,
      has_blockers INTEGER NOT NULL DEFAULT 0, blocked_reason TEXT, ai_review_verdict TEXT, needs_secret TEXT,
      is_strategy INTEGER NOT NULL DEFAULT 0, pr_url TEXT, pr_number INTEGER,
      deleted_at TEXT, created_at TEXT, updated_at TEXT
    );
  `)
  db.prepare("INSERT INTO users (id, username, role) VALUES (1, 'operator', 'admin')").run()
  db.prepare("INSERT INTO routines (id, name, enabled) VALUES (10, 'high-agency:sales-bot', 1), (11, 'high-agency:ops-bot', 1)").run()
  db.prepare(`INSERT INTO agent_chat_high_agency (slug, enabled, workspace, run_as_user_id, routine_id)
              VALUES ('sales-bot', 1, 'operationkit', 1, 10), ('ops-bot', 1, 'operationkit', 1, 11)`).run()
  db.prepare("INSERT INTO settings (key, value) VALUES ('bot_registry_additions', ?)")
    .run(JSON.stringify(BOTS.map((b) => ({ id: b.id, agent_slugs: [b.slug] }))))
})

interface Card { id: number; status: string; session_id: null; workspace: string; title: string; description: string; owner_bot: string | null; agent_context: string | null; is_strategy: number; pr_url: null; pr_number: null; ai_review_verdict: string }

/** A reviewed card waiting on a person: the state in which a bot may close its own work. */
function card(id: number, fields: { owner_bot?: string | null; agent_context?: string | null }): Card {
  const row: Card = {
    id, status: 'review', session_id: null, workspace: 'operationkit', title: `Card ${id}`, description: '',
    owner_bot: fields.owner_bot ?? null, agent_context: fields.agent_context ?? null,
    is_strategy: 0, pr_url: null, pr_number: null, ai_review_verdict: 'pass',
  }
  db.prepare(
    `INSERT INTO objectives (id, title, description, status, workspace, agent_context, owner_bot, ai_review_verdict, created_at, updated_at)
     VALUES (?, ?, '', 'review', 'operationkit', ?, ?, 'pass', ?, ?)`,
  ).run(id, row.title, row.agent_context, row.owner_bot, RECENT, RECENT)
  return row
}

const review = () => reviewHighAgencyWork(db, { now: NOW, knownBots: BOTS.map((b) => b.slug), chatBots: CHAT_BOTS })

/** The owner the SUPERVISOR sees: put the card over budget and read the flag it files (none = out of scope). */
function supervisorOwner(c: Card): string | null {
  review() // creates the job-accounting tables
  setObjectiveCeiling(db, c.id, { costUsd: 5 })
  recordSpend(db, c.id, { usd: 6 })
  const flag = review().flags.find((f) => f.kind === 'over_budget' && f.objective_id === c.id)
  return flag ? flag.owner : null
}

/** The owner BOT APPROVAL sees: the one bot that may close the card as its own reviewed work. */
function approvalOwner(c: Card): string | null {
  const may = BOTS.filter((b) => {
    const e = botApprovalEligibility(db, { card: c as never, declaredBot: b.id, keyOwnerUserId: 1, keyWorkspaces: null, now: NOW })
    if (!e.eligible) expect(e.refusal).toBe('not_bot_owned')
    return e.eligible
  })
  expect(may.length).toBeLessThanOrEqual(1)
  return may[0]?.slug ?? null
}

/** The owner the WAKE BRIEF's "your cards" filter sees (?owned_by_bot=<slug>). */
function briefOwner(c: Card): string | null {
  const mine = BOTS.filter((b) => cardIdsOwnedByBot(db, b.slug, [c], { chatBots: CHAT_BOTS }).includes(c.id))
  expect(mine.length).toBeLessThanOrEqual(1)
  return mine[0]?.slug ?? null
}

describe('one owner, three readers', () => {
  const table: Array<{ name: string; owner_bot: string | null; agent_context: string | null; owner: string | null }> = [
    { name: 'owner_bot only (worked by another agent)', owner_bot: 'Sales Bot', agent_context: 'cto', owner: 'sales-bot' },
    { name: 'agent_context only', owner_bot: null, agent_context: 'sales-bot', owner: 'sales-bot' },
    { name: 'both, disagreeing: owner_bot wins', owner_bot: 'Ops Bot', agent_context: 'sales-bot', owner: 'ops-bot' },
    { name: 'default agent, no owner_bot: nobody', owner_bot: null, agent_context: 'general', owner: null },
  ]
  for (const row of table) {
    it(row.name, () => {
      const c = card(1, row)
      expect(cardOwnerBot(c, db, { chatBots: CHAT_BOTS })?.slugs[0] ?? null).toBe(row.owner)
      expect(supervisorOwner(c)).toBe(row.owner)
      expect(approvalOwner(c)).toBe(row.owner)
      expect(briefOwner(c)).toBe(row.owner)
    })
  }
})

describe('a card a High Agency bot filed from chat', () => {
  it('is in supervisor scope and on the bot\'s own list, though the default agent works it', () => {
    const c = card(7, { owner_bot: 'Sales Bot', agent_context: 'general' })
    db.prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (7, 1, 'sales-bot')").run()
    const r = review()
    expect(r.cards).toBe(1)
    expect(r.flags).toEqual([]) // owned by an awake bot: not orphaned
    expect(supervisorOwner(c)).toBe('sales-bot')
    expect(briefOwner(c)).toBe('sales-bot')
    expect(approvalOwner(c)).toBe('sales-bot')
  })

  it('a chat bot outside the registry owns the card filed under its display name', () => {
    db.prepare("INSERT INTO agent_chat_high_agency (slug, enabled, workspace, run_as_user_id) VALUES ('growth-helper', 1, 'operationkit', 1)").run()
    const chatBots = [...CHAT_BOTS, { slug: 'growth-helper', name: 'Growth Helper' }]
    const c = card(8, { owner_bot: 'Growth Helper', agent_context: 'general' })
    expect(cardOwnerBot(c, db, { chatBots })).toMatchObject({ botId: null, slugs: ['growth-helper'], via: 'owner_bot' })
    expect(cardIdsOwnedByBot(db, 'growth-helper', [c], { chatBots })).toEqual([8])
    expect(reviewHighAgencyWork(db, { now: NOW, chatBots }).cards).toBe(1)
    // Not a registered bot, so no registered bot may close it as its own work.
    expect(approvalOwner(c)).toBeNull()
  })
})

describe('edges of the rule', () => {
  it('a worker persona slug is not the bot that shares its name', () => {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'bot_registry_additions'")
      .run(JSON.stringify([{ id: 'Sales Bot', agent_slugs: ['acme-sales'] }]))
    // agent_context "sales-bot" folds to the same key as the NAME "Sales Bot", but it is not one of its chat slugs.
    db.exec("DELETE FROM agent_chat_high_agency")
    expect(cardOwnerBot(card(1, { agent_context: 'sales-bot' }), db, { chatBots: [] })).toBeNull()
  })

  it('an owner_bot nothing here answers to is still the owner: agent_context is not consulted', () => {
    const c = card(1, { owner_bot: 'Outside Assistant', agent_context: 'sales-bot' })
    expect(cardOwnerBot(c, db, { chatBots: CHAT_BOTS })).toEqual({ botId: null, name: 'Outside Assistant', slugs: [], via: 'owner_bot' })
    expect(briefOwner(c)).toBeNull()
    expect(approvalOwner(c)).toBeNull()
  })

  it('PR 797 guard: a registered bot that only shares the filing chat bot\'s display name does not own its card', () => {
    // "helper" is an unregistered chat bot named "Ops Bot"; it filed card 9 and works it under its own slug.
    const chatBots = [...CHAT_BOTS, { slug: 'helper', name: 'Ops Bot' }]
    const c = card(9, { owner_bot: 'Ops Bot', agent_context: 'helper' })
    db.prepare("INSERT INTO agent_chat_cards (objective_id, user_id, agent_slug) VALUES (9, 1, 'helper')").run()
    expect(cardOwnerBot(c, db, { chatBots })).toBeNull()
    expect(approvalOwner(c)).toBeNull()
    expect(cardIdsOwnedByBot(db, 'ops-bot', [c], { chatBots })).toEqual([])
  })

  it('blank values own nothing', () => {
    expect(cardOwnerBot({ id: 1, owner_bot: '  ', agent_context: '' }, db, { chatBots: CHAT_BOTS })).toBeNull()
    expect(cardOwnerBot({ id: 1, owner_bot: null, agent_context: null }, db, { chatBots: CHAT_BOTS })).toBeNull()
  })
})
