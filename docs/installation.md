# Installing Drift

Drift is a semantic version-control layer that wraps Git. Every commit becomes
an **Intent** — the prompt, model, and verification behind the change — signed
and stored in `.drift/`. Two surfaces:

- the **`drift` CLI** (humans and scripts), and
- the **MCP server** (six tools for AI agents: `drift_realize`,
  `drift_context`, `drift_replay`, `drift_blame`, `drift_verify`, `drift_log`).

> **Current status:** the `@drift/*` npm packages are **not published yet**,
> so the commands below lead with the **clone path** — it works right now from
> a checkout of this repository (`node /abs/path/to/drift/packages/drift-mcp/dist/index.js`).
> The `npx -y @drift/mcp` one-liners activate automatically once the packages
> land on npm (see [NPM_RELEASE.md](NPM_RELEASE.md)); until then they return a
> 404, so use the clone command shown first.

**Requirements:** Node.js >= 24 (uses the built-in `node:sqlite`), npm, git —
and a checkout of the repository:

```bash
git clone https://github.com/lilcipherx/drift.git && cd drift
npm install
```

## CLI

```bash
node /abs/path/to/drift/packages/drift-cli/dist/cli.js --help
```

Once published: `npx -y @drift/cli --help` (no clone).

## MCP server — per harness

The same six tools are wired into every agent harness. Replace the two
placeholders:

| Placeholder | Replace with |
| :--- | :--- |
| `/abs/path/to/drift` | where you checked out this repository |
| `/abs/path/to/your/repo` | the repository Drift should operate on (`DRIFT_REPO`) |

### Claude Code

Plugin-style (marketplace manifest lives in this repo at
`.claude-plugin/marketplace.json`):

```text
/plugin marketplace add lilcipherx/drift
/plugin install drift@drift
```

Or add the MCP server directly (project scope):

```bash
claude mcp add drift --env DRIFT_REPO=/abs/path/to/your/repo -- node /abs/path/to/drift/packages/drift-mcp/dist/index.js
# once published:
claude mcp add drift --env DRIFT_REPO=/abs/path/to/your/repo -- npx -y @drift/mcp
```

Or copy the ready-made config:

```bash
cp examples/harness-configs/claude-code/.mcp.json .mcp.json
```

Verify with `claude mcp list`.

### Antigravity

```bash
agy plugin install https://github.com/lilcipherx/drift
```

### Codex App

Settings → MCP servers → add a local server:

- **Name:** `drift`
- **Command:** `node` (clone path) — `npx` once published
- **Args:** `/abs/path/to/drift/packages/drift-mcp/dist/index.js` — `-y @drift/mcp` after publication
- **Env:** `DRIFT_REPO=/abs/path/to/your/repo`

### Codex CLI

Add to `~/.codex/config.toml` (clone path):

```toml
[mcp_servers.drift]
command = "node"
args = ["/abs/path/to/drift/packages/drift-mcp/dist/index.js"]
env = { DRIFT_REPO = "/abs/path/to/your/repo" }
```

(Once published, `command = "npx"`, `args = ["-y", "@drift/mcp"]`.)

### Cursor

```bash
cp examples/harness-configs/cursor/mcp.json .cursor/mcp.json
```

### Factory Droid

```bash
droid plugin marketplace add https://github.com/lilcipherx/drift
droid plugin install drift@drift
```

### Gemini CLI

```bash
gemini extensions install https://github.com/lilcipherx/drift
# update later:
gemini extensions update drift
```

### GitHub Copilot CLI

```bash
copilot mcp add drift -e DRIFT_REPO=/abs/path/to/your/repo -- node /abs/path/to/drift/packages/drift-mcp/dist/index.js
```

Or copy the ready-made config to `.github/mcp.json` and restart Copilot.

### Kimi Code

`/plugins` → Marketplace > Drift → install, or directly from this repository:

```text
/plugins install https://github.com/lilcipherx/drift
```

### OpenCode

```text
Fetch and follow instructions from https://raw.githubusercontent.com/lilcipherx/drift/main/.opencode/INSTALL.md
```

### Pi

```bash
pi install git:github.com/lilcipherx/drift
```

### VS Code

```bash
cp examples/harness-configs/claude-code/.mcp.json .vscode/mcp.json
```

## GitHub App (PR summaries)

`@drift/app` posts a semantic intent summary on every pull request (idempotent
— one comment, updated in place). See `packages/drift-app/app.yml` and
`scripts/webhook-proxy.sh` for local development.

## GitHub Action (CI check + PR comment)

Complete workflow (development-only ref, see the note below):

```yaml
name: drift

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write   # needed ONLY to post/update the PR comment

jobs:
  drift:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0   # REQUIRED: the Action computes the PR commit range
      - uses: lilcipherx/drift@main     # development-only; pin a release tag once one exists
        with:
          operation: log               # allowlist: log | doctor | status | verify-intent (informational only)
          comment: 'true'              # post (or update) the Drift summary on the PR
          fail-on-comment-error: 'false'
          fail-on-provenance-error: 'true'  # fail the job on invalid/tampered provenance
```

**Permissions.** The Action only reads the repository (`contents: read`).
Posting/updating a PR comment uses the Issues API, which for pull requests
requires `pull-requests: write` (the minimal correct permission — `issues:
write` is broader than needed). Without it, the job still runs the `command`
check and writes the same safe summary to the step summary; the comment step
warns instead of failing (`fail-on-comment-error: 'true'` opts into failing).

**Forks.** On `pull_request` events from forks, GitHub hands the workflow a
read-only token by default, so the comment cannot be posted from a fork. The
Action degrades gracefully: the summary lands in the step summary and a
warning is emitted. Drift deliberately does **not** use `pull_request_target`
(which would execute fork-controlled code with the base-branch token).

**Scope and privacy.** The summary contains **only the commits of the current
PR** (immutable `base.sha` / `head.sha` via `git merge-base` + `git rev-list`)
and renders only the safe public summary from `.drift/public/` manifests —
never the full prompt. The comment is updated in place (marker-based), so
repeated synchronize events never duplicate it.

> **Version reference:** `@main` is a development-only pin. Do not use a
> release tag (e.g. `v0.3.1`) for inputs that did not exist in that release —
> pin `@main` (dev), an exact commit SHA for testing, or a future release tag
> once it exists.
