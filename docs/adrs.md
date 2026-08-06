# Engineering Decision Records

## ADR-001: Intent metadata storage

- **Problem:** Where to store the intent DAG?
- **Alternatives:** git notes; a metadata branch; a SQLite file in `.drift/`.
- **Decision:** SQLite in `.drift/` (Node's built-in `node:sqlite`, WAL mode).
- **Justification:** notes are slow to query; branches pollute workflows. SQLite
  gives O(1) lookups, ACID, and a single portable file.

## ADR-002: AST diffing algorithm

- **Problem:** How to compare ASTs?
- **Alternatives:** GumTree; full tree-sitter; symbol-signature extraction.
- **Decision:** symbol-signature extraction (functions/classes/methods) with
  body-hash matching for rename/move detection, plus a real syntax gate
  (TypeScript compiler transpile / Python `ast`).
- **Justification:** near-git speed, zero native deps, and rename-as-RENAMED
  semantics. `parseSymbols`/`validateSyntax` are the plugin point for a future
  tree-sitter implementation.

## ADR-003: Core language — *amended by ADR-006*

## ADR-004: Primary skill surface

- **Decision:** the MCP server is the agent-facing skill; the CLI is the engine;
  the GitHub Action is the CI showcase.
- **Justification:** agent-tooling programs judge new agent capabilities; the
  MCP tools (`drift_realize`, …) are that surface.

## ADR-005: MVS scope

- **Decision:** slice first — `init`, `realize`, `log`, `blame` — plus
  `context`, `verify`, `replay`, `doctor`, `export`.
- **Justification:** delivers the "aha" in one command, works fully offline.

## ADR-006: v0.1.0 language — TS-first, not Rust

- **Problem:** the original PRD specified a Rust CLI (ADR-003).
- **Context:** v0.1.0 must be buildable, testable and shippable with **zero
  native toolchain** (no cargo in the build environment; no node-gyp builds).
- **Decision:** v0.1.0 ships TypeScript (Node >= 24) across the entire stack.
- **Justification:** Node's built-in `node:sqlite` + `node:crypto` (Ed25519)
  remove every native dependency; the CLI and MCP server share one codebase and
  one test suite. Cold-start and per-commit overhead targets are still met for
  the MVS.
- **Cost / mitigation:** Rust remains the migration path for perf-critical paths
  (`drift-ast` → tree-sitter). Interfaces are isolated behind
  `parseSymbols`/`validateSyntax` so the swap is mechanical.

## ADR-007: Signature verification source of truth

- **Decision:** verification rebuilds the canonical payload from the intent's
  **object file**, never from SQLite rows.
- **Justification:** SQLite re-serialization is not guaranteed byte-identical to
  what was signed (array ordering); the object file is what was actually signed.

## ADR-008: CI workflows are not committed to the repository

- **Problem:** the PRD (§36, launch checklist) specifies
  `.github/workflows/{ci,release,eval}.yml`, but the account's Actions had to
  be disabled (billing / failing runs on `main`), per the maintainer's explicit
  instruction to remove CI and keep zero failing checks.
- **Decision:** `.github/workflows/` is intentionally **not** committed.
  Local validation is fully covered instead: `npm test` (98 tests),
  `npm run eval` (scenario suite + baseline gate), `bash scripts/acceptance-mvs.sh`
  (PRD §4.2 acceptance), and `npm run build` (typecheck). The workflows are
  one `git commit` away when Actions is re-enabled — the checkpoints they
  encoded are exactly the commands above.
- **Justification:** the PRD's *intent* — a release pipeline that fails on
  regression — is preserved by the eval regression gate and the local test
  suite; committing workflow files to a disabled-Actions account would only
  recreate the failing runs the maintainer asked to remove.
