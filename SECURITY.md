# Security Policy

## Reporting a Vulnerability

Please report security issues using the GitHub private vulnerability
reporting feature on this repository:
https://github.com/lilcipherx/drift/security/advisories/new

**Do not open a public issue for security problems.**

### SLA

- **Acknowledgment:** within 48 hours
- **Fix (critical):** within 14 days
- **Fix (non-critical):** next release

## Scope

- The `drift` CLI and MCP server
- The GitHub App webhook server (`packages/drift-app`) — HMAC signature
  verification, request-size limits, idempotent comment updates
- Intent signature & verification (`drift-core` crypto module)
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
| Secret leakage in prompts | Regex redaction before any storage; default `commit-summary` mode keeps the full prompt out of git history |
| Data at rest (prompt / agent state) | AES-256-GCM via `DRIFT_MASTER_KEY` when `[encryption] enabled = true` (v0.2.0); GCM auth detects tampering |
| Prompt injection via code comments | Reviewer/merge LLM prompts ignore code comments; LLM output re-validated |
| Malformed AST input | Parsers are bounded; parse failure aborts commit (exit code 2) |
| Malicious `verifyCmd` / `--verify-cmd` | `drift verify` re-runs the recorded command with the user's shell. Only run `verify` on intents you trust (local or from a trusted upstream); verify `verifyCmd` before recording it via `realize --verify-cmd`. |

## Prompt storage (default: summary-only commits)

The full prompt is **never** written to public git history by default. The
`.drift/config.toml` `[prompts] mode` setting controls persistence:

| Mode | Full prompt in `.drift` (local) | Full prompt in `git log` |
| :--- | :---: | :---: |
| `commit-summary` (default) | ✅ | ❌ — commit carries only `Intent:`/`Model:`/`Verification:`/`Drift-Intent:` |
| `full` | ✅ | ✅ (opt-in, legacy) |
| `none` | ❌ | ❌ |

The summary is built **after** secret redaction, so secrets cannot leak via
it. The mode only affects new intents; history is never rewritten.

## Encryption at rest (v0.2.0)

Set `[encryption] enabled = true` in `.drift/config.toml` and export
`DRIFT_MASTER_KEY` (64-hex, or any passphrase — hashed with SHA-256). The
intent's `prompt` and `agentState` are then AES-256-GCM encrypted before
storage, bound to the intent id via AAD. Legacy plaintext intents remain
readable. `drift replay` of encrypted state without the key fails with exit 4.

**Known limitation:** encryption protects the `.drift` intent storage and the
agent state, not the git commit subject. In `full` mode the commit message
carries the plaintext (redacted) prompt; in the default `commit-summary` mode
it carries only the truncated first line. If prompts must never be readable,
use `none` or keep secrets out of prompts (redaction still applies).
