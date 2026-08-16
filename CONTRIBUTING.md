# Contributing to Drift

Thanks for helping build the provenance layer for AI-generated code.
Please read and follow our [Code of Conduct](CODE_OF_CONDUCT.md).

**Table of contents**

1. [Prerequisites](#prerequisites)
2. [Setup](#setup)
3. [Development loop](#development-loop)
4. [Repository layout](#repository-layout)
5. [Coding conventions](#coding-conventions)
6. [Adding a new integration](#adding-a-new-integration)
7. [Reporting bugs](#reporting-bugs)
8. [Submitting a pull request](#submitting-a-pull-request)
9. [Release process](#release-process)

## Prerequisites

- **Node.js >= 24** — Drift uses the built-in `node:sqlite` and `node:crypto`
  (Ed25519, AES-GCM), so there are **zero native dependencies**.
- **npm** (any recent version) and **git**.
- A terminal with `git` on the `PATH`. Windows, macOS and Linux are all
  supported; the CI matrix runs Ubuntu and Windows.

## Setup

```bash
git clone https://github.com/lilcipherx/drift.git
cd drift
npm install
npm run build          # compiles all packages with tsc (dist/ is committed,
                       # so this is optional for running, required for editing)
```

The `dist/` build output is committed, so the CLI/MCP server run from a fresh
clone without a build step. When you edit TypeScript, rebuild with
`npm run build` before running tests.

## Development loop

```bash
npm test               # unit + integration + MCP e2e + app e2e (node:test)
npm run eval           # eval scenarios + regression gate against eval/baseline.json
npm run eval:record    # re-record the baseline (only when behaviour intentionally changed)
bash scripts/acceptance-mvs.sh   # PRD §4.2 acceptance on a fresh temp repo
```

Keep the whole suite green and the eval gate passing before you commit.
There is no lint step today — `tsc -b` with `strict: true` is the gate.

## Repository layout

```
packages/drift-ast     Semantic parser (TS/JS + Python) — symbols, syntax gate, deltas
packages/drift-core    Engine — SQLite intent store, git wrapper, crypto, redaction, config
packages/drift-cli     The `drift` CLI
packages/drift-sdk     Programmatic SDK + Zod intent schemas
packages/drift-mcp     MCP server (6 tools) — delegates to the CLI
packages/drift-app     GitHub App webhook server (pull_request handler)
packages/drift-action  GitHub Action (composite, root action.yml)
tests/unit             Pure unit tests (config, crypto, redaction, store, packaging, pr-comment)
tests/integration      End-to-end CLI tests on temp git repos
tests/mcp              MCP JSON-RPC e2e tests
tests/app              GitHub App handler + live webhook-server tests
eval/                  Eval harness + scenarios + recorded baseline
examples/              demo-repo, harness configs, webhook payloads
scripts/               seed-demo, acceptance, publish, app-verify helpers
```

## Coding conventions

- **TypeScript, strict.** All packages share `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch`,
  `NodeNext` ESM).
- **Zero native dependencies.** Prefer `node:sqlite`, `node:crypto`,
  `node:http` over npm packages. If you must add a dependency, justify it in
  `docs/adrs.md`.
- **Security defaults are non-negotiable:** secrets are redacted before any
  storage; paths are contained to the repo root; telemetry stays off.
- **Contracts:**
  - `drift-core` never shells out to git for reads when a pure SQLite query
    works.
  - `drift-mcp` never parses git or SQLite directly — it always delegates to
    the CLI with `--json`.
  - `drift realize` must **never** commit broken syntax (exit code 2).
  - Exit codes are the PRD contract: 0 OK · 1 error · 2 syntax · 3 no changes
    · 4 key · 5 corrupt. Do not reuse or renumber them.
- **Errors are structured.** Under `--json`, every command prints
  `{ "status": "ok", ... }` or `{ "status": "error", "type", "message",
  "exitCode" }`. Never emit plain text on stdout when `--json` is requested.
- **Tests.** New behaviour needs a test that exercises the real code (CLI
  spawns on temp git repos, no mocks unless unavoidable — see the existing
  `tests/` for the patterns). Name tests by the behaviour they lock in.
- **Commit style.** Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`,
  `chore:`, `ci:`), one logical change per commit, message in the imperative
  and short enough to scan. The `dist/` output is committed — rebuild before
  committing source changes.

## Adding a new integration

The agent-facing surface is the **MCP server**; the harness install is just
wiring.

1. **Engine work** goes in `packages/drift-core` (or `drift-ast` for parsing).
   Add the command to the `Drift` class and the CLI in
   `packages/drift-cli/src/cli.ts` (help text, flags, `--json` shape, exit
   codes).
2. **Agent work** — expose the new command as an MCP tool in
   `packages/drift-mcp/src/index.ts` (input schema via zod, delegate to the
   CLI). Keep the tool name `drift_<verb>`.
3. **Harness manifests** — add the tool to the ready-made configs in
   `examples/harness-configs/` and the root manifests (`.claude-plugin/`,
   `.cursor-plugin/`, `.codex-plugin/`, `.plugin/`, `gemini-extension.json`,
   `mcp.json`). Each config must point at the MCP server and set `DRIFT_REPO`.
4. **Docs** — document the new surface in `docs/api.md` and the agent skill
   (`skills/drift/SKILL.md`).
5. **Tests** — integration test through the CLI, e2e through the MCP server,
   and a unit test where the logic is pure.

## Reporting bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) — include:

- **Command + flags** you ran (exact).
- **Expected vs actual output** (paste it, don't paraphrase).
- **Environment**: OS, Node version (`node -v`), npm version, Drift version
  (`drift version`), whether you're on a fresh clone or a checkout.
- **Repro repo**: a minimal script that reproduces the bug is worth more than
  a paragraph.

Security issues: **do not open a public issue** — use
[private vulnerability reporting](https://github.com/lilcipherx/drift/security/advisories/new)
per [SECURITY.md](SECURITY.md).

## Submitting a pull request

1. Open an issue / RFC for non-trivial changes (so the design is agreed
   before the code).
2. Create a branch from `main` — one branch per concern.
3. Implement with tests; keep `npm test` green and `npm run eval` passing.
4. Update `CHANGELOG.md` (under `[Unreleased]`) and `docs/` if the public
   surface changed.
5. Rebuild `dist/` (`npm run build`) so the committed artifacts match.
6. Open the PR using [the template](.github/PULL_REQUEST_TEMPLATE.md). CI runs
   on every PR — all jobs must be green.

## Release process

See [docs/NPM_RELEASE.md](docs/NPM_RELEASE.md) for the full owner checklist.
In short: bump all package versions in lockstep → `npm install
--package-lock-only` → build/test/eval → `npm pack --dry-run` →
`bash scripts/publish-npm.sh` → tag + `gh release create`. Releases are tagged
`v0.x.y` on `main`.
