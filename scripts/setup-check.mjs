#!/usr/bin/env node
// Dependency-free: run before npm ci. This command never installs or changes anything.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const USAGE = `Usage: node scripts/setup-check.mjs [--mode source|server] [--json]

source (default): check the host for source development with AI workers.
server: check the target host for the Ubuntu installer; host Node is not required
        by that installer, and it installs Docker itself when needed.

Run this on the machine where Operation Kit will execute. These preliminary
checks do not validate credentials, capacity, or a completed installation.
See INSTALL.md for the supported server installation and install/verify.sh.
`

export function collectChecks({ mode = 'source', platform = process.platform,
  nodeVersion = process.versions.node,
  readRelease = () => readFileSync('/etc/os-release', 'utf8'),
  probe = () => spawnSync('docker', ['info', '--format', '{{.OSType}}'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  }),
} = {}) {
  if (!['source', 'server'].includes(mode)) throw new Error('Unknown setup mode')
  const checks = []
  const add = (id, status, message, action = '') => checks.push({ id, status, message, action })
  if (mode === 'source') {
    add('node', nodeVersion.split('.')[0] === '22' ? 'pass' : 'block',
      `Node ${nodeVersion}; this repository builds and tests with Node 22.`,
      nodeVersion.split('.')[0] === '22' ? '' : 'Select Node 22 before running npm ci in app/. Native dependencies may fail on other versions.')
    add('host', platform === 'linux' ? 'pass' : 'block',
      platform === 'linux' ? 'Linux host detected.' : `Native ${platform} is not the documented full worker runtime.`,
      platform === 'linux' ? '' : 'Use an Ubuntu 24.04 host or VM and follow INSTALL.md. Starting Docker Desktop alone does not make the Ubuntu installer supported on this host.')
  } else {
    let release = ''
    try { if (platform === 'linux') release = readRelease() } catch { /* reported below */ }
    const value = key => release.match(new RegExp(`^${key}=["']?([^"'\\r\\n]+)["']?$`, 'm'))?.[1]
    const supported = platform === 'linux' && value('ID') === 'ubuntu' && value('VERSION_ID') === '24.04'
    add('host', supported ? 'pass' : 'block',
      supported ? 'Ubuntu 24.04 detected.' : 'The server installer requires Ubuntu 24.04; this host could not be verified as supported.',
      supported ? '' : 'Run the installer on a fresh Ubuntu 24.04 host. For a trial without a domain, follow INSTALL.md: Test install without a domain.')
    add('node', 'info', 'Host Node version is not a server-installer prerequisite; the app image provides Node.')
  }

  let result
  try { result = probe() } catch { result = { error: { code: 'UNKNOWN' } } }
  const failure = mode === 'source' ? 'block' : 'warn'
  if (result.error?.code === 'ENOENT') {
    add('docker', failure, 'Docker CLI is not installed or is not on PATH.',
      mode === 'server' ? 'The Ubuntu installer installs Docker; no manual install is needed on a fresh supported server.' : 'Install Docker on the Linux execution host, then run this check again.')
  } else if (result.error || result.status !== 0) {
    add('docker', failure, 'Docker engine is unavailable, inaccessible, or did not respond within 10 seconds.',
      mode === 'server' ? 'The installer configures Docker on a fresh supported server. On an existing install, check docker info and service access.' : 'Run docker info in this terminal. Start the engine and check access permissions. On Windows/macOS, also resolve the host requirement above.')
  } else if (String(result.stdout).trim() !== 'linux') {
    add('docker', failure, 'The active Docker engine is not a Linux engine.', 'Select a Linux Docker engine and run this check again.')
  } else {
    add('docker', 'pass', 'Linux Docker engine is reachable.')
  }
  return { mode, checks, blocked: checks.some(check => check.status === 'block') }
}

export function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) { console.log(USAGE); return 0 }
  let mode = 'source'
  let json = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true
    else if (args[i] === '--mode' && ['source', 'server'].includes(args[i + 1])) mode = args[++i]
    else { console.error(USAGE); return 2 }
  }
  const report = collectChecks({ mode })
  if (json) console.log(JSON.stringify(report, null, 2))
  else {
    console.log(`Operation Kit setup check (${mode})\n`)
    for (const check of report.checks) {
      console.log(`[${check.status.toUpperCase()}] ${check.message}`)
      if (check.action) console.log(`  Next: ${check.action}`)
    }
    console.log(report.blocked
      ? '\nResolve the blockers above before installing dependencies or starting the installer.'
      : '\nPreliminary checks complete. Follow INSTALL.md; installation and credentials still need verification.')
  }
  return report.blocked ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main()
}
