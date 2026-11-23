#!/usr/bin/env bash
# ci-docs-only-test.sh — fixture test for scripts/ci-docs-only.py (obj 901348).
#
# Builds a throwaway git repo and asserts which diffs the gate may treat as
# docs/vault-only (heavy jobs skipped, `gate` still green) and which must run
# the full suite. Runs first in the gate's `changes` job, so a broken rule can
# never silently wave a code change through as "docs".
#
# USAGE: scripts/ci-docs-only-test.sh
# EXIT:  0 when every assertion passes; 1 otherwise.

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="$REPO_ROOT/scripts/ci-docs-only.py"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILED=0
ok()  { echo "  PASS  $*"; }
bad() { echo "  FAIL  $*"; FAILED=1; }

R="$WORK/repo"
mkdir -p "$R" && cd "$R" || exit 1
git init -q -b main
git config user.email fixture@example.com
git config user.name fixture
mkdir -p docs/api docs/design docs/wiki app/server/src .github/workflows scripts tests/smoke/flow .evidence/1
echo '# guide'            > docs/guide.md
echo '# api'              > docs/api/README.md
echo '# read by a test'   > docs/read-by-test.md
echo '# design note'      > docs/design/note.md
echo '# wiki'             > docs/wiki/Page.md
echo 'k: v'               > docs/fixture.yaml
echo '# readme'           > README.md
echo 'export const x = 1' > app/server/src/x.ts
echo 'on: pull_request'   > .github/workflows/gate.yml
echo 'echo hi'            > scripts/foo.sh
# Test readers: a dir walker, a path.join reader, and a comment that only
# mentions a docs dir (a comment is not a reader).
cat > app/server/src/lint.test.ts <<'T'
const DOC_DIRS = ['docs/api']
const p = path.join(root, 'docs', 'read-by-test.md')
// background: docs/design holds prose design notes
T
git add -A && git commit -qm base
BASE=$(git rev-parse HEAD)

# expect NAME WANT — commit the staged change, classify BASE..HEAD, reset.
expect() {
  local name="$1" want="$2" got
  git add -A && git commit -qm "$name" --allow-empty
  # Every case except 'empty diff' must actually change something, or it passes vacuously.
  if [ "$name" != 'empty diff' ] && git diff --quiet "$BASE" HEAD; then bad "$name: fixture produced an empty diff"; git reset -q --hard "$BASE"; return; fi
  got=$(python3 "$CHECK" "$BASE" HEAD 2>"$WORK/err")
  if [ "$got" = "docs_only=$want" ]; then ok "$name -> $want"; else bad "$name: want docs_only=$want, got '$got'"; sed 's/^/        /' "$WORK/err"; fi
  git reset -q --hard "$BASE"
}

echo '# more'   >> docs/guide.md;                                  expect 'edit prose doc' true
echo '# more'   >> docs/wiki/Page.md;                              expect 'edit vault wiki page' true
echo '# more'   >> docs/design/note.md;                            expect 'doc whose dir is only named in a comment' true
echo '# more'   >> README.md; echo x > tests/smoke/flow/01.png;    expect 'root README + smoke evidence png' true
mkdir -p .evidence/1; echo '# ev' > .evidence/1/ARTIFACT.md;                        expect 'evidence markdown' true
git rm -q docs/guide.md;                                           expect 'delete prose doc' true
git mv docs/guide.md docs/guide2.md;                               expect 'rename within docs' true
                                                                   expect 'empty diff' false
echo '# more'   >> docs/guide.md; echo 'export const y = 2' >> app/server/src/x.ts
                                                                   expect 'docs + app code' false
echo '# more'   >> .github/workflows/gate.yml;                     expect 'workflow file' false
echo 'echo yo'  >> scripts/foo.sh;                                 expect 'script' false
mkdir -p .evidence/1; echo 'echo hi' > .evidence/1/run.sh;                             expect 'shell script under .evidence' false
echo 'k: w'     >  docs/fixture.yaml;                              expect 'yaml fixture under docs' false
echo '# more'   >> docs/api/README.md;                             expect 'doc under a dir a test walks' false
echo '# new'    >  docs/api/new-page.md;                           expect 'new doc under a dir a test walks' false
echo '# more'   >> docs/read-by-test.md;                           expect 'doc a test reads via path.join' false
git mv docs/guide.md app/guide.md;                                 expect 'rename out of docs' false

# Fail closed: an unreachable base must exit non-zero, never print an answer.
if out=$(python3 "$CHECK" 0000000000000000000000000000000000000000 HEAD 2>/dev/null); then
  bad "bad base sha: exited 0 (printed '$out')"
else
  ok 'bad base sha -> non-zero exit'
fi

[ "$FAILED" -eq 0 ] && echo "ci-docs-only fixture: ALL PASS" || echo "ci-docs-only fixture: FAILURES"
exit "$FAILED"
