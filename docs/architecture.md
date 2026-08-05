# Architecture

## Overview

Drift is a **semantic version control layer over git**. It does not fork git; it
wraps it. The atomic unit of history is the **Intent** — a signed record of
*what changed, why, by whom (or what), and how to verify it*.

```
Agent / Developer
   │  drift_realize / git commit with intent
   ▼
┌────────────────────────────────────────────┐
│ drift-cli (Node)                           │
│  ├── drift-ast   syntax check + AST delta  │
│  ├── drift-core  realize/log/blame/verify  │
│  │    ├── SQLite DAG (.drift/drift.db)     │
│  │    ├── content-addressed objects        │
│  │    ├── Ed25519 signing                  │
│  │    └── secret redaction                 │
│  └── git CLI   stage · commit · blame      │
└────────────────────────────────────────────┘
   │  Drift-Intent: did_… trailer             │
   ▼
git history (unchanged semantics)   ◀── removing .drift/ is safe
```

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

## The MCP contract

`drift-mcp` never touches git or SQLite itself. Every tool shells out to the CLI
with `--json` and maps the result — keeping one source of truth for behavior.

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
- **Prompt injection:** reviewer/merge LLM templates ignore code comments;
  LLM merge output is re-validated before acceptance.
- **Supply chain:** zero native dependencies; pinned TS compiler via lockfile.
