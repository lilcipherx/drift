# Architecture

## Overview

Drift is a **semantic version control layer over git**. It does not fork git; it
wraps it. The atomic unit of history is the **Intent** — a signed record of
*what changed, why, by whom (or what), and how to verify it*.

```
Agent / Developer
   │  drift realize (CLI) / drift_realize (MCP)
   ▼
┌──────────────────────────────────────────────────────┐
│ drift-cli (Node)                                     │
│  ├── drift-ast    syntax check + AST delta           │
│  ├── drift-core   realize/log/blame/verify/replay    │
│  │    ├── SQLite DAG (.drift/drift.db, WAL)          │
│  │    ├── content-addressed objects (.drift/objects) │
│  │    ├── Ed25519 signing + AES-256-GCM encryption   │
│  │    └── secret redaction                           │
│  └── git CLI    stage · commit · blame               │
└──────────────────────────────────────────────────────┘
   │  Drift-Intent: did_… trailer            │ MCP over stdio
   ▼                                        ▼
git history (unchanged semantics)    drift-mcp → AI agents (6 tools)
                                              ▲
drift-app (webhook server) ── PR commits ─────┘
   → reads trailers → posts semantic summary comment (idempotent)
```

## Packages

| Package | Role |
| :--- | :--- |
| `@drift/ast` | Semantic parser (TypeScript/JS, Python): symbol extraction, syntax gate, ADDED/MODIFIED/DELETED/MOVED/RENAMED deltas. |
| `@drift/core` | The engine: SQLite intent store, git wrapper, Ed25519 signing, AES-GCM encryption, secret redaction, config — the realize/log/blame/verify/replay/doctor pipelines. |
| `@drift/cli` | The `drift` command line interface (thin shell over the engine). |
| `@drift/sdk` | Programmatic SDK (`Drift` class) plus Zod intent schemas. |
| `@drift/mcp` | MCP server exposing six tools to AI agents; delegates to the CLI with `--json`. |
| `@drift/app` | GitHub App: pull_request webhook handler that posts intent summaries and check runs. |

## The realize pipeline

```
parse pre-state (HEAD) → stage → parse post-state
   → validate syntax (TS via tsc transpile, Python via ast)   [fail ⇒ exit 2, no commit]
   → compute AST delta (ADDED/MODIFIED/DELETED/MOVED/RENAMED)
   → redact secrets from prompt & state
   → build intent → canonical JSON → SHA-256 → Ed25519 signature
   → write object to .drift/objects/aa/bb….json (atomic write-rename)
   → git commit -m "<prompt>\n\nDrift-Intent: <id>"
   → insert DAG rows → update head
```

## Storage

| Layer | Technology | Purpose |
| :--- | :--- | :--- |
| Code | git | blobs, commits, blame — untouched semantics |
| Intents | JSON, content-addressed | `.drift/objects/<sha2>/<sha…>.json` — tamper-evident |
| DAG | SQLite (WAL) | `intents`, `intent_files`, `drift_meta` — fast queries |
| Keys | PEM file | `.drift/keys/ed25519.pem` (0600, gitignored) |

Signature verification uses the intent's **object file** as the source of truth
(the canonical JSON it was signed over), so verification is byte-exact.

## Prompt storage modes

What lands in public git history is configurable per-repo
(`[prompts] mode` in `.drift/config.toml`):

| Mode | `.drift` store | Git commit message |
| :--- | :--- | :--- |
| `commit-summary` (**default**) | full (redacted) prompt | `Intent:` first line (≤72 chars) + `Model:` / `Verification:` / `Drift-Intent:` trailers — the full prompt never enters git history automatically |
| `full` | full (redacted) prompt | full (redacted) prompt (legacy behaviour) |
| `none` | nothing | generic `Intent recorded` subject + trailers only |

The summary is computed **after** secret redaction, so a secret in the first
line is redacted before it can reach the commit message. Encryption at rest
applies on top of any mode. The mode affects only new intents — history is
never rewritten. `drift status` reports the active mode.

## Encryption at rest (v0.2.0)

When `[encryption] enabled = true` in `.drift/config.toml`, the intent's
`prompt` and `agentState` are **AES-256-GCM** encrypted before storage
(`encv1:` marker, random 12-byte IV per value, AAD bound to the intent id).
The key comes from `DRIFT_MASTER_KEY` (64 hex chars verbatim, otherwise
SHA-256 passphrase).

- The git commit message keeps the plaintext prompt, so history stays readable.
- `drift log`/`blame` degrade to a `[encrypted]` placeholder without the key.
- `replay`/`realize` fail with exit 4 (`E_KEY`) when the key is missing.
- The signature covers the stored (encrypted) canonical form, so verification
  never requires the master key. Legacy plaintext intents pass through
  untouched.

## The MCP contract

`drift-mcp` never touches git or SQLite itself. Every tool shells out to the
CLI with `--json` and maps the result — keeping one source of truth for
behaviour. The repo is selected via the `DRIFT_REPO` env var (defaults to the
server's working directory). Errors are always structured JSON, never plain
text, so agents can parse them.

## The GitHub App (drift-app)

`drift-app start` runs a small HTTP server (`POST /webhook`) that verifies the
GitHub HMAC signature, then on `pull_request` `opened` / `synchronize` /
`reopened`:

1. Reads `Drift-Intent: <id>` trailers from the PR commits (paginated).
2. Hydrates the intent objects from `.drift/objects/` at the PR head.
3. Posts a **semantic summary comment** (marker `<!-- drift:summary -->`) plus
   a check run.

The summary is **idempotent**: if a Drift comment already exists on the PR it
is updated in place (PATCH), so repeated deliveries and force-pushes never
stack duplicate comments. Oversized payloads get `413` (no endless GitHub
retries); client-side errors are acked with `200`.

## Git compatibility contract

1. `drift init` never rewrites history.
2. Trailers (`Drift-Intent:`) are inert text for non-Drift users.
3. Deleting `.drift/` leaves a fully functional repo.
4. Standard git commands work unchanged.
5. `drift export` dumps intents to portable JSON.

## Security model

- **Tampering:** content-addressed objects; any edit breaks the hash chain.
- **Repudiation:** Ed25519 signatures tied to the per-repo key.
- **Secrets:** regex redaction before any storage (configurable in
  `.drift/config.toml`).
- **Data at rest:** AES-256-GCM via `DRIFT_MASTER_KEY` when encryption is
  enabled; GCM authentication detects tampering.
- **Prompt injection:** reviewer/merge LLM templates ignore code comments;
  LLM merge output is re-validated before acceptance.
- **Shell execution:** `drift verify` / `--verify-cmd` re-runs the recorded
  command with your shell — only run `verify` on intents you trust (local or
  from a trusted upstream).
- **Path containment:** `drift blame` / `drift context` reject paths that
  escape the repository root (`../`, absolute/cross-drive paths, symlinks via
  realpath) before any filesystem read.
- **Supply chain:** zero native dependencies; pinned TS compiler via lockfile.
