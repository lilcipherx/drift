# PR #7 — Final Completeness Audit

Audit of the final completeness, malformed trust-root, persistent-runner,
commit-enumeration, Core association, staging, Check Run reliability, and
orphan-private-object defects on PR #7.

## Starting state

- Branch: `fix/privacy-pr-provenance`
- Starting SHA: `9152fa55dccd066b30ca177bc1f41c591dccc965` (pushed, matches `origin`)
- Working tree: clean
- PR: #7 OPEN, merge state CLEAN, base `main`
- CI on starting SHA (run `31957096854`): Linux ARM64 self-hosted success,
  Windows success, fork-only Linux job skipped
- Tests: 223/223 passing locally

## Defects under audit

1. New PR trailers whose manifest is missing are treated as a neutral
   `missing-manifest` state, indistinguishable from historical legacy
   provenance — a newly introduced intent must fail.
2. Trust-root state is inferred from key-text presence; malformed PEM must be
   strictly parsed into `absent`/`valid`/`malformed` and never given a
   fallback fingerprint for a security decision.
3. The CI trust boundary uses only the same-repository condition; Dependabot
   and other bot-authored PRs in the same repository must not reach the
   persistent self-hosted runner.
4. The GitHub App Pull Request Commits endpoint caps at 250 commits; a
   truncated list must not produce a trust conclusion.
5. Core maps intent ID → one SHA with "first value wins"; duplicate references
   must surface as ambiguous/replayed.
6. `drift realize` auto-stages tracked `.drift/config.toml` working-tree edits
   instead of preserving the staged version; modified tracked public keys must
   never be staged.
7. A successful PR comment can hide a failed Check Run API operation; the
   Check Run must fail independently and retryably.
8. Failed realizations may leave prompt-bearing orphan private objects behind.

## Resolution (this pass)

1. **Missing-manifest policy** — `trailer-without-manifest` is now a hard
   violation for a NEW trailer (its referencing commit is not an ancestor of
   base / is ahead of base) whose manifest exists nowhere; only a reference
   carried in from base history (legacy pre-V2 intent) stays a neutral
   `missing` state. Implemented in `scripts/pr-comment.mjs` (via
   `git merge-base --is-ancestor`) and the App audit (via
   `compare base...head`). Wrong-filename placement (manifest content id ≠
   filename id) is a distinct orphan violation.
2. **Strict trust-root parsing** — `packages/drift-core/src/trust-root.ts`
   (`parseTrustRoot`, `evaluateTrustRootChange`, full base/head state table
   incl. `malformed-bootstrap`, `malformed-replacement`, `base-malformed`)
   shared by Core and the App and mirrored dependency-free in the Action.
   Malformed material never receives a fallback identity used in a security
   decision; `signerState` gains a `malformed` state and `drift init` / `key
   import` refuse a malformed committed root.
3. **Persistent-runner boundary** — `.github/workflows/ci.yml` now requires a
   real `User` author with `OWNER | MEMBER | COLLABORATOR` association and a
   non-bot login for the ARM64 job; the hosted fallback (renamed
   `test-linux-untrusted`) runs every untrusted PR class with identical
   validation. Policy pinned by `scripts/ci-trust-policy.mjs` +
   `tests/unit/ci-trust-policy.test.mjs` (which also asserts the workflow
   expressions match and `pull_request_target` is never a trigger).
4. **App commit completeness** — `getPullCommits` now returns a
   `PullCommitCollection` with `expectedCount`/`complete` (compared against
   PR metadata); `incomplete-commit-audit` is a failing violation on count
   mismatch, interrupted pagination, duplicates or blank SHAs. The
   introduction commit is never guessed from the head SHA.
5. **Core associations** — `intentCommitIndex` now yields structured
   `IntentCommitAssociation` (unique / missing / ambiguous / replayed /
   duplicate) from chronological trailer scanning; `drift log --json` exposes
   `association`, `drift status` counts every trailer-referenced id, human
   log flags ambiguous/replayed/duplicate, and `blame` fails safely on a
   multi-intent commit.
6. **Config/key staging** — `drift realize` stages `.drift/config.toml` only
   when THIS operation created it; a pre-existing config (tracked, untracked,
   staged, or edited) is never `git add`ed, so a staged version A is never
   replaced by an unstaged working-tree version B. A tracked public key with
   any working-tree modification still refuses realization.
7. **Check Run reliability** — structured `GitHubWriteResult` outcomes;
   check-failed is never hidden by a successful comment, transient failures
   (network/5xx/429) are retryable (webhook 500 → redelivery), permanent 4xx
   acknowledged; read-only mode writes nothing.
8. **Orphan private objects** — a failed realize removes the private object
   (and tmp file) it created, plus empty shard dirs; a successful commit +
   local-DB failure keeps it; `drift doctor` detects orphan objects (no DB
   row, no manifest, no trailer) without printing the prompt and `--fix`
   removes them.
