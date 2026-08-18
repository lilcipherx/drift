# PR #7 — Final Completeness Continuation

This document records the resumed uncommitted state of the PR #7 final-completeness
repair and the corrections applied before the final gate.

## 1. Resumed uncommitted state (2026-08-16)

- Branch: `fix/privacy-pr-provenance`
- HEAD: `9152fa55dccd066b30ca177bc1f41c591dccc965` (pushed baseline)
- PR: #7 (open, clean)
- Working tree: all in-progress final-completeness changes **uncommitted**

### Modified files (uncommitted)

- `.github/workflows/ci.yml`
- `README.md`
- `SECURITY.md`
- `action.yml`
- `docs/RELEASE_READINESS.md`
- `docs/SELF_HOSTED_ARM64_AUDIT.md`
- `docs/api.md`
- `docs/architecture.md`
- `packages/drift-app/src/github.ts`, `handler.ts`, `intents.ts`, `summarize.ts`, `trust.ts`
- `packages/drift-cli/src/cli.ts`
- `packages/drift-core/src/engine.ts`, `index.ts`, `store.ts`, `trailers.ts`
- `scripts/pr-comment.mjs`
- `tests/app/abort-live.test.mjs`, `app.test.mjs`, `live-server.test.mjs`, `shutdown-live.test.mjs`
- `tests/integration/merge-blockers.test.mjs`
- `tests/unit/pr-comment.test.mjs`
- generated `packages/*/dist/**` rebuilt from `src/` via `npm run build`

### Untracked files

- `docs/PR7_FINAL_COMPLETENESS_AUDIT.md`
- `packages/drift-core/src/trust-root.ts` (+ generated `dist/trust-root.*`)
- `scripts/ci-trust-policy.mjs`
- `tests/unit/ci-trust-policy.test.mjs`

### Baseline (pre-correction)

- `npm run build`: clean
- `npm test`: 256/256 passing (uncommitted implementation)
- `npm run eval`: passing
- `bash scripts/acceptance-mvs.sh`: passing
- CI on `9152fa5` is NOT evidence for the new commits; a fresh run is required
  on the new final SHA.

## 2. Corrections applied in this continuation

1. **Intent-count semantics** — `status` counts only strictly valid committed
   public manifests and supported local legacy records; trailer-only IDs,
   malformed/orphan manifests, ambiguous/replayed associations and
   duplicate trailers are exposed as `associationDiagnostics`, never as valid
   intents.
2. **Trust-root parsing** — strict Ed25519-only parser (absent / valid /
   malformed with code) shared by Core, Action, App, signer status, key import,
   and bootstrap evaluation. Security decisions never use the legacy textual
   fallback fingerprint.
3. **PR commit completeness** — App fails closed on `>250` commits, count
   mismatch, duplicate/malformed SHAs, or interrupted pagination; the head SHA
   is never used as a guessed introduction commit. Pull-request Files
   completeness is checked the same way.
4. **Structured intent associations** — explicit-ref resolver over commits
   reachable from `HEAD` (not `--all`); states: unique, missing,
   duplicate-in-commit, replayed, ambiguous; surfaced in `log`, `context`,
   `blame`, `verify`, `verify-intent`, `export`, `status`, `doctor`, and JSON.
5. **Blame ambiguity** — blame filters candidates by file (and symbol when
   present) and returns an explicit `ambiguous`/`no-match` state instead of
   picking an arbitrary first intent.
6. **Reference-safe private-object rollback** — pre-existence and byte checks
   before write; deletion only of objects created by the current operation;
   reuse of identical pre-existing objects; fail-safe on byte mismatch;
   doctor distinguishes orphan-before-commit / committed-but-db-missing /
   referenced / unknown.
7. **Persistent-runner trust boundary** — ARM64 self-hosted only for trusted
   human PRs (same-repo + `user.type == User` + OWNER/MEMBER/COLLABORATOR);
   Dependabot, other bots, external forks, and untrusted associations route to
   a GitHub-hosted Linux fallback; verified by a policy matrix test and by the
   actual `ci.yml` expressions.
8. **Check Run delivery** — Check Run is the primary machine-readable result;
   a successful comment never substitutes for a missing/failed Check Run;
   transient Check Run failures produce a retryable webhook failure;
   read-only mode performs no writes.
9. **Trailer-without-manifest** — every trailer in the current PR range is a
   new reference for that PR; missing/malformed/wrong-ID/wrong-filename
   manifests are failures (never a neutral legacy state). Legacy missing
   manifests remain neutral only in local historical Core views.

## 3. Verification gate

```bash
npm ci --no-audit --no-fund
npm run build
npm test
npm run eval
bash scripts/acceptance-mvs.sh
```

followed by package smoke tests, syntax validation, focused commits, push,
and a fresh ARM64 + Windows CI run on the new final SHA.

PR #7 remains open and unmerged; nothing is published, tagged, or released.
## 3. Corrections applied in this continuation (completed)

1. **Status counting (correction 2)** — `status` counts ONLY strictly valid
   committed public manifests as `publicIntents`; trailer-only IDs, malformed
   and orphan manifests, ambiguous / replayed / duplicate-in-commit
   associations are exposed in `associationDiagnostics` (with ID lists) and
   never inflate `publicIntents` / `intents`. Human output now shows
   `committed public intents` / `local legacy records` / `provenance errors`.
2. **Trust-root parsing (correction 3)** — the shared strict parser
   (`tryParseTrustRoot`, mirrored in the Action) accepts ONLY validated
   Ed25519 PUBLIC keys: private-key PEM, certificates, RSA/EC keys, malformed
   and oversized input are `malformed` with stable codes
   (`oversized | parse-error | not-public-key | unsupported-key-type`).
   Fingerprints come from `signingKeyIdForValidKey` (validated KeyObject →
   SPKI-DER hash); the textual fallback is diagnostics-only and can never
   produce bootstrap / unchanged / valid / trusted / signing-allowed. Applied
   in Core signer state, `init`, `status`, the Action, the App's
   `signatureStateFor` / `readKey`, and base/head evaluation.
3. **PR commit completeness (correction 4)** — `getPullCommits` returns
   structured completeness with typed reasons
   (`over-endpoint-limit | count-mismatch | pagination-interrupted |
   duplicate-sha | invalid-sha`); >250 expected commits, count mismatch,
   duplicate/malformed SHAs and interrupted pagination all fail closed and
   produce an `incomplete-commit-audit` violation. Pull-request Files
   completeness is compared against PR metadata `changed_files` and fails
   closed on mismatch.
4. **Structured associations (correction 5)** — the resolver now exposes
   `duplicate-in-commit` (with `occurrences`), plus unique / missing /
   replayed / ambiguous; it scans commits reachable from HEAD (never `--all`)
   chronologically and never picks newest/first. `log`, `context`, `blame`,
   `export`, `status`, `doctor` and MCP JSON expose the association.
5. **Blame (correction 6)** — candidates are filtered by the blamed file
   path; exactly one → `unique`, none → explicit `missing`/baseline, more
   than one → `association: ambiguous` with the candidate IDs (no arbitrary
   first intent, no throw).
6. **Reference-safe private objects (correction 7)** — the object write
   records pre-existence and bytes: identical pre-existing objects are
   reused, differing bytes fail safely (never overwritten silently), and the
   pre-commit rollback deletes only objects this operation created (tmp files
   always removed). Doctor categorizes orphan-before-commit /
   committed-but-db-missing / referenced / unknown, is bounded by file count
   and size, never prints prompts, and `--fix` deletes only
   orphan-before-commit objects.
7. **Persistent-runner boundary (correction 8)** — verified the ci.yml
   expressions match the policy module exactly; added the aggregate
   `test-linux` gate job (hosted, no checkout) that proves exactly one Linux
   routing job ran and one was skipped.
8. **Check Run delivery (correction 9)** — verified the structured
   write-result policy: check 403 + comment OK → actionable non-retryable
   failure; transient check 5xx + comment OK → retryable failure; both fail →
   failure; read-only mode performs no writes.
9. **Trailer-without-manifest (correction 10)** — verified every trailer in
   the current PR range is a new reference: missing / malformed / wrong-ID /
   wrong-filename manifests are failures in both Action and App, independent
   of token presence or comment permission.

## 4. Verification results (2026-08-16, Windows x64)

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --no-audit --no-fund` | 0 | 103 packages, clean install |
| `npm run build` (tsc -b) | 0 | clean, no type errors |
| `npm test` | 0 | 280/280 passing (abort-live flake fixed with polling) |
| `npm run eval` | 0 | gate passed |
| `bash scripts/acceptance-mvs.sh` | 0 | all acceptance gates pass |
| npm pack + clean-install smoke | 0 | drift version 0.1.1, drift + drift-mcp binaries |
| `git diff --check` | 0 | no whitespace errors |
| node --check pr-comment.mjs / ci-trust-policy.mjs | 0 | syntax OK |
| bash -n publish-npm.sh / acceptance-mvs.sh | 0 | shell syntax OK |
| Python yaml.safe_load(ci.yml, action.yml) | 0 | YAML valid |

New regression suites: `tests/unit/trust-root.test.mjs` (8), 
`tests/app/commit-completeness.test.mjs` (9), status-counting / blame /
object-reference-safety tests in `tests/integration/merge-blockers.test.mjs`
(6 new), Action Ed25519-only parser test (1), CI aggregate-gate assertions.

## 5. Remaining steps

Focused commits, push to `fix/privacy-pr-provenance`, update PR #7, fresh
Windows + real Oracle ARM64 CI on the new final SHA. PR #7 remains open and
unmerged; nothing is published, tagged, or released.
