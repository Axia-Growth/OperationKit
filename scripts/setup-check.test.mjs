import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectChecks } from './setup-check.mjs'

const linuxDocker = () => ({ status: 0, stdout: 'linux\n' })
const source = overrides => collectChecks({ platform: 'linux', nodeVersion: '22.12.0', probe: linuxDocker, ...overrides })

test('reports the Windows, Node 24 and stopped Docker installation failure together', () => {
  const report = source({ platform: 'win32', nodeVersion: '24.16.0', probe: () => ({ status: 1 }) })
  assert.equal(report.blocked, true)
  assert.deepEqual(report.checks.filter(c => c.status === 'block').map(c => c.id), ['node', 'host', 'docker'])
  assert.ok(report.checks.every(c => c.action.length > 0))
})

test('a running Docker Desktop engine does not make Windows a supported host', () => {
  assert.equal(source({ platform: 'win32' }).checks.find(c => c.id === 'host').status, 'block')
})

test('source prerequisites pass with Node 22, Linux and a Linux engine', () => {
  assert.equal(source().blocked, false)
})

test('fresh Ubuntu server can proceed without Docker or host Node 22', () => {
  const report = source({ mode: 'server', nodeVersion: '24.16.0',
    readRelease: () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
    probe: () => ({ error: { code: 'ENOENT' } }),
  })
  assert.equal(report.blocked, false)
  assert.equal(report.checks.find(c => c.id === 'docker').status, 'warn')
  assert.equal(report.checks.find(c => c.id === 'node').status, 'info')
})

test('unsupported or unreadable Linux distribution blocks server install', () => {
  for (const readRelease of [() => 'ID=ubuntu\nVERSION_ID="22.04"\n', () => 'ID=debian\nVERSION_ID="24.04"\n', () => { throw new Error('unreadable') }]) {
    assert.equal(source({ mode: 'server', readRelease }).blocked, true)
  }
})

test('missing CLI, inaccessible engine, timeouts and Windows containers block source setup', () => {
  for (const result of [{ error: { code: 'ENOENT' } }, { status: 1 }, { error: { code: 'ETIMEDOUT' }, status: null }, { status: 0, stdout: 'windows\n' }]) {
    assert.equal(source({ probe: () => result }).checks.find(c => c.id === 'docker').status, 'block')
  }
})

test('Docker errors never echo potentially sensitive raw diagnostics', () => {
  const report = source({ probe: () => ({ status: 1, stderr: 'secret-value', stdout: 'secret-value' }) })
  assert.equal(JSON.stringify(report).includes('secret-value'), false)
})

test('CLI help and invalid arguments work without dependencies', () => {
  const script = fileURLToPath(new URL('./setup-check.mjs', import.meta.url))
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  const invalid = spawnSync(process.execPath, [script, '--mode', 'unknown'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
})
