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
| Prompt injection via code comments | Reviewer/merge LLM prompts ignore code comments; LLM output re-validated |
| Malformed AST input | Parsers are bounded; parse failure aborts commit (exit code 2) |
