/**
 * Persistent-runner trust boundary (PR #7 defect 4): Dependabot and other
 * automation bots must NEVER run on the persistent self-hosted ARM64 runner,
 * even for same-repository PRs. External forks and untrusted author
 * associations get the GitHub-hosted Linux fallback instead. This suite pins
 * the pure policy function AND the exact `if:` expressions in
 * .github/workflows/ci.yml so the workflow cannot drift from the policy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BOT_LOGINS,
  TRUSTED_ASSOCIATIONS,
  isTrustedForPersistentRunner,
} from "../../scripts/ci-trust-policy.mjs";

const REPO = "lilcipherx/drift";

const event = (overrides) => ({
  eventName: "pull_request",
  repository: REPO,
  headRepoFullName: REPO,
  authorLogin: "lilcipherx",
  authorType: "User",
  authorAssociation: "OWNER",
  ...overrides,
});

test("ci trust policy: maintainer and collaborator same-repo PRs run on the persistent runner", () => {
  for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
    assert.equal(
      isTrustedForPersistentRunner(event({ authorAssociation: association })),
      true,
      `${association} must be trusted`,
    );
  }
});

test("ci trust policy: Dependabot and other bots NEVER run on the persistent runner", () => {
  for (const login of [...BOT_LOGINS, "some-other-bot[bot]"]) {
    assert.equal(
      isTrustedForPersistentRunner(
        event({ authorLogin: login, authorType: "Bot" }),
      ),
      false,
      `${login} must be untrusted`,
    );
  }
  // bot-typed authors are untrusted even when the login list does not know them
  assert.equal(
    isTrustedForPersistentRunner(event({ authorType: "Bot", authorLogin: "renovate[bot]" })),
    false,
  );
});

test("ci trust policy: external fork PRs never run on the persistent runner", () => {
  assert.equal(
    isTrustedForPersistentRunner(
      event({ headRepoFullName: "someone-else/drift" }),
    ),
    false,
  );
});

test("ci trust policy: untrusted same-repo associations (CONTRIBUTOR / NONE / FIRST_TIME) are untrusted", () => {
  for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]) {
    assert.equal(
      isTrustedForPersistentRunner(event({ authorAssociation: association })),
      false,
      `${association} must be untrusted`,
    );
  }
});

test("ci trust policy: push and workflow_dispatch are trusted", () => {
  assert.equal(isTrustedForPersistentRunner(event({ eventName: "push" })), true);
  assert.equal(isTrustedForPersistentRunner(event({ eventName: "workflow_dispatch" })), true);
});

test("ci trust policy: non-pull_request events are untrusted (hosted fallback)", () => {
  assert.equal(isTrustedForPersistentRunner(event({ eventName: "issue_comment" })), false);
});

test("ci trust policy: the workflow expressions match the pure policy (no drift)", () => {
  const yml = readFileSync(resolve(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
  // The ARM64 gate must require, for PRs: same repo AND User type AND a
  // trusted association AND not a known bot login.
  const trusted = yml.split("\n").find((l) => l.includes("github.event.pull_request.head.repo.full_name == github.repository"));
  assert.ok(trusted, "ci.yml must contain the same-repo condition");
  for (const association of TRUSTED_ASSOCIATIONS) {
    assert.ok(
      yml.includes(`github.event.pull_request.author_association == '${association}'`),
      `ci.yml must trust association ${association}`,
    );
  }
  for (const login of BOT_LOGINS) {
    assert.ok(
      yml.includes(`github.event.pull_request.user.login != '${login}'`),
      `ci.yml must exclude bot login ${login}`,
    );
  }
  assert.ok(
    yml.includes("github.event.pull_request.user.type == 'User'"),
    "ci.yml must require a real User author on the persistent runner",
  );
  // The hosted fallback must be the exact De Morgan negation (untrusted gate).
  const untrustedJob = yml.match(/test-linux-untrusted:[\s\S]*?timeout-minutes/s)?.[0] ?? "";
  assert.ok(untrustedJob.includes("head.repo.full_name != github.repository"), "untrusted job must catch forks");
  assert.ok(untrustedJob.includes("author_association != 'OWNER'"), "untrusted job must catch non-OWNER/MEMBER/COLLABORATOR");
  assert.ok(untrustedJob.includes("user.login == 'dependabot[bot]'"), "untrusted job must catch dependabot");
  // pull_request_target must never be a trigger used to execute untrusted code
  assert.ok(
    !/^\s*pull_request_target:/m.test(yml) && !yml.includes("pull_request_target:\n"),
    "pull_request_target must never be used as a trigger",
  );
  // The aggregate `test-linux` gate must depend on BOTH routing jobs, run on
  // hosted infrastructure with always(), and never check out PR code.
  const aggregate = yml.match(/test-linux:\n[\s\S]*?timeout-minutes: 10[\s\S]*?(?=\n  #|\n  [a-z-]+:)/)?.[0] ?? "";
  assert.ok(aggregate.includes("needs: [test-linux-arm64, test-linux-untrusted]"), "aggregate must depend on both Linux jobs");
  assert.ok(aggregate.includes("if: always()"), "aggregate must run even when one routing job is skipped");
  assert.ok(aggregate.includes("runs-on: ubuntu-latest"), "aggregate must run on GitHub-hosted infrastructure");
  assert.ok(!aggregate.includes("actions/checkout"), "aggregate must never check out PR code");
  assert.ok(aggregate.includes("needs.test-linux-arm64.result"), "aggregate must inspect the ARM64 job result");
  assert.ok(aggregate.includes("needs.test-linux-untrusted.result"), "aggregate must inspect the hosted job result");
});

test("ci trust policy: trusted human events route to ARM64, untrusted to hosted (full scenario matrix)", () => {
  const scenarios = [
    // [description, event fields, expected persistent-runner decision]
    ["maintainer same-repo PR", event({ authorAssociation: "OWNER" }), true],
    ["collaborator same-repo PR", event({ authorAssociation: "COLLABORATOR" }), true],
    ["member same-repo PR", event({ authorAssociation: "MEMBER" }), true],
    ["Dependabot PR", event({ authorLogin: "dependabot[bot]", authorType: "Bot" }), false],
    ["Renovate PR", event({ authorLogin: "renovate[bot]", authorType: "Bot" }), false],
    ["github-actions[bot] PR", event({ authorLogin: "github-actions[bot]", authorType: "Bot" }), false],
    ["other bot same-repo PR", event({ authorLogin: "robot[bot]", authorType: "Bot" }), false],
    ["external fork PR", event({ headRepoFullName: "attacker/drift" }), false],
    ["untrusted same-repo PR (NONE)", event({ authorAssociation: "NONE" }), false],
    ["untrusted same-repo PR (CONTRIBUTOR)", event({ authorAssociation: "CONTRIBUTOR" }), false],
    ["push to main", event({ eventName: "push" }), true],
    ["workflow_dispatch", event({ eventName: "workflow_dispatch" }), true],
  ];
  for (const [label, fields, expected] of scenarios) {
    assert.equal(
      isTrustedForPersistentRunner(fields),
      expected,
      `${label}: expected ${expected ? "ARM64 self-hosted" : "GitHub-hosted"}`,
    );
  }
});
