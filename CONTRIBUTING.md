# Contributing to Drift

Thanks for helping build the provenance layer for AI-generated code.

## Development setup

Requirements: **Node.js >= 24** (uses the built-in `node:sqlite`), npm, git.

```bash
npm install
npm run build   # compiles all packages with tsc
npm test        # unit + integration + MCP e2e tests
```

## Repository layout

```
packages/drift-ast     Semantic parser + AST delta computation
packages/drift-core    Intent store (SQLite), git wrapper, crypto, redaction, pipelines
packages/drift-cli     The `drift` command-line interface
packages/drift-sdk     Programmatic SDK + Zod intent schema
packages/drift-mcp     MCP server exposing drift tools to AI agents
packages/drift-action  GitHub Action (composite)
```

## How to add a feature

1. Open an issue / RFC for non-trivial changes.
2. Implement in the relevant package; keep public APIs documented.
3. Add tests (unit in `tests/unit`, integration in `tests/integration` using temp git repos, MCP e2e in `tests/mcp`).
4. Run `npm test` until green.
5. Update `CHANGELOG.md`.

## Contracts

- `drift-core` never shells out to git for reads when a pure SQLite query works.
- `drift-mcp` never parses git directly — it always delegates to the CLI.
- SQLite migrations are forward-only and idempotent.
- `drift realize` must **never** commit broken syntax (exit code 2 instead).

## Code of conduct

Be excellent to each other. Harassment-free community only.
