# Changelog

All notable changes are tracked here (git-cliff style, kept manually for v0.1.0).

## [Unreleased] — v0.2.0 (encryption at rest)

### Added
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
