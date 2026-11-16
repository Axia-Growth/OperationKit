/**
 * jail-browser-proof-stage.ts — stage a browser jail EXACTLY as the server does
 * (obj 901029), for scripts/jail-browser-proof.sh.
 *
 * Uses the shipped planner (`planJailCardBrowser`) and the shipped argv builder
 * (`buildJailRunArgv`), so the proof exercises production code, not a copy.
 * Prints the docker argv (without the leading "docker") as one JSON array.
 *
 *   usage: tsx scripts/jail-browser-proof-stage.ts <root> <image> [--no-seccomp]
 *          (run from app/server so module resolution finds its deps)
 */
import fs from 'node:fs'
import path from 'node:path'
import { planJailCardBrowser } from '../app/server/src/services/card-browser-spawn.js'
import { buildJailRunArgv, renderEnvFile, JAIL_HOME_PATH } from '../app/server/src/services/session-jail.js'

const [root, image, ...rest] = process.argv.slice(2)
if (!root || !image) {
  console.error('usage: jail-browser-proof-stage.ts <root> <image> [--no-seccomp] [--name N] [--cmd "..."]')
  process.exit(2)
}
const flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined }
const sessionId = 'cc-901029-proof'
const home = path.join(root, 'home')
const work = path.join(root, 'workspace')
fs.mkdirSync(path.join(home, '.cc'), { recursive: true })
fs.mkdirSync(work, { recursive: true })

// The planner's own WORKER policy (obj 901051), from a stock env (no install
// domain): loopback refused, metadata + private network blocked, everything else
// refused. `--loopback-ports P` = an operator's CARD_BROWSER_WORKER_LOOPBACK_PORTS.
const loopbackPorts = flag('--loopback-ports')
const r = planJailCardBrowser({
  sessionId,
  scriptDirHost: path.join(home, '.cc'),
  scriptDirGuest: `${JAIL_HOME_PATH}/.cc`,
  jailHomeGuest: JAIL_HOME_PATH,
  env: loopbackPorts ? { CARD_BROWSER_WORKER_LOOPBACK_PORTS: loopbackPorts } : {},
  // jail-browser-proof.sh already checked both images exist (and tags them :proof,
  // not the :local name the planner probes for), so skip the presence probe here.
  imagePresent: () => true,
})
if (!r.ok) { console.error(`planner refused: ${r.reason}`); process.exit(1) }
const envFile = path.join(root, 'jail.env')
// HOME as the real spawn sets it (fullEnv in spawnInTmux); uid 1000 would otherwise get a read-only /home/node.
fs.writeFileSync(envFile, renderEnvFile({ ...r.plan.env, HOME: JAIL_HOME_PATH }), { mode: 0o644 })
// The proof runs as uid 1000 with files staged by the runner user; open them up.
for (const p of [home, ...walk(home)]) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o777 : 0o644)
fs.chmodSync(work, 0o777)

const argv = buildJailRunArgv({
  objectiveId: flag('--name') ?? '901029',
  sessionId,
  worktreePath: work,
  homePath: home,
  envFilePath: envFile,
  image,
  seccompProfile: rest.includes('--no-seccomp') ? undefined : r.plan.jail!.seccompProfile,
  tmpSize: '512m',
  command: ['bash', '-lc', (r.plan.jail!.guardPrefix) + (flag('--cmd') ?? 'sleep infinity')],
})
// `run -d` → foreground, so the proof sees the command's exit code and output.
const out = argv.filter((a) => a !== '-d')
out.splice(1, 0, '--rm')
process.stdout.write(JSON.stringify(out))

function walk(d: string): string[] {
  return fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name)
    return e.isDirectory() ? [p, ...walk(p)] : [p]
  })
}
