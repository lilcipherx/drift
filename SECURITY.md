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
| Accidental `git add .` of private Drift data | `.drift/.gitignore` ignores everything except the public allow-list (`.drift/public/` + `config.toml` + `.gitignore`) — verified by tests; `drift doctor` flags tracked private files |
| Full prompt leaking into git history / PR comments | Default `commit-summary` mode; raw prompt stays in the local gitignored store; only the first line of the redacted prompt (sanitized, truncated) becomes the public summary in the signed manifest and PR comment (ADR-009) |
| Secret leakage in prompts | Regex redaction before any storage |
| Data at rest (prompt / agent state) | AES-256-GCM via `DRIFT_MASTER_KEY` when `[encryption] enabled = true` (v0.2.0); GCM auth detects tampering |
| Malicious intent metadata rendered in PR comments | All public strings are sanitized (control chars, ANSI, HTML comments, mention spam) and length-limited before rendering |
| Prompt injection via code comments | Reviewer/merge LLM prompts ignore code comments; LLM output re-validated |
| Malformed AST input | Parsers are bounded; parse failure aborts commit (exit code 2) |
| Malicious `verifyCmd` / `--verify-cmd` | `drift verify` re-runs the recorded command with the user's shell. Only run `verify` on intents you trust (local or from a trusted upstream); verify `verifyCmd` before recording it via `realize --verify-cmd`. |

## Prompt storage (default: summary-only commits)

The full prompt is **never** written to public git history by default, and
`git add .` can never stage private Drift data: `drift init` writes a
`.drift/.gitignore` that ignores the SQLite store, `objects/`, `keys/` and
`private/`, keeping only `.drift/public/` (public key + signed intent
manifests) trackable (ADR-009). The `.drift/config.toml` `[prompts] mode`
setting controls persistence:

| Mode | Full prompt in `.drift` (local, gitignored) | Public data in git |
| :--- | :---: | :--- |
| `commit-summary` (default) | ✅ | `Intent:` first line + trailers in the commit; sanitized first-line summary in `.drift/public/intents/<id>.json` |
| `full` | ✅ | Full (redacted) prompt in the commit message (opt-in, legacy) — visibly unsafe |
| `none` | ❌ | Generic `Intent recorded` subject; empty public summary |

The summary is built **after** secret redaction, so secrets cannot leak via
it. The mode only affects new intents; history is never rewritten. A fresh
clone has no private store: `drift log` / `blame` / `verify-intent` serve
from the committed public manifests.

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
