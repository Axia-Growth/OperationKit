# Operation Kit Dev: GitHub repo rights (obj 901492)

Lets the Dev bot merge a pull request **by repo and number**, with no card linked
to it (the public repo's "Sync from upstream" PR included), and update a branch in
a way that really starts CI. It is a per-repo grant, **off by default**, on top of
the operator tools ([Operation-Kit-Dev-Operator-Tools.md](./Operation-Kit-Dev-Operator-Tools.md)).

## Why

`dev_merge_pr` and `merge_approved_pr` merge only the PR of one of Dev's own
cards: both start from a card id, and the card is where ownership, the AI review
verdict and the audit trail live. The live server deploys from the public repo,
whose rolling sync PR has no card, so merged work could not go live without the
owner merging on GitHub by hand.

## How the merge tools reach GitHub today

Every server-side merge shells `gh` from the server process and resolves a
credential per call (`services/grant-merge-github-auth.ts`), first hit wins:

1. the server's own login: env `GH_TOKEN` / `GITHUB_TOKEN`, else a `hosts.yml` in `GH_CONFIG_DIR`;
2. the GitHub connection of the person the merge is for (Settings → Integrations);
3. the workspace GitHub integration token.

All three are a **person's user token**. None is the Actions `GITHUB_TOKEN` and
none is a GitHub App. GitHub starts workflows for commits made with a user token,
and that is what the record shows: on 2026-11-19 every open PR whose head was a
GitHub update-branch commit (author the owner's account, committer `web-flow`)
had a `gate` workflow run on that exact commit.

So the "required check `gate` was never scheduled" refusals were not a token
limit. Two things cause them:

- `gate` is the LAST job of the `gate` workflow. While the other jobs run, the
  check named `gate` does not exist on the PR yet. "Not there" was read as
  "never scheduled".
- The workflow cancels a run when a newer commit arrives on the same PR. Two
  updates close together leave a cancelled run and no `gate` check at all.

A third cause exists and is now reported for what it is: GitHub starts no
pull-request workflow on a branch that **conflicts** with its base.

## The grant

- Bot settings panel → **GitHub repo rights** (`RepoRightsSection.tsx`), under Operator tools.
  An admin adds one repo at a time as `owner/name` and can switch each off.
- `GET|PUT /api/agent-chat/agents/:slug/repo-rights` (`{repo, enabled}`). PUT needs an
  admin's browser cookie: an API key, a member and an admin's Bearer token are 403.
- Table `dev_ops_repo_grants`, one row per repo. **No row = off.** No wildcard, no
  default. A revoke stamps the row and takes effect on the next call, including
  for a merge that is waiting on CI.
- Only `operation-kit-dev` can hold it (`services/dev-ops/repo-grant.ts`).
- It sits under the operator-tools gate (`devOpsGate`): the switch on, an **admin
  typing in the browser**, never a card wake, a bot wake, a queued turn or a key.
  That typed message is the owner's word for the merge.

## The tools

Offered only while at least one repo is granted (`services/agent-chat/dev-ops-tools.ts`):

| Tool | What it does |
|---|---|
| `dev_merge_repo_pr {repo, number}` | Squash-merge the PR, pinned with `--match-head-commit` to the head that was graded. A behind branch is updated first and merged by the 30 s tick once CI is green on the new head. |
| `dev_refresh_pr_ci {repo, number}` | Update a behind branch and make sure CI runs on the head. Never merges. |

**The card.** If a live card links the PR (same repo and number), that card gets the
merge line and is marked done. If none does, a card is filed in the chat's
workspace, already done, titled `Merged <repo>#<n>: <PR title>`, with the PR link,
head commit and CI result.

**Really starting CI** (`kickCi`). After a branch update the tick looks at the
Actions runs on the new head commit:

- a run exists and is running: fine;
- a run was cancelled or failed to start: it is re-run (`POST …/actions/runs/{id}/rerun`);
- on `dev_refresh_pr_ci` only, a failed or timed-out run has its failed jobs re-run
  (`…/rerun-failed-jobs`). A merge request never re-runs a failure;
- no run appears within 10 minutes: the row fails as `ci_never_started`, with the
  likely cause and the name of the credential that fixes it. It is never left silent.

A run is restarted at most 3 times in total, and a waiting row lives 90 minutes.
A CI refusal now says "still running on this head" when a run is in progress.

## Walls

All in `services/dev-ops/repo-merge.ts`; none can be configured off. Each has a test.

| Wall | Rule |
|---|---|
| Reserved PRs | The grant-merge reserved list (seed 645 in both repos, `grant_merge_reserved_prs`, `CC_GRANT_MERGE_RESERVED_PRS`) plus the Full access protected list. Refused **before any GitHub call**: never merged, updated or re-run. |
| Reserved content | A PR whose title, description or commits name a reserved PR, or whose files include a file a reserved PR **adds**, is refused. A sync-shaped PR (branch `sync/…` or title "Sync from upstream") is also refused when any upstream reserved PR cannot be read, and any PR with more files than GitHub will list: no proof, no merge. |
| CodeQL | Open high or critical code-scanning alerts on the PR block the merge unless every one is in a test file. Unreadable alerts block. A test file is one GitHub classifies as a test, a `*.test.*` / `*.spec.*` / `test_*.py` / `*_test.go` file, or a file under `__tests__/`, `__mocks__/` or the top-level `tests/`. GitHub's code-scanning result check, when it finished as failed, is judged by this rule and not by its colour; if no high finding explains the failure, it counts as red. Every other check stays strict. |
| A linked card | A failed or blocked AI review, a worker still running, a Strategy and a money-path card refuse. No review yet is allowed, as for `dev_merge_pr`. |
| The owner's word | Only in a chat turn an admin typed in the browser. The standing merge grant still covers only a bot's own cards and is unchanged. |
| Mergeability | Open, not a draft, not from a fork. Only GitHub `CLEAN` / `HAS_HOOKS`, or `UNSTABLE` when the one non-green check is the code-scanning result the CodeQL rule cleared and nothing else on the head is red. **No admin bypass.** |
| After a branch update | The tick merges only GitHub's own update commit: two parents, one the head that was graded, signed by GitHub (`web-flow`, verified), the other parent already on the base branch. A hand-made merge commit pushed while waiting is never merged. |
| Review conversations | A thread left by GitHub's code-scanning bot on a test file is resolved (the CodeQL rule accepted that finding). A person's conversation is never resolved; if even one stays open nothing is resolved, and the merge is refused and says how many are open. |
| Deploys and migrations | Not part of this. A merge starts no deploy; `dev_deploy` is unchanged. |
| Repo settings | Never read for writing. The only GitHub writes are update-branch, Actions re-run, resolving a bot thread and the squash-merge (asserted by an allow-list test). |
| Audit | Every call, merge, refusal and background step is a `dev_ops_audit` row with person, target `owner/name#n`, outcome, code and a sentence. Grant changes too. |

## The credential (optional)

No new credential is required: the user token in use today can do all of the above on
both repos. A dedicated one is worth having so merges are limited to two repos and do
not ride on a person's full-scope token. The code reads it **by name** at call time and
falls back to the chain above when it is absent.

- **Secret name:** `DEV_BOT_GITHUB_TOKEN` (Settings → Secrets, workspace or global scope).
- **Kind:** a fine-grained personal access token, resource owner = the GitHub organisation.
- **Repos:** the private app repo and the public repo. Nothing else.
- **Repository permissions (the minimum):**

| Permission | Level | Used for |
|---|---|---|
| Metadata | Read | required by GitHub; branch rules |
| Contents | Read and write | the merge; the update-branch merge commit |
| Pull requests | Read and write | read the PR, update its branch, merge it, resolve a code-scanning bot thread |
| Actions | Read and write | list the runs on a commit; re-run one |
| Workflows | Read and write | update a branch when the base changed a workflow file |
| Checks | Read | the PR's check runs |
| Commit statuses | Read | the PR's commit statuses |
| Code scanning alerts | Read | the CodeQL rule |
| Administration | Read | the public repo's classic branch protection (its required checks) |

Steps for the owner:

1. GitHub → your avatar → Settings → Developer settings → Personal access tokens → Fine-grained tokens → **Generate new token**.
2. Name it `operation-kit-dev-bot`. Resource owner: the organisation. Expiration: 90 days.
3. Repository access → **Only select repositories** → pick the two repos.
4. Set the nine permissions in the table. Leave every other permission at "No access".
5. Generate, copy the token once, and paste it into **Settings → Secrets** as `DEV_BOT_GITHUB_TOKEN`. Do not paste it into chat.
6. Bot settings → GitHub repo rights now reads "GitHub calls use the secret DEV_BOT_GITHUB_TOKEN".

If the organisation requires approval for fine-grained tokens, approve it under
Organisation settings → Personal access tokens → Pending requests.

## Known limits

- A sync PR is merged only when it is clean. Today's public sync PR is not: CodeQL
  reports a high finding in a non-test file, so the tool refuses it by design.
- The reserved-content file check compares against files a reserved PR **adds**. A
  reserved PR that only edits existing files is caught by the text rule alone.
- Fork PRs are refused: outside contributions reach the private repo by hand
  (see `.github/workflows/oss-sync.yml`).
- No GitHub App. An installation token would need a signing key on the server and
  token minting; a named fine-grained token gives the same reach with less to hold.

## Tests

- `services/dev-ops/repo-merge.test.ts`: the grant, the merge path on both repos,
  CI green and "still running", update + restart + "never started", every wall, the
  GitHub call allow-list, the audit rows and the named credential.
- `routes/agent-chat-repo-rights.test.ts`: off by default, browser admin only, one
  exact repo per row, audit and feed lines, no credential value in the payload.
- `client/.../RepoRightsSection.test.tsx`: the settings section.
