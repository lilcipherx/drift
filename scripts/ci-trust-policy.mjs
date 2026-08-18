#!/usr/bin/env node
/**
 * Persistent-runner trust policy (docs/SELF_HOSTED_ARM64_AUDIT.md, PR #7).
 *
 * The persistent self-hosted ARM64 runner must NEVER execute untrusted code.
 * A same-repository condition alone is NOT a trust boundary: Dependabot and
 * other automation bots open same-repository PRs, and an untrusted
 * association (CONTRIBUTOR / FIRST_TIME_* / NONE) must not get persistent-host
 * execution either.
 *
 * Trusted (ARM64 self-hosted):
 *   - push to trusted protected branches
 *   - workflow_dispatch (requires write access to dispatch)
 *   - same-repository pull_request whose author is a real User with
 *     association OWNER | MEMBER | COLLABORATOR and is not a known bot login.
 *
 * Untrusted (GitHub-hosted Linux fallback — identical validation suite):
 *   - external fork PRs
 *   - Dependabot / Renovate / github-actions[bot] PRs
 *   - any bot-typed author (user.type != 'User')
 *   - same-repository PRs with an untrusted author association
 *
 * The `if:` conditions in .github/workflows/ci.yml are hand-written GitHub
 * expressions; `tests/unit/ci-trust-policy.test.mjs` pins this function to
 * the exact expression text so they cannot drift.
 */

export const BOT_LOGINS = new Set(["dependabot[bot]", "renovate[bot]", "github-actions[bot]"]);
export const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

/** The persistent-runner gate: true only for trusted events. */
export function isTrustedForPersistentRunner({
  eventName,
  repository,
  headRepoFullName,
  authorLogin,
  authorType,
  authorAssociation,
}) {
  // push to trusted protected branches / maintainer workflow_dispatch
  if (eventName === "push" || eventName === "workflow_dispatch") return true;
  if (eventName !== "pull_request") return false;
  // external forks never run on the persistent runner
  if (headRepoFullName !== repository) return false;
  // bots (dependabot, renovate, github-actions, any Bot-typed author) never do
  if (authorType !== "User") return false;
  if (BOT_LOGINS.has(authorLogin)) return false;
  // only OWNER / MEMBER / COLLABORATOR same-repo PRs
  return TRUSTED_ASSOCIATIONS.has(authorAssociation);
}

/** The hosted fallback gate: the exact negation of the trusted gate for PRs. */
export function isUntrustedPullRequest(event) {
  return event.eventName === "pull_request" && !isTrustedForPersistentRunner(event);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { eventName, repository, headRepoFullName, authorLogin, authorType, authorAssociation } =
    process.env;
  const trusted = isTrustedForPersistentRunner({
    eventName,
    repository,
    headRepoFullName,
    authorLogin,
    authorType,
    authorAssociation,
  });
  console.log(trusted ? "trusted" : "untrusted");
  process.exit(trusted ? 0 : 1);
}
