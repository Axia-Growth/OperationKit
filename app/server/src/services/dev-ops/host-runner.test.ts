/**
 * obj 901424 — host-runner.sh itself, run under bash with the host tools stubbed
 * (sudo, git, docker, curl) and the repo's real install/lib.sh:
 *
 *  deploy
 *   - runs `update.sh --config <conf>` exactly (no --skip-cloudflare / --skip-backup);
 *   - verify + health pass → state deployed, no rollback;
 *   - verify fails → rollback: old commit checked out, pre-update images re-tagged,
 *     `backup.sh restore <this run's backup> --config <conf> --yes`, stack up → rolled_back;
 *   - public health fails → the same rollback;
 *   - update fails before a backup exists → failed, nothing rolled back.
 *  Access
 *   - a protected address is never removed (no PUT is sent);
 *   - add writes every existing entry plus exactly one email; never a domain rule;
 *   - the API token reaches curl on STDIN only, never in its argv, never in output.
 *  DNS
 *   - the install's own record and names outside the zone refuse with no write.
 *
 * Needs bash + jq (present on the CI runner); skipped where either is missing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHash } from 'crypto'

const RUNNER = path.join(__dirname, 'host-runner.sh')
const REPO_LIB = path.resolve(__dirname, '../../../../../install/lib.sh')
const has = (bin: string) => spawnSync('bash', ['-c', `command -v ${bin}`], { env: { ...process.env, PATH: `${process.env.HOME}/bin:${process.env.PATH}` } }).status === 0
const READY = has('jq') && has('flock') && fs.existsSync(REPO_LIB)
const TOKEN = 'cfTok_RUNNER_TEST_0123456789abcdef0123456789'

let T: string
let SRC: string
let CONF: string
let OPT: string
let BIN: string
let LOGS: string
let HOSTDATA: string

function w(file: string, body: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body, { mode })
}
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '')

function setup(opts: { verifyFails?: boolean; healthFailsUntilRollback?: boolean; updateFailsBeforeBackup?: boolean; partialBackup?: boolean; nothingNew?: boolean; policy?: unknown[] } = {}) {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-devops-runner-'))
  SRC = path.join(T, 'src')
  OPT = path.join(T, 'opt')
  BIN = path.join(T, 'bin')
  LOGS = path.join(T, 'logs')
  HOSTDATA = path.join(T, 'hostdata')
  CONF = path.join(SRC, 'client.conf')
  fs.mkdirSync(LOGS, { recursive: true })
  fs.mkdirSync(HOSTDATA, { recursive: true })
  w(path.join(SRC, 'install/lib.sh'), fs.readFileSync(REPO_LIB, 'utf8'))
  w(CONF, `CLIENT_NAME="Test"\nCLIENT_SLUG="test-co"\nDOMAIN="ai.example.test"\nZONE="example.test"\nINSTALL_DIR="${OPT}"\n`)
  w(path.join(OPT, 'secrets/stack.env'), 'OK_CF_ACCESS_AUD=aud-123\nOK_CF_ACCESS_PROTECTED_EMAILS=installer@example.test\n')
  w(path.join(OPT, 'secrets/cloudflare-api-token'), `${TOKEN}\n`, 0o600)
  w(path.join(T, 'head'), 'old0000000000000000000000000000000000000\n')

  // update.sh: records its args, takes a "backup", tags images, moves HEAD.
  w(path.join(SRC, 'install/update.sh'), `#!/usr/bin/env bash
echo "$@" >> "${LOGS}/update.args"
${opts.partialBackup ? `mkdir -p "${OPT}/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ)"; exit 1` : ''}
${opts.updateFailsBeforeBackup ? 'exit 1' : ''}
b="${OPT}/backups/pre-update-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$b"; touch "$b/command-center.db" "$b/data.tar.gz"
echo "pre-update-$(date -u +%Y%m%dT%H%M%SZ)" > "${LOGS}/image-tag"
${opts.nothingNew ? '' : `echo new1111111111111111111111111111111111111 > "${T}/head"`}
exit 0
`, 0o755)
  w(path.join(SRC, 'install/verify.sh'), `#!/usr/bin/env bash\necho "$@" >> "${LOGS}/verify.args"\nexit ${opts.verifyFails ? 1 : 0}\n`, 0o755)
  w(path.join(SRC, 'install/backup.sh'), `#!/usr/bin/env bash\necho "$@" >> "${LOGS}/backup.args"\ntouch "${LOGS}/restored"\nexit 0\n`, 0o755)
  w(path.join(SRC, 'install/cloudflare.sh'), `#!/usr/bin/env bash\necho "$@" >> "${LOGS}/cloudflare.args"\necho status-ok\n`, 0o755)
  w(path.join(SRC, 'install/docker-compose.yml'), 'name: test\n')

  w(path.join(BIN, 'sudo'), `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -u) shift 2 ;; -H) shift ;; *) break ;; esac; done
exec "$@"
`, 0o755)
  w(path.join(BIN, 'git'), `#!/usr/bin/env bash
echo "$@" >> "${LOGS}/git.args"
for a in "$@"; do
  case "$a" in
    get-url) echo "https://x-access-token:hunter2@github.example.test/acme/public-copy.git"; exit 0 ;;
    rev-parse) cat "${T}/head"; exit 0 ;;
    checkout) sha="\${@: -1}"; echo "$sha" > "${T}/head"; exit 0 ;;
  esac
done
exit 0
`, 0o755)
  w(path.join(BIN, 'docker'), `#!/usr/bin/env bash
echo "$@" >> "${LOGS}/docker.args"
if [ "$1" = image ] && [ "$2" = ls ]; then cat "${LOGS}/image-tag" 2>/dev/null; fi
exit 0
`, 0o755)
  // curl: health URLs, and a tiny Cloudflare API from fixture files.
  const policy = JSON.stringify({ id: 'pol1', name: 'Allowed people', decision: 'allow', precedence: 1, session_duration: '24h', approval_required: false, purpose_justification_required: true, purpose_justification_prompt: 'why?', created_at: '2026-01-01', include: opts.policy ?? [] })
  w(path.join(T, 'policy.json'), policy)
  w(path.join(BIN, 'curl'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${LOGS}/curl.argv"
if [ "\${*: -1}" != "\${*: -1#http}" ]; then :; fi
url="\${@: -1}"
cfg=""; for a in "$@"; do [ "$a" = "-K" ] && cfg=$(cat); done
[ -n "$cfg" ] && printf '%s\\n' "$cfg" >> "${LOGS}/curl.stdin"
method=GET; data=""
while [ $# -gt 0 ]; do case "$1" in -X) method=$2; shift 2 ;; --data) data=$2; shift 2 ;; *) shift ;; esac; done
case "$url" in
  http://127.0.0.1:3002/api/health) exit 0 ;;
  https://ai.example.test/api/health)
    ${opts.healthFailsUntilRollback ? `if [ -f "${LOGS}/restored" ]; then printf 200; else printf 302; fi; exit 0` : 'printf 200; exit 0'} ;;
esac
p=\${url#*client/v4}
case "$method $p" in
  "GET /zones?name=example.test") echo '{"success":true,"result":[{"id":"z1","account":{"id":"acc1"}}]}' ;;
  "GET /accounts/acc1/access/apps?per_page=100") echo '{"success":true,"result":[{"id":"app1","aud":"aud-123"}]}' ;;
  "GET /accounts/acc1/access/apps/app1/policies") echo "{\\"success\\":true,\\"result\\":[$(cat "${T}/policy.json")]}" ;;
  "PUT /accounts/acc1/access/apps/app1/policies/pol1")
    printf '%s\\n' "$data" >> "${LOGS}/put.body"
    jq -c --argjson b "$data" '. + {include: $b.include}' "${T}/policy.json" > "${T}/policy.next" && mv "${T}/policy.next" "${T}/policy.json"
    echo '{"success":true,"result":{}}' ;;
  GET\\ /zones/z1/dns_records*) echo '{"success":true,"result":[]}' ;;
  *) echo '{"success":false,"errors":[{"message":"unexpected"}]}' ;;
esac
`, 0o755)
}

function run(args: string[], stdin = ''): { code: number; stdout: string; stderr: string; json: Record<string, unknown> | null } {
  const r = spawnSync('bash', [RUNNER, ...args], {
    input: stdin,
    encoding: 'utf8',
    timeout: 60_000,
    env: { PATH: `${BIN}:${process.env.HOME}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: T, OK_DEVOPS_CF_API: 'https://api.cloudflare.test/client/v4', OK_DEVOPS_PAUSE: '0' },
  })
  const lines = (r.stdout || '').trim().split('\n').filter(l => l.startsWith('{'))
  let json: Record<string, unknown> | null = null
  try { json = lines.length ? JSON.parse(lines[lines.length - 1]) : null } catch { json = null }
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr, json }
}

function deploy(id = 7) {
  const r = run(['deploy', SRC, CONF, String(id), 'https://ai.example.test/api/health', HOSTDATA])
  const status = JSON.parse(read(path.join(HOSTDATA, 'dev-ops', `deploy-${id}.json`)) || '{}') as Record<string, string>
  return { ...r, status }
}

afterEach(() => { if (T) fs.rmSync(T, { recursive: true, force: true }) })

describe.skipIf(!READY)('host-runner.sh deploy', () => {
  beforeEach(() => setup())

  it('runs update.sh --config exactly, then verify + health → deployed, nothing rolled back', () => {
    const r = deploy()
    expect(r.status.state).toBe('deployed')
    expect(read(path.join(LOGS, 'update.args')).trim()).toBe(`--config ${CONF}`)
    expect(read(path.join(LOGS, 'verify.args')).trim()).toBe(`--config ${CONF}`)
    expect(read(path.join(LOGS, 'backup.args'))).toBe('')
    expect(r.status.from_sha).toMatch(/^old/)
    expect(r.status.to_sha).toMatch(/^new/)
    expect(r.status.backup_dir).toContain(`${OPT}/backups/pre-update-`)
    expect(r.status.source).toBe('https://github.example.test/acme/public-copy.git')
  })

  it('same commit before and after → unchanged ("nothing new to deploy"), never deployed; no rollback (obj 901479)', () => {
    setup({ nothingNew: true })
    const r = deploy()
    expect(r.code).toBe(0)
    expect(r.status.state).toBe('unchanged')
    expect(r.status.from_sha).toBe(r.status.to_sha)
    expect(r.status.message).toMatch(/^nothing new to deploy: main at https:\/\/github\.example\.test\/acme\/public-copy\.git is still old0+/)
    expect(r.status.message).toContain('No new code went live')
    expect(JSON.stringify(r.status)).not.toContain('hunter2')
    // update.sh, verify.sh and the health check still ran; nothing was restored.
    expect(read(path.join(LOGS, 'update.args')).trim()).toBe(`--config ${CONF}`)
    expect(read(path.join(LOGS, 'verify.args')).trim()).toBe(`--config ${CONF}`)
    expect(read(path.join(LOGS, 'backup.args'))).toBe('')
  })
})

describe.skipIf(!READY)('host-runner.sh rollback', () => {
  it('verify fails → old commit, old images, restore THIS run\'s backup, stack up → rolled_back', () => {
    setup({ verifyFails: true })
    const r = deploy()
    expect(r.status.state).toBe('rolled_back')
    expect(r.status.step).toBe('verify')
    expect(read(path.join(LOGS, 'git.args'))).toMatch(/checkout --quiet --detach old0+/)
    expect(read(path.join(T, 'head'))).toMatch(/^old/)
    const docker = read(path.join(LOGS, 'docker.args'))
    expect(docker).toMatch(/tag operationkit-app:pre-update-\S+ operationkit-app:local/)
    expect(docker).toMatch(/compose --project-name operationkit .* up -d/)
    expect(read(path.join(LOGS, 'backup.args')).trim()).toMatch(new RegExp(`^restore ${OPT}/backups/pre-update-\\S+ --config ${CONF} --yes$`))
  })

  it('public health fails → the same rollback, then health answers again → rolled_back', () => {
    setup({ healthFailsUntilRollback: true })
    const r = deploy()
    expect(r.status.state).toBe('rolled_back')
    expect(r.status.step).toBe('health')
    expect(read(path.join(LOGS, 'backup.args'))).toMatch(/^restore /)
  })

  it('update.sh fails before its backup → failed, nothing rolled back', () => {
    setup({ updateFailsBeforeBackup: true })
    const r = deploy()
    expect(r.status.state).toBe('failed')
    expect(read(path.join(LOGS, 'backup.args'))).toBe('')
    expect(read(path.join(LOGS, 'git.args'))).not.toMatch(/checkout/)
  })

  it('a half-written backup folder (backup.sh failed) is not a backup: failed, nothing rolled back', () => {
    setup({ partialBackup: true })
    const r = deploy()
    expect(r.status.state).toBe('failed')
    expect(read(path.join(LOGS, 'backup.args'))).toBe('')
  })

  it('refuses a non-https health URL and odd paths', () => {
    setup()
    expect(run(['deploy', SRC, CONF, '7', 'http://ai.example.test/api/health', HOSTDATA]).json?.code).toBe('bad_args')
    expect(run(['deploy', `${SRC}/../x`, CONF, '7', 'https://ai.example.test/api/health', HOSTDATA]).json?.code).toBe('bad_args')
  })
})

describe.skipIf(!READY)('host-runner.sh Cloudflare Access', () => {
  const SEEDED = 'seeded-owner@example.test'
  const SEEDED_SHA = createHash('sha256').update(SEEDED).digest('hex')
  const START = [{ email: { email: SEEDED } }, { email: { email: 'owner@example.test' } }, { email: { email: 'casey@example.com' } }, { group: { id: 'g1' } }]

  it('never removes a protected address (seed hash, installer list, request list) — no PUT sent', () => {
    setup({ policy: START })
    for (const email of [SEEDED, 'Seeded-Owner@example.test', 'installer@example.test', 'owner@example.test']) {
      const r = run(['access-remove', SRC, CONF], JSON.stringify({ email, protected: ['owner@example.test'], protected_sha256: [SEEDED_SHA] }))
      expect(r.json).toMatchObject({ ok: false, code: 'protected' })
    }
    expect(read(path.join(LOGS, 'put.body'))).toBe('')
  })

  it('add keeps every existing entry and adds exactly one email; the token goes to curl on stdin only', () => {
    setup({ policy: START })
    const r = run(['access-add', SRC, CONF], JSON.stringify({ email: 'New@Example.test' }))
    expect(r.json).toMatchObject({ ok: true, code: 'added', email: 'new@example.test' })
    const body = JSON.parse(read(path.join(LOGS, 'put.body')).trim())
    expect(body.include).toEqual([...START, { email: { email: 'new@example.test' } }])
    expect(body.include.some((x: Record<string, unknown>) => 'email_domain' in x)).toBe(false)
    // Every other policy setting is carried over; read-only fields are not sent.
    expect(body).toMatchObject({ name: 'Allowed people', decision: 'allow', precedence: 1, session_duration: '24h', approval_required: false, purpose_justification_required: true, purpose_justification_prompt: 'why?' })
    expect(body.created_at).toBeUndefined()
    expect(body.id).toBeUndefined()
    expect(read(path.join(LOGS, 'curl.argv'))).not.toContain(TOKEN)
    expect(read(path.join(LOGS, 'curl.stdin'))).toContain(`Authorization: Bearer ${TOKEN}`)
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
  })

  it('add refuses a domain', () => {
    setup({ policy: START })
    expect(run(['access-add', SRC, CONF], JSON.stringify({ email: 'example.com' })).json).toMatchObject({ ok: false, code: 'bad_email' })
    expect(read(path.join(LOGS, 'put.body'))).toBe('')
  })

  it('remove drops only that one entry', () => {
    setup({ policy: START })
    const r = run(['access-remove', SRC, CONF], JSON.stringify({ email: 'casey@example.com', protected: [] }))
    expect(r.json).toMatchObject({ ok: true, code: 'removed' })
    const body = JSON.parse(read(path.join(LOGS, 'put.body')).trim())
    expect(body.include).toEqual(START.filter(x => x.email?.email !== 'casey@example.com'))
  })

  it('list returns emails / domains only', () => {
    setup({ policy: START })
    expect(run(['access-list', SRC, CONF], '{}').json).toMatchObject({ ok: true, allow: { emails: [SEEDED, 'owner@example.test', 'casey@example.com'], domains: [], other_rules: 1 } })
  })
})

describe.skipIf(!READY)('host-runner.sh DNS + cloudflare.sh', () => {
  beforeEach(() => setup())

  it('the install\'s own record and names outside the zone refuse with no write', () => {
    expect(run(['dns-upsert', SRC, CONF], JSON.stringify({ type: 'CNAME', name: 'ai.example.test', content: 'x.example.test' })).json?.code).toBe('own_record')
    expect(run(['dns-delete', SRC, CONF], JSON.stringify({ type: 'A', name: 'www.other.com' })).json?.code).toBe('outside_zone')
    expect(run(['dns-upsert', SRC, CONF], JSON.stringify({ type: 'NS', name: 'x.example.test', content: 'ns.evil.com' })).json?.code).toBe('bad_type')
    expect(read(path.join(LOGS, 'curl.argv'))).not.toMatch(/-X (POST|PUT|DELETE)/)
  })

  it('cloudflare.sh runs only status / api-bypass / api-bic', () => {
    expect(run(['cf-run', SRC, CONF], JSON.stringify({ command: 'down' })).json?.code).toBe('bad_command')
    expect(read(path.join(LOGS, 'cloudflare.args'))).toBe('')
    expect(run(['cf-run', SRC, CONF], JSON.stringify({ command: 'status' })).json).toMatchObject({ ok: true, code: 'ran' })
    expect(read(path.join(LOGS, 'cloudflare.args')).trim()).toBe(`status --config ${CONF}`)
  })
})
