# Security Policy

## Reporting a Vulnerability

Please report security issues to **security@drift.dev** or use the GitHub
private vulnerability reporting feature on this repository.

**Do not open a public issue for security problems.**

### SLA

- **Acknowledgment:** within 48 hours
- **Fix (critical):** within 14 days
- **Fix (non-critical):** next release

## Scope

- The `drift` CLI and MCP server
- Intent signature & verification (`drift-crypto`)
- Secret redaction logic
- SQLite DAG integrity

## Safe harbor

We consider coordinated, good-faith security research to be authorized. Please
include a description of the issue, reproduction steps, and impact. Do not
test against production or third-party systems.

## Threat model (summary)

| Threat | Mitigation |
| :--- | :--- |
| Tampering with `.drift/objects` | Content-addressed objects; hash chain breaks on edit |
| Repudiation | Every intent is Ed25519-signed with the repo key |
| Secret leakage in prompts | Regex redaction before any storage |
| Data at rest (prompt / agent state) | AES-256-GCM via `DRIFT_MASTER_KEY` when `[encryption] enabled = true` (v0.2.0); GCM auth detects tampering |
| Prompt injection via code comments | Reviewer/merge LLM prompts ignore code comments; LLM output re-validated |
| Malformed AST input | Parsers are bounded; parse failure aborts commit (exit code 2) |

## Encryption at rest (v0.2.0)

Set `[encryption] enabled = true` in `.drift/config.toml` and export
`DRIFT_MASTER_KEY` (64-hex, or any passphrase — hashed with SHA-256). The
intent's `prompt` and `agentState` are then AES-256-GCM encrypted before
storage, bound to the intent id via AAD. Legacy plaintext intents remain
readable. `drift replay` of encrypted state without the key fails with exit 4.

**Known limitation:** the commit message itself carries the plaintext prompt
(PRD §9.1 keeps history readable), so the prompt remains visible in `git log`
to anyone with repo access. Encryption protects the `.drift` intent storage
and the agent state, not the git commit subject. If prompts must never be
readable, do not put secrets in them (redaction still applies).
