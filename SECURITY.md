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
| `none` | ❌ | Generic `Intent recorded` subject; generic non-prompt public summary (never empty) |

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

## Public provenance integrity (pull requests)

Committed public manifests are **append-only** in pull requests and are
audited by content, never by filename presence:

- an existing manifest that is modified, deleted or renamed on a PR is an
  **integrity violation**;
- a new manifest is legitimate only when its introducing commit carries
  exactly one matching `Drift-Intent:` trailer, the id does not already exist
  on the base branch (replay), the id is referenced by exactly one commit
  (ambiguous otherwise), and the PR-head blob is byte-identical to the
  introduced blob (added-then-modified is a violation);
- an unchanged manifest (byte-identical on base and head) is never reported
  as modified.

These rules are enforced by the GitHub App (Check Run conclusion) and the
composite GitHub Action (`fail-on-provenance-error`, default `true`, exits
non-zero AFTER the safe step summary and comment are generated — even when
no `GITHUB_TOKEN` is available, and independently of comment failures).

Missing-manifest policy (distinct from the above): a **new** `Drift-Intent:`
trailer introduced by the current PR whose public manifest does not exist at
base OR head is a hard violation (`trailer-without-manifest`) — newly
introduced intents must carry their manifest in the same commit. Only a
reference carried in from **base history** (a legacy pre-V2 intent with no
manifest anywhere, whose referencing commit is not new to the PR) stays a
neutral `missing` state. Neutral states — valid bootstrap,
unsigned/unverifiable/legacy-missing manifests, no intents — never fail by
default. An initial trust-root bootstrap (base has no key, head introduces a
valid first key) is VISIBLE in the step summary/comment and stays neutral;
replacement/removal AND any **malformed** key state (malformed initial key,
malformed replacement, malformed base root — never given a fallback
identity) are blocking failures.

## Cross-component key identity and validation

- **Canonical key identity:** one implementation (`signingKeyIdFor`) hashes
  the canonical **SPKI DER** bytes of the Ed25519 public key (SHA-256, first
  16 hex chars) in Core, the Action and the App. Textual PEM is never hashed,
  so LF/CRLF and whitespace differences can never change a key's identity or
  masquerade as a key replacement.
- **Strict trust-root parsing:** key state is decided ONLY by strict PEM
  parsing (`parseTrustRoot` / `evaluateTrustRootChange` shared by Core and
  the App, mirrored dependency-free by the Action): absent / valid /
  malformed. Malformed material NEVER receives a fallback fingerprint used
  in a security decision. Base/head states: none, bootstrap (neutral),
  unchanged, replaced (failure), removed (failure), malformed-bootstrap
  (failure), malformed-replacement (failure), base-malformed (failure — a
  malformed base root means no trust root can be established).
- **Strict bounded parsing:** manifest JSON is bounded to 256 KiB before
  `JSON.parse`; unknown top-level / `agent` / `files` fields are rejected
  (they cannot silently join the signed payload). The App audit is PR-scoped
  via the paginated changed-files API: limits apply ONLY to public-provenance
  files CHANGED or INSPECTED by the current pull request (200 files / 50 MiB
  of changed content) — never to the repository's accumulated history, so a
  repository with millions of unchanged historical manifests still allows a
  source-only PR. An incomplete changed-files listing is reported as an
  incomplete audit, never inferred as "no public changes". Oversized files
  are reported as malformed — never loaded whole, never echoed.
- **Comment ownership:** the App updates a comment only when
  `performed_via_github_app.id` equals the configured Drift App id (never an
  arbitrary positive id; an unavailable App id means no comment is owned);
  the Action updates only `github-actions[bot]` (type `Bot`) comments. The
  two integrations never edit each other's markers.
- **Index safety:** `drift realize` snapshots the real git index file
  byte-for-byte and restores it EXACTLY on ANY failure before the commit
  lands — including a failed `git commit` (missing identity, failing hooks),
  AST/syntax analysis, redaction, private-object writing, signing and
  manifest staging. Only files generated by the failed operation are removed;
  successful commits and post-commit local-DB failures are never rolled back.
  Snapshots are discarded on success and never leak as `drift-idx-*` temp
  backups. A failed realize also removes the prompt-bearing private object it
  created (no orphan left behind); a successful commit keeps it, and
  `drift doctor` reports any orphan private object (no DB row, no manifest,
  no trailer) with a safe `--fix` cleanup path — it never prints the prompt.
- **Immutable PR trust inputs:** the GitHub Action makes trust decisions ONLY
  from the immutable `pull_request.base.sha` / `pull_request.head.sha` git
  objects (`git show <sha>:<path>`) — never from `HEAD` or the working tree,
  so a synthetic merge checkout, a mutated worktree or an earlier workflow
  step cannot influence the trust result. Missing history fails safely with a
  `fetch-depth: 0` message.
- **Config/key staging:** `drift realize` NEVER `git add`s a pre-existing
  `.drift/config.toml` — even when its working-tree content equals the safe
  template (that would replace a user's staged version A with the
  working-tree version B). A tracked public key with any working-tree
  modification refuses realization instead of being staged. Partially staged
  hunks, intent-to-add and staged renames/deletions survive every pre-commit
  failure byte-for-byte.
- **App commit completeness:** the App compares the returned PR commit list
  against the PR metadata count. The REST commits endpoint caps at 250;
  `returned != expected`, interrupted pagination, duplicate entries or blank
  SHAs make the audit `incomplete-commit-audit` — a failing check, never a
  truncated "success". The introduction commit is NEVER guessed from the head
  SHA.
- **Check Run reliability:** the App returns structured Check Run + comment
  write results. A failed Check Run is never hidden by a successful comment:
  transient failures (network / 5xx / 429) make the webhook retryable (500 →
  GitHub redelivers) while permanent 4xx failures are acknowledged. Read-only
  mode performs no writes.
- **Persistent-runner trust boundary:** the self-hosted ARM64 runner executes
  ONLY trusted events — push to protected branches, workflow_dispatch, and
  same-repository PRs authored by a real User with association OWNER / MEMBER
  / COLLABORATOR (never `dependabot[bot]`, `renovate[bot]`, `github-actions[bot]`,
  any bot-typed author, an external fork, or an untrusted association). All
  untrusted PR classes run the identical validation on an ephemeral
  GitHub-hosted Linux runner; `pull_request_target` is never used.
