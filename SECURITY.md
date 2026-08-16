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
| Full prompt leaking into git history / PR comments | The raw prompt is private by default. The public summary is a separate explicit `--summary` (redacted → sanitized → truncated) or a generic non-prompt fallback (`Drift intent <id>`) — never prompt text, never a commit subject. The Action/App render only that summary (ADR-009) |
| Secret leakage in prompts | Regex redaction before any storage |
| Data at rest (prompt / agent state) | AES-256-GCM via `DRIFT_MASTER_KEY` when `[encryption] enabled = true` (v0.2.0); GCM auth detects tampering |
| Malicious intent metadata rendered in PR comments | All public strings are sanitized (control chars, ANSI, HTML comments, mention spam) and length-limited before rendering |
| Prompt injection via code comments | Reviewer/merge LLM prompts ignore code comments; LLM output re-validated |
| Malformed AST input | Parsers are bounded; parse failure aborts commit (exit code 2) |
| Malicious `verifyCmd` / `--verify-cmd` | A verification string is treated as untrusted code. `drift verify <id>` is informational (never executes). It runs only with an explicit `drift verify <id> --run` AND a validly signed manifest verified against the committed trust root; `--allow-untrusted-command` forces it with a prominent warning. Never auto-enabled by the Action/App/MCP. |

## Prompt storage (default: summary-only commits)

The full prompt is **never** written to public git history by default, and
`git add .` can never stage private Drift data: `drift init` writes a
`.drift/.gitignore` that ignores the SQLite store, `objects/`, `keys/` and
`private/`, keeping only `.drift/public/` (public key + signed intent
manifests) trackable (ADR-009). The `.drift/config.toml` `[prompts] mode`
setting controls persistence:

| Mode | Full prompt in `.drift` (local, gitignored) | Public data in git |
| :--- | :---: | :--- |
| `commit-summary` (default) | ✅ | `Intent:` <explicit public summary or generic fallback> + trailers in the commit; the same safe summary (never prompt text) in `.drift/public/intents/<id>.json` |
| `full` | ✅ | Full (redacted) prompt in the commit message (opt-in, legacy) — visibly unsafe |
| `none` | ❌ | Generic `Intent recorded` subject; empty public summary |

The summary is built **after** secret redaction, so secrets cannot leak via
it. It is **never derived from the prompt**: the first line of a one-line
prompt would otherwise be copied verbatim into git history. The mode only
affects new intents; history is never rewritten. A fresh clone has no private
store: `drift log` / `blame` / `verify-intent` serve from the committed
public manifests, and `drift init` preserves the committed public key
byte-for-byte (read-only signer mode until `drift key import --file <path>`
restores the matching private key).

## Encryption at rest (v0.2.0)

Set `[encryption] enabled = true` in `.drift/config.toml` and export
`DRIFT_MASTER_KEY` (64-hex, or any passphrase — hashed with SHA-256). The
intent's `prompt` and `agentState` are then AES-256-GCM encrypted before
storage, bound to the intent id via AAD. Legacy plaintext intents remain
readable. `drift replay` of encrypted state without the key fails with exit 4.

**Known limitation:** encryption protects the `.drift` intent storage and the
agent state, not the git commit subject. In `full` mode the commit message
carries the plaintext (redacted) prompt; in the default `commit-summary` mode
it carries only the safe public summary. If prompts must never be readable,
use `none` or keep secrets out of prompts (redaction still applies).

## Export privacy

`drift export` is **public-only by default**: it outputs committed public
manifests with `"containsPrivatePrompts": false` and never a prompt. Private
prompts are exported only with the explicit `drift export
--include-private-prompt` flag, which marks the output
`"containsPrivatePrompts": true`, warns on stderr, and **refuses to write
inside the git repository** unless `--allow-repository-output` is given.
