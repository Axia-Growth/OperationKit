/**
 * Spawn identity/secret env — extracted from session-manager.ts (behavior frozen).
 *
 * THE single place every session's identity/secret env is assembled. Previously
 * the same 8-key block was duplicated at all 5 spawn sites. `buildSpawnEnv`
 * consolidates it. With both scoping flags OFF (committed default) and the
 * default ADMIN tier, the env is byte-for-byte identical to the old inline block.
 */
import { spawnEnvFor as workspaceMcpSpawnEnv } from './workspace-mcp-servers.js'
import type { Objective } from '@operationkit/shared'
import { getDb } from '../db/index.js'
import {
  GIT_SSH_COMMAND,
  SCOPE_SUPABASE_ACCESS_TOKEN,
  USE_SCOPED_SECRETS,
} from '../config.js'
import { getDecryptedForUser, getForUser } from './user-github-tokens.js'
import {
  canUseConnectorCredential,
  checkConnectorCredential,
  type ConnectorActor,
  type ConnectorDenyReason,
} from './connector-guard.js'
import { CONNECTOR_ID as GITHUB_CONNECTOR } from './user-github-tokens.js'
import { CONNECTOR_ID as GOOGLE_CONNECTOR } from './user-google-connections.js'
import {
  getForUser as getGoogleConnectionForUser,
  getDecryptedRefreshToken as getGoogleRefreshToken,
  getOAuthClientById as getGoogleOAuthClientById,
  writeIsolatedGoogleCredsDir,
  writeEmptyGoogleCredsDir,
} from './user-google-connections.js'
import { resolveSecrets } from './secrets-store.js'
import { allowlistedKeys, getSessionEnvMode, sessionKeyFilter, sessionSubjects } from './secret-env-policy.js'
import {
  SESSION_SECRET_ACCESS_FLAG,
  mintSessionToken,
  readSettingFlag,
  stripServerSigningSecrets,
  SERVER_ONLY_SESSION_ENV,
} from '../lib/session-trust.js'
import { sessionKbAccessEnabled, verifiedSenderStampsEnabled } from '../lib/session-trust.js'
import { resolveWriteWorkspace } from './workspaces.js'
import { botKeyFilter, botScopeEnv, sessionBotScope, type BotScope } from './bot-session-scope.js'

// ────────────────────────────────────────────────────────────────────────────
// Spawn-env construction (obj-2202 / onboarding gate B1–B4)
//
// THE single place every session's identity/secret env is assembled. Previously
// the same 8-key block was duplicated, verbatim, at all 5 spawn sites
// (startSession / arena / sendFollowUp / planner-respawn / reviewer). Duplication
// meant secret-scoping had to be edited in 5 places and was impossible to test as
// a unit. `buildSpawnEnv` consolidates it; every spawn site now calls it.
//
// SAFETY CONTRACT: with both scoping flags OFF (the committed default) and the
// default ADMIN tier, buildSpawnEnv returns a byte-for-byte identical env to the
// old inline block — see session-spawn-env.test.ts (no-regression assertion).
// The member tier and the scoped-token paths are additive/dormant until a
// Operator-gated cutover (SPAWN-ENV-SCOPING-CUTOVER.md) provisions real scoped tokens
// and flips the flags. This worker mints/rotates NOTHING.
// ────────────────────────────────────────────────────────────────────────────

/** Which spawn path is building the env. Lets the policy/seams differentiate
 *  (e.g. only Supabase-touching kinds keep the org token once scoping is on). */
export type SpawnSessionKind = 'worker' | 'arena' | 'followup' | 'planner' | 'reviewer'

/** The capability/secret grants for a spawn tier. ONE tested source of truth for
 *  the two-tier (admin vs member) decision. The env-expressible grants
 *  (adminDopplerToken, supabaseToken) take effect immediately behind their flags;
 *  the mount/group grants (dockerSocket, adminTokenFile, siblingHomeAccess) are
 *  enforced at cutover by the docker-compose mount changes + a non-docker-group
 *  runuser identity (they cannot be revoked from the env alone) and are surfaced
 *  here so the policy is auditable and testable in one spot. */
export interface SpawnSecurityPolicy {
  /** Docker host socket (= host root) reachable by the session. */
  dockerSocket: boolean
  /** The personal Doppler admin-token FILE is readable by the session. */
  adminTokenFile: boolean
  /** Sibling account homes (other ccuser / cc-accounts Claude/Codex OAuth) mounted. */
  siblingHomeAccess: boolean
  /** Broadcast Doppler ADMIN token injected as DOPPLER_TOKEN (vs a scoped token). */
  adminDopplerToken: boolean
  /** Org-wide SUPABASE_ACCESS_TOKEN injected. */
  supabaseToken: boolean
}

/** Two-tier spawn policy. ADMIN = unchanged current behavior (full host
 *  capabilities). MEMBER = the dormant, denied-by-default path for non-admin
 *  members (none exist yet; onboarding is gated on exactly this work). */
export function spawnSecurityPolicy(isAdminSpawn: boolean): SpawnSecurityPolicy {
  if (isAdminSpawn) {
    return {
      dockerSocket: true,
      adminTokenFile: true,
      siblingHomeAccess: true,
      adminDopplerToken: true,
      supabaseToken: true,
    }
  }
  // Member path: deny host-root + org-secret blast radius (audit T1–T4).
  return {
    dockerSocket: false,
    adminTokenFile: false,
    siblingHomeAccess: false,
    adminDopplerToken: false,
    supabaseToken: false,
  }
}

/**
 * Who this session is acting as. Assigned user wins (Casey working a card Operator
 * filed must send as Casey). Fall back to the creator. Never a third person.
 */
export function resolveActingUserId(
  objective: Pick<Objective, 'assigned_user_id' | 'created_by'> | null | undefined,
): number | null {
  if (!objective) return null
  const assigned = objective.assigned_user_id
  if (typeof assigned === 'number' && assigned > 0) return assigned
  const created = objective.created_by
  if (typeof created === 'number' && created > 0) return created
  return null
}

/**
 * True when this card was routed to its owner by somebody ELSE.
 *
 * Routing work to a person is ordinary, and an admin is allowed to do it. What
 * is NOT ordinary is the routed session quietly opening the assignee's Google
 * account: whoever assigned the card would then be acting as them. So a
 * delegated card runs with its connectors marked absent unless the assignee has
 * opted that connector in (Settings → Connectors → "allow on work assigned by
 * others"). Self-assigned work, and work with no assignee, is never delegated.
 */
export function isDelegatedCard(
  objective: Pick<Objective, 'assigned_user_id' | 'created_by'>,
): boolean {
  const assigned = objective.assigned_user_id
  const creator = objective.created_by
  if (typeof assigned !== 'number' || assigned <= 0) return false
  if (typeof creator !== 'number' || creator <= 0) return false
  return assigned !== creator
}

/**
 * The principal a spawned session's credential reads are made as. It acts for
 * the card's owner, and — when the card was filed by an agent key — inherits
 * that key's connector allow-list, so a key cannot reach through a card it
 * created to a connector it was never granted.
 */
export function spawnActor(objective: Objective, actingUserId: number | null): ConnectorActor {
  const keyId = (objective as { agent_key_id?: number | null }).agent_key_id
  let agentKey: { keyId: number; keyLabel: string; connectors: string[] | null } | null = null
  if (typeof keyId === 'number' && keyId > 0) {
    try {
      const row = getDb()
        .prepare('SELECT id, label, connectors, revoked_at FROM agent_api_keys WHERE id = ?')
        .get(keyId) as { id: number; label: string; connectors: string | null; revoked_at: string | null } | undefined
      // A key that has since been deleted OR revoked leaves the card with no
      // connector grant at all, which is the safe reading of "the grant is
      // gone". Revoke is the only removal the API offers, so it must read the
      // same as a delete — otherwise a card queued by a revoked inherit-mode
      // key ("owner") keeps every connector its owner has (obj 900331).
      agentKey = row
        ? { keyId: row.id, keyLabel: row.label, connectors: row.revoked_at ? [] : parseKeyConnectors(row.connectors) }
        : { keyId, keyLabel: (objective as { agent_key_label?: string | null }).agent_key_label ?? '', connectors: [] }
    } catch {
      agentKey = { keyId, keyLabel: '', connectors: [] }
    }
  }
  return { kind: 'session', userId: actingUserId, objectiveId: objective.id, agentKey }
}

function parseKeyConnectors(raw: string | null): string[] {
  if (raw == null) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** SEAM — decide whether an objective spawns on the ADMIN or MEMBER tier.
 *  Resolved from the acting user's GLOBAL role in `users`:
 *  a `member` owner ⇒ 'member' tier; anything else (admin, or no resolvable
 *  owner row) ⇒ 'admin'. This FAILS SAFE to 'admin' = today's behavior: a
 *  missing/unknown owner, or any DB error, keeps the full-capability tier rather
 *  than silently downgrading a real admin session.
 *
 *  NOTE: the tier only withholds SUPABASE_ACCESS_TOKEN when SCOPE_SUPABASE_ACCESS_TOKEN
 *  is ON. Secrets themselves come from the native store (USE_SCOPED_SECRETS, default ON). */
export function resolveSpawnTier(objective: Objective): 'admin' | 'member' {
  const ownerId = resolveActingUserId(objective)
  if (ownerId == null) return 'admin'
  try {
    const row = getDb()
      .prepare('SELECT role FROM users WHERE id = ?')
      .get(ownerId) as { role: 'admin' | 'member' } | undefined
    return row?.role === 'member' ? 'member' : 'admin'
  } catch {
    // Fail safe to today's full-capability tier; never block/alter a spawn on a
    // DB hiccup.
    return 'admin'
  }
}

/** Install-level fallback git identity (obj-701130, moved to install config).
 *
 *  WHY a fallback exists at all: git resolves a commit's author by precedence
 *  (GIT_AUTHOR_* env > repo-local > --global HOME/.gitconfig > --system
 *  /etc/gitconfig). When a card owner has no linked GitHub token,
 *  `userGitIdentityEnv` returns `{}`, and a commit in a fresh worktree falls all
 *  the way through to whatever ~/.gitconfig or /etc/gitconfig the host happens to
 *  carry — often an UNLINKED identity that Vercel Pro then rejects with
 *  COMMIT_AUTHOR_REQUIRED. Env is the TOP of git's precedence chain, so setting
 *  GIT_AUTHOR_* / GIT_COMMITTER_* in the spawn env makes the result predictable.
 *
 *  WHO it is: the install's OWN bot or operator account, set at install time as
 *  FALLBACK_GIT_NAME / FALLBACK_GIT_EMAIL in client.conf (written to the app as
 *  OK_FALLBACK_GIT_NAME / OK_FALLBACK_GIT_EMAIL). It used to be a hard-coded
 *  vendor account, which put a third party's GitHub identity on every client's
 *  commits; the product no longer ships any default identity.
 *
 *  Not configured (or malformed) ⇒ `null`, and buildSpawnEnv blanks the git
 *  identity so a commit FAILS instead of silently borrowing someone else's
 *  (see GIT_IDENTITY_MISSING_MESSAGE). */
export function resolveFallbackGitIdentity(
  env: NodeJS.ProcessEnv = process.env,
): { name: string; email: string } | null {
  const name = (env.OK_FALLBACK_GIT_NAME || '').trim()
  const email = (env.OK_FALLBACK_GIT_EMAIL || '').trim()
  if (!name || !email) return null
  // git rejects '<', '>' and newlines in an ident; a bare "x@y" is all we need.
  if (/[<>\r\n]/.test(name) || /[<>\s]/.test(email) || !/^[^@]+@[^@]+$/.test(email)) return null
  return { name, email }
}

/** Shown to a session (env + prompt) whose owner has no linked GitHub account on
 *  an install with no fallback identity configured. */
export const GIT_IDENTITY_MISSING_MESSAGE =
  'No git identity for this session, so git commit will fail: the card owner should connect GitHub in Settings → Connectors → GitHub, ' +
  'or ask an admin to set FALLBACK_GIT_NAME / FALLBACK_GIT_EMAIL in the install config.'

/** Per-user GitHub PR attribution (obj-2221 / W4).
 *
 *  Resolves the env that makes a session's commits AND opened PR attribute to the
 *  OBJECTIVE OWNER (`ownerId` = objective.created_by) on GitHub, per the PRD
 *  ("Per-User GitHub Token & PR Attribution", Part B0/B4). GitHub decides a PR's
 *  attribution from two INDEPENDENT levers, so we set both:
 *    - the PR "opened by" actor   ← the token that runs `gh pr create`  → GH_TOKEN
 *    - the commit author/committer ← the commit's author/committer email → GIT_*
 *  The SSH push transport (GIT_SSH_COMMAND, shared deploy key) is irrelevant to
 *  attribution and is left untouched by this hook.
 *
 *  We ALSO export GITHUB_TOKEN (alias of GH_TOKEN): `gh` prefers GH_TOKEN, but
 *  some git/CI tooling reads GITHUB_TOKEN — setting both guarantees every caller
 *  in the spawn authenticates as the user.
 *
 *  Fallback contract (NEVER block work): if the owner has no linked token, or
 *  anything goes wrong resolving it, return {} — the spawn then falls back to the
 *  shared bot identity (gh at /etc/gh + rotation-home .gitconfig) exactly as
 *  before. This makes the feature purely additive and decoupled from the
 *  scoped-Doppler cutover (USE_SCOPED_DOPPLER_TOKENS).
 *
 *  Invariants honored: stays PURE (only DB reads), MUST NOT throw, and NEVER logs
 *  the raw PAT — the decrypted token flows only into the returned env, which goes
 *  straight into the spawned child's process env. */
export function userGitIdentityEnv(
  ownerId: number | null | undefined,
  actor: ConnectorActor,
): Record<string, string> {
  if (ownerId == null) return {}
  try {
    // Masked identity (login + author/committer email) — resolved + verified at
    // link time by W1's validatePat. No raw token here.
    const summary = getForUser(ownerId)
    if (!summary || !summary.github_login || !summary.github_email) return {}

    // Server-only seam: decrypt the PAT. Only reached when a row exists.
    // Owner-scoped: refused (and audited) unless this principal is the owner
    // and, when it is an agent key's session, holds the connector on its list.
    const token = getDecryptedForUser(ownerId, actor)
    if (!token) return {}

    const name = summary.github_login
    const email = summary.github_email
    return {
      GH_TOKEN: token,
      GITHUB_TOKEN: token,
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
    }
  } catch {
    // Any failure (DB, decrypt) ⇒ fall back to bot identity. Never block a spawn.
    return {}
  }
}

/** Per-user Google Workspace credential for a spawn (obj-706070).
 *
 *  Command Center's Google access was ONE shared credential (Operator's), so a
 *  session doing Workspace work for Casey wrote Docs as Operator. This resolver makes
 *  the credential follow the ACTING USER: the objective's owner. Casey's session
 *  gets Casey's refresh token; Operator's gets Operator's. There is no cross-user path —
 *  the lookup is keyed on `ownerId` and nothing else.
 *
 *  Connected ⇒ inject the owner's grant:
 *    GOOGLE_WORKSPACE_CONNECTION = 'user'
 *    USER_GOOGLE_EMAIL           = the connected Google account
 *    GOOGLE_REFRESH_TOKEN        = the owner's decrypted refresh token
 *    GOOGLE_OAUTH_CLIENT_ID/SECRET = the client the grant belongs to
 *
 *  NOT connected (or the OAuth client is unconfigured, or anything throws) ⇒
 *  EXPLICIT ABSENCE, never a silent fallback to another user's credential:
 *    GOOGLE_WORKSPACE_CONNECTION = 'absent'
 *  and ZERO token keys. A session that needs Workspace access reads that marker
 *  and tells the user to connect at Settings → Account, rather than silently
 *  acting as Operator. Operator is not special-cased: his credential was migrated to his
 *  own user row (scripts/migrate-google-credential.ts), so he takes the
 *  connected branch like everyone else.
 *
 *  Invariants, mirroring userGitIdentityEnv: PURE (DB reads only), MUST NOT
 *  throw, and NEVER logs token material — the decrypted refresh token flows only
 *  into the returned env, which goes straight into the spawned child's env. */
export function userGoogleCredentialEnv(
  ownerId: number | null | undefined,
  actor: ConnectorActor,
): Record<string, string> {
  const absent = { GOOGLE_WORKSPACE_CONNECTION: 'absent' }
  if (ownerId == null) return absent
  try {
    // Masked summary first — identity + health, no token material.
    const summary = getGoogleConnectionForUser(ownerId)
    if (!summary) return absent

    // The client that ISSUED this user's grant — a refresh token only works
    // against its issuing client, and migrated credentials came from the legacy
    // one. Unknown/unconfigured client ⇒ the credential cannot be refreshed, so
    // report absence rather than handing the session a token that will 401.
    const client = getGoogleOAuthClientById(summary.client_id)
    if (!client) return absent

    // Server-only seam: decrypt. Only reached when a row exists.
    // Owner-scoped: a refusal here is indistinguishable, to the session, from
    // "not connected" — which is exactly the contract. It is audited.
    const refreshToken = getGoogleRefreshToken(ownerId, actor)
    if (!refreshToken) return absent

    return {
      GOOGLE_WORKSPACE_CONNECTION: 'user',
      USER_GOOGLE_EMAIL: summary.google_email,
      GOOGLE_REFRESH_TOKEN: refreshToken,
      GOOGLE_OAUTH_CLIENT_ID: client.clientId,
      GOOGLE_OAUTH_CLIENT_SECRET: client.clientSecret,
    }
  } catch {
    // Any failure (DB, decrypt) ⇒ explicit absence. Never block a spawn, and
    // never degrade into somebody else's Google account.
    return absent
  }
}

/** Resolve SUPABASE_ACCESS_TOKEN for a spawn. Flag OFF (default) OR a tier that
 *  keeps Supabase ⇒ current behavior. Flag ON + member tier ⇒ withheld (''). */
function resolveSupabaseToken(policy: SpawnSecurityPolicy): string {
  const current = process.env.SUPABASE_ACCESS_TOKEN || ''
  if (!SCOPE_SUPABASE_ACCESS_TOKEN || policy.supabaseToken) return current
  return ''
}

/** Build the identity/secret env handed to a spawned session. Called by ALL 5
 *  spawn sites. `homeDir` differs per site (account home vs objective home) so it
 *  is a parameter. `isAdminSpawn` defaults to the objective's resolved tier (today
 *  always admin) but is overridable for tests / explicit member spawns. */
export function buildSpawnEnv(opts: {
  objective: Objective
  homeDir: string
  sessionKind: SpawnSessionKind
  isAdminSpawn?: boolean
}): Record<string, string> {
  const { objective, homeDir } = opts
  const isAdminSpawn = opts.isAdminSpawn ?? (resolveSpawnTier(objective) === 'admin')
  const policy = spawnSecurityPolicy(isAdminSpawn)

  // NOTE: key order below is load-bearing for the no-regression byte test — it
  // matches the old inline block exactly (the wrapper serializes via Object.entries).
  const env: Record<string, string> = {
    HOME: homeDir,
    USER: 'ccuser',
    TERM: 'dumb',
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    GIT_SSH_COMMAND,
    GH_CONFIG_DIR: '/etc/gh',
    SUPABASE_ACCESS_TOKEN: resolveSupabaseToken(policy),
  }

  const actingUserId = resolveActingUserId(objective)

  // W4 per-user GitHub identity. Assigned user wins over creator so Casey's
  // assigned card does not open PRs as Operator (and vice versa).
  // Settings → Connectors access rules (obj 720115): no rule = allowed, so this
  // only withholds a credential the person has explicitly limited.
  const connectorUse = { agent: objective.agent_context, workspace: objective.workspace }
  const delegated = isDelegatedCard(objective)
  const actor = spawnActor(objective, actingUserId)
  // obj 901330 — a card for one of the scoped Example bots gets only its pack:
  // connectors on its list AND named in the owner's Who can use it rule.
  const botScope = safeBotScope(objective)
  const mayUse = (connectorId: string): boolean =>
    checkConnectorCredential({
      connectorId,
      ownerUserId: actingUserId,
      actor,
      use: connectorUse,
      delegated,
      botScope,
    }).allowed

  if (mayUse(GITHUB_CONNECTOR)) {
    Object.assign(env, userGitIdentityEnv(actingUserId, actor))
  }

  // Fallback git identity (obj-701130). If the block above injected NO
  // commit-author identity (the owner has no linked GitHub token ⇒
  // userGitIdentityEnv returned {}), a commit would fall through git's precedence
  // chain to whatever HOME/.gitconfig or /etc/gitconfig the host carries. Use the
  // install's own configured identity when there is one; otherwise set the
  // identity env to EMPTY strings, which git refuses ("empty ident name not
  // allowed"), so the commit fails loudly instead of borrowing another person's
  // identity. GIT_IDENTITY tells the session which case it is in (prompt-builder).
  // Per-user identity (when the owner IS linked) MUST take precedence — we only
  // fill when it is absent.
  if (env.GIT_AUTHOR_EMAIL) {
    env.GIT_IDENTITY = 'user'
  } else {
    const fallback = resolveFallbackGitIdentity()
    env.GIT_AUTHOR_NAME = fallback?.name ?? ''
    env.GIT_AUTHOR_EMAIL = fallback?.email ?? ''
    env.GIT_COMMITTER_NAME = fallback?.name ?? ''
    env.GIT_COMMITTER_EMAIL = fallback?.email ?? ''
    if (fallback) {
      env.GIT_IDENTITY = 'install'
    } else {
      env.GIT_IDENTITY = 'absent'
      env.GIT_IDENTITY_HELP = GIT_IDENTITY_MISSING_MESSAGE
    }
  }

  // obj-706070 per-user Google Workspace credential. ALWAYS adds at least
  // GOOGLE_WORKSPACE_CONNECTION ('user' | 'absent') so a session can always tell
  // "I have the acting user's Google account" from "there is none" — the explicit
  // -absence contract that replaces the old silent fallback to Operator's shared
  // credential. Token keys are added ONLY on the connected branch. This appends
  // after the git-identity block and BEFORE scoped secrets, so an explicit scoped
  // secret can still override a Google key if an operator ever needs to.
  const googleEnv = mayUse(GOOGLE_CONNECTOR)
    ? userGoogleCredentialEnv(actingUserId, actor)
    : { GOOGLE_WORKSPACE_CONNECTION: 'absent' }
  Object.assign(env, googleEnv)

  // Always isolate the Google MCP credential dir. The shared folder
  // `/home/operator/assistant/google-credentials` holds every user's JSON; workspace-mcp
  // reads the whole directory, which is how Casey's session sent as Operator.
  if (env.GOOGLE_WORKSPACE_CONNECTION === 'user' && actingUserId != null) {
    env.WORKSPACE_MCP_CREDENTIALS_DIR =
      writeIsolatedGoogleCredsDir(actingUserId, actor) || writeEmptyGoogleCredsDir(String(actingUserId))
  } else {
    env.WORKSPACE_MCP_CREDENTIALS_DIR = writeEmptyGoogleCredsDir(String(actingUserId ?? 'none'))
  }
  if (actingUserId != null) env.CC_ACTING_USER_ID = String(actingUserId)

  // Native secrets store. ON by default. Set USE_SCOPED_SECRETS=0 to skip.
  // Most-specific-wins (global < workspace < user < workspace_user). Never
  // blocks a spawn: failure leaves the env as-is.
  if (USE_SCOPED_SECRETS) {
    try {
      Object.assign(
        env,
        resolveSecrets({
          workspace: objective.workspace,
          userId: actingUserId,
          audit: true,
          actorUserId: null,
          keyFilter: sessionSecretKeyFilter(objective, actingUserId),
        }),
      )
    } catch (err) {
      console.warn('[session-manager] scoped-secrets injection failed (env unchanged):', (err as Error).message)
    }
  }

  // obj-716719: the store's GLOBAL GOOGLE_OAUTH_CLIENT_ID/SECRET (the primary
  // web client) clobbered the per-user grant's issuing client above. A refresh
  // token only works against the client that minted it, so Casey's session got
  // her legacy-client refresh token paired with the primary client → 401
  // unauthorized_client. A connected user's grant must win as one unit.
  if (googleEnv.GOOGLE_WORKSPACE_CONNECTION === 'user') Object.assign(env, googleEnv)

  // obj 900620 — remote MCP servers connected in Settings → Integrations for
  // THIS card's workspace only: their access tokens as CC_MCP_TOKEN_<id> plus a
  // secret-free descriptor spawnInTmux renders into the engine's MCP config.
  // Keyed on objective.workspace, so a card in workspace A never receives
  // workspace B's servers or tokens; a card with no workspace receives none.
  // Never blocks a spawn.
  try {
    Object.assign(env, workspaceMcpSpawnEnv(objective.workspace, botScope ? { allowSlug: slug => botScope.mcpServers.has(slug) } : undefined))
  } catch (err) {
    console.warn('[session-manager] workspace MCP injection failed (env unchanged):', (err as Error).message)
  }

  // obj 900208 — `git push` over https with the GitHub connection. GH_TOKEN alone
  // only authenticates `gh`; plain git asks a credential helper, and a session
  // (above all a jailed one, whose checkout carries no repo-local helper) has
  // none, so the push died with "could not read Username" and the worker asked
  // for a GH_TOKEN secret it was already holding. Applied AFTER the secrets
  // store so a Settings → Secrets GH_TOKEN override is used the same way.
  Object.assign(env, githubPushHelperEnv(env))

  // Markers so a scoped worker can tell what it holds and why (names only).
  if (botScope) Object.assign(env, botScopeEnv(botScope))

  applySessionTrustEnv(env, objective, actingUserId, opts.sessionKind)

  // obj 901458 — a coding session that starts with no GitHub login says so on the
  // card now, naming the reason, instead of failing silently at `git push`. Side
  // effect only: the env is unchanged.
  noteGithubUnavailableAtStart(objective, env, opts.sessionKind)

  return env
}

/**
 * D4 (obj 900540): which Secrets-store keys this session may hold in its env.
 * Migration mode (default for existing installs) = every key, unchanged; the
 * session-end scan logs non-allowlisted names it referenced. Enforce mode = only
 * keys allowlisted for the card's agent profile or its skills; the rest stay
 * reachable through the broker. If the allowlist cannot be read in enforce mode,
 * nothing from the store is injected (fail closed).
 */
export function sessionSecretKeyFilter(
  objective: Objective,
  actingUserId: number | null,
): ((key: string) => boolean) | undefined {
  // obj 901330 — a scoped bot is filtered to its pack in EITHER mode, so an
  // empty allowlist under migration no longer means "every key" for it.
  const scope = safeBotScope(objective)
  if (scope) {
    let subjects = null
    try {
      subjects = sessionSubjects(objective, actingUserId)
    } catch {
      subjects = null
    }
    try {
      return botKeyFilter(scope, subjects)
    } catch {
      return () => false
    }
  }
  const mode = getSessionEnvMode()
  if (mode !== 'enforce') return undefined
  try {
    return sessionKeyFilter(mode, allowlistedKeys(sessionSubjects(objective, actingUserId)))
  } catch {
    return () => false
  }
}

/**
 * The scoped-bot pack for this card, or null. A card whose agent_context names
 * a scoped bot is scoped even if the ownership lookup fails.
 */
export function safeBotScope(objective: Objective): BotScope | null {
  try {
    return sessionBotScope(objective as Objective & { owner_bot?: string | null })
  } catch {
    try {
      return sessionBotScope(objective, { ownerSlugs: () => [] })
    } catch {
      return null
    }
  }
}

/** git config key for the github.com https credential helper (obj 900208). */
export const GITHUB_HELPER_CONFIG_KEY = 'credential.https://github.com.helper'
/** `gh` answers git's credential `get` from GH_TOKEN / GITHUB_TOKEN in its env.
 *  Deliberately contains no `$`: the tmux wrapper exports values inside double
 *  quotes, which would expand a shell variable at export time. The token itself
 *  is never written into git config or onto disk — `gh` reads it from the env. */
export const GITHUB_HELPER_CONFIG_VALUE = '!gh auth git-credential'

/**
 * Env-scoped git config that lets plain `git push/fetch` to github.com use the
 * session's GitHub token. Only when one is present; {} otherwise, so a spawn
 * with no GitHub token is unchanged. Uses GIT_CONFIG_COUNT/KEY_n/VALUE_n
 * (git ≥ 2.31), the env equivalent of `git -c`, so nothing is written to the
 * session's HOME or the checkout. Appends after any GIT_CONFIG_* already set.
 */
export function githubPushHelperEnv(env: Record<string, string>): Record<string, string> {
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return {}
  const existing = Number.parseInt(env.GIT_CONFIG_COUNT || '0', 10)
  const n = Number.isFinite(existing) && existing > 0 ? existing : 0
  return {
    GIT_CONFIG_COUNT: String(n + 1),
    [`GIT_CONFIG_KEY_${n}`]: GITHUB_HELPER_CONFIG_KEY,
    [`GIT_CONFIG_VALUE_${n}`]: GITHUB_HELPER_CONFIG_VALUE,
  }
}

/** Why a session does or does not hold its owner's GitHub connection. */
export type GithubSessionAccess =
  | { state: 'connected'; login: string; ownerUserId: number }
  | {
      state: 'unavailable'
      reason: ConnectorDenyReason | 'not_connected'
      ownerUserId: number | null
      keyLabel: string | null
    }

/**
 * The same decision buildSpawnEnv makes for the GitHub connector, as a value
 * the prompt can explain (obj 900208). PURE: uses the non-auditing
 * canUseConnectorCredential (buildSpawnEnv already audits the real read), reads
 * only the masked summary (never decrypts), and never throws.
 */
export function githubSessionAccess(objective: Objective): GithubSessionAccess {
  const ownerUserId = resolveActingUserId(objective)
  const keyLabel = (objective as { agent_key_label?: string | null }).agent_key_label ?? null
  try {
    const actor = spawnActor(objective, ownerUserId)
    const decision = canUseConnectorCredential({
      connectorId: GITHUB_CONNECTOR,
      ownerUserId,
      actor,
      use: { agent: objective.agent_context, workspace: objective.workspace },
      delegated: isDelegatedCard(objective),
      botScope: safeBotScope(objective),
    })
    if (!decision.allowed) return { state: 'unavailable', reason: decision.reason, ownerUserId, keyLabel }
    const summary = ownerUserId != null ? getForUser(ownerUserId) : null
    if (!summary || !summary.github_login) return { state: 'unavailable', reason: 'not_connected', ownerUserId, keyLabel }
    return { state: 'connected', login: summary.github_login, ownerUserId: ownerUserId as number }
  } catch {
    return { state: 'unavailable', reason: 'not_connected', ownerUserId, keyLabel }
  }
}

/**
 * obj 718944 — session trust env. Flag-gated, so a flags-off spawn env is
 * byte-identical to before. Either flag on: drop the server's JWT signing key
 * (store-injected copies here, inherited tmux-env copies via the wrapper's
 * `unset`). `session_secret_access` on: hand the worker an objective-scoped
 * token for the secrets broker and its own card's needs-secret route.
 */
export function applySessionTrustEnv(
  env: Record<string, string>,
  objective: Pick<Objective, 'id' | 'workspace'>,
  actingUserId: number | null,
  sessionKind: SpawnSessionKind = 'worker',
): void {
  // obj 901106: the card browser's Cloudflare Access service token belongs to the
  // control plane alone (it trades it for a short-lived Access cookie). Never in
  // a card's env, flags or no flags — even if an operator stored it in Settings.
  for (const k of SERVER_ONLY_SESSION_ENV) delete env[k]
  const stamps = verifiedSenderStampsEnabled()
  const secretAccess = readSettingFlag(SESSION_SECRET_ACCESS_FLAG)
  // obj 900204 — knowledge-base access needs the SAME objective-scoped token.
  // Unlike the obj-718944 flags this one defaults ON: a jailed card that cannot
  // read its own workspace's KB is the bug being fixed. It is NOT a secrets
  // grant — the token only unlocks /api/files + /api/docs scoped to this card's
  // workspace; the broker/needs-secret routes still require `session_secret_access`.
  const kbAccess = sessionKbAccessEnabled()
  if (!stamps && !secretAccess && !kbAccess) return
  // Mandatory whenever a derived token exists: a session holding JWT_SECRET
  // could mint its own token for ANY workspace and defeat the scoping entirely.
  stripServerSigningSecrets(env)
  env.CC_STRIP_SIGNING_SECRETS = '1'
  // obj 900910: this same token is how POST /api/internal/objectives/:id/message
  // derives the SENDER card (lib/message-caller.ts) instead of trusting a
  // self-declared from_objective_id. KB access defaults ON, so every default
  // spawn carries it; with both flags off a /message caller falls back to the
  // recorded, unverified self-declared path.
  if (secretAccess || kbAccess) {
    try {
      env.CC_OBJECTIVE_ID = String(objective.id)
      env.CC_SESSION_TOKEN = mintSessionToken({
        objectiveId: objective.id,
        workspace: resolveWriteWorkspace(objective.workspace),
        actingUserId,
        // obj 901525 — the AI reviewer may READ its workspace's knowledge base
        // through this same token (to check a deliverable that lives there)
        // but must never write it. Every other session kind keeps the
        // read-write token it always had.
        readOnly: sessionKind === 'reviewer',
      })
    } catch (err) {
      console.warn('[session-trust] session token not minted:', (err as Error).message)
    }
  }
}

/**
 * Why GitHub is missing, in one plain sentence that names the fix (obj 900208).
 * Shared by the prompt line (session-trust-prompt) and the start-time card note.
 */
export function githubUnavailableFix(reason: GithubUnavailableReason, keyLabel: string | null = null): string {
  const fix: Record<GithubUnavailableReason, string> = {
    no_owner:
      'this card has no owner, so nobody\'s GitHub connection applies. Ask on the card for an owner to be assigned (the person whose GitHub should open the PR).',
    not_connected:
      'the card owner has not connected GitHub. The fix is Settings → Connectors → GitHub — one connection serves chat and coding sessions alike.',
    key_connector: `this card was filed by the API key${keyLabel ? ` "${keyLabel}"` : ''}, which is not allowed to use GitHub. Its owner can add GitHub to that key in Settings → API keys.`,
    delegated_card:
      'this card was assigned to its owner by someone else, and the owner has not allowed GitHub on work assigned by others. The owner can turn that on in Settings → Connectors → GitHub.',
    access_rule:
      'the owner limited their GitHub connection to other agents or workspaces in Settings → Connectors → GitHub.',
    cross_user: 'the GitHub connection belongs to someone else.',
    bot_scope: "this card's bot does not have GitHub on its connector list (obj 901330). Only the owner can change a bot's list; do not work around it.",
    no_grant:
      "the owner's Settings → Connectors → GitHub → Who can use it list does not name this card's bot. The owner adds the bot there; do not ask for a GH_TOKEN secret.",
    token_unreadable:
      "the owner's GitHub connection is set up but its token could not be read at start. The owner can reconnect at Settings → Connectors → GitHub.",
  }
  return fix[reason] ?? fix.not_connected
}

/** Every reason a session can start without a GitHub login. */
export type GithubUnavailableReason = ConnectorDenyReason | 'not_connected' | 'token_unreadable'

/** activity_log metadata.kind of the start-time card note. */
export const GITHUB_UNAVAILABLE_NOTE_KIND = 'github_unavailable_at_start'

/**
 * The start-time note for a session that holds no GitHub login, or null when
 * none is due: GH_TOKEN/GITHUB_TOKEN is in the env (connection or a Secrets
 * override), or the card is not on a repo project (it never needs to push).
 * PURE apart from the non-auditing access read. Never throws.
 */
export function githubStartNote(
  objective: Objective,
  env: Record<string, string>,
): { reason: GithubUnavailableReason; line: string } | null {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return null
  if (!String(objective.project ?? '').trim()) return null
  const access = githubSessionAccess(objective)
  const reason: GithubUnavailableReason = access.state === 'connected' ? 'token_unreadable' : access.reason
  const keyLabel = access.state === 'connected' ? null : access.keyLabel
  return {
    reason,
    line: `Session started with no GitHub login (${reason}): ${githubUnavailableFix(reason, keyLabel)} It cannot push a branch or open a pull request until that is fixed.`,
  }
}

/**
 * Write the start-time note as a card line (activity_log, metadata.kind
 * `github_unavailable_at_start`) for a worker or follow-up session. One line per
 * reason: a respawn with the same reason as the card's last such note writes
 * nothing. Returns true when a line was written. Never throws, never blocks a spawn.
 */
export function noteGithubUnavailableAtStart(
  objective: Objective,
  env: Record<string, string>,
  sessionKind: SpawnSessionKind,
): boolean {
  if (sessionKind !== 'worker' && sessionKind !== 'followup') return false
  try {
    const note = githubStartNote(objective, env)
    if (!note) return false
    const db = getDb()
    const last = db
      .prepare(
        "SELECT json_extract(metadata, '$.reason') AS reason FROM activity_log WHERE objective_id = ? AND json_extract(metadata, '$.kind') = ? ORDER BY id DESC LIMIT 1",
      )
      .get(objective.id, GITHUB_UNAVAILABLE_NOTE_KIND) as { reason: string | null } | undefined
    if (last?.reason === note.reason) return false
    db.prepare(
      `INSERT INTO activity_log (project, workspace, objective_id, event_type, title, metadata)
       VALUES (?, ?, ?, 'progress', ?, ?)`,
    ).run(
      objective.project || '',
      resolveWriteWorkspace(objective.workspace),
      objective.id,
      note.line,
      JSON.stringify({ kind: GITHUB_UNAVAILABLE_NOTE_KIND, reason: note.reason, session_kind: sessionKind }),
    )
    return true
  } catch (err) {
    console.warn('[session-spawn-env] GitHub start note failed:', (err as Error).message)
    return false
  }
}
