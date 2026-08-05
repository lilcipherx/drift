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

Give your agent Drift: [Claude Code](#claude-code), [Antigravity](#antigravity),
[Codex App](#codex-app), [Codex CLI](#codex-cli), [Cursor](#cursor),
[Factory Droid](#factory-droid), [Gemini CLI](#gemini-cli),
[GitHub Copilot CLI](#github-copilot-cli), [Kimi Code](#kimi-code),
[OpenCode](#opencode), [Pi](#pi).

Prefer no agent? Use the [CLI](#cli), the [GitHub App](#github-app), the
[GitHub Action](#github-action), or [VS Code](#vs-code). Want the 5-minute "aha"
first? Seed the [demo repo](#demo) and run `drift blame`.

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
(`@drift/mcp`). Most read the same `mcpServers` block:

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

Where a harness uses a different shape (TOML, OpenCode's `environment`), the
difference is shown in that section. In every case: `DRIFT_REPO` points at the
repository Drift should operate on, and the agent gets the six `drift_*` tools.

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
- Verify: `claude mcp list` shows `drift`.

### Antigravity

- Open **Settings → MCP servers** in Antigravity and add a local server:
  - **Command:** `node`
  - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
  - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`
- Antigravity runs the server at session start, so Drift is active from the first
  message. Reinstall by pulling and rebuilding this repo.

### Codex App

- In the Codex app, open the MCP servers settings (Plugins section) and add a
  local server:
  - **Command:** `node`
  - **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js`
  - **Env:** `DRIFT_REPO=/abs/path/to/your/repo`

### Codex CLI

- Add the server to `~/.codex/config.toml`:

  ```toml
  [mcp_servers.drift]
  command = "node"
  args = ["/abs/path/to/drift/packages/drift-mcp/dist/index.js"]
  env = { DRIFT_REPO = "/abs/path/to/your/repo" }
  ```

- Restart Codex; the six `drift_*` tools appear in the tool list.

### Cursor

- Add the `mcpServers` block to `.cursor/mcp.json` in your project.
- Enable it: **Cursor Settings → MCP → `drift` → Enable**.

### Factory Droid

- Open Droid's MCP server settings (or its `mcp_servers` config) and add a local
  server pointing at `node /abs/path/to/drift/packages/drift-mcp/dist/index.js`
  with `DRIFT_REPO` set to your repository.

### Gemini CLI

- Add the `mcpServers` block to `.gemini/settings.json` (project) or
  `~/.gemini/settings.json` (global).
- In a session, run `/mcp list` to confirm the connection, `/mcp reload` after
  editing the file.

### GitHub Copilot CLI

- Register with the CLI (or add the block to `.github/mcp.json`):

  ```bash
  copilot mcp add drift \
    -e DRIFT_REPO=/abs/path/to/your/repo \
    -- node /abs/path/to/drift/packages/drift-mcp/dist/index.js
  ```

- Or `.github/mcp.json` with `{ "mcpServers": { "drift": { "type": "local",
  "command": "node", "args": ["/abs/path/to/drift/packages/drift-mcp/dist/index.js"],
  "env": { "DRIFT_REPO": "/abs/path/to/your/repo" } } } }`.

### Kimi Code

- Open Kimi Code's MCP settings and add a local server with the `mcpServers`
  block from the top of this section.

### OpenCode

- OpenCode uses its own config shape (note `environment`, not `env`). Add to
  `opencode.json`:

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "drift": {
        "type": "local",
        "command": ["node", "/abs/path/to/drift/packages/drift-mcp/dist/index.js"],
        "environment": { "DRIFT_REPO": "/abs/path/to/your/repo" },
        "enabled": true
      }
    }
  }
  ```

- Verify with `opencode mcp list`.

### Pi

- Install the Pi MCP adapter, then set up inside a session:

  ```bash
  pi install npm:pi-mcp-adapter
  # inside a pi session:
  /mcp setup
  ```

- Or drop the `mcpServers` block into `.mcp.json` / `~/.pi/agent/mcp.json`.

### VS Code

- Add the `mcpServers` block to `.vscode/mcp.json` (native VS Code MCP support).
  VS Code picks it up on window reload.

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
