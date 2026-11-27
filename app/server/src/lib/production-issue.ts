/**
 * The one check for "this card was filed from a production signal" (obj 901771).
 * No imports on purpose: pure decision modules (poller-decisions, auto-merge,
 * the merge prechecks) use it without pulling in the database.
 *
 * A card with this origin fixes a client's LIVE app, so a person merges its
 * pull request: auto-merge, grant merges, standing merges and the Dev bot merge
 * tools refuse it, the worker-end route always sends it to the AI reviewer, and
 * a merge of its PR never auto-deploys. Docs: docs/wiki/Production-Issue-Intake.md.
 */
export const PRODUCTION_ISSUE_ORIGIN = 'production-issue'

export function isProductionIssueCard(card: { origin?: string | null } | null | undefined): boolean {
  return !!card && card.origin === PRODUCTION_ISSUE_ORIGIN
}
