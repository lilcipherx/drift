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

## ADR-008: CI workflows

- **Problem:** the PRD (§36, launch checklist) specifies
  `.github/workflows/{ci,release,eval}.yml`; the account's Actions were
  disabled at one point (billing / failing runs on `main`), and the
  maintainer asked for zero failing checks.
- **Decision (2026-08-16, amended):** `.github/workflows/ci.yml` **is now
  committed** — the owner direction moved to "real CI for external
  contributors". It runs on `push` to `main` and `pull_request` on a
  `ubuntu-latest` + `windows-latest` × Node 24 matrix: `npm ci` →
  `npm run build` (typecheck) → `npm test` (118 tests) → `npm run eval`
  (scenario suite + regression gate) → `bash scripts/acceptance-mvs.sh`
  (PRD §4.2 acceptance) → an npm-pack smoke test (packs the four-package
  chain into an empty dir and runs the installed `drift version`, no
  registry). Every step uses commands that are verified green locally.
- **Justification:** OSS contributors need a visible green check; the eval
  regression gate and test suite are the substance, CI is their public face.
  If the account's Actions are ever disabled again, the same commands still
  run locally via `npm test` / `npm run eval` / `scripts/acceptance-mvs.sh`.
