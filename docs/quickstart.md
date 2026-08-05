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

## Next steps

- Full command reference: [api.md](api.md)
- How Drift works under the hood: [architecture.md](architecture.md)
- Configuring encryption at rest, redaction, and the AST parser:
  [api.md](api.md#configuration-driftconfigtoml)
