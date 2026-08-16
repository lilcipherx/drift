# Good First Issues

A curated list of small, well-scoped tasks for new contributors. Each task
has a concrete acceptance criterion, points at the exact files to touch, and
is deliberately independent of the others. Pick one, follow
[CONTRIBUTING.md](../CONTRIBUTING.md), and open a PR.

Every task must keep the bar green: `npm test` (123 tests), `npm run eval`
(regression gate), and — for source changes — a rebuilt `dist/`.

---

## 1. Add a redaction pattern for npm tokens

- **Where:** `packages/drift-core/src/redact.ts` (`DEFAULT_PATTERN_SOURCES`) and
  `packages/drift-core/src/config.ts` (the same list in `DEFAULT_CONFIG` + template).
- **What:** npm access tokens look like `npm_<36 hex chars>` and `npmp_` /
  `npmu_` / `npmi_` variants. Add a pattern that redacts them.
- **Acceptance:** a unit test in `tests/unit/redact.test.mjs` proves
  `npm_<token>` → `[REDACTED]` and that a legitimate `npm install` sentence
  is untouched.

## 2. Add `drift_log` filters to the eval harness

- **Where:** `eval/harness.mjs` + `eval/scenarios/realize-blame.json`.
- **What:** a new scenario step that calls `drift_log` with `--limit`/`--file`
  and asserts the returned intent count, exercising the CLI→eval path.
- **Acceptance:** `npm run eval` passes and the scenario is visible in the
  recorded baseline.

## 3. Expose `drift_doctor` and `drift_export` as MCP tools

- **Where:** `packages/drift-mcp/src/index.ts`, `docs/api.md`,
  `skills/drift/SKILL.md`, `examples/harness-configs/README.md`.
- **What:** the CLI already has `doctor` and `export`; the MCP server only
  exposes six tools. Add `drift_doctor` (runs `doctor --json`, returns checks)
  and `drift_export` (returns the portable JSON).
- **Acceptance:** `tests/mcp/mcp.test.mjs` gains a test calling both tools
  over a real JSON-RPC session; `tools/list` reports eight tools; docs updated
  (including the "six tools" wording in README/quickstart).

## 4. `drift log --jsonl` (newline-delimited JSON)

- **Where:** `packages/drift-cli/src/cli.ts` (`log` case).
- **What:** for scripting pipelines, print one JSON object per line instead of
  a wrapped array. Exit codes and filtering unchanged.
- **Acceptance:** integration test in `tests/integration/pipeline.test.mjs`
  asserts each line parses as JSON and the lines equal `intents` array order.

## 5. Blame class methods (`ClassName.method`)

- **Where:** `packages/drift-ast/src/index.ts` (symbol extraction),
  `packages/drift-cli/src/cli.ts` (`--function` handling),
  `packages/drift-core/src/engine.ts` (`blame`).
- **What:** `drift blame src/x.ts --function UserService.login` should resolve
  a method inside a class, not just a top-level function.
- **Acceptance:** integration test: create a class, realize an intent that
  changes a method body, blame by `Class.method` returns the intent.

## 6. Timeout for `drift verify`

- **Where:** `packages/drift-core/src/engine.ts` (`verify`), `config.ts`.
- **What:** `spawnSync` in `verify` is unbounded — a hung `verifyCmd` hangs
  the CLI. Add a `[verify] timeout_ms` config (default e.g. 60 000) and return
  a structured `timeout` status when the command exceeds it.
- **Acceptance:** unit/integration test with `--verify-cmd` sleeping longer
  than a small configured timeout; `--json` reports the timeout cleanly, exit
  code 1, and the CLI does not hang.

## 7. `drift init` friendly re-init

- **Where:** `packages/drift-core/src/engine.ts` (`init`), `cli.ts`.
- **What:** running `init` in a repo that already has `.drift/` currently
  silently no-ops. Make it print a short "already initialized — run
  `drift status`" message and keep the existing key/config untouched.
- **Acceptance:** integration test asserts the second `init` exit 0, prints
  the hint, and the Ed25519 key file is byte-identical.

## 8. `export` respects `--limit` and `--json`

- **Where:** `packages/drift-cli/src/cli.ts` (`export`).
- **What:** `drift export --limit 10` exports the latest 10 intents;
  `drift export --json` still prints JSON (it already does) but should
  surface errors through the standard JSON error contract instead of plain text.
- **Acceptance:** integration test for `--limit`; a corruption test proving
  the JSON error shape on a broken store.

## 9. Docs-command check in CI

- **Where:** `.github/workflows/ci.yml`, a small script under `scripts/`.
- **What:** every code block that starts with a `drift`/`node packages/...`
  command in README + `docs/` is parsed and dry-run executed against the demo
  repo (with a safe allowlist for commands that mutate or need a token).
- **Acceptance:** the check runs in CI and fails the job when a documented
  command no longer exists (`drift --help` exit 1 for unknown commands).

## 10. `context` for a whole directory

- **Where:** `packages/drift-core/src/engine.ts` (`context`), `store.ts`.
- **What:** `drift context src/` returns intents touching any file under the
  prefix (the SQL already supports prefix matching via `LIKE`).
- **Acceptance:** integration test: two files, two intents; `context src/`
  returns both; `context src/a.ts` returns only the first.

## 11. GitHub App: `neutral` check-run when verification is missing

- **Where:** `packages/drift-app/src/handler.ts` + `summarize.ts`, tests in
  `tests/app/app.test.mjs`.
- **What:** the check run is always `conclusion: "success"`. When none of the
  PR's intents record a `verifyCmd`, post `neutral` with a title like
  "N intents summarized (no verification recorded)".
- **Acceptance:** handler test with a payload whose intents have no
  `verifyCmd` asserts the check-run input conclusion is `neutral`.

## 12. Windows path smoke test for `export --out`

- **Where:** `tests/integration/pipeline.test.mjs`.
- **What:** `drift export --out "<path with spaces and unicode>"` writes the
  file (Windows real-path handling has historically been a weak spot).
- **Acceptance:** the test runs on the Windows CI leg and on any dev machine;
  the exported file parses and has the expected intents.

---

## How to claim one

1. Comment on the issue (or open the PR directly for the very smallest ones).
2. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) — fork, branch, tests first,
   conventional commit, rebuild `dist/`.
3. Keep `npm test` + `npm run eval` green; CI must pass.

_Suggest a new task by opening an issue tagged `good first issue` — the
maintainers will size it._
