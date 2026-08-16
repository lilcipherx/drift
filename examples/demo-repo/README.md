# Drift demo repository

A real Drift history you can walk through in two minutes.

Only **public provenance** is committed: `.drift/config.toml`,
`.drift/.gitignore` and `.drift/public/` (signed intent manifests + the public
key — ADR-009). The SQLite store, content-addressed objects and the signing
key live under `examples/demo-repo/.drift/` **locally but are gitignored**, so
`git add .` can never stage them. After a fresh clone, `drift log` /
`drift blame` / `drift context` work from the committed public manifests
without any private database.

## Requirements

Node.js >= 24 and git. Clone the parent repository and install once:

```bash
git clone https://github.com/lilcipherx/drift.git && cd drift
npm install
```

## Walk through

The embedded `.git` history of this demo cannot be committed inside a
repository, so a fresh clone regenerates it first (this dogfoods the CLI:
`init` + three `realize` intents, ~2 s):

```bash
bash scripts/seed-demo.sh     # from the repository root — recreates examples/demo-repo
cd examples/demo-repo

# 1. What happened, and in what order?
node ../../packages/drift-cli/dist/cli.js log

# 2. Why does refreshToken exist?
node ../../packages/drift-cli/dist/cli.js blame src/auth.ts --function refreshToken

# 3. Everything that touched auth.ts
node ../../packages/drift-cli/dist/cli.js context src/auth.ts
```

`drift log` shows the safe public summary; the full prompt stays in the local
private store and is only shown with `--include-private-prompt`.

## Privacy model

```text
.drift/
├── .gitignore        committed — ignores everything except the allow-list
├── config.toml       committed
├── public/           committed — the ONLY trackable Drift data
│   ├── key.pem
│   └── intents/<id>.json
├── drift.db          local only (gitignored)
├── objects/          local only (gitignored)
└── keys/             local only (gitignored)
```
