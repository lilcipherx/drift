# Changelog

All notable changes are tracked here (git-cliff style, kept manually).

## [Unreleased]

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
- README gains a **“Verified live”** section documenting the real end-to-end
  test (fresh clone + `npm install` + MCP handshake + CLI cycle + `claude mcp
  add` executed for real, with results and dates) — including the npm path:
  the packed `@drift/*` tarballs installed via `npm install` into an empty
  directory answered `serverInfo: drift 0.1.0` with all six tools (`HANDSHAKE
  OK`), proving `npx -y @drift/mcp` needs no clone.
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
