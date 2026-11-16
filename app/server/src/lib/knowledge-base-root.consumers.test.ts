/**
 * obj 900964 — one way to find the knowledge base root.
 *
 * Six modules used to resolve the root on their own: the chat engine read
 * KNOWLEDGE_BASE_DIR, loops / content owners / contacts / the internal vault
 * routes read VAULT_PATH, the mentor context hard-coded the operator's path,
 * and the Knowledge page read SECOND_BRAIN_DIR. So chat bots could read one
 * folder while the Knowledge page wrote another. Every consumer must now
 * return `knowledgeBaseRoot()` under every env combination.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DATA_KB_DIR, KB_ROOT_ENV_VARS, isVaultLayout, knowledgeBaseRoot } from './knowledge-base-root.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-root-consumers-'))
process.env.DB_PATH = path.join(TMP, 'cc.db')
process.env.JWT_SECRET = 'kb-root-consumers-test'

const ROOT_VARS = [...KB_ROOT_ENV_VARS, 'DOC_INGEST_KB_DIR'] as const
const saved: Record<string, string | undefined> = {}
for (const name of ROOT_VARS) saved[name] = process.env[name]

function setEnv(vars: Partial<Record<(typeof ROOT_VARS)[number], string>>): void {
  for (const name of ROOT_VARS) delete process.env[name]
  Object.assign(process.env, vars)
}

type Consumers = Record<string, () => string>
let consumers: Consumers

beforeAll(async () => {
  const engine = await import('../services/agent-chat/engine.js')
  const loops = await import('../services/loops.js')
  const owners = await import('../services/content-owners.js')
  const mentor = await import('../services/mentor-context.js')
  const fileAccess = await import('../services/file-access.js')
  const contacts = await import('../routes/contacts.js')
  const internalVault = await import('../routes/internal-vault.js')
  consumers = {
    'agent-chat engine.knowledgeRoot': () => engine.knowledgeRoot(),
    'loops': () => loops.loopsVaultBase(),
    'content-owners': () => owners.vaultBase(),
    'content-owners ownerPaths': () =>
      path.dirname(path.dirname(owners.ownerPaths({ vault_workspace: 'acme', founder_slug: 'f' } as never).wsRoot)),
    'mentor-context': () => mentor.mentorVaultRoot(),
    'file-access vault root': () => fileAccess.defaultFileRoots().find((r) => r.id === 'vault')!.path,
    'file-access shared path': () => path.dirname(fileAccess.defaultSharedPaths()[0]),
    'routes/contacts': () => contacts.contactsVaultBase(),
    'routes/internal-vault': () => internalVault.internalVaultBase(),
  }
}, 60_000)

afterEach(() => setEnv({}))
afterAll(() => {
  for (const name of ROOT_VARS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  fs.rmSync(TMP, { recursive: true, force: true })
})

function expectAllAgree(expected: string): void {
  expect(knowledgeBaseRoot()).toBe(expected)
  for (const [name, read] of Object.entries(consumers)) expect(read(), name).toBe(expected)
}

describe('every consumer resolves the same knowledge base root', () => {
  it('no env var set: the default vault when it is on this host, else the /app/data folder', () => {
    setEnv({})
    const expected = knowledgeBaseRoot({})
    // Whichever branch this host takes, it is one of the two documented defaults, never a third path.
    expect([path.resolve(DATA_KB_DIR), '/home/operator/second-brain']).toContain(expected)
    expectAllAgree(expected)
  })

  it('no env var set, no vault on the host: /app/data/knowledge-base (DOC_INGEST_KB_DIR overrides)', () => {
    expect(knowledgeBaseRoot({}, false)).toBe(path.resolve(DATA_KB_DIR))
    expect(knowledgeBaseRoot({ DOC_INGEST_KB_DIR: '/data/kb' }, false)).toBe('/data/kb')
    expect(isVaultLayout({}, false)).toBe(false)
  })

  for (const name of KB_ROOT_ENV_VARS) {
    it(`only ${name} set: everyone uses it`, () => {
      const dir = path.join(TMP, name.toLowerCase())
      setEnv({ [name]: dir })
      expectAllAgree(dir)
      expect(isVaultLayout()).toBe(true)
    })
  }

  it('several set: SECOND_BRAIN_ROOT > SECOND_BRAIN_DIR > KNOWLEDGE_BASE_DIR > VAULT_PATH, for everyone', () => {
    const dirs = Object.fromEntries(KB_ROOT_ENV_VARS.map((n) => [n, path.join(TMP, 'multi', n.toLowerCase())]))
    for (let i = 0; i < KB_ROOT_ENV_VARS.length; i++) {
      const present = KB_ROOT_ENV_VARS.slice(i)
      setEnv(Object.fromEntries(present.map((n) => [n, dirs[n]])))
      expectAllAgree(dirs[present[0]])
    }
  })

  it('a blank value is ignored, not treated as a root', () => {
    const dir = path.join(TMP, 'blank')
    setEnv({ SECOND_BRAIN_DIR: '  ', KNOWLEDGE_BASE_DIR: '', VAULT_PATH: dir })
    expectAllAgree(dir)
  })
})
