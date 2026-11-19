#!/usr/bin/env python3
"""ci-docs-only.py - is this pull request a docs/vault-only change?

Used by the `changes` job in .github/workflows/gate.yml (obj 901348). When the
answer is yes, the heavy gate jobs (typecheck, unit, build, ...) are skipped and
the aggregate `gate` check still reports success, so a docs-only PR stays
mergeable without spending a full ~16-job CI run.

USAGE:  ci-docs-only.py BASE HEAD
        Run inside the repo. BASE/HEAD are any commit-ish; on a pull_request
        checkout the workflow passes `HEAD^1 HEAD` (merge commit vs base tip).
OUTPUT: stdout, one line for $GITHUB_OUTPUT:  docs_only=true | docs_only=false
        The reasoning goes to stderr.
EXIT:   0 with an answer; non-zero if git fails (fail closed: the gate goes red).

A diff is docs-only ONLY when EVERY changed path (adds, edits, deletes; renames
count as both sides) passes both rules:

  1. The path is documentation or vault evidence:
       docs/**, design/**, .evidence/**, tests/smoke/**  with a doc/image
       extension (.md .markdown .txt .png .jpg .jpeg .gif .svg .webp), or one of
       the root files README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md
       INSTALL.md CLAUDE.md.
     Anything else - app code, scripts, install, workflows, config, lockfiles,
     YAML/JSON fixtures that happen to live under docs/ - is NOT docs-only.

  2. No gated test reads it. Some docs ARE test inputs (a docs lint walks
     docs/api, a test parses docs/design/BOT-SECRET-SCOPE.md). So every test,
     fixture and test config at HEAD (see CORPUS below) is searched for
     the changed path, each of its parent directories (2+ segments), its
     basename (when that name is specific), and the quoted-segment form
     ('docs', 'api') used with path.join. Any hit means a test may depend on
     this file, so the full suite runs.

An empty diff, or a git error, is never docs-only.
"""
import os
import re
import subprocess
import sys

DOC_EXT = {'.md', '.markdown', '.txt', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'}
DOC_DIRS = ('docs/', 'design/', '.evidence/', 'tests/smoke/')
ROOT_DOCS = {'README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md', 'INSTALL.md', 'CLAUDE.md'}
# Basenames too common to search for on their own (they appear in fixtures that
# write a throwaway README.md). Their directory needles still apply.
GENERIC_BASENAMES = {'README.md', 'readme.md', 'index.md', 'ARTIFACT.md', 'NOTES.md'}

# The search corpus: what the gated jobs EXECUTE and could trip over a doc.
#   * every test/spec file and test fixture under app/ (the vitest suites, server
#     + client + shared),
#   * the vite/vitest configs and setup files (a build or test-time import of a
#     doc would show up here),
#   * the gate's own script tests under scripts/.
# App runtime code is deliberately NOT in the corpus: nothing under
# app/**/src reads a repo doc at runtime (checked when this was written; a new
# reader would be exercised by a test, which IS in the corpus). Code comments
# that merely cite a doc path still count as a hit - conservative by design.
CORPUS = [
    ':(glob)app/**/*.test.*', ':(glob)app/**/*.spec.*', ':(glob)app/**/__tests__/**',
    ':(glob)app/**/__fixtures__/**', ':(glob)app/**/fixtures/**',
    ':(glob)app/*/vite.config.*', ':(glob)app/*/vitest.config.*', ':(glob)app/*/vitest.setup.*',
    ':(glob)scripts/**/*test*', ':(glob)scripts/test-integrity.py',
]
# Fixture DOCS (markdown under a fixtures dir) are data, not readers.
CORPUS_EXCLUDES = [':(exclude,glob)**/*.md', ':(exclude,glob)**/*.png', ':(exclude,glob)**/*.svg']


def git(*args, ok_codes=(0,)):
    r = subprocess.run(['git', *args], capture_output=True, text=True)
    if r.returncode not in ok_codes:
        sys.stderr.write(r.stderr)
        raise SystemExit(f'FATAL: git {" ".join(args)} exited {r.returncode}')
    return r


def is_doc_path(p):
    if p in ROOT_DOCS:
        return True
    ext = os.path.splitext(p)[1].lower()
    return ext in DOC_EXT and p.startswith(DOC_DIRS)


Q = "[\"'`]"  # any quote that opens/closes a string literal


def ere(text):
    """Escape a literal for POSIX ERE (git grep -E)."""
    return re.sub(r'([.\[\]()*+?{}|^$\\])', r'\\\1', text)


def needles(p):
    """POSIX ERE patterns whose presence in a test means it may read `p`.

    * the full path, anywhere (it is specific enough on its own);
    * each parent dir of 2+ segments as a WHOLE string literal ('docs/api',
      'docs/api/', '../../docs/api', 'docs/api/**') - a dir walker. A comment or
      a longer path that merely starts with the dir does not count;
    * the basename as a quoted literal (or after a '/'), unless it is generic,
      in which case 'parent/basename' anywhere;
    * each adjacent segment pair in quoted path.join form: 'docs', 'api'.
    """
    parts = p.split('/')
    pats = {ere(p)}
    for i in range(2, len(parts)):
        d = ere('/'.join(parts[:i]))
        pats.add(f"{Q}(\\.\\./)*{d}(/[*][^\"'`]*)?/?{Q}")
    base = parts[-1]
    if base not in GENERIC_BASENAMES:
        pats.add(f"({Q}|/){ere(base)}{Q}")
    elif len(parts) >= 2:
        pats.add(ere('/'.join(parts[-2:])))
    for x, y in zip(parts, parts[1:]):
        pats.add(f"{Q}{ere(x)}{Q}[[:space:]]*,[[:space:]]*{Q}{ere(y)}{Q}")
    return sorted(pats)


def referenced_by_code(p):
    cmd = ['grep', '-l', '-I', '-E']
    for rx in needles(p):
        cmd += ['-e', rx]
    r = git(*cmd, '--', *CORPUS, *CORPUS_EXCLUDES, ok_codes=(0, 1))
    return sorted(set(r.stdout.split()))


def classify(paths):
    """Return (docs_only: bool, reasons: list[str])."""
    if not paths:
        return False, ['empty diff -> run everything']
    reasons = []
    for p in paths:
        if not is_doc_path(p):
            reasons.append(f'not docs/vault: {p}')
    if reasons:
        return False, reasons
    for p in paths:
        hits = referenced_by_code(p)
        if hits:
            reasons.append(f'read by code: {p} <- {", ".join(hits[:5])}{" ..." if len(hits) > 5 else ""}')
    if reasons:
        return False, reasons
    return True, [f'docs/vault-only: {p}' for p in paths]


def main(argv):
    if len(argv) != 3:
        raise SystemExit('usage: ci-docs-only.py BASE HEAD')
    base, head = argv[1], argv[2]
    # --no-renames: a rename is reported as delete + add, so BOTH paths are judged.
    out = git('diff', '--no-renames', '--name-only', base, head).stdout
    paths = [l for l in out.splitlines() if l.strip()]
    docs_only, reasons = classify(paths)
    sys.stderr.write(f'{len(paths)} changed path(s) between {base} and {head}\n')
    for r in reasons[:200]:
        sys.stderr.write(f'  {r}\n')
    print(f'docs_only={"true" if docs_only else "false"}')


if __name__ == '__main__':
    main(sys.argv)
