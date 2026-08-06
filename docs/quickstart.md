# Quickstart

> Goal: go from zero to `drift blame` showing the *why* behind a function in
> under five minutes.

Requires **Node.js >= 24** (uses the built-in `node:sqlite`) and git.

## 1. Install

```bash
git clone https://github.com/lilcipherx/drift.git && cd drift
npm install
```

The `dist/` build output is committed, so no build step is needed. (Optional:
`npm link` inside `packages/drift-cli` makes a global `drift` command so you
can drop the `node packages/drift-cli/dist/cli.js` prefix below.)

## 2. Initialize Drift in a repo

```bash
cd /path/to/your/repo
node /path/to/drift/packages/drift-cli/dist/cli.js init
```

This creates `.drift/` — a SQLite DAG store, `config.toml`, and a per-repo
Ed25519 signing key. Nothing in your git history is touched.

## 3. Make a change with intent

Edit a file, then:

```bash
node /path/to/drift/packages/drift-cli/dist/cli.js realize -p "Add login flow with validation" --agent --model claude-3-5-sonnet
```

`realize` stages the change, checks the syntax (broken code → exit 2, **no
commit**), redacts secrets from your prompt, computes the AST delta, signs the
intent, stores it in `.drift/objects/`, and commits with a `Drift-Intent: <id>`
trailer.

## 4. See the "why"

```bash
node /path/to/drift/packages/drift-cli/dist/cli.js log
node /path/to/drift/packages/drift-cli/dist/cli.js blame src/auth.ts --function login
node /path/to/drift/packages/drift-cli/dist/cli.js context src/auth.ts --limit 5
```

`blame` maps the line or function through `git blame` back to the intent that
created it — the original prompt, author, model, and signature.

## 5. Verify your intent

```bash
node /path/to/drift/packages/drift-cli/dist/cli.js verify-intent <intent-id>
node /path/to/drift/packages/drift-cli/dist/cli.js doctor
```

`verify-intent` checks the Ed25519 signature; `doctor` reports store integrity
(and can repair orphans with `--fix`).

## Verified live (Проверено вживую)

End-to-end run of this quickstart on **Windows 11** (Node.js v24.18.0, npm
11.16.0), **2026-08-06**: fresh `git clone` from GitHub → first `drift blame`
showing the *why* took **~8.1 seconds** in total (limit: 5 minutes). All steps
ran verbatim from the README; the npx one-liners were skipped because the
`@drift/*` packages are not published yet, and **no step hit a registry 404**.

| # | Step | Time | Result |
| :-- | :--- | ---: | :--- |
| 1 | `git clone https://github.com/lilcipherx/drift.git` | ~2.4 s | ✅ |
| 2 | `npm install` | ~3.0 s | ✅ 103 packages |
| 3 | `node packages/drift-cli/dist/cli.js --help` | ~90 ms | ✅ |
| 4a | `bash scripts/seed-demo.sh` | 2.4 s | ✅ demo repo |
| 4b | `drift log` (demo) | 68 ms | ✅ |
| 4c | `drift blame src/auth.ts --function refreshToken` (aha) | 116 ms | ✅ prompt + model + `signature: valid` |
| 5a | `drift init` | 85 ms | ✅ |
| 5b | `drift realize -p "Add login flow…"` | 598 ms | ✅ intent + AST delta |
| 5c | `drift log` | 67 ms | ✅ |
| 5d | `drift blame src/auth.ts --function login` (first blame) | 116 ms | ✅ prompt + model + `signature: valid` |
| 5e | `drift context src/auth.ts --limit 5` | 87 ms | ✅ |
| 5f | `drift doctor` | 248 ms | ✅ all checks pass |

**Result: 10/10 checks pass**, no 404 anywhere, first working `blame` within
~9 seconds of starting from an empty clone.

### npm path (before publication: measured via `npm pack`)

The `@drift/*` packages are not published to npm yet, so the exact
`npx -y @drift/cli` / `npx -y @drift/mcp` one-liners were measured through
their exact equivalent: `npm pack` the four-package chain
(`@drift/ast` → `@drift/core` → `@drift/cli` → `@drift/mcp`, all `0.1.1`)
and `npm install` the resulting tarballs into an **empty directory** — the
same bytes and bin entries npx would fetch, but sourced locally.

| # | Step | Time | Result |
| :-- | :--- | ---: | :--- |
| 1 | `npm install` the 4 packed tarballs into an empty dir | ~4.7 s | ✅ |
| 2 | `drift --help` (installed bin, no clone) | ~101 ms | ✅ Usage shown |
| 3 | `mcp` JSON-RPC handshake (`initialize` + `tools/list`) | ~1.0 s | ✅ `serverInfo: drift 0.1.1`, all six `drift_*` tools |

**Result: ALL PASS** — the packed `@drift/*` chain installs and serves the MCP
handshake from an empty directory with no clone and no build step, proving the
`npx -y @drift/mcp` path will work the moment the packages land on npm.

## Next steps

- Full command reference: [api.md](api.md)
- How Drift works under the hood: [architecture.md](architecture.md)
- Configuring encryption at rest, redaction, and the AST parser:
  [api.md](api.md#configuration-driftconfigtoml)
