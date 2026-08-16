# Drift API reference

Two surfaces: the **CLI** (human + scriptable) and the **MCP server** (for AI
agents). Both share one engine — the MCP server shells out to the CLI with
`--json`, so the behaviour contract is identical.

---

## CLI

### Running the CLI

From a checkout (no publish needed):

```bash
npm install
node packages/drift-cli/dist/cli.js <command> [flags]
```

Optional: `npm link` inside `packages/drift-cli` makes a global `drift`
command available.

Every command accepts `--json` for machine-readable output and `--no-color`
(also honoured via the `NO_COLOR` env var).

### Commands

| Command | What it does |
| :--- | :--- |
| `drift init` | Create `.drift/` in the current git repo (SQLite DAG, `config.toml`, Ed25519 keypair). Idempotent; in a fresh clone it preserves the committed public key and enters read-only signer mode. |
| `drift status` | Show repo state — intents, head, prompt mode, encryption, signer state, git branch — and the next step. Friendly before `init`. |
| `drift realize -p "<prompt>" [--summary "<public text>"] [files...]` | Stage + commit changes with an intent. Rejects broken syntax (exit 2) before anything is committed. Commits source + signed public manifest + key in ONE commit. |
| `drift log [--author a] [--model m] [--file f] [--limit n]` | List intents. |
| `drift blame <file> --line N \| --function NAME` | Map a line/function to the intent that created it. |
| `drift context <file> [--limit n]` | Last intents touching a file (reasoning ground for agents). |
| `drift verify <intent-id> [--run] [--allow-untrusted-command]` | Information by default (no execution); `--run` executes the recorded command only when the manifest is validly signed. |
| `drift replay <intent-id> [--checkout]` | Restore a prior agent state; optionally checkout the intent's commit. |
| `drift doctor [--fix]` | Check `.drift` integrity; `--fix` repairs orphan rows. |
| `drift export [--out file] [--include-private-prompt] [--allow-repository-output]` | Dump intents to portable JSON. Public-only by default; private prompts need the explicit flag and refuse in-repo output. |
| `drift verify-intent <intent-id>` | Verify an intent's Ed25519 signature (valid/invalid/unsigned/unverifiable). |
| `drift key import --file <path>` | Import the repository private signing key into a read-only clone (must match the committed trust root). |
| `drift version` | Print the CLI version. |

### `drift realize` flags

| Flag | Meaning |
| :--- | :--- |
| `-p, --prompt <text>` | The intent: what changed and why (required). **Private** — never leaves the local `.drift` store by default. |
| `--summary <text>` | **Public** summary for the intent: redacted, sanitized, truncated; appears in git history, manifests, `log`/`blame`, PR comments. If omitted, a generic non-prompt fallback (`Drift intent did_…`) is used — the prompt is never copied. |
| `--agent` | Mark the intent as authored by an agent. |
| `--model <name>` | Model identifier (implies `--agent`), e.g. `claude-3-5-sonnet`. |
| `--state <b64>` | base64 JSON cognitive state to checkpoint for `replay`. |
| `--verify-cmd <cmd>` | Verification command recorded with the intent (shown by `drift verify`, executed only with `--run` on a validly signed manifest). |
| `--no-ast` | Skip AST parsing; record a text delta instead. |
| `files...` | Restrict the commit to the given paths (default: all changes). |

### Exit codes

| Code | Meaning |
| :--- | :--- |
| 0 | OK |
| 1 | Error (bad input, unknown intent, path escapes repo, …) |
| 2 | Syntax error — commit aborted, history untouched |
| 3 | No changes to realize |
| 4 | Encryption key missing (`DRIFT_MASTER_KEY`) or invalid |
| 5 | Corrupt store |

### JSON output

Successful commands print `{ "status": "ok", ... }` to **stdout**; errors
print `{ "status": "error", "type", "message", "exitCode" }` as JSON (under
`--json`). Usage errors (missing/unknown args, unknown command) go to
**stdout**; runtime errors (bad intent id, path escapes, syntax gate, …) go
to **stderr** — consumers should merge both streams before parsing. Example:

```bash
drift realize -p "Add login flow" --agent --model claude-3-5-sonnet --json
```

```json
{
  "status": "ok",
  "gitSha": "a1b2c3…",
  "intentId": "did_0123…",
  "astDelta": [{ "type": "ADDED", "filePath": "src/auth.ts", "summary": "add login handler" }],
  "redactions": 0
}
```

`drift log --json` → `{ "status": "ok", "intents": [{ "id", "gitSha",
"authorType", "authorId", "model", "summary", "timestamp", "files",
"association" }] }`. `association` is the deterministic trailer-derived
commit association — `{ "state": "unique", "commit" } | { "state":
"missing" } | { "state": "ambiguous", "commits" } | { "state":
"replayed", "originalCommit", "laterCommits" } | { "state":
"duplicate", "commit" }` — and is never silently collapsed: when the
association is ambiguous or the id was replayed, `gitSha` holds the
introducing commit (or is empty) and the state is visible in the JSON. Human
output appends `⚠ambiguous` / `⚠replayed` / `⚠duplicate-trailer`.
`drift status --json` reports `intentAssociations` counts (unique / missing /
ambiguous / replayed / duplicate) over every trailer-referenced id.
The private `prompt` is **omitted by default** (ADR-009); add
`--include-private-prompt` to include it (local repos only, warns on stderr).
`drift verify --json` → `{ "status": "ok", "intentId", "verifyStatus":
"pass"|"fail"|"timeout"|"no-command"|"not-executed"|"refused",
"signature": "valid"|"invalid"|"unsigned"|"unverifiable"|"untrusted-key",
"verifyCmd", "exitCode", "stdout", "stderr", "message" }`. By default the
status is `not-executed` — a recorded verification command never runs without
`--run`.
`drift export --json` → `{ "schemaVersion": 2, "containsPrivatePrompts":
false, "exportedAt", "intents": [{ "id", "gitSha", "association",
"authorType", "authorId", "model", "summary", "timestamp", "files" }] }`
— no prompt field by default; `--include-private-prompt` sets
`containsPrivatePrompts` to true and adds the local prompt (requires the
local store).
`drift replay --json` → `{ "status": "ok", "intentId", "gitSha",
"agentState", "checkedOut" }`.

### Environment variables

| Var | Purpose |
| :--- | :--- |
| `DRIFT_REPO` | Force the repository root (used by the MCP server). |
| `DRIFT_MASTER_KEY` | AES-256-GCM master key for encryption at rest (64 hex chars, or any passphrase — hashed with SHA-256). |
| `NO_COLOR` | Disable ANSI colours. |

### Configuration (`.drift/config.toml`)

```toml
[core]
version = 1

[ast]
parsers = ["typescript", "python"]
fallback_to_text_on_error = true

[redaction]
patterns = []        # default: AWS/OpenAI/GitHub/Slack/JWT/PEM/… secret shapes

[encryption]
enabled = false
key_provider = "env:DRIFT_MASTER_KEY"

[telemetry]
enabled = false

[prompts]
mode = "commit-summary"   # commit-summary | full | none
```

### Prompt storage modes

Controls how (and whether) the **full prompt** is persisted:

| Mode | Full prompt in `.drift` (gitignored, local) | Public data in git history |
| :--- | :---: | :--- |
| `commit-summary` (default) | ✅ | `Intent:` <public summary> (≤72 chars) + `Model:` / `Verification:` / `Drift-Intent:` trailers; explicit summary (or generic fallback) in the signed `.drift/public/intents/<id>.json` manifest |
| `full` | ✅ | full (redacted) prompt in the commit message — legacy, visibly unsafe |
| `none` | ❌ (empty) | generic `Intent recorded` subject, empty manifest summary unless an explicit `--summary` is passed — nothing derived from the prompt |

> The public summary is **never derived from the prompt** (ADR-009): pass
> `drift realize --summary "safe public text"` for a meaningful summary, or
> get a generic `Drift intent did_…` fallback. The summary is redacted first
> (a secret in `--summary` becomes `[REDACTED]` before it can reach the
> commit message), sanitized and truncated. A one-line prompt never appears
> in git history.
>
> `drift init` writes a `.drift/.gitignore` that makes `.drift/public/` the
> only trackable Drift data (ADR-009) — `git add .` can never stage the
> private store, and a fresh clone serves `log`/`blame` from the manifests.
>
> `[encryption] enabled = true` applies **on top of** any mode: whatever is
> stored in `.drift` (prompt, agent state) is AES-256-GCM encrypted.
> Changing the mode only affects **new** intents; existing history is never
> rewritten.

---

## MCP server

The MCP server exposes Drift to AI agents over stdio (JSON-RPC). It never
touches git or SQLite itself — every tool delegates to the CLI, so agent
behaviour matches the CLI exactly.

**Start it:** `node packages/drift-mcp/dist/index.js` (from the checkout), or
`npx -y @drift/mcp` once published. Point it at a repository with `DRIFT_REPO`
(defaults to the server's working directory). It reports
`serverInfo: { "name": "drift", "version": "<package version>" }` (matches the installed `@drift/mcp` package) and six tools:

### `drift_realize`

Commit changes with intent tracking — use instead of `git commit`. Rejects
broken syntax before committing; prompts are redacted for secrets.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `prompt` | string (required) | What you changed and why |
| `files` | string[] | Optional paths to include |
| `model` | string | Model identifier |
| `agentState` | string | base64 JSON state to checkpoint for replay |
| `verifyCmd` | string | Verification command recorded with the intent |

### `drift_context`

Return the last N intents for a file — hydrate reasoning before editing.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `file` | string (required) | File path (repo-relative) |
| `limit` | number | Max intents (default 5) |

### `drift_replay`

Restore a prior agent cognitive state; optionally checkout the commit first —
resume a crashed or interrupted task.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `intentId` | string (required) | Intent id (`did_…`) |
| `checkout` | boolean | Checkout the intent's commit first |

### `drift_blame`

Ask *“why does this function exist?”* — returns the safe public summary, model
and intent for a line or function.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `file` | string (required) | File path (repo-relative) |
| `line` | number | 1-based line number |
| `functionName` | string | Function name to blame (either `line` or `functionName`) |

### `drift_verify`

Report an intent's recorded verification command and signature state WITHOUT
executing it (default). Set `run: true` to execute — allowed only when the
manifest is validly signed by the repository key; repository-provided
verification strings are code.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `intentId` | string (required) | Intent id |
| `run` | boolean | Execute the recorded command (default false — informational only) |

### `drift_log`

List recorded intents with optional filters.

| Input | Type | Meaning |
| :--- | :--- | :--- |
| `author` | string | Filter by author id |
| `model` | string | Filter by model |
| `file` | string | Filter to intents touching a file |
| `limit` | number | Max intents |

### Tool responses

Every tool returns a JSON string under a text content block:
`{ "status": "ok", … }` on success, or
`{ "status": "error", "type", "details", "exitCode" }` on failure. Errors are
always structured JSON — never plain text — so agents can parse them.
