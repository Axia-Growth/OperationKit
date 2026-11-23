#!/usr/bin/env python3
"""gate-docs-only-test.py - prove the required `gate` check on a docs-only diff.

Workflow-level test for obj 901348. It lifts the two Python programs the `gate`
job runs straight out of .github/workflows/gate.yml (no copy to drift) and runs
them against simulated `needs` results:

  * a docs/vault-only PR: guarded heavy jobs skipped, `changes` green with
    docs_only=true  ->  gate GREEN (the required context stays mergeable);
  * a code PR where a guarded job was skipped               ->  gate RED;
  * `changes` failed (so every guarded job was skipped)     ->  gate RED;
  * docs_only=true but an UNguarded job was skipped         ->  gate RED;
  * docs_only=false with a skipped guarded job              ->  gate RED;
  * a cancelled job on a docs-only PR                       ->  gate RED;
  * the job-structure assert accepts the real file and rejects a stray `if:`,
    a guard without `needs: changes`, and an `if:` on `changes` itself.

USAGE: scripts/gate-docs-only-test.py      EXIT: 0 all pass, 1 otherwise.
"""
import json
import os
import re
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(ROOT, '.github', 'workflows', 'gate.yml')
SRC = open(GATE).read()
GUARD = "    if: needs.changes.outputs.docs_only != 'true'"
failed = 0


def step_python(step_name):
    """The `python3 - <<'PY' ... PY` body of a named step in the gate job."""
    gate_job = SRC.split('\n  gate:\n', 1)[1]
    step = gate_job.split(f'- name: {step_name}\n', 1)[1]
    m = re.search(r"python3 - <<'PY'\n(.*?)\n[ \t]*PY\n", step, re.S)
    if not m:
        sys.exit(f'FATAL: no embedded python in step {step_name!r}')
    lines = m.group(1).split('\n')
    indent = min(len(l) - len(l.lstrip()) for l in lines if l.strip())
    return '\n'.join(l[indent:] for l in lines)


RESULT_PY = step_python('Assert every upstream job succeeded')
NEEDS_PY = step_python('Assert every job in this workflow is in gate.needs')

jobs_block = SRC.split('\njobs:\n', 1)[1]
JOBS = [j for j in re.findall(r'^  ([A-Za-z0-9_-]+):$', jobs_block, re.M) if j != 'gate']
blocks = dict(re.findall(r'^  ([A-Za-z0-9_-]+):$\n(.*?)(?=^  [A-Za-z0-9_-]+:$|\Z)', jobs_block, re.M | re.S))
GUARDED = sorted(j for j, b in blocks.items() if GUARD in b.splitlines())
UNGUARDED = sorted(j for j in JOBS if j not in GUARDED and j != 'changes')


def run(py, gate_src, results=None):
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, '.github', 'workflows'))
        with open(os.path.join(d, '.github', 'workflows', 'gate.yml'), 'w') as f:
            f.write(gate_src)
        env = dict(os.environ)
        if results is not None:
            env['RESULTS'] = json.dumps(results)
        r = subprocess.run([sys.executable, '-c', py], cwd=d, env=env, capture_output=True, text=True)
        return r.returncode, r.stdout + r.stderr


def expect(name, want_green, code, out):
    global failed
    green = code == 0
    if green == want_green:
        print(f"  PASS  {name} -> gate {'GREEN' if green else 'RED'}")
    else:
        failed = 1
        print(f"  FAIL  {name}: want {'GREEN' if want_green else 'RED'}, got exit {code}")
        print('        ' + out.replace('\n', '\n        '))


def results(changes='success', docs_only='true', **overrides):
    r = {'changes': {'result': changes, 'outputs': {'docs_only': docs_only} if changes == 'success' else {}}}
    for j in GUARDED:
        r[j] = {'result': 'skipped' if docs_only == 'true' else 'success', 'outputs': {}}
    for j in UNGUARDED:
        r[j] = {'result': 'success', 'outputs': {}}
    for j, v in overrides.items():
        r[j.replace('_', '-')] = {'result': v, 'outputs': {}}
    return r


if not GUARDED:
    sys.exit('FATAL: no job carries the docs-only guard - nothing to test')
print(f'guarded: {GUARDED}\nunguarded (always run): {UNGUARDED}')

# --- result assertion ------------------------------------------------------
expect('docs/vault-only PR, guarded jobs skipped', True, *run(RESULT_PY, SRC, results()))
expect('code PR, every job green', True, *run(RESULT_PY, SRC, results(docs_only='false')))
code_pr = results(docs_only='false'); code_pr[GUARDED[0]]['result'] = 'skipped'
expect(f'code PR, {GUARDED[0]} skipped', False, *run(RESULT_PY, SRC, code_pr))
broken = results(); broken['changes'] = {'result': 'failure', 'outputs': {}}
expect('changes job failed, guarded jobs skipped', False, *run(RESULT_PY, SRC, broken))
missing = results(); missing['changes'] = {'result': 'success', 'outputs': {}}
expect('changes green but no docs_only output', False, *run(RESULT_PY, SRC, missing))
if UNGUARDED:
    un = results(); un[UNGUARDED[0]]['result'] = 'skipped'
    expect(f'docs-only PR, unguarded {UNGUARDED[0]} skipped', False, *run(RESULT_PY, SRC, un))
cancelled = results(); cancelled[GUARDED[0]]['result'] = 'cancelled'
expect('docs-only PR, a guarded job cancelled', False, *run(RESULT_PY, SRC, cancelled))
red = results(); red[GUARDED[-1]]['result'] = 'failure'
expect('docs-only PR, a guarded job failed', False, *run(RESULT_PY, SRC, red))

# --- structure assertion ---------------------------------------------------
expect('real gate.yml structure', True, *run(NEEDS_PY, SRC))
stray = SRC.replace(GUARD, "    if: github.actor != 'dependabot[bot]'", 1)
expect('stray if: on a job', False, *run(NEEDS_PY, stray))
no_needs = SRC.replace('    needs: changes\n' + GUARD, GUARD, 1)
expect('guard without needs: changes', False, *run(NEEDS_PY, no_needs))
skip_changes = SRC.replace('    name: changes (docs/vault-only?)\n', '    name: changes (docs/vault-only?)\n' + GUARD + '\n', 1)
expect('if: on the changes job', False, *run(NEEDS_PY, skip_changes))
not_needed = SRC.replace('needs: [changes, ', 'needs: [', 1)
expect('changes missing from gate.needs', False, *run(NEEDS_PY, not_needed))

print('gate docs-only test: ALL PASS' if not failed else 'gate docs-only test: FAILURES')
sys.exit(failed)
