# PR #7 — Final trust & security audit baseline

Recorded before any production change in this pass.

## Starting state

- Branch: `fix/privacy-pr-provenance`
- HEAD: `289ea935909a7ee1947a74a37a14a25cd49d4c58`
- Working tree: clean
- PR: https://github.com/lilcipherx/drift/pull/7 — OPEN, `mergeStateStatus: CLEAN`
- CI (run 31945017077, on HEAD): `test (Linux ARM64, node 24)` SUCCESS 1m14s on
  the Oracle Cloud self-hosted runner; `test (Windows, node 24)` SUCCESS 2m11s;
  fork fallback job SKIPPED (same-repo PR, by design).
- Local suite baseline: 158 tests passing; eval + acceptance passing
  (recorded in the prior pass, reproduced at HEAD).

## Issues to reproduce and fix (this pass)

A. GitHub App Check Run always concludes `success` regardless of provenance state.
B. A key-only PR (replaces `.drift/public/key.pem`, no intents) exits through the
   "no intents" early return before the trust-root change is reported.
C. With no base key, a head signature that fails verification is mislabeled
   `bootstrap` instead of `invalid`.
D. Comment upsert matches only the marker string — a user-authored spoofed marker
   comment would be updated instead of the genuine Drift comment.
E. Public manifests are parsed with a permissive type guard; malformed data must
   be strictly validated and must not crash consumers or be treated as valid.
F. The composite Action passes a free-form `command` string into the CLI
   (unquoted shell expansion) — unsafe operations could reach the CLI.
G. `drift verify --run` inherits the full process environment (secrets).
H. The GitHub App skips webhook signature verification when no secret is
   configured (should fail closed in production).
I. Realize failure paths call a broad `git reset`, discarding user-staged state.

## Reproduction results (recorded 2026-08-16, before fixes)

All reproductions were run against the build at `289ea93` on Windows
(x86_64, Node v24.18.0).

### A — App Check Run always `success`

`packages/drift-app/src/handler.ts` creates the check run with a hard-coded
`conclusion: "success"` regardless of `intent.signatureState`. A state vector
fed through `fetchIntents` (see the new tests) always yields a green check.
Reproduced: a check run for an intent in the `invalid` / `untrusted-key` /
`key-changed` states concludes `success`.

### B — key-only PR invisible (Action + App)

Manual scenario: repo with a signed intent on `main` → branch `keyonly` that
replaces ONLY `.drift/public/key.pem` (no source, no trailer, no manifest).

```text
intents: 0 | baseKey present: true | keyChanged: true
```

`scripts/pr-comment.mjs` `main()` computes `buildSummary(intents)` → `null`
and returns via the "no Drift intents" early return BEFORE the key-change
warning (the warning lives after the early return). The App handler likewise
returns `no-intents` before reading base/head keys. Both make a key-only PR
invisible.

### C — invalid bootstrap signature mislabeled `bootstrap`

`signatureStateFor` (Action) and the App equivalent return `bootstrap`
whenever the base key is absent — even when the head signature fails
cryptographic verification against the head key. Reproduced with an invalid
signature over a fresh head key: state was `bootstrap`, expected `invalid`.

### D — spoofed comment marker is updated

`upsertComment` fetches issue comments and PATCHes the FIRST comment whose
body contains the marker, with no ownership check. Reproduced with a mocked
API: a comment authored by a regular user (`alice`, `type: User`) containing
the marker was updated (`{"action":"updated","id":11}`) instead of being
left untouched.

### E — malformed manifests crash consumers

Committed a manifest with `files` as an object, `signature: 12345`, and
`timestamp: "not-a-number"`. Results:

```text
drift log          error: (v.files ?? []).map is not a function   (exit 0, text mode)
drift log --json   {"status":"error","message":"(v.files ?? []).map is not a function"}
drift export       error: Invalid time value
drift verify       signature: invalid   (no actionable "malformed" diagnostic)
```

`log` and `export` crash on the malformed tracked data; nothing distinguishes
"malformed" from a valid-but-badly-signed manifest.

### F — unsafe Action command input

`action.yml` interpolates `${{ inputs.command }}` directly into a bash string
(`node .../cli.js $DRIFT_COMMAND --json`), so inputs such as
`verify <id> --run`, `export --include-private-prompt`, `replay <id>`, or
`key import ...` would be passed through unquoted shell expansion to the CLI.
No allowlist exists.

### G — verification command inherits secrets

`engine.verify()` executes `spawnSync(verifyCmd, { shell: true, ... })` with
no `env` option → the child inherits the full parent environment including
`GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `DRIFT_MASTER_KEY`, and any
other secret set in the shell. Reproduced: a marker-writing command could
read `DRIFT_ENV_SECRET_GITHUB_61a4` etc. from the environment.

### H — App webhook verification skipped without a secret

`handleWebhook` only verifies `if (deps.webhookSecret && …)` — with no secret
configured, signature verification is silently skipped and the request is
processed. `runStart` requires the env var, but the handler layer (and any
embedding use) is fail-open.

### I — realize failure destroys user-staged state

On a syntax error, `realize()` calls `unstage(repoRoot)` = `git reset` (mixed
reset to HEAD), which discards the user's staged files, partially staged
hunks, and intent-to-add entries. Reproduced: with `A.txt` fully staged,
`B.txt` partially staged and `C.txt` intent-to-add, a failed realize left the
index empty. Also `stagePublicFiles` stages `config.toml` whenever it exists
(comment claims "only when already tracked" — code does not check).

## Fix plan

1. Strict versioned public-manifest validation in core with resource limits;
   consumers never crash on malformed data and never render it as valid.
2. Sanitized verification-command environment by default; explicit
   `--inherit-env` opt-in (CLI + MCP; never in Action/App).
3. Git index snapshot/restore around realize staging; `config.toml` staged
   only when already tracked.
4. Action: base-branch-first trust evaluation, key-only-PR visibility,
   bootstrap signature semantics, marker-v2 comment ownership, strict
   manifest validation, allowlisted structured inputs.
5. App: shared check-run conclusion policy, key-only-PR handling, bootstrap
   semantics, comment ownership, webhook fail-closed with explicit insecure
   dev mode.
6. Regression tests for every issue (shared state vectors where possible),
   documentation alignment, full gate, fresh real ARM64 + Windows CI on the
   final commit.
