# Quickstart

> Goal: go from zero to `drift blame` showing the *why* behind a function in
> under five minutes.

## 1. Install & build

Requires **Node.js >= 24** (uses the built-in `node:sqlite`) and git.

```bash
git clone <your-fork> drift && cd drift
npm install
npm run build
```

## 2. Seed the demo repository

```bash
bash scripts/seed-demo.sh
cd examples/demo-repo
```

This generates a real git + Drift history: an initial scaffold plus three
intents (two agent, one human) — all produced by running the actual CLI.

## 3. See the "aha"

```bash
node ../../packages/drift-cli/dist/cli.js log
node ../../packages/drift-cli/dist/cli.js blame src/auth.ts --function refreshToken
node ../../packages/drift-cli/dist/cli.js context src/auth.ts --limit 5
```

## 4. Try it on your own repo

```bash
cd /your/repo
node /path/to/drift/packages/drift-cli/dist/cli.js init

# edit a file, then:
node /path/to/drift/packages/drift-cli/dist/cli.js realize -p "What you changed and why" --agent --model your-model
node /path/to/drift/packages/drift-cli/dist/cli.js log --json
```

## What just happened

- `drift init` created `.drift/` — SQLite DAG, config, and a per-repo Ed25519 key.
- `drift realize` parsed your file, validated syntax (broken code → exit 2, no
  commit), redacted secrets from your prompt, computed the AST delta, signed the
  intent, stored it content-addressed in `.drift/objects/`, and committed with a
  `Drift-Intent: <id>` trailer.
- `drift blame` maps a line/function through `git blame` to the intent that
  created it.
