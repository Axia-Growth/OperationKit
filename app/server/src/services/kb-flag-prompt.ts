/**
 * Knowledge-gap flags in the worker prompt (obj 901767).
 *
 * A worker that notices a knowledge-base fact is missing, wrong or out of date
 * REPORTS it with one call instead of rewriting the page mid-task: the busy
 * worker is not the curator. The flag lands on the Knowledge base Cleanup tab
 * and in the queue a curator run reads (GET /api/kb-wiki/flags). The workspace
 * and card link come from the session token, so the body carries neither.
 */
import { CC_API } from './kb-access-prompt.js'

export function buildKbFlagBlock(): string[] {
  return [
    '',
    '## Knowledge gaps: flag them, do not rewrite them',
    '',
    'If you notice something in the knowledge base that is MISSING, WRONG or OUT OF DATE while you work, file a flag and carry on. Do not quietly rewrite a domain fact in a knowledge page to fix it: a flag is reviewed on the Cleanup tab and by the curator, a silent edit is not. (Your own deliverables and decision capture are unaffected.)',
    '```bash',
    `curl -s -X POST ${CC_API}/api/kb-wiki/flags -H "X-CC-Session-Token: $CC_SESSION_TOKEN" -H 'Content-Type: application/json' \\`,
    `  -d '{"kind":"wrong","subject":"Acme billing contact","page":"organizations/acme.md","detail":"Page says Dana; the latest invoice thread is signed by Lee.","suggested_fix":"Billing contact: Lee Park"}'`,
    '```',
    '`kind` is `missing`, `wrong` or `stale`; `subject` and `detail` are required; `page` and `suggested_fix` are optional. Your card is linked automatically. A `201` (new) or `200` with `"reused":true` (already flagged) means it landed.',
  ]
}
