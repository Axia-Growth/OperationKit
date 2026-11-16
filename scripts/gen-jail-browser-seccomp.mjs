#!/usr/bin/env node
// gen-jail-browser-seccomp.mjs — regenerate app/server/src/lib/jail-browser-seccomp.json
// (obj 901029).
//
// The browser jail keeps every jail control (cap-drop ALL, no-new-privileges,
// read-only root, non-root user). The ONE thing it needs that Docker's default
// seccomp profile withholds from a container without CAP_SYS_ADMIN is the
// ability to create the user/pid/net namespaces Chromium's OS sandbox is built
// from (clone with CLONE_NEW* flags, unshare, setns), plus chroot: the zygote
// chroots into /proc/self/fdinfo/ inside its NEW user namespace, and Docker's
// default only allows chroot to containers holding CAP_SYS_CHROOT (the jail drops
// it). The kernel still requires CAP_SYS_CHROOT in the caller's own namespace,
// so outside a fresh user namespace chroot keeps failing with EPERM. So:
//
//   Docker's default profile, from a PINNED moby/profiles commit
//   + ONE extra rule: allow chroot / clone / unshare / setns, without CAP_SYS_ADMIN.
//
// Nothing else changes. mount / umount / bpf / perf_event_open etc. stay behind
// CAP_SYS_ADMIN, which the jail never has, so they remain blocked. clone3 keeps
// returning ENOSYS (glibc falls back to clone, which the new rule filters only
// by name). jail-browser-seccomp.test.ts asserts exactly this delta.
//
//   usage: node scripts/gen-jail-browser-seccomp.mjs           # fetch + write
//          node scripts/gen-jail-browser-seccomp.mjs --check   # exit 1 if stale
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

export const MOBY_PROFILES_COMMIT = 'f862455628f78f84c937e967e4a03902fb1dee11'
const SRC = `https://raw.githubusercontent.com/moby/profiles/${MOBY_PROFILES_COMMIT}/seccomp/default.json`
export const USERNS_RULE = {
  names: ['chroot', 'clone', 'setns', 'unshare'],
  action: 'SCMP_ACT_ALLOW',
  comment:
    'obj 901029: Chromium user-namespace sandbox in the card browser jail. ' +
    'The ONLY addition to Docker\'s default profile; see scripts/gen-jail-browser-seccomp.mjs.',
}

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(here, '../app/server/src/lib/jail-browser-seccomp.json')

const res = await fetch(SRC)
if (!res.ok) { console.error(`fetch ${SRC} -> ${res.status}`); process.exit(2) }
const raw = await res.text()
const base = JSON.parse(raw)
const profile = {
  ...base,
  // Provenance (commit + this script) lives in the added rule comment, not a
  // top-level key, so the file stays a plain Docker seccomp profile.
  syscalls: [...base.syscalls, USERNS_RULE],
}
const body = JSON.stringify(profile, null, 2) + '\n'
if (process.argv.includes('--check')) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : ''
  if (cur !== body) { console.error(`${OUT} is stale; re-run without --check`); process.exit(1) }
  console.log('up to date')
} else {
  fs.writeFileSync(OUT, body)
  console.log(`wrote ${OUT} (base sha256 ${crypto.createHash('sha256').update(raw).digest('hex')})`)
}
