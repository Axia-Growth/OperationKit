/**
 * Answers a person's question on a decision (obj 901059) — the Q&A thread.
 *
 * The bot that raised the decision answers, in the decision's own thread, with
 * the card's context. It is ONE model call with NO tools: answering a question
 * about a decision must never take an action (approve/deny stays with the
 * person, in the same thread). Which bot answers:
 *
 *   decision.agent_slug  (the chat bot that raised it)
 *   → the card's owner_bot
 *   → the card's agent_context, when it names an installed bot
 *   → the install's first bot
 *
 * Card text (description, last summary) reaches the model inside an
 * untrusted-content frame: it is the card's data, not instructions.
 *
 * Tests swap the whole answerer with `setDecisionAnswerer`.
 */
import type Database from 'better-sqlite3'
import type { DecisionView, Objective } from '@operationkit/shared'
import { findAgent, installDefaultProvider, listAgents } from './agent-chat/engine.js'
import { chooseProviderId, createProvider } from './agent-chat/providers.js'
import type { ChatAgent } from './agent-chat/agent-defs.js'
import { frameAndScan } from './injection-telemetry.js'
import { askQuestion, getDecision, recordAnswer, redactDecisionText } from './decisions.js'

export interface DecisionAnswerInput {
  decision: DecisionView
  objective: Objective | null
  question: string
}

export interface DecisionAnswer {
  text: string
  /** Display name of who answered. */
  by: string
}

export type DecisionAnswerer = (input: DecisionAnswerInput) => Promise<DecisionAnswer>

const ANSWER_TIMEOUT_MS = 90_000

let override: DecisionAnswerer | null = null
/** Tests: replace the answerer (null restores the real one). */
export function setDecisionAnswerer(a: DecisionAnswerer | null): void {
  override = a
}

function pickAgent(decision: DecisionView, objective: Objective | null): ChatAgent | null {
  const candidates = [decision.agent_slug, objective?.owner_bot ?? null, objective?.agent_context ?? null]
  for (const slug of candidates) {
    if (!slug) continue
    const a = findAgent(slug)
    if (a) return a
  }
  try {
    return listAgents().agents[0] ?? null
  } catch {
    return null
  }
}

/** The prompt the answering bot gets. Exported for tests. */
export function answerPrompt(input: DecisionAnswerInput, botName: string): { system: string; user: string } {
  const { decision: d, objective: o } = input
  const b = d.briefing
  const briefing = [
    `Context: ${b.context || '(none given)'}`,
    `Question: ${b.question || '(none given — the raise had no briefing)'}`,
    ...b.options.map(opt =>
      `Option ${opt.key}: ${opt.label}${opt.key === b.recommended ? ' (recommended)' : ''}\n  pros: ${opt.pros.join('; ')}\n  cons: ${opt.cons.join('; ')}\n  next: ${opt.next}`,
    ),
    b.recommended_why ? `Why recommended: ${b.recommended_why}` : '',
    d.raw_note ? `Original note: ${d.raw_note}` : '',
  ].filter(Boolean).join('\n')
  const earlier = d.thread
    .filter(m => m.role !== 'system')
    .slice(-8)
    .map(m => `${m.role === 'human' ? 'Person' : botName}: ${m.body}`)
    .join('\n')
  const card = o
    ? frameAndScan(
        {
          source: 'card-summary',
          scope: o.workspace ?? null,
          label: `card #${o.id}`,
          text: [
            `Title: ${o.title}`,
            `Status: ${o.status}`,
            o.description ? `Description: ${String(o.description).slice(0, 3000)}` : '',
            o.last_session_summary ? `Latest summary: ${String(o.last_session_summary).slice(0, 3000)}` : '',
            (o as Objective & { job_review_note?: string | null }).job_review_note
              ? `Review note: ${(o as Objective & { job_review_note?: string | null }).job_review_note}`
              : '',
          ].filter(Boolean).join('\n'),
          maxChars: 7000,
        },
        { objectiveId: o.id, workspace: o.workspace ?? null },
      )
    : '(the card no longer exists)'
  const system = [
    `You are ${botName}. You asked a person to make a decision on card #${d.objective_id}, and they have a question about it before they choose.`,
    'Answer their question directly, in plain words, in under 120 words. Use the briefing and the card context below. If you do not know, say so and say what you would check.',
    'Do not take any action, do not decide for them and do not claim anything was approved: approve/deny stays with the person, right under your answer.',
    'Do not repeat the whole briefing; answer only what was asked.',
  ].join('\n')
  const user = [
    '## The decision you raised',
    briefing,
    '',
    '## The card',
    card,
    earlier ? `\n## The thread so far\n${earlier}` : '',
    '',
    '## Their question',
    input.question,
  ].join('\n')
  // The question reaches us before storage, and the card text is quoted raw:
  // redact the whole prompt so a pasted key never goes to the model provider.
  return { system, user: redactDecisionText(user) }
}

const realAnswerer: DecisionAnswerer = async input => {
  const agent = pickAgent(input.decision, input.objective)
  if (!agent) throw new Error('no bot is installed to answer')
  const provider = createProvider(chooseProviderId(agent, installDefaultProvider()), agent)
  const { system, user } = answerPrompt(input, agent.name)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ANSWER_TIMEOUT_MS)
  timer.unref?.()
  try {
    const out = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], agent, signal: ac.signal })
    const text = (out.content ?? '').trim()
    if (!text) throw new Error('the bot gave an empty answer')
    return { text, by: agent.name }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Record the question, ask the bot, store its answer. Returns the question row
 * immediately; the answer lands asynchronously (the promise resolves with it).
 */
export function askAndAnswer(
  db: Database.Database,
  decisionId: number,
  p: { author: string; body: string },
): { question: ReturnType<typeof askQuestion>; answered: Promise<void> } {
  const question = askQuestion(db, decisionId, p)
  const answered = (async () => {
    const decision = getDecision(db, decisionId)
    if (!decision) return
    const objective = (db.prepare('SELECT * FROM objectives WHERE id = ?').get(decision.objective_id) as Objective | undefined) ?? null
    try {
      const a = await (override ?? realAnswerer)({ decision, objective, question: question.body })
      recordAnswer(db, question.id, { body: a.text, author: a.by })
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      recordAnswer(db, question.id, {
        body: `The bot could not answer just now (${why.slice(0, 160)}). Ask again, or decide with what is above.`,
        author: null,
        failed: true,
      })
    }
  })()
  return { question, answered }
}
