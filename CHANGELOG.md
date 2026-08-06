# Changelog

All notable changes are tracked here (git-cliff style, kept manually).

## [Unreleased]

### Fixed
- `drift blame --function` now attributes the intent whose commit touched ANY
  line of the function body (PRD §7.3), so a body-only edit of a pre-Drift
  function resolves to its intent instead of "baseline" — the PRD §4.2
  acceptance "aha" works end-to-end. Untouched functions still report
  "pre-Drift baseline".
- `drift-app` graceful shutdown no longer hangs: `server.close()` waits for
  every open connection, and `closeIdleConnections()` releases only sockets
  that completed a request — a connected-but-request-less client blocked
  shutdown forever. The server now owns a connection registry, releases idle
  connections immediately on `close()`, spares in-flight responses, and
  force-closes stragglers after a 5 s grace.
- `drift-app` close() now resolves promptly after an in-flight request
  completes: a socket spared mid-request becomes idle the moment its response
  finishes and is released by a closing sweep (previously close() waited out
  the whole force grace). Grace is configurable via `closeGraceMs`; close() is
  idempotent (SIGINT+SIGTERM share one promise).
- Documented (evidence-backed): on Windows, external SIGTERM/SIGINT delivery
  terminates Node without running JS handlers, so the graceful path is
  POSIX/console-ctrl only — `scripts/verify-app-start.sh` asserts this.

### Added
- `eval/` harness (PRD §22): scenarios (`syntax-error-retry`,
  `realize-blame`), metrics (syntax-rejection rate, blame accuracy, replay
  fidelity), recorded baseline (`eval/baseline.json`) and a >5% regression
  gate. `npm run eval` / `npm run eval:record`.
- `scripts/acceptance-mvs.sh` — repeatable PRD §4.2 acceptance run.

### Tests
- `tests/app/abort-live.test.mjs`: live E2E for client disconnect during webhook
  processing — abort after full body (mid-upstream-call), abort mid-body, and
  RST-style socket destroy. Asserts the `res.destroyed` guards keep the server
  alive, a fully-read delivery is still processed to completion, and no
  uncaught exception / unhandled rejection fires.
- `tests/app/shutdown-live.test.mjs`: close() resolves while a request-less
  keep-alive socket is still open (red on the old bare-`server.close()`, green
  with the registry fix) and refuses new connections after closing.
- `tests/app/shutdown-live.test.mjs` (TDD): spares an in-flight request
  (response delivered, close() resolves promptly — not via the force timer)
  and force-closes a request that never completes after `closeGraceMs`. Both
  were watched red against the one-shot implementation before the sweep fix.
- `scripts/verify-app-start.sh`: live check that `drift-app start` fails fast
  with a clear error without `GITHUB_WEBHOOK_SECRET` and, with it, boots,
  answers `/health`, 404s non-POST `/webhook`, acks a bad signature as
  non-retryable, and releases its port on termination.
- `scripts/verify-close-behavior.mjs`: live behavior check of the webhook
  server's `close()` — happy-path webhook (comment + marker + check run),
  in-flight webhook spared while `close()` runs mid-handler (response
  delivered, idempotent PATCH by marker, comment not duplicated, close()
  resolves promptly instead of waiting out the force grace, port released),
  idempotent double `close()`, and zero uncaught exceptions / unhandled
  rejections — driving the real built code with only the GitHub API mocked.

### Fixed (release audit)
- `@drift/cli` package `types` pointed at `dist/index.d.ts`, which the build
  never emits (only `cli.d.ts`) — a dangling types path for TS consumers.
  Now `dist/cli.d.ts`.
- The Anthropic `sk-ant-` key pattern existed in `redact.ts` defaults but was
  missing from `config.ts` `DEFAULT_CONFIG`/template, so repos without a
  custom `config.toml` did not redact Anthropic keys. Added to both.
- A corrupted `.drift/drift.db` surfaced as a generic exit 1; it now reports
  exit 5 (`corrupt`) with a recovery hint per PRD §14.1.
- `@drift/mcp` `serverInfo.version` was a hardcoded `0.1.0` constant; it now
  reads the real version from `package.json` (works in the monorepo and when
  installed from npm), so it can never drift from the release.

### Tests
- `tests/unit/config.test.mjs`: `sk-ant-` must be a default pattern and
  actually redact an Anthropic-style key.
- `tests/integration/pipeline.test.mjs`: corrupted `drift.db` → exit 5
  (`corrupt` type), not a generic error.
- `tests/mcp/mcp.test.mjs`: `serverInfo.version` must equal the package
  version (regression for the hardcoded constant).
- `tests/unit/packaging.test.mjs`: every package `types`/`main`/`bin` target
  must exist, and all package versions match the monorepo root (regression
  for the dangling `@drift/cli` types path).

### Docs
- README + `.opencode/INSTALL.md`: since the `@drift/*` npm packages are not
  published yet, every installation section now leads with the **clone path**
  (`node packages/drift-mcp/dist/index.js`, `node packages/drift-cli/dist/cli.js`)
  and marks the `npx -y @drift/mcp` / `npx -y @drift/cli` one-liners as
  activating once the packages land on npm — a fresh user no longer hits a
  registry 404.
- ADR-008: CI workflows intentionally not committed (Actions disabled per
  maintainer); local gates replace them.
- README: Evaluation section, test-count badges updated to 101.
- README: removed the end-to-end verification results table (verification is
  covered by the live suites in `tests/` and the scripts in `scripts/`).

## [0.3.0] — 2026-08-05

### Changed
- README rewritten: Quickstart, How it works, per-harness Installation, The
  Basic Workflow, What's Inside, Philosophy, Security, Contributing, Updating,
  Community.
- README Quickstart now lists agent harnesses as anchor links (Claude Code,
  Cursor, Codex, Cline, Windsurf, VS Code / Copilot), each jumping to its own
  installation subsection with concrete MCP setup steps.
- Quickstart expanded to the full harness list — Claude Code, Antigravity,
  Codex App, Codex CLI, Cursor, Factory Droid, Gemini CLI, GitHub Copilot CLI,
  Kimi Code, OpenCode, Pi — each with its own installation subsection
  (per-harness MCP config shapes: TOML for Codex CLI, `environment` for
  OpenCode, `copilot mcp add` for Copilot CLI, `pi-mcp-adapter` for Pi, …).
- Added `examples/harness-configs/` — ready-made config files for all 11
  harnesses (`.mcp.json` for Claude Code, `.cursor/mcp.json`, Codex CLI
  `config.toml`, Gemini CLI `settings.json`, Copilot `.github/mcp.json`,
  OpenCode `opencode.json`, Pi `mcp.json`, plus step-by-step READMEs for the
  settings-panel harnesses Antigravity / Codex App / Factory Droid / Kimi Code),
  linked from each README installation section.
- README installation sections reworked: every harness now starts with a short
  one-command install (`claude mcp add`, `copilot mcp add`,
  `pi install npm:pi-mcp-adapter`, config copies, settings panels), then a
  verify step and a link to the ready-made config file.
- Installation commands shown as plugin-style installs with Drift identifiers:
  `agy plugin install https://github.com/lilcipherx/drift`,
  `droid plugin install drift@drift`, `gemini extensions install`,
  `/plugins install https://github.com/lilcipherx/drift`,
  `pi install git:github.com/lilcipherx/drift`.
- Added `.opencode/INSTALL.md` (fetched by OpenCode's install instruction) and
  `docs/README.opencode.md`, `docs/README.kimi.md` harness docs.
- **Real plugin manifests for every harness** so the README install commands
  work: `.claude-plugin/plugin.json` (Claude Code, with MCP server),
  `.plugin/plugin.json` (GitHub Copilot CLI), `gemini-extension.json` (Gemini
  CLI), `plugin.json` + `mcp_config.json` (Antigravity), `.factory-plugin/`
  plugin + marketplace (Factory Droid), `mcp.json` (Droid MCP servers), and a
  `pi` key in the root `package.json` (Pi).
- Removed all references to external repositories from the README, PRD and
  changelog — installation is fully self-contained to this repository.
- Added `.cursor-plugin/plugin.json` and `.codex-plugin/plugin.json` manifests;
  all plugin manifests now pass `DRIFT_REPO` to the MCP server (which falls
  back to the server's working directory when unset); marketplace `source`
  entries use the GitHub-repo object form (`{"source":"github","repo":…}`)
  instead of bare URL strings; the `pi` package now ships a real prompt
  template (`prompts/drift.md`) and a `drift-intent` skill (`skills/drift/`).
- Committed `packages/*/dist` (build output) so plugin manifests and CLI
  instructions can run the MCP server / CLI from a fresh clone without a build
  step — `npm install` is still required for workspace symlinks and external
  deps. `.gitignore` now un-ignores `packages/*/dist`; install instructions
  updated accordingly (`npm install` only).
- **MCP server prepared for npm publishing** (`@drift/mcp`, chain
  `@drift/ast` → `@drift/core` → `@drift/cli` → `@drift/mcp`). All harness
  manifests (`.claude-plugin/`, `.plugin/`, `.cursor-plugin/`,
  `.codex-plugin/`, `gemini-extension.json`, `mcp_config.json`, `mcp.json`),
  `examples/harness-configs/*`, `.opencode/INSTALL.md`, README and docs now
  launch the server via `npx -y @drift/mcp` — no clone needed once the
  packages are published to npm (only `DRIFT_REPO` must be set). CLI is
  available the same way: `npx -y @drift/cli`. `@drift/mcp` gains a `mcp` bin
  entry so npx resolves the executable by package name.
- README documented the real end-to-end verification: fresh clone + `npm
  install` + MCP handshake + CLI cycle + `claude mcp add` (results and
  dates), including the npm path — the packed `@drift/*` tarballs installed
  via `npm install` into an empty directory answered `serverInfo: drift
  0.1.0` with all six tools (`HANDSHAKE OK`), proving `npx -y @drift/mcp`
  needs no clone. (That results table was later removed from the README;
  the checks live on in `tests/` and `scripts/`.)
- Fixed `@drift/cli` `main` field (`dist/index.js` → `dist/cli.js`) — the CLI
  package only builds `cli.js`, so the old `main` pointed at a file that does
  not exist (broke `import "@drift/cli"`).
- Added `scripts/publish-npm.sh` — one command that publishes the
  `@drift/ast` → `@drift/core` → `@drift/cli` → `@drift/mcp` chain in order,
  confirms each version on the registry, and verifies the `npx -y @drift/mcp`
  handshake from an empty directory.
- GitHub Action runs the CLI **from its own checkout** (`node
  packages/drift-cli/dist/cli.js`, `dist/` is committed) instead of
  `npx -y @drift/cli@0.1.0` — the Action works today, before any `@drift/*`
  package is published. It materialises the workspace links with `npm ci` and
  drops the now-unused `version` input; it will switch to npm-mode
  automatically once the publish chain lands.

### Fixed
- **CLI fuzz hardening** (real file-based fuzz over prompts/paths with spaces,
  quotes, `$()`, backticks, tabs, newlines, unicode incl. non-BMP, long
  paths, and garbage `--line`/`--limit` values): `drift <unknown> --json`
  now emits a machine-readable `{"status":"error",…}` on stdout instead of
  leaking the plain-text usage banner. All JSON output parses; no stack
  traces or unhandled exceptions on any input.
- **Path containment extended to symlinks/junctions**: `drift blame`/`drift
  context` already rejected `../` and absolute/cross-drive escapes (v0.2.3);
  a live junction test proved the realpath guard also blocks a link *inside*
  the repo pointing outside — before any filesystem read. Positive cases
  (real path, in-repo link) keep working; regression test skips only where
  symlinks cannot be created (Windows without privileges).
- **`drift-app dev --dry-run` actually dry**: the handler unconditionally
  posted the comment and created a check run even in dry-run mode. Added
  `readOnly` to `WebhookDeps` — the summary is built and returned as
  `action: "dry-run"` with zero writes (verified against a local mock: only
  GET requests, no POST).
- `drift-app dev`/`start` honor **`GITHUB_API_BASE_URL`** (the client already
  supported `baseUrl`) so the dev command can point at a local mock instead
  of always hitting `api.github.com`.

### Added
- **Live webhook-server E2E suite** (`tests/app/live-server.test.mjs`): real
  `createWebhookServer` + real `GitHubAppClient` (RS256 JWT) against a local
  mock GitHub API. Covers `opened` (posts summary comment), `reopened`,
  commit pagination via `Link` header (150 commits, trailer only on page 2),
  `synchronize` idempotent PATCH, repeated-delivery idempotency, payload
  without `installation.id` (clean error, not retryable), intent object
  missing → commit-subject fallback, PR with no `Drift-Intent` trailers
  (`no-intents`, nothing written), bad HMAC (acked, not retryable), 9 MB body
  → 413, `/health`.
- README badge + PR template test counts refreshed (69 → 83 → current);
  CONTRIBUTING/SECURITY/PR-template refresh: layout lists `drift-app`,
  security scope includes the webhook server, `drift-crypto` misnomer fixed
  (crypto lives in `drift-core`).

## [0.2.3] — 2026-08-05

### Fixed (wave-2 audit)
- `doctor --fix` no longer fails with `FOREIGN KEY constraint failed` when
  deleting an intent that has children — `deleteById` reparents dependants to
  the deleted intent's parent first.
- CLI usage errors (empty prompt, missing arguments) stay machine-readable
  under `--json` instead of leaking plain text to stdout.
- `drift blame` / `drift context` reject paths that escape the repository root
  (`../` traversal, absolute/cross-drive paths, symlinks via realpath) before
  any filesystem read.

## [0.2.2] — 2026-08-05

### Fixed (production-readiness audit)
- AST parser no longer trips over **regex literals containing `{`/`}`/`/`**
  (now masked like strings/comments) — valid code with regexes is no longer
  rejected by the syntax gate (exit 2). Division is not mistaken for a regex.
- `drift log`/`drift context` with a non-finite `--limit` (e.g. `Infinity`,
  `NaN`) no longer crashes with a SQL error — limits are clamped to a safe
  positive integer.
- `drift version` reports the real package version instead of a hardcoded
  string.
- GitHub App: PR commits are **paginated** (PRs with > 100 commits are fully
  scanned); intent-object fetching stops as soon as all referenced intents are
  loaded; webhook requests get a 30s timeout; oversized bodies are rejected
  with **413** (no endless GitHub retries) up to an 8 MB cap; `PORT` is
  validated; summary table cells escape `|` so untrusted paths/summaries
  cannot break markdown; the response writer is guarded against
  `ERR_HTTP_HEADERS_SENT` when a request is terminated mid-handling.
- `config.toml` inline `#` comments are now honored (outside strings).
- SECURITY.md documents the `verify` / `--verify-cmd` shell-execution trust
  boundary.

### Removed
- Removed GitHub Actions from the repository: `.github/workflows/ci.yml` and
  `release.yml` deleted, all workflow runs deleted — no CI, no failing checks.

## [0.2.1] — 2026-08-05

### Changed
- **Idempotent summary comments** in `@drift/app`: the comment embeds an
  invisible `<!-- drift:summary -->` marker; on any PR action
  (`opened`/`synchronize`/`reopened`) the existing Drift comment is updated in
  place (PATCH) instead of posting a new one, so comments never accumulate on
  repeated deliveries. Adds paginated `listIssueComments` and `updateComment`
  GitHub API methods.

## [0.2.0] — 2026-08-05

### Added
- **`@drift/app` GitHub App** (PRD §16): `pull_request` webhook handler that
  reads `Drift-Intent` trailers from PR commits, hydrates intent objects from
  `.drift/objects/` at the PR head, and posts a semantic intent summary comment
  plus a check run. HMAC webhook signature verification, GitHub App JWT →
  installation token auth, optional `DRIFT_MASTER_KEY` decryption of encrypted
  prompts, `drift-app start` / `drift-app dev <payload> [--dry-run]`, mock
  payload fixture, smee.io webhook proxy script.
- **AES-256-GCM encryption at rest** (PRD §7.4, §17.1–17.2): when
  `[encryption] enabled = true` in `.drift/config.toml`, the intent's `prompt`
  and `agentState` are encrypted before storage (marker `encv1:`). Key comes
  from `DRIFT_MASTER_KEY` (64-hex verbatim, otherwise SHA-256 passphrase).
- `E_KEY` (exit 4) when encryption is enabled but the key is missing, and when
  replaying encrypted state without it.
- `drift doctor` gains an `encryption-key` check when encryption is on.
- Backward compatible: legacy plaintext intents pass through untouched; the
  Ed25519 signature covers the stored (encrypted) canonical form, so signature
  verification never needs the master key.

## [0.1.0] — 2026-08-05

### Added
- `drift init` — `.drift/` scaffold: SQLite DAG, `config.toml`, Ed25519 keypair.
- `drift realize -p "<prompt>"` — intent commit with AST delta, secret
  redaction, Ed25519 signature, `Drift-Intent:` trailer; rejects broken syntax
  (exit 2) before any history is created.
- `drift log`, `drift blame --line|--function`, `drift context`,
  `drift verify`, `drift replay --checkout`, `drift doctor`, `drift export`,
  `drift verify-intent`.
- Semantic parser for TypeScript/JavaScript and Python (symbol extraction +
  ADDED/MODIFIED/DELETED/MOVED/RENAMED deltas) with a real syntax gate.
- MCP server (`@drift/mcp`) exposing `drift_realize`, `drift_context`,
  `drift_replay`, `drift_blame`, `drift_verify`, `drift_log`.
- Programmatic SDK (`@drift/sdk`) with Zod intent schemas.
- GitHub Action (`action.yml`, composite) for intent checks in CI.
- Test suite: 40 tests (unit, temp-git-repo integration, MCP JSON-RPC e2e).
- Seeded demo repository generator (`scripts/seed-demo.sh`).

### Security
- Ed25519 signing of every intent; verification via object-file canonical JSON.
- Default secret redaction patterns (AWS, OpenAI, GitHub, Slack, JWT, PEM…).
- Keys are never committed (`.drift/keys/` gitignored) except throwaway demo keys.
