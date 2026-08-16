---
name: drift-intent
description: Commit changes as Drift intents (semantic versioning layer on git) and trace why code exists. Use when the repository has a .drift/ directory and the drift CLI (or the @drift/mcp MCP server) is available.
---

# Drift intents

Use the `drift` CLI instead of a bare `git commit` whenever the repository has
a `.drift/` directory (check with `ls .drift` or `drift doctor`). Drift records
*why* code exists — the prompt, model and provenance — not just what changed.

## status — where are we?

```bash
drift status
```

Reports the repo state (intents, head, prompt mode, encryption, git branch)
and the next step. Run it first in an unfamiliar checkout — if Drift is not
initialized it says so and tells you to run `drift init`.

## realize — commit with intent

```bash
drift realize -p "<prompt: what and why>" --agent --model <model>
```

- Broken syntax is rejected before any commit (exit 2): fix the code, retry.
- Secrets in prompts are redacted automatically; never paste keys anyway.
- Exit 3 means there was nothing to commit (`E_NO_CHANGES`).
- `--verify-cmd "<cmd>"` records a verification command re-run by `drift verify`.
- **Prompt storage** is controlled by `[prompts] mode` in `.drift/config.toml`:
  `commit-summary` (default — the raw prompt stays in the private, gitignored
  `.drift/` store; only the first line of the redacted prompt is public),
  `full` (prompt also in the commit message — legacy, unsafe), `none` (prompt
  stored nowhere). `drift log`/`blame` return the safe public `summary` by
  default; the private prompt needs `--include-private-prompt`.

## blame / context — trace intent

```bash
drift blame src/auth.ts --function refreshToken
drift context src/auth.ts            # hydrate reasoning for a file
```

`blame` resolves the intent whose commit touched the function — a body-only
edit of a pre-Drift function reports "pre-Drift baseline".

## verify / replay

```bash
drift verify <intent-id>         # re-run the recorded --verify-cmd
drift replay --checkout          # restore a prior cognitive state (agentState)
```

## doctor / export

```bash
drift doctor                     # health check; detects corrupt .drift store (exit 5)
drift export                     # portable JSON export of all intents
```

If `doctor` reports corruption, never edit `.drift/` by hand — re-run
`drift doctor` after fixing, or restore from git history.

## Exit codes (contract)

| Code | Meaning |
| :--- | :--- |
| 0 | OK |
| 1 | Error (bad input, unknown intent, path escapes repo, …) |
| 2 | Syntax error — commit aborted, history untouched |
| 3 | No changes to realize |
| 4 | Encryption key missing (`DRIFT_MASTER_KEY`) or invalid |
| 5 | Corrupt store |

## JSON output

Add `--json` for machine-readable output. Successful commands print
`{ "status": "ok", ... }` to stdout; errors print
`{ "status": "error", "type", "message", "exitCode" }` (thrown errors go to
stderr, usage errors to stdout; MCP merges both). `log --json` returns
intents with `authorType` (`"AGENT"`/`"HUMAN"`, uppercase), `model`, `summary`,
`gitSha`; `verify --json` returns
`verifyStatus: "pass"|"fail"|"no-command"`.

## Environment

| Var | Purpose |
| :--- | :--- |
| `DRIFT_REPO` | Force the repository root (used by the MCP server). |
| `DRIFT_MASTER_KEY` | AES-256-GCM master key for encryption at rest. |
| `NO_COLOR` | Disable ANSI colours. |

## MCP tools

When the agent talks to the `@drift/mcp` server (Claude Code, Cursor, Codex,
Copilot, Gemini, …), the same operations are exposed as six tools:

| Tool | Equivalent CLI |
| :--- | :--- |
| `drift_realize` | `drift realize` (rejects broken syntax) |
| `drift_context` | `drift context` |
| `drift_replay` | `drift replay` |
| `drift_blame` | `drift blame` |
| `drift_verify` | `drift verify` |
| `drift_log` | `drift log` |

Tools return structured JSON errors (every tool: `{ "status": "error",
"details" }`; `drift_realize` additionally carries `type` and `exitCode`),
never crash the server — hostile input (path traversal `../`, empty prompts)
is rejected with a clean error.

## Security defaults

- Secrets (AWS keys, OpenAI `sk-`, GitHub tokens, Slack, JWT, PEM) are
  redacted from prompts **before** storage; `[REDACTED]` appears in `log`.
- Paths are contained to the repository root (`../` escapes are rejected).
- Telemetry is off by default.
