# Drift — Intent-Driven Versioning

> **Git tracks what changed. Drift tracks *why* it changed — and who (or what) decided.**

Drift is a semantic version-control layer that wraps Git. Every commit becomes an
**Intent**: the prompt that produced the change, the agent model behind it, the
AST-level mutations, an optional checkpoint of the agent's cognitive state, and a
cryptographic Ed25519 signature — all linked into an auditable, replayable graph.

Built for the AI era. When more than 80% of code is generated, text diffs are
useless for review: they show *what* changed, never *why*. Drift rejects broken
syntax before it enters history, answers *"why does this function exist?"* with
the originating prompt, and lets a crashed agent resume from its last checkpoint.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%3E%3D24-green)
[![Tests](https://img.shields.io/badge/tests-69%20passing-brightgreen)](.github/workflows/ci.yml)

## Quickstart

Give your coding agent Drift: [Claude Code](#claude-code),
[Cursor](#cursor), [Codex](#codex), [Cline](#cline), [Windsurf](#windsurf),
[VS Code / Copilot](#vs-code--copilot). Prefer no agent? Use the
[CLI](#cli), the [GitHub App](#github-app), or the [GitHub Action](#github-action).

Want the 5-minute "aha" first? Seed the [demo repo](#demo) and run `drift blame`.

## How it works

It starts the moment you run `drift init`. Drift creates `.drift/` — a SQLite DAG,
a config, and a per-repo Ed25519 keypair — and from then on every commit becomes
an intent.

When you (or your agent) run `drift realize -p "<prompt>"`, Drift *doesn't* just
commit. It parses the change semantically, **rejects the commit if the syntax is
broken** (exit 2 — broken code never enters history), redacts secrets from your
prompt, computes an AST delta (ADDED / MODIFIED / DELETED / MOVED / RENAMED),
signs the intent, and stores it content-addressed in `.drift/objects/` before
committing with a `Drift-Intent:` trailer.

After that, `drift blame` can walk any line or function back to the prompt that
created it, `drift context` hydrates the last intents for a file so an agent
grounds itself before editing, and `drift verify` re-runs the recorded
verification command. A crashed agent runs `drift replay --checkout` and resumes
exactly where it left off.

And because these are MCP tools, your coding agent can use them directly —
`drift_realize` instead of `git commit`.

## Installation

Installation differs by harness. If you use more than one, install Drift
separately for each one. All harnesses talk to the same MCP server
(`@drift/mcp`) with the same `mcpServers` block:

```json
{
  "mcpServers": {
    "drift": {
      "command": "node",
      "args": ["/abs/path/to/drift/packages/drift-mcp/dist/index.js"],
      "env": { "DRIFT_REPO": "/abs/path/to/your/repo" }
    }
  }
}
```

### Claude Code

- Register the server with the CLI (or drop the `mcpServers` block into your
  project's `.mcp.json`):

  ```bash
  # one-time build, from this repository
  git clone https://github.com/lilcipherx/drift.git && cd drift
  npm install && npm run build

  claude mcp add drift \
    --env DRIFT_REPO=/abs/path/to/your/repo \
    -- node /abs/path/to/drift/packages/drift-mcp/dist/index.js
  ```

- Ready-made example: [`examples/claude-code-integration/mcp.json`](examples/claude-code-integration/mcp.json)
- Verify: `claude mcp list` shows `drift`. Your agent then calls
  `drift_realize` instead of `git commit`.

### Cursor

- Add the same `mcpServers` block to `.cursor/mcp.json` in your project.
- Enable it: **Cursor Settings → MCP → `drift` → Enable**.
- Agent calls: `drift_realize`, `drift_context`, `drift_blame`, `drift_verify`,
  `drift_replay`, `drift_log`.

### Codex

- Add the block to your Codex config (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.drift]
  command = "node"
  args = ["/abs/path/to/drift/packages/drift-mcp/dist/index.js"]
  env = { DRIFT_REPO = "/abs/path/to/your/repo" }
  ```

- Restart Codex; the six `drift_*` tools appear in the tool list.

### Cline

- Add the block to `cline_mcp_settings.json` (VS Code extension settings).
- Set `DRIFT_REPO` to the repository you work in, approve the server, done.

### Windsurf

- Add the block to `.codeium/windsurf/mcp_config.json`.
- Restart Windsurf and enable the `drift` server in the MCP panel.

### VS Code / Copilot

- Add the block to `.vscode/mcp.json` (native VS Code MCP support) or the
  Copilot MCP config. VS Code picks it up on reload.

### CLI

From this repository:

```bash
git clone https://github.com/lilcipherx/drift.git && cd drift
npm install && npm run build
node packages/drift-cli/dist/cli.js --help
```

On your own repository:

```bash
node /path/to/drift/packages/drift-cli/dist/cli.js init
# … edit a file …
node /path/to/drift/packages/drift-cli/dist/cli.js realize -p "Fix race condition in token refresh" --agent --model claude-3-5-sonnet
node /path/to/drift/packages/drift-cli/dist/cli.js log
```

### GitHub App

Install `@drift/app` to get intent summaries on every pull request:

- Reads `Drift-Intent:` trailers from PR commits, hydrates the intent objects from
  `.drift/objects/` at the PR head, and posts a **semantic summary comment** —
  review the intent, not 2,000 lines of diff. Comments are idempotent: the app
  updates its own marker comment in place, so they never accumulate.
- Runs as a webhook server: `drift-app start` (see `packages/drift-app/app.yml`
  for the app manifest, `scripts/webhook-proxy.sh` for local debugging).

### GitHub Action

Check intent health in CI:

```yaml
- uses: lilcipherx/drift@v0.2.1
  with:
    command: log     # or: doctor / verify <intent-id>
```

## Demo

The 5-minute "aha" — a real Drift history, generated by the CLI itself:

```bash
bash scripts/seed-demo.sh
cd examples/demo-repo

node ../../packages/drift-cli/dist/cli.js log
node ../../packages/drift-cli/dist/cli.js blame src/auth.ts --function refreshToken
```

`blame` prints the prompt, model and a **valid signature** for the function:

```
src/auth.ts:12 (refreshToken)
  AGENT @ Drift Demo
  model:   claude-3-5-sonnet
  prompt:  Fix race condition in token refresh by de-duplicating in-flight refreshes
  intent:  did_2941b4547b4ed505a7c37190247768a7
  commit:  087c492f…  signature: valid
```

## The Basic Workflow

1. **init** — Creates `.drift/` (SQLite DAG, config, Ed25519 keypair). Never rewrites
   history; deleting `.drift/` leaves a fully functional git repo.

2. **realize** — Commit with intent. Syntax gate (exit 2), secret redaction,
   AST delta, Ed25519 signature, `Drift-Intent:` trailer. This is `git commit` for
   the AI era.

3. **log** — Timeline of intents: id, author (agent vs human), model, prompt.

4. **blame / context** — `blame --line|--function` walks a symbol back to its
   originating prompt; `context <file>` hydrates the last N intents for grounding.

5. **verify** — Re-runs the recorded verification command for an intent and checks
   the Ed25519 signature against the object file (never against DB rows).

6. **replay** — Restore a checkpointed agent state; `--checkout` resets the
   worktree. Crash recovery for agents.

7. **doctor** — DAG integrity, signature checks, orphan cleanup, encryption-key
   check when encryption is enabled.

**The agent checks the intent before any task.** Mandatory for anyone touching
generated code.

## What's Inside

### Core
| Package | What it does |
| :--- | :--- |
| **`@drift/cli`** | The `drift` CLI — `init`, `realize`, `log`, `blame`, `context`, `verify`, `replay`, `doctor`, `export` |
| **`@drift/core`** | Intent store (SQLite DAG), git wrapper, Ed25519 signatures, secret redaction, AES-256-GCM encryption at rest |
| **`@drift/ast`** | Semantic parser (TypeScript/JavaScript, Python) + AST deltas with a real syntax gate |

### Agent integration
| Package | What it does |
| :--- | :--- |
| **`@drift/mcp`** | MCP server — six tools for Claude Code / Codex / Cline, delegates to the CLI |
| **`@drift/sdk`** | Typed SDK + Zod intent schemas |
| **`@drift/app`** | GitHub App — `pull_request` webhook that posts idempotent intent-summary comments |

### Review & CI
| Package | What it does |
| :--- | :--- |
| **`@drift/action`** | GitHub Action (composite) — `log` / `doctor` / `verify` in CI |

## Philosophy

- **Semantics over text** — diffs show what; intents show why. Always.
- **Broken code never enters history** — the syntax gate is the front door.
- **Evidence over claims** — every intent is signed; every claim is verifiable.
- **Security by default** — secrets redacted, telemetry off, no network calls,
  optional AES-256-GCM encryption at rest (v0.2.0+).
- **Simplicity** — zero native dependencies, strict git compatibility, no
  rewriting of history.

## Security

- Every intent is **Ed25519-signed**; verification uses the object-file canonical
  JSON, so signature checks never need the master key.
- Prompts are **regex-redacted** for secrets (AWS, OpenAI, GitHub, Slack, JWT,
  PEM, …) before any storage.
- **Encryption at rest (v0.2.0):** `[encryption] enabled = true` + `DRIFT_MASTER_KEY`
  encrypts `prompt` and `agentState` with AES-256-GCM (AAD-bound to the intent id).
  Note: the commit message keeps the plaintext prompt by design (PRD §9.1) — see
  [SECURITY.md](SECURITY.md).
- Keys are never committed (`.drift/keys/` is gitignored) except throwaway demo keys.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The general flow:

1. Fork the repository.
2. Create a branch for your work.
3. Keep `npm test` green (69 tests: unit, temp-git-repo integration, MCP
   JSON-RPC e2e, GitHub App handler).
4. Submit a PR using the template.

Design decisions are tracked in [docs/adrs.md](docs/adrs.md) — note that the PRD
originally chose Rust (ADR-003); this implementation ships TypeScript-first
(ADR-006) for a zero-native-dependency MVS. The `drift-ast` parser interface is
the drop-in point for a future tree-sitter implementation.

## Updating

Drift is released on the [releases page](https://github.com/lilcipherx/drift/releases)
as versioned tags (`v0.1.0`, `v0.2.0`, `v0.2.1`, …). Pull the latest tag, rebuild,
and point your MCP / Action config at it:

```bash
git pull origin main
npm install && npm run build
```

Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Security notes: [SECURITY.md](SECURITY.md).

## Community

- **Repository**: [github.com/lilcipherx/drift](https://github.com/lilcipherx/drift)
- **Issues**: [github.com/lilcipherx/drift/issues](https://github.com/lilcipherx/drift/issues)
- **Releases**: [github.com/lilcipherx/drift/releases](https://github.com/lilcipherx/drift/releases)
- **Documentation**: [`docs/`](docs/quickstart.md), [`examples/demo-repo`](examples/demo-repo)
