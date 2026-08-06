<p align="center">
  <img src="docs/assets/drift-hero.png" width="420" alt="Drift — the robot that sees the why inside the code" />
</p>

<h1 align="center">Drift</h1>
<p align="center"><em>Git tracks what changed. Drift tracks why.</em></p>

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
[![Tests](https://img.shields.io/badge/tests-105%20passing-brightgreen)](tests/)

## Quickstart

Give your agent Drift: [Claude Code](#claude-code), [Antigravity](#antigravity),
[Codex App](#codex-app), [Codex CLI](#codex-cli), [Cursor](#cursor),
[Factory Droid](#factory-droid), [Gemini CLI](#gemini-cli),
[GitHub Copilot CLI](#github-copilot-cli), [Kimi Code](#kimi-code),
[OpenCode](#opencode), [Pi](#pi).

Prefer no agent? Use the [CLI](#cli), the [GitHub App](#github-app), the
[GitHub Action](#github-action), or [VS Code](#vs-code). Want the 5-minute "aha"
first? Seed the [demo repo](#demo) and run `drift blame`.

**Documentation:** [Quickstart](docs/quickstart.md) (5-minute start) ·
[API reference](docs/api.md) (CLI + MCP tools) ·
[Architecture](docs/architecture.md) (how Drift works under the hood)

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

Deeper reading: the full command reference lives in
[docs/api.md](docs/api.md) (CLI flags, exit codes, JSON schemas, MCP tool
inputs), and [docs/architecture.md](docs/architecture.md) explains the
storage model, encryption at rest, the webhook app, and the security
boundaries.

## Installation

Installation differs by harness. If you use more than one, install Drift
separately for each one. All harnesses expose the same six tools:
`drift_realize`, `drift_context`, `drift_replay`, `drift_blame`, `drift_verify`,
`drift_log`.

Every command below is backed by a real manifest in this repository
(`.claude-plugin/plugin.json`, `.plugin/plugin.json`,
`.cursor-plugin/plugin.json`, `.codex-plugin/plugin.json`,
`gemini-extension.json`, `plugin.json`, `.factory-plugin/`,
`package.json` → `pi`) or a ready-made config in
`examples/harness-configs/` — installation needs only **Node.js ≥ 24 and
npm** (the MCP server runs via `npx -y @drift/mcp`, no clone needed).

### Claude Code

Install as a plugin from the Drift marketplace (plugin-style, like Superpowers):

```text
/plugin marketplace add lilcipherx/drift
/plugin install drift@drift
```

Or add the Drift MCP server directly (project scope):

```bash
claude mcp add drift --env DRIFT_REPO=/abs/path/to/your/repo -- npx -y @drift/mcp
```

Or copy the ready-made config:

```bash
cp examples/harness-configs/claude-code/.mcp.json .mcp.json
```

Verify with `claude mcp list` — you should see `drift` with its six tools.

> The marketplace manifest lives at `.claude-plugin/marketplace.json` in this
> repository (github-source `lilcipherx/drift`, strict plugin →
> `.claude-plugin/plugin.json` in the same repo).

### Antigravity

Install Drift as a plugin from this repository:

```bash
agy plugin install https://github.com/lilcipherx/drift
```

Antigravity runs the plugin's session-start hook, so Drift is active from the
first message. Reinstall with the same command to update.

### Codex App

In the Codex app, open **Settings → MCP servers** and add:

- **Name**: `drift`
- **Command**: `npx`
- **Args**: `-y @drift/mcp`
- **Env**: `DRIFT_REPO=/abs/path/to/your/repo`

### Codex CLI

Add the Drift MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.drift]
command = "npx"
args = ["-y", "@drift/mcp"]
env = { DRIFT_REPO = "/abs/path/to/your/repo" }
```

Restart Codex, then ask for `drift_blame` / `drift_context` in any session.

### Cursor

Copy the ready-made config and enable MCP servers in Cursor settings:

```bash
cp examples/harness-configs/cursor/mcp.json .cursor/mcp.json
```

Then ask for `drift_blame` in chat.

### Factory Droid

- Register the marketplace:

  ```bash
  droid plugin marketplace add https://github.com/lilcipherx/drift
  ```

- Install the plugin:

  ```bash
  droid plugin install drift@drift
  ```

### Gemini CLI

- Install the extension:

  ```bash
  gemini extensions install https://github.com/lilcipherx/drift
  ```

- Update later:

  ```bash
  gemini extensions update drift
  ```

### GitHub Copilot CLI

Add the Drift MCP server:

```bash
copilot mcp add drift -e DRIFT_REPO=/abs/path/to/your/repo -- npx -y @drift/mcp
```

Or copy the ready-made config to `.github/mcp.json` and restart Copilot.

### Kimi Code

Drift is available in Kimi Code's plugin marketplace.

- Open Kimi Code's plugin manager:

  ```text
  /plugins
  ```

- Go to `Marketplace` > `Drift` and install it.

- Or install directly from this repository:

  ```text
  /plugins install https://github.com/lilcipherx/drift
  ```

- Detailed docs: [docs/README.kimi.md](docs/README.kimi.md)

### OpenCode

OpenCode uses its own plugin install; install Drift separately even if you
already use it in another harness.

- Tell OpenCode:

  ```text
  Fetch and follow instructions from https://raw.githubusercontent.com/lilcipherx/drift/main/.opencode/INSTALL.md
  ```

- Detailed docs: [docs/README.opencode.md](docs/README.opencode.md)

### Pi

Install Drift as a Pi package from this repository:

```bash
pi install git:github.com/lilcipherx/drift
```

For local development, run Pi with this checkout loaded as a temporary package:

```bash
pi -e /path/to/drift
```

### VS Code

Add the Drift MCP server to `.vscode/mcp.json` (native VS Code MCP support):

```bash
cp examples/harness-configs/claude-code/.mcp.json .vscode/mcp.json
```

VS Code picks it up on window reload.

### CLI

Without cloning — the CLI is published to npm:

```bash
npx -y @drift/cli --help
```

From this repository:

```bash
git clone https://github.com/lilcipherx/drift.git && cd drift
npm install
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
- uses: lilcipherx/drift@v0.3.0
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

## Evaluation

The [eval harness](eval/harness.mjs) (PRD §22) drives the real CLI with mock
file states — no LLM calls, no network — and records a baseline:

```bash
npm run eval           # run scenarios + compare against baseline (regression gate)
npm run eval:record    # re-record eval/baseline.json
```

Metrics gated at >5% regression (PRD §22.3): **syntax-error rejection rate**
(must be 100%), **blame accuracy**, **replay fidelity**. Scenarios live in
[eval/scenarios/](eval/scenarios/).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The general flow:

1. Fork the repository.
2. Create a branch for your work.
3. Keep `npm test` green (105 tests: unit, temp-git-repo integration, MCP
   JSON-RPC e2e, GitHub App handler + live webhook-server E2E + client-abort
   + graceful-shutdown robustness).
4. Keep the eval baseline green: `npm run eval` (PRD §22).
5. Submit a PR using the template.

Design decisions are tracked in [docs/adrs.md](docs/adrs.md) — note that the PRD
originally chose Rust (ADR-003); this implementation ships TypeScript-first
(ADR-006) for a zero-native-dependency MVS. The `drift-ast` parser interface is
the drop-in point for a future tree-sitter implementation.

## Updating

MCP servers launched via `npx -y @drift/mcp` pick up new versions automatically
(`npx` always fetches the latest published release). Releases are tagged on the
[releases page](https://github.com/lilcipherx/drift/releases) (`v0.1.0`,
`v0.2.0`, `v0.2.1`, …). For the CLI from a checkout:

```bash
git pull origin main
npm install
```

Changelog: [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Security notes: [SECURITY.md](SECURITY.md).

## Community

- **Repository**: [github.com/lilcipherx/drift](https://github.com/lilcipherx/drift)
- **Issues**: [github.com/lilcipherx/drift/issues](https://github.com/lilcipherx/drift/issues)
- **Releases**: [github.com/lilcipherx/drift/releases](https://github.com/lilcipherx/drift/releases)
- **Documentation**: [quickstart](docs/quickstart.md) · [API reference](docs/api.md) · [architecture](docs/architecture.md) · [`examples/demo-repo`](examples/demo-repo)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
