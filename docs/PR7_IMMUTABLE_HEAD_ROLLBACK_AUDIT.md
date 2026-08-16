# PR #7 — Immutable-Head & Exact-Rollback Audit

## 1. Starting state (verified 2026-08-16)

- Branch `fix/privacy-pr-provenance`, HEAD `cd1925ad7fb4f1f9e865ab88574ed755bb8b5d8f` (pushed), PR #7 OPEN / mergeState CLEAN.
- Working tree clean; 212/212 tests baseline; ARM64 + Windows CI green on `cd1925a`.
- Trust boundary preserved: `[self-hosted, Linux, ARM64]` for trusted Linux, `ubuntu-latest` for fork PRs, `windows-latest` for Windows.

## 2. Defects reproduced

### D1 — failed `git commit` does not restore the exact index

- Reproduction: repo with a partially staged `src/a.ts` (staged hunk + unstaged hunk); `git commit` forced to fail by unsetting identity; run `drift realize`.
- Old result: `git diff --cached --binary` hash CHANGED (Drift's own staging of the manifest polluted the user's index; only a partial `git reset` of the manifest path ran, and source stayed staged).
- Root cause: the phase-name model (`phase = "committing"`) classified a FAILED commit as post-commit, so the byte-for-byte snapshot restore was skipped.
- Regression test: `realize failure cleanup: failed git commit restores the EXACT original index and removes the generated manifest` + `failed pre-commit hook also restores the exact original index` (tests/integration/merge-blockers.test.mjs), comparing the index-file hash, `git diff --cached --binary`, `--porcelain=v2`, `ls-files --stage` and `ls-files --debug` before/after.

### D2 — Action trust reads use `HEAD` and the working tree

- Reproduction (Scenario A): base B (key K1) → head H (key K2) → synthetic merge commit M whose tree shows K1; event `head.sha = H`; working tree at M.
- Old result: `headKey = getFileAt(repoRoot, "HEAD", ...)` read K1 → "unchanged" (no warning) instead of "replaced".
- Reproduction (Scenario B/C): working-tree mutation of `.drift/public/key.pem` and a manifest changed the trust result because manifests were read with `readFileSync` from the working tree.
- Root cause: provenance reads were not keyed to the immutable event SHAs.
- Regression tests: `Action immutable head: synthetic merge checkout cannot affect trust results (scenario A)` and `Action immutable head: working-tree provenance mutations are ignored (scenario B/C)` (tests/unit/pr-comment.test.mjs).

### D3 — missing `GITHUB_TOKEN` bypasses the provenance failure policy

- Reproduction: invalid provenance, `GITHUB_TOKEN` absent, `FAIL_ON_PROVENANCE_ERROR=true` → the early `return` after "token not set" skipped the exit-code policy; workflow stayed green.
- Regression test: `Action failure policy: invalid provenance fails WITHOUT a token (exit non-zero, summary still written)`.

### D4 — initial trust-root bootstrap invisible in the Action

- Reproduction: key-only PR introducing the first `.drift/public/key.pem` → `buildSummary` received a reduced boolean, so the body was null and nothing was summarized.
- Regression test: `Action trust-root bootstrap: key-only PR is visible, neutral, and exits 0`.

### D5 — App audit scales with repository history

- Reproduction: 201 unchanged historical manifests on base+head, source-only PR → the directory-list + content-compare audit hit `MAX_AUDITED_MANIFESTS` and produced a violation.
- Root cause: the audit enumerated every manifest instead of the PR's changed files.
- Regression tests: `App audit scalability: >200 unchanged historical manifests never fail a source-only PR`, `1000 unchanged historical manifests + one valid atomic addition → success`, `large historical provenance total never counts against a source-only PR`, `App audit limits apply ONLY to changed PR provenance; incomplete pagination fails safely`.

### D6 — Core/Action validator divergence

- Reproduction: whitespace-only agent identifier — Core `valid`, Action `malformed` (the mandatory parity matrix caught it).
- Root cause: the Action's dependency-free mirror lacked checks Core had (and the empty-identifier case exposed Core's own gap).
- Resolution: Core now rejects empty/whitespace-only `agent.identifier`; the Action mirror gained the whitespace-summary, V2 agent-type, empty-identifier and control-character checks; a mandatory parity matrix (`validator parity: identical vectors classify identically in Core, Action and App`) feeds 19 vectors to all three consumers and fails on any divergence.

## 3. Fixes

1. Engine: `commitLanded` boolean replaces the phase names; ANY failure before the commit lands (staging, analysis, redaction, writes, signing, public-file staging, `git commit`, hooks, missing identity) restores the byte-for-byte index snapshot; generated public files (manifest + anything created by this operation) are removed; successful commits and post-commit DB failures are never rolled back; the snapshot is always discarded.
2. Action: base key from `event.baseSha`, head key + head manifests from `event.headSha` (immutable `git show <sha>:<path>`); `refExists` fails safely with a `fetch-depth: 0` message when history is incomplete; `buildSummary` receives the full key-change enum (bootstrap visible + neutral, replacement/removal blocking, none ordinary); `provenanceError` computed early and applied AFTER the step summary, independent of the token and the comment.
3. App: `getPullFiles` returns `{ files, truncated }` (pagination cap ⇒ audit reports incomplete); `auditProvenanceIntegrity` audits ONLY changed public-provenance paths (per-PR limits on changed files/bytes), detects added/modified/deleted/renamed/orphan/intro-mismatch/mutated/replay/ambiguous, and never enumerates unchanged history; replay is checked per trailer id against the base ref.

Full gate after fixes: 223/223 tests, eval, acceptance, pack smoke (see final report in the PR).
