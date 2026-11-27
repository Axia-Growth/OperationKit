/**
 * Outcome-first intake (obj 901764).
 *
 * A person states the OUTCOME they want in plain language ("before-and-after
 * screenshots on every PR", "a contact form on the site that emails sales").
 * A bot that can file cards turns it into a PROPOSED breakdown with the
 * `propose_outcome` chat tool: one card, its checkable "done when", its
 * acceptance criteria, any child cards, and any standing rule the person asked
 * for. Nothing is filed yet. The person sees the breakdown in the chat, edits
 * it, and presses "Approve and start". Only then are the cards filed (through
 * the same guarded path every chat-filed card uses) and started.
 *
 * The person owns the problem and the definition of done; skills, tools and
 * knowledge folders stay an implementation detail they never pick.
 *
 * Standing outcome rules ("before-and-after screenshots on every PR") are a
 * per-workspace list (`outcome_rules`), not a skill file. On approval each rule
 * the person kept ticked is frozen into the card's acceptance criteria as
 * `rule-<id>`, so the independent reviewer grades it like any other criterion.
 *
 * This file is the ONE definition of the proposal shape and its checks. The
 * chat tool, the approve route and the chat panel all read it. No imports: it
 * must load in the browser and in Node alike.
 */

export type CriterionType = 'functional' | 'visual' | 'data'
export type CriterionMethod = 'browser' | 'api' | 'doc'

export interface OutcomeCriterion {
  id: string
  criterion: string
  type: CriterionType
  method: CriterionMethod
}

/** One card of a proposed breakdown (the outcome card, or one child). */
export interface OutcomeCardDraft {
  title: string
  /** What to do and the context. Becomes the card description. */
  brief: string
  /** ONE checkable statement of done. Becomes the card's completion goal. */
  done_when: string
  criteria: OutcomeCriterion[]
  stop_conditions: string[]
}

export type RuleScope = 'pr' | 'all'

/** A standing rule the person may save with this proposal. */
export interface SuggestedRule {
  text: string
  applies_to: RuleScope
  /** Save it on approval. Defaults to true; the person can untick it. */
  save: boolean
}

export interface OutcomeProposal {
  /** The person's own words, kept verbatim so the breakdown can be checked against them. */
  outcome: string
  card: OutcomeCardDraft
  children: OutcomeCardDraft[]
  suggested_rules: SuggestedRule[]
  /**
   * Standing rules already saved for the workspace that the person chose NOT to
   * apply to these cards. Default empty = every saved rule applies.
   */
  skip_rule_ids: number[]
}

export interface OutcomeRule {
  id: number
  workspace: string
  text: string
  applies_to: RuleScope
  created_by: number | null
  created_at: string
}

export type ProposalStatus = 'pending' | 'approving' | 'approved' | 'discarded'

export const MAX_OUTCOME_CHARS = 2000
export const MAX_TITLE_CHARS = 200
export const MAX_BRIEF_CHARS = 8000
export const MAX_DONE_WHEN_CHARS = 1000
export const MAX_CRITERIA = 10
export const MAX_CRITERION_CHARS = 500
export const MAX_CHILDREN = 6
export const MAX_STOP_LINES = 8
export const MAX_RULE_CHARS = 300
export const MAX_RULES_PER_WORKSPACE = 20
export const MAX_SUGGESTED_RULES = 5

const TYPES: readonly CriterionType[] = ['functional', 'visual', 'data']
const METHODS: readonly CriterionMethod[] = ['browser', 'api', 'doc']

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max).trim() : ''
}

function oneLine(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().replace(/^(?:[-*•]\s+)+/, '').slice(0, max).trim() : ''
}

/**
 * Drop leading and trailing '-' in one linear pass. Replaces `/^-+|-+$/g`, which
 * CodeQL flags as a polynomial regex on uncontrolled input (js/polynomial-redos):
 * `-+$` is retried at every dash of a long run that is not at the end.
 */
function trimDashes(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && s.charCodeAt(start) === 45) start++
  while (end > start && s.charCodeAt(end - 1) === 45) end--
  return s.slice(start, end)
}

/** A criterion id: lowercase kebab, unique within the card. */
function slugId(raw: string, n: number): string {
  const s = trimDashes(raw.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 40)
  return s || `c${n}`
}

/**
 * The criteria a caller sent, as a clean list. Accepts objects
 * (`{criterion, type?, method?, id?}`) or bare strings. Blank and repeated
 * lines are dropped; a `rule-*` id is reserved for standing rules and is
 * re-numbered so a bot cannot forge one.
 */
export function normalizeCriteria(raw: unknown): OutcomeCriterion[] {
  const items: unknown[] = Array.isArray(raw) ? raw : []
  const out: OutcomeCriterion[] = []
  const seenText = new Set<string>()
  const seenId = new Set<string>()
  for (const item of items) {
    const obj = (item && typeof item === 'object' ? item : { criterion: item }) as Record<string, unknown>
    const criterion = oneLine(obj.criterion ?? obj.text, MAX_CRITERION_CHARS)
    if (!criterion) continue
    const key = criterion.toLowerCase()
    if (seenText.has(key)) continue
    seenText.add(key)
    const type = TYPES.includes(obj.type as CriterionType) ? (obj.type as CriterionType) : 'functional'
    const method = METHODS.includes(obj.method as CriterionMethod) ? (obj.method as CriterionMethod) : 'doc'
    let id = slugId(typeof obj.id === 'string' ? obj.id : '', out.length + 1)
    if (id.startsWith('rule-')) id = `c${out.length + 1}`
    while (seenId.has(id)) id = `${id}-${out.length + 1}`
    seenId.add(id)
    out.push({ id, criterion, type, method })
    if (out.length >= MAX_CRITERIA) break
  }
  return out
}

function normalizeStopLines(raw: unknown): string[] {
  const items: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\r?\n/) : []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const line = oneLine(item, 300)
    if (!line || seen.has(line.toLowerCase())) continue
    seen.add(line.toLowerCase())
    out.push(line)
    if (out.length >= MAX_STOP_LINES) break
  }
  return out
}

function normalizeCard(raw: unknown): OutcomeCardDraft {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    title: oneLine(o.title, MAX_TITLE_CHARS),
    brief: text(o.brief ?? o.description, MAX_BRIEF_CHARS),
    done_when: oneLine(o.done_when, MAX_DONE_WHEN_CHARS),
    criteria: normalizeCriteria(o.criteria ?? o.acceptance_criteria),
    stop_conditions: normalizeStopLines(o.stop_conditions),
  }
}

export function normalizeRuleScope(v: unknown): RuleScope {
  return v === 'all' ? 'all' : 'pr'
}

/** A standing rule's text, as one clean line ('' = not a rule). */
export function normalizeRuleText(v: unknown): string {
  return oneLine(v, MAX_RULE_CHARS)
}

function normalizeSuggestedRules(raw: unknown): SuggestedRule[] {
  const items: unknown[] = Array.isArray(raw) ? raw : []
  const out: SuggestedRule[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const o = (item && typeof item === 'object' ? item : { text: item }) as Record<string, unknown>
    const t = normalizeRuleText(o.text ?? o.rule)
    if (!t || seen.has(t.toLowerCase())) continue
    seen.add(t.toLowerCase())
    out.push({ text: t, applies_to: normalizeRuleScope(o.applies_to), save: o.save !== false })
    if (out.length >= MAX_SUGGESTED_RULES) break
  }
  return out
}

/** Where a card in the proposal stands, for error messages a person can act on. */
function where(i: number | null, title: string): string {
  if (i === null) return 'The outcome card'
  return `Child card ${i + 1}${title ? ` ("${title}")` : ''}`
}

function cardErrors(c: OutcomeCardDraft, i: number | null): string[] {
  const w = where(i, c.title)
  const errs: string[] = []
  if (!c.title) errs.push(`${w} needs a title`)
  if (!c.brief) errs.push(`${w} needs a brief (what to do and why)`)
  if (!c.done_when) errs.push(`${w} needs "done when": one checkable statement of what done looks like`)
  if (c.criteria.length === 0) errs.push(`${w} needs at least one acceptance criterion a reviewer can check`)
  return errs
}

export type NormalizeResult = { ok: true; proposal: OutcomeProposal } | { ok: false; errors: string[]; proposal: OutcomeProposal }

/**
 * Turn whatever a bot or the panel sent into a clean proposal, plus the gaps
 * that stop it being filed. Every card needs a title, a brief, a "done when"
 * and at least one criterion: the definition of done is never left implicit.
 */
export function normalizeProposal(raw: unknown): NormalizeResult {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const childrenRaw: unknown[] = Array.isArray(o.children) ? o.children : []
  const proposal: OutcomeProposal = {
    outcome: text(o.outcome, MAX_OUTCOME_CHARS),
    card: normalizeCard(o.card ?? o),
    children: childrenRaw.slice(0, MAX_CHILDREN).map(normalizeCard),
    suggested_rules: normalizeSuggestedRules(o.suggested_rules ?? o.standing_rules),
    skip_rule_ids: (Array.isArray(o.skip_rule_ids) ? o.skip_rule_ids : [])
      .map(Number)
      .filter((n): n is number => Number.isInteger(n) && n > 0),
  }
  const errors: string[] = []
  if (!proposal.outcome) errors.push('outcome is required: the person\'s own words for what they want')
  errors.push(...cardErrors(proposal.card, null))
  proposal.children.forEach((c, i) => errors.push(...cardErrors(c, i)))
  if (childrenRaw.length > MAX_CHILDREN) errors.push(`At most ${MAX_CHILDREN} child cards; merge the smaller parts`)
  const titles = new Set<string>([proposal.card.title.toLowerCase()])
  for (const c of proposal.children) {
    const t = c.title.toLowerCase()
    if (t && titles.has(t)) errors.push(`Two cards are both titled "${c.title}"; give each card its own title`)
    titles.add(t)
  }
  return errors.length ? { ok: false, errors, proposal } : { ok: true, proposal }
}

/** The criterion id a standing rule is frozen under. */
export function ruleCriterionId(ruleId: number): string {
  return `rule-${ruleId}`
}

/**
 * A standing rule as an acceptance criterion. A PR-only rule says so in its own
 * words, so the reviewer skips it on a card that opened no pull request instead
 * of failing it.
 */
export function ruleCriterion(rule: Pick<OutcomeRule, 'id' | 'text' | 'applies_to'>): OutcomeCriterion {
  const criterion = rule.applies_to === 'pr'
    ? `Standing rule for every pull request: ${rule.text} (If this card opens no pull request, mark this criterion skipped.)`
    : `Standing rule: ${rule.text}`
  return { id: ruleCriterionId(rule.id), criterion, type: 'functional', method: 'doc' }
}

/** A card's criteria plus the standing rules that apply to it, never twice. */
export function withRuleCriteria(criteria: OutcomeCriterion[], rules: Pick<OutcomeRule, 'id' | 'text' | 'applies_to'>[]): OutcomeCriterion[] {
  const out = [...criteria]
  const ids = new Set(out.map(c => c.id))
  for (const r of rules) {
    const c = ruleCriterion(r)
    if (ids.has(c.id)) continue
    ids.add(c.id)
    out.push(c)
  }
  return out
}

/**
 * The approved breakdown as the card's approved plan (the planning stage's
 * own column, rendered to the worker as "Approved Plan — EXECUTE THIS").
 * `childIds` are the card numbers the children were filed as, in order.
 */
export function renderApprovedBreakdown(p: OutcomeProposal, opts: { approvedBy: string; childIds?: number[] }): string {
  const lines: string[] = [
    `Approved by ${opts.approvedBy} from the outcome they stated:`,
    '',
    ...p.outcome.split('\n').map(l => `> ${l}`),
    '',
    `Done when: ${p.card.done_when}`,
  ]
  if (p.children.length > 0) {
    lines.push(
      '',
      `This outcome is split into ${p.children.length} child card(s). They were filed under this card and run in parallel as a fan-out (the server starts them under its concurrency limit):`,
      '',
    )
    p.children.forEach((c, i) => {
      const id = opts.childIds?.[i]
      lines.push(`${i + 1}. ${id ? `#${id} ` : ''}${c.title} — done when: ${c.done_when}`)
    })
    lines.push(
      '',
      'Your part: do NOT redo or re-file the child cards. Watch them (`cc-live.mjs children <this card>`), and when they have all finished, check THIS card\'s acceptance criteria end to end across their results, do any integration the outcome still needs, and report. If a child is blocked or failed, say which and why instead of doing its work yourself.',
    )
  }
  lines.push('', 'The acceptance criteria below were approved with this breakdown. An independent reviewer grades the work against them; you do not grade yourself.')
  return lines.join('\n')
}
