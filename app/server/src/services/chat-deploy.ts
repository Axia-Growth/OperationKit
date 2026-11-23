/**
 * "Deploy on your word" — a hot deploy from chat, only when the owner says so
 * (obj 901393).
 *
 * The owner chose option C on decision #34 (card #901383): Operation Kit Dev may
 * deploy from chat, but ONLY when the owner asks for it in that chat, each time.
 * This module is the server side of the chat tool `deploy_on_owner_word`
 * (agent-chat/chat-deploy-tool.ts). Every call is re-checked here, in order, and
 * every call — allowed or refused — writes one `chat_deploys` row:
 *
 *  1. the install switch `settings.chat_deploy_enabled = '1'` (no row = OFF);
 *  2. not a wake turn (card wake, bot-to-bot wake): only a live chat turn;
 *  3. the bot is on `settings.chat_deploy_bots` (no row = operation-kit-dev);
 *  4. the person is an admin AND the latest message in the lane is theirs, was
 *     typed in the browser (`meta.owner_browser`, stamped by the server from how
 *     the POST authenticated), belongs to THIS turn, asks for a deploy (read from
 *     the stored text, not from the model), and was not already used by an
 *     earlier deploy: one say-so = one deploy;
 *  5. the chat's workspace owns the install's own repo (`selfRepo()`);
 *  6. there is a live checkout (`DRIFT_GUARD` is not off);
 *  7. no deploy running, and none inside the shared auto-deploy debounce window
 *     (same lock file as services/auto-deploy.ts);
 *  8. the live checkout is clean and not ahead (`runDriftCheck()`, which fetches);
 *  9. something to deploy (HEAD behind origin/main);
 * 10. no migration (`lib/migration-paths.ts`, the SAME rule as the "Merged,
 *     waiting for deploy" flag — a `db/schema/*.ts` change runs at server start,
 *     so a restart IS the migration);
 * 11. no rebuild (Dockerfile, docker-compose, package.json, lockfiles);
 * 12. if the mode restarts the backend: no card is working (it says how many).
 *
 * Then it spawns `scripts/self-deploy.sh <mode>` DETACHED (it outlives the very
 * restart it causes), pinned to the origin/main commit the owner was shown
 * (`CC_DEPLOY_EXPECT_SHA`: if main moved meanwhile, the script refuses). Never
 * `--force`, never a rebuild. The script's exit code and log land in files;
 * `settleChatDeploys` (run by the reconciler after the restart) turns them into
 * deployed / rolled_back / failed, and agent-chat/chat-deploy-report.ts posts the
 * outcome into the same chat thread.
 *
 * Full access and delegation grants are NOT consulted: neither stands in for the
 * owner's word. `POST /api/internal/deploy`, `auto_deploy_enabled` and
 * `auto_merge_enabled` are not read or changed.
 */
import { execFileSync, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Database } from 'better-sqlite3'
import { CC_REPO_DIR } from '../config.js'
import { migrationPaths } from '../lib/migration-paths.js'
import { DEPLOY_DEBOUNCE_MS, deployLockAgeMs, SELF_DEPLOY_REPO_DIR, SELF_DEPLOY_SCRIPT, selfRepo, writeDeployLock } from './auto-deploy.js'
import { collectDeployStatus, type DeployStatus, type WaitingEntry } from './deploy-waiting.js'
import { runDriftCheck, type DriftResult } from './drift-guard.js'
import { redactForStorage } from './secret-redaction.js'

export const CHAT_DEPLOY_SETTING = 'chat_deploy_enabled'
export const CHAT_DEPLOY_BOTS_SETTING = 'chat_deploy_bots'
export const DEFAULT_CHAT_DEPLOY_BOTS = ['operation-kit-dev'] as const
/** A `started` row older than this with no result is settled as failed. */
export const CHAT_DEPLOY_RESULT_TIMEOUT_MS = 20 * 60_000

export type DeployMode = 'frontend' | 'backend' | 'both'
export type ChatDeployOutcome = 'refused' | 'started' | 'deployed' | 'rolled_back' | 'failed'

export type RefusalCode =
  | 'disabled'
  | 'wake_turn'
  | 'bot_not_allowed'
  | 'not_owner'
  | 'not_owner_browser'
  | 'no_ask_this_turn'
  | 'no_deploy_ask'
  | 'ask_already_used'
  | 'no_self_repo'
  | 'not_self_repo_workspace'
  | 'no_live_checkout'
  | 'deploy_running'
  | 'debounced'
  | 'git_unreadable'
  | 'drift'
  | 'nothing_to_deploy'
  | 'migration_needed'
  | 'rebuild_needed'
  | 'cards_working'
  | 'spawn_failed'

export interface ChatDeployPr {
  pr_number: number | null
  title: string
  card_id: number | null
  short_sha: string
}

export interface ChatDeployResult {
  deploy_id: number
  outcome: 'refused' | 'started' | 'failed'
  code: RefusalCode | 'started'
  /** One plain sentence for the owner. */
  message: string
  mode: DeployMode | null
  from_commit: string | null
  to_commit: string | null
  prs: ChatDeployPr[]
  /** Paths that triggered a migration / rebuild refusal (at most a handful). */
  paths?: string[]
  working_cards?: number
}

export interface ChatDeployRequest {
  userId: number
  username: string
  agentSlug: string
  botName: string
  workspace: string
  /** null = the bot's main conversation. */
  threadId: number | null
  /** Ids of the person's messages delivered by THIS turn (ToolContext.turnMessageIds). */
  turnMessageIds: readonly number[]
  /** True for a card wake or a bot-to-bot wake. */
  wake: boolean
}

export interface SpawnJob {
  id: number
  mode: DeployMode
  expectSha: string
  logPath: string
  exitPath: string
}

/** Everything that touches the host. Tests replace these; production uses the defaults. */
export interface ChatDeployDeps {
  driftCheck: () => DriftResult
  deployStatus: (db: Database) => DeployStatus
  /** `git -C <live checkout> <args>` → trimmed stdout. */
  git: (args: string[]) => string
  spawnDeploy: (job: SpawnJob) => void
  lockAgeMs: () => number | null
  writeLock: (reason: string) => void
  selfRepo: () => string
  now: () => Date
  env: NodeJS.ProcessEnv
  dir: () => string
}

function defaultGit(args: string[]): string {
  return execFileSync('git', ['-C', CC_REPO_DIR, ...args], { encoding: 'utf-8', timeout: 15_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function defaultSpawn(job: SpawnJob): void {
  // `bash -c` wrapper: run the script with its output in a log, then write the
  // exit code atomically. Detached + unref so it survives the server restart.
  const child = spawn(
    'bash',
    ['-c', 'bash "$0" "$1" > "$2" 2>&1; code=$?; echo "$code" > "$3.tmp" && mv "$3.tmp" "$3"', SELF_DEPLOY_SCRIPT, job.mode, job.logPath, job.exitPath],
    { detached: true, stdio: 'ignore', cwd: SELF_DEPLOY_REPO_DIR, env: { ...process.env, CC_DEPLOY_EXPECT_SHA: job.expectSha } },
  )
  child.unref()
}

const DEFAULT_DEPS: ChatDeployDeps = {
  driftCheck: () => runDriftCheck(),
  deployStatus: db => collectDeployStatus(db),
  git: defaultGit,
  spawnDeploy: defaultSpawn,
  lockAgeMs: () => deployLockAgeMs(),
  writeLock: reason => writeDeployLock(reason),
  selfRepo: () => selfRepo(),
  now: () => new Date(),
  env: process.env,
  dir: () => process.env.CC_CHAT_DEPLOY_DIR || path.join(os.tmpdir(), 'cc-chat-deploys'),
}

let overrides: Partial<ChatDeployDeps> = {}
/** Test hook: replace host-touching deps. Pass `{}` to reset. */
export function __setChatDeployDeps(d: Partial<ChatDeployDeps>): void {
  overrides = d
}
function deps(): ChatDeployDeps {
  return { ...DEFAULT_DEPS, ...overrides }
}

// ── settings ──

function readSetting(db: Database, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined
    return row?.value ?? null
  } catch {
    return null
  }
}

/** The install switch. Default OFF; only '1' (or 'true') turns it on. Read at call time. */
export function isChatDeployEnabled(db: Database): boolean {
  const v = (readSetting(db, CHAT_DEPLOY_SETTING) ?? '').trim().toLowerCase()
  return v === '1' || v === 'true'
}

/** Which chat bots may offer the tool. No row = operation-kit-dev only; '' or '0' = none. */
export function chatDeployBots(db: Database): string[] {
  const raw = readSetting(db, CHAT_DEPLOY_BOTS_SETTING)
  if (raw == null) return [...DEFAULT_CHAT_DEPLOY_BOTS]
  if (raw.trim() === '0') return []
  return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

export function setChatDeployEnabled(db: Database, on: boolean): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(CHAT_DEPLOY_SETTING, on ? '1' : '0')
}

/**
 * Should the chat tool be OFFERED for this turn? Switch on, allowed bot, admin,
 * and the chat's workspace owns the install's repo. A convenience only: every
 * call is re-checked by runChatDeploy.
 */
export function chatDeployOfferable(db: Database, who: { slug: string; userId: number; workspace: string }): boolean {
  try {
    if (!isChatDeployEnabled(db)) return false
    if (!chatDeployBots(db).includes(who.slug.toLowerCase())) return false
    const role = (db.prepare('SELECT role FROM users WHERE id = ?').get(who.userId) as { role?: string } | undefined)?.role
    if (role !== 'admin') return false
    return workspaceOwnsRepo(db, who.workspace, deps().selfRepo())
  } catch {
    return false
  }
}

// ── pure rules ──

/** "https://github.com/Owner/Repo.git" / "Owner/Repo" → "owner/repo". */
export function normalizeRepo(s: string | null | undefined): string {
  return String(s || '')
    .trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Does `workspace` own this install's own repo (a `workspace_repos.github` row naming it)? */
export function workspaceOwnsRepo(db: Database, workspace: string, repo: string): boolean {
  const want = normalizeRepo(repo)
  if (!workspace || !want) return false
  try {
    const rows = db.prepare('SELECT github FROM workspace_repos WHERE workspace = ?').all(workspace) as { github: string | null }[]
    return rows.some(r => normalizeRepo(r.github) === want)
  } catch {
    return false
  }
}

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/i

/** A change that needs the image rebuilt (never a hot deploy). */
export function isRebuildPath(file: string): boolean {
  const p = String(file || '').trim().replace(/^\.?\//, '')
  if (!p || TEST_FILE.test(p)) return false
  const base = p.split('/').pop() || ''
  if (/^Dockerfile(\..+)?$/i.test(base) || /\.dockerfile$/i.test(base)) return true
  if (/^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i.test(base)) return true
  if (base === 'package.json') return true
  if (['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'].includes(base)) return true
  return false
}

export function rebuildPaths(files: readonly string[]): string[] {
  return Array.from(new Set(files.filter(isRebuildPath)))
}

/**
 * The deploy mode the changed files need. Client code → frontend; server code →
 * backend; shared types (used by both), or client + server → both. Anything else
 * (docs, scripts, smoke evidence) needs no restart: frontend (a build in place).
 */
export function deployModeFor(files: readonly string[]): DeployMode {
  let fe = false
  let be = false
  for (const raw of files) {
    const f = String(raw || '').replace(/^\.?\//, '')
    if (f.startsWith('app/shared/')) { fe = true; be = true }
    else if (f.startsWith('app/client/')) fe = true
    else if (f.startsWith('app/server/')) be = true
  }
  if (fe && be) return 'both'
  if (be) return 'backend'
  return 'frontend'
}

export function restartsBackend(mode: DeployMode): boolean {
  return mode === 'backend' || mode === 'both'
}

const NEGATION = /\b(don'?t|do not|dont|never|not yet|no need to|hold off|without deploying|wait (on|before|with)|stop)\b[^.!?\n]*\b(deploy|ship|live)/i
const DEPLOY_WORD = /\b(deploy|redeploy|ship it|ship them|ship that|ship this|go live|push (it |them |this )?live|make (it |them |this )?live)\b/i
const QUESTION_ONLY = /\b(should|would|what|which|when|why|how|is|are|will|did|has|have)\b[^?]*\b(deploy|live)\b[^?]*\?\s*$/i
const POLITE_ASK = /\b(can|could|would) you\b|\bplease\b|\bgo ahead\b/i

/**
 * Does this stored message ask for a deploy? A plain, conservative reading:
 * a deploy word, no negation in front of it, and not a pure question about it
 * ("should we deploy?" is a question; "can you deploy now?" is an ask).
 */
export function asksForDeploy(text: string): boolean {
  const t = String(text || '').trim()
  if (!t || t.length > 2000) return false
  if (!DEPLOY_WORD.test(t)) return false
  if (NEGATION.test(t)) return false
  if (QUESTION_ONLY.test(t) && !POLITE_ASK.test(t)) return false
  return true
}

// ── the owner's ask ──

interface StoredMsg { id: number; role: string; content: string; meta: string | null }

/** The newest delivered (not queued) row from the person in this lane. */
export function latestPersonMessage(db: Database, userId: number, slug: string, threadId: number | null): { id: number; content: string; ownerBrowser: boolean } | null {
  const row = db
    .prepare(
      `SELECT id, role, content, meta FROM agent_chat_messages
        WHERE user_id = ? AND agent_slug = ? AND ${threadId == null ? 'thread_id IS NULL' : 'thread_id = ?'} AND role = 'user'
          AND COALESCE(json_extract(meta, '$.queued'), 0) = 0
        ORDER BY id DESC LIMIT 1`,
    )
    .get(...(threadId == null ? [userId, slug] : [userId, slug, threadId])) as StoredMsg | undefined
  if (!row) return null
  let meta: Record<string, unknown> = {}
  try { meta = row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {} } catch { meta = {} }
  return { id: row.id, content: row.content, ownerBrowser: meta.owner_browser === true }
}

// ── audit ──

interface AuditRow {
  user_id: number
  username: string
  agent_slug: string
  bot_name: string
  workspace: string
  thread_id: number | null
  message_id: number | null
  from_commit: string | null
  to_commit: string | null
  prs: ChatDeployPr[]
  mode: DeployMode | null
  outcome: ChatDeployOutcome
  reason: string | null
  detail: string | null
}

function writeAudit(db: Database, r: AuditRow): number {
  const info = db
    .prepare(
      `INSERT INTO chat_deploys (user_id, username, agent_slug, bot_name, workspace, thread_id, message_id, from_commit, to_commit, prs_json, mode, outcome, reason, detail, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      r.user_id, r.username, r.agent_slug, r.bot_name, r.workspace, r.thread_id, r.message_id,
      r.from_commit, r.to_commit, JSON.stringify(r.prs), r.mode, r.outcome, r.reason, r.detail,
      r.outcome === 'started' ? null : new Date().toISOString(),
    )
  return Number(info.lastInsertRowid)
}

export interface ChatDeployRow {
  id: number
  user_id: number
  username: string
  agent_slug: string
  bot_name: string
  workspace: string
  thread_id: number | null
  message_id: number | null
  from_commit: string | null
  to_commit: string | null
  prs: ChatDeployPr[]
  mode: DeployMode | null
  outcome: ChatDeployOutcome
  reason: string | null
  detail: string | null
  created_at: string
  finished_at: string | null
  reported_at: string | null
}

function mapRow(r: Record<string, unknown>): ChatDeployRow {
  let prs: ChatDeployPr[] = []
  try { prs = JSON.parse(String(r.prs_json || '[]')) as ChatDeployPr[] } catch { prs = [] }
  const { prs_json: _drop, ...rest } = r
  return { ...(rest as unknown as Omit<ChatDeployRow, 'prs'>), prs }
}

export function getChatDeploy(db: Database, id: number): ChatDeployRow | null {
  const r = db.prepare('SELECT * FROM chat_deploys WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return r ? mapRow(r) : null
}

/** The newest chat deploy that got past the gates (started or finished), else the newest refusal. */
export function lastChatDeploy(db: Database): ChatDeployRow | null {
  try {
    const r = (db.prepare("SELECT * FROM chat_deploys WHERE outcome != 'refused' ORDER BY id DESC LIMIT 1").get() ??
      db.prepare('SELECT * FROM chat_deploys ORDER BY id DESC LIMIT 1').get()) as Record<string, unknown> | undefined
    return r ? mapRow(r) : null
  } catch {
    return null
  }
}

// ── the call ──

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 8) : 'unknown'
}

export function prList(prs: readonly ChatDeployPr[]): string {
  if (prs.length === 0) return 'no pull requests'
  return prs
    .map(p => (p.pr_number != null ? `PR #${p.pr_number}` : `commit ${p.short_sha}`) + (p.title ? ` "${p.title}"` : '') + (p.card_id != null ? ` (card #${p.card_id})` : ''))
    .join(', ')
}

function prsFrom(waiting: readonly WaitingEntry[]): ChatDeployPr[] {
  // Oldest first reads better in a list of what goes live.
  return [...waiting].reverse().map(w => ({ pr_number: w.pr_number, title: w.title, card_id: w.card_id, short_sha: w.short_sha }))
}

function workingCards(db: Database): number {
  try {
    const r = db
      .prepare("SELECT COUNT(*) AS n FROM objectives WHERE status = 'working' AND session_id IS NOT NULL AND deleted_at IS NULL")
      .get() as { n: number }
    return Number(r.n) || 0
  } catch {
    return 0
  }
}

/** Run one chat deploy request through every gate; start it or refuse it. Always writes one audit row. Never throws. */
export function runChatDeploy(db: Database, req: ChatDeployRequest): ChatDeployResult {
  const d = deps()
  const base: Omit<AuditRow, 'outcome' | 'reason' | 'detail'> = {
    user_id: req.userId,
    username: req.username,
    agent_slug: req.agentSlug,
    bot_name: req.botName,
    workspace: req.workspace,
    thread_id: req.threadId,
    message_id: null,
    from_commit: null,
    to_commit: null,
    prs: [],
    mode: null,
  }
  const refuse = (code: RefusalCode, message: string, extra: Partial<ChatDeployResult> = {}): ChatDeployResult => {
    let id = 0
    try {
      id = writeAudit(db, { ...base, mode: extra.mode ?? base.mode, prs: extra.prs ?? base.prs, outcome: code === 'spawn_failed' ? 'failed' : 'refused', reason: code, detail: message })
    } catch (err) {
      console.warn('[chat-deploy] audit write failed:', (err as Error).message)
    }
    console.log(`[chat-deploy] #${id} refused (${code}) for ${req.username} via ${req.agentSlug}: ${message}`)
    return {
      deploy_id: id,
      outcome: code === 'spawn_failed' ? 'failed' : 'refused',
      code,
      message,
      mode: base.mode,
      from_commit: base.from_commit,
      to_commit: base.to_commit,
      prs: base.prs,
      ...extra,
    }
  }

  // 1. the switch
  if (!isChatDeployEnabled(db)) return refuse('disabled', 'Deploy on your word is switched off on this install (Settings → Platform).')
  // 2. a live chat turn only
  if (req.wake) return refuse('wake_turn', 'A wake turn cannot deploy. Only the owner, in a live chat, can ask for a deploy.')
  // 3. the bot
  if (!chatDeployBots(db).includes(req.agentSlug.toLowerCase())) return refuse('bot_not_allowed', 'This bot is not allowed to deploy from chat.')
  // 4. the owner's word, in this turn
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId) as { role?: string } | undefined
  if (user?.role !== 'admin') return refuse('not_owner', 'Only the owner can ask for a deploy. A team member cannot.')
  const ask = latestPersonMessage(db, req.userId, req.agentSlug, req.threadId)
  if (!ask || !req.turnMessageIds.includes(ask.id)) {
    return refuse('no_ask_this_turn', 'There is no message from the owner in this turn to act on. Ask for the deploy in a new message.')
  }
  base.message_id = ask.id
  if (!ask.ownerBrowser) return refuse('not_owner_browser', 'The ask did not come from the owner signed in in the browser, so it does not count.')
  if (!asksForDeploy(ask.content)) return refuse('no_deploy_ask', 'The owner\'s latest message does not ask for a deploy. I only deploy when the owner says so.')
  const used = db
    .prepare("SELECT id FROM chat_deploys WHERE message_id = ? AND outcome != 'refused' LIMIT 1")
    .get(ask.id) as { id: number } | undefined
  if (used) return refuse('ask_already_used', `That ask was already used by deploy #${used.id}. One say-so is one deploy; ask again for another.`)
  // 5. the install's own repo, owned by this workspace
  const repo = d.selfRepo()
  if (!repo) return refuse('no_self_repo', 'This install has no own repo set (HARNESS_REPO), so there is nothing a chat deploy may ship.')
  if (!workspaceOwnsRepo(db, req.workspace, repo)) {
    return refuse('not_self_repo_workspace', `This chat's workspace (${req.workspace || 'none'}) does not own ${repo}, so it cannot deploy it.`)
  }
  // 6. a live checkout exists
  if ((d.env.DRIFT_GUARD || '').trim().toLowerCase() === 'off') {
    return refuse('no_live_checkout', 'This install runs from an image (DRIFT_GUARD=off). There is no live checkout to hot-deploy.')
  }
  // 7. one deploy at a time, sharing auto-deploy's lock and window
  const now = d.now()
  const running = db
    .prepare("SELECT id, created_at FROM chat_deploys WHERE outcome = 'started' ORDER BY id DESC LIMIT 1")
    .get() as { id: number; created_at: string } | undefined
  if (running && now.getTime() - Date.parse(running.created_at.replace(' ', 'T') + (running.created_at.endsWith('Z') ? '' : 'Z')) < CHAT_DEPLOY_RESULT_TIMEOUT_MS) {
    return refuse('deploy_running', `Deploy #${running.id} is still running. Wait for its result before asking again.`)
  }
  const age = d.lockAgeMs()
  if (age != null && age < DEPLOY_DEBOUNCE_MS) {
    return refuse('debounced', `A deploy ran ${Math.round(age / 1000)}s ago. Wait ${Math.ceil((DEPLOY_DEBOUNCE_MS - age) / 1000)}s and ask again.`)
  }
  // 8. clean and not divergent (this call fetches origin/main)
  const drift = d.driftCheck()
  if (!drift.ok) return refuse('git_unreadable', 'The live checkout could not be read, so what would go live is unknown.')
  if (drift.dirtyServedFiles.length > 0 || drift.ahead > 0) {
    return refuse('drift', `The live checkout is dirty or ahead of main (${drift.reasons.join(' ') || 'drift'}). A dirty or divergent tree is never deployed.`)
  }
  // 9. something to deploy
  const status = d.deployStatus(db)
  if (!status.ok || !status.head || !status.origin_main) return refuse('git_unreadable', status.error || 'The live checkout could not be compared with main.')
  base.from_commit = status.head
  base.to_commit = status.origin_main
  if (status.dirty_served_files.length > 0 || status.ahead > 0) {
    return refuse('drift', 'The live checkout is dirty or ahead of main. A dirty or divergent tree is never deployed.')
  }
  if (status.head === status.origin_main || status.waiting.length === 0) {
    return refuse('nothing_to_deploy', 'Nothing to deploy: the live checkout is already at main.')
  }
  base.prs = prsFrom(status.waiting)
  let files: string[]
  try {
    files = d.git(['log', '--name-only', '--format=', `${status.head}..${status.origin_main}`]).split('\n').map(s => s.trim()).filter(Boolean)
  } catch (err) {
    return refuse('git_unreadable', `The changed files could not be read: ${(err as Error).message.split('\n')[0]}`)
  }
  // 10. migration (same rule as the waiting list's flag)
  const mig = Array.from(new Set([...migrationPaths(files), ...status.waiting.flatMap(w => w.migration_paths)]))
  if (mig.length > 0 || status.waiting.some(w => w.migration)) {
    return refuse('migration_needed', `A database migration is waiting (${mig.slice(0, 3).join(', ')}${mig.length > 3 ? ` +${mig.length - 3}` : ''}). A restart would run it, so the owner deploys this one.`, { paths: mig.slice(0, 10) })
  }
  // 11. rebuild
  const rb = rebuildPaths(files)
  if (rb.length > 0) {
    return refuse('rebuild_needed', `This needs a container rebuild (${rb.slice(0, 3).join(', ')}${rb.length > 3 ? ` +${rb.length - 3}` : ''}), not a hot deploy, so the owner deploys this one.`, { paths: rb.slice(0, 10) })
  }
  // 12. working cards, if the backend restarts
  const mode = deployModeFor(files)
  base.mode = mode
  if (restartsBackend(mode)) {
    const n = workingCards(db)
    if (n > 0) {
      return refuse('cards_working', `${n} card${n === 1 ? ' is' : 's are'} working, and this deploy restarts the server (mode ${mode}). I do not force it; ask again when they are done.`, { working_cards: n })
    }
  }

  // Start it.
  let id = 0
  try {
    id = writeAudit(db, { ...base, outcome: 'started', reason: null, detail: `Deploying ${prList(base.prs)} (mode ${mode}).` })
  } catch (err) {
    console.warn('[chat-deploy] audit write failed:', (err as Error).message)
    return { deploy_id: 0, outcome: 'failed', code: 'spawn_failed', message: 'The deploy could not be recorded, so it was not started.', mode, from_commit: base.from_commit, to_commit: base.to_commit, prs: base.prs }
  }
  const dir = d.dir()
  const job: SpawnJob = { id, mode, expectSha: status.origin_main, logPath: path.join(dir, `${id}.log`), exitPath: path.join(dir, `${id}.exit`) }
  try {
    fs.mkdirSync(dir, { recursive: true })
    d.writeLock(`chat deploy #${id} by ${req.username} via ${req.agentSlug}`)
    d.spawnDeploy(job)
  } catch (err) {
    const msg = `The deploy script could not be started: ${(err as Error).message.split('\n')[0]}`
    db.prepare("UPDATE chat_deploys SET outcome = 'failed', reason = 'spawn_failed', detail = ?, finished_at = ? WHERE id = ?").run(msg, new Date().toISOString(), id)
    return { deploy_id: id, outcome: 'failed', code: 'spawn_failed', message: msg, mode, from_commit: base.from_commit, to_commit: base.to_commit, prs: base.prs }
  }
  console.log(`[chat-deploy] #${id} started by ${req.username} via ${req.agentSlug}: ${short(base.from_commit)} → ${short(base.to_commit)} (${mode}) ${prList(base.prs)}`)
  const restartNote = restartsBackend(mode)
    ? 'The server restarts for a few seconds; I will post the result here when it is back.'
    : 'No restart is needed; I will post the result here when the build is done.'
  return {
    deploy_id: id,
    outcome: 'started',
    code: 'started',
    message: `Deploying ${prList(base.prs)} (mode ${mode}). ${restartNote}`,
    mode,
    from_commit: base.from_commit,
    to_commit: base.to_commit,
    prs: base.prs,
  }
}

// ── settling a started deploy (after the restart) ──

export interface SettledDeploy {
  row: ChatDeployRow
  outcome: 'deployed' | 'rolled_back' | 'failed'
  detail: string
}

function logTail(text: string, lines = 4): string {
  const tail = text.split('\n').map(l => l.trim()).filter(Boolean).slice(-lines).join(' / ')
  return redactForStorage(tail.slice(-400)).text
}

/** Decide one started deploy's outcome from its exit code, its log and the checkout HEAD. Pure. */
export function decideOutcome(input: { exitCode: number; log: string; head: string | null; row: Pick<ChatDeployRow, 'mode' | 'to_commit' | 'from_commit'> }): { outcome: SettledDeploy['outcome']; detail: string } {
  const { exitCode, log, head, row } = input
  if (exitCode === 0) {
    if ((row.mode === 'frontend') && !/"ok"\s*:\s*true/.test(log)) {
      return { outcome: 'failed', detail: `The deploy call did not succeed: ${logTail(log)}` }
    }
    if (row.to_commit && head && head !== row.to_commit) {
      return { outcome: 'failed', detail: `The script finished, but the live checkout is at ${short(head)}, not ${short(row.to_commit)}.` }
    }
    return { outcome: 'deployed', detail: `Live at ${short(row.to_commit)}.` }
  }
  if (/AUTO-ROLLED-BACK/.test(log)) {
    return { outcome: 'rolled_back', detail: `The server did not come back healthy, so it was rolled back to ${short(row.from_commit)}. Nothing from this deploy is live.` }
  }
  if (exitCode === 3 || /\[main-moved\]/.test(log)) {
    return { outcome: 'failed', detail: 'Main moved after the list was shown (a newer merge landed), so nothing was deployed. Ask again to see the new list.' }
  }
  if (exitCode === 2) {
    return { outcome: 'failed', detail: `The server did not come back after the deploy and the rollback did not recover it. Check the server now. ${logTail(log)}` }
  }
  return { outcome: 'failed', detail: `The deploy script stopped with code ${exitCode}: ${logTail(log)}` }
}

/**
 * Settle every `started` chat deploy whose script has finished (or timed out).
 * Updates the row; the caller posts the result to chat and the cards. Never throws.
 */
export function settleChatDeploys(db: Database): SettledDeploy[] {
  const d = deps()
  const out: SettledDeploy[] = []
  let rows: ChatDeployRow[]
  try {
    rows = (db.prepare("SELECT * FROM chat_deploys WHERE outcome = 'started' ORDER BY id").all() as Record<string, unknown>[]).map(mapRow)
  } catch {
    return out
  }
  const dir = d.dir()
  const nowMs = d.now().getTime()
  for (const row of rows) {
    const exitPath = path.join(dir, `${row.id}.exit`)
    const logPath = path.join(dir, `${row.id}.log`)
    let exitCode: number | null = null
    try {
      const raw = fs.readFileSync(exitPath, 'utf-8').trim()
      if (/^\d+$/.test(raw)) exitCode = Number(raw)
    } catch {
      exitCode = null
    }
    let decided: { outcome: SettledDeploy['outcome']; detail: string }
    if (exitCode == null) {
      const created = Date.parse(row.created_at.replace(' ', 'T') + (row.created_at.endsWith('Z') ? '' : 'Z'))
      if (!Number.isFinite(created) || nowMs - created < CHAT_DEPLOY_RESULT_TIMEOUT_MS) continue
      decided = { outcome: 'failed', detail: `No result from the deploy script after ${Math.round(CHAT_DEPLOY_RESULT_TIMEOUT_MS / 60_000)} minutes. Check the server and the "Merged, waiting for deploy" panel.` }
    } else {
      let log = ''
      try { log = fs.readFileSync(logPath, 'utf-8') } catch { log = '' }
      let head: string | null = null
      try { head = d.git(['rev-parse', 'HEAD']) || null } catch { head = null }
      decided = decideOutcome({ exitCode, log, head, row })
    }
    const res = db
      .prepare("UPDATE chat_deploys SET outcome = ?, detail = ?, finished_at = ? WHERE id = ? AND outcome = 'started'")
      .run(decided.outcome, decided.detail, new Date(nowMs).toISOString(), row.id)
    if (res.changes === 0) continue
    console.log(`[chat-deploy] #${row.id} settled: ${decided.outcome} — ${decided.detail}`)
    out.push({ row: { ...row, outcome: decided.outcome, detail: decided.detail }, outcome: decided.outcome, detail: decided.detail })
  }
  return out
}

/** Finished deploys whose outcome was not posted back to chat yet. */
export function unreportedChatDeploys(db: Database): ChatDeployRow[] {
  try {
    return (db
      .prepare("SELECT * FROM chat_deploys WHERE outcome IN ('deployed', 'rolled_back', 'failed') AND reported_at IS NULL AND reason IS NOT 'spawn_failed' ORDER BY id")
      .all() as Record<string, unknown>[]).map(mapRow)
  } catch {
    return []
  }
}

export function markReported(db: Database, id: number): void {
  db.prepare('UPDATE chat_deploys SET reported_at = ? WHERE id = ?').run(new Date().toISOString(), id)
}

/** The line posted into the chat thread once a deploy is settled. */
export function outcomeLine(row: ChatDeployRow): string {
  const what = prList(row.prs)
  switch (row.outcome) {
    case 'deployed':
      return `Deploy #${row.id} is live: ${what} (mode ${row.mode}). ${row.detail ?? ''}`.trim()
    case 'rolled_back':
      return `Deploy #${row.id} was rolled back: ${row.detail ?? 'it failed its health check.'} It carried ${what}.`
    default:
      return `Deploy #${row.id} did not go live: ${row.detail ?? 'unknown error.'} It carried ${what}.`
  }
}
