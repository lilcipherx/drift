# Threat Model

Systematic adversary analysis for Drift (CLI, MCP, GitHub Action, GitHub App).
Every mitigation is implemented and, where noted, regression-tested. No
unresolved Critical or High finding is known to remain; residual risks are
explicitly marked **RESIDUAL** with the reason and the planned treatment.

Trust boundaries and data surfaces are described in
[PRODUCTION_READINESS_AUDIT.md](./PRODUCTION_READINESS_AUDIT.md).

---

## 1. Adversary and asset model

| Adversary | Capabilities | Assets targeted |
|---|---|---|
| Malicious repository | Full control of a repo the user clones (files, git history, manifests, hooks via git, but NOT the user's key) | Prompt theft, code execution via verify commands, provenance forgery |
| Malicious contributor | Can author commits/PRs in a repo that uses Drift | Provenance forgery, comment/check spam, runner abuse |
| Compromised GitHub token | Can call GitHub APIs as the App/user | Check Run/comment forgery, read access |
| Compromised App installation | Attacker controls an installation's repo | Tenant isolation breach, rate-limit exhaustion |
| Malicious manifest | Crafted `.drift/public/intents/*.json` | Parser DoS, state divergence, trust confusion |
| Key replacement | Writes a different `.drift/public/key.pem` | Signature forgery |
| Stale/replayed webhook | Replays or delays GitHub deliveries | Double processing, stale-state success |
| Poisoned cache | Writes the local manifest index (`drift.db`) | Bounded-command selection manipulation |
| Persistent-runner compromise | Executes untrusted code on the self-hosted runner | Host takeover, secret theft |
| Verification-command execution | Supplies `verification` strings | Code execution on the operator's machine |
| Local prompt theft | Reads files on a machine with a Drift repo | Raw prompt extraction |
| Supply-chain compromise | Compromises an npm dependency | Code execution in CLI/MCP/App |

---

## 2. Mitigations by threat

### 2.1 Malicious repository

| Attack | Mitigation | Evidence |
|---|---|---|
| `verification` string executes code on `drift verify` | `drift verify` is **informational by default**; execution requires explicit `--run` AND a manifest validly signed against the committed trust root (or `--allow-untrusted-command` with a prominent warning). Command runs via explicit argv, never a shell. | `tests/unit/pr-comment.test.mjs`, engine verify |
| Shell interpolation in any git operation | All git invocations use `execFile`-style argv arrays; paths are `--`-separated; never `-c` with user strings. | `git.ts` (`execGit`) |
| Path traversal / repo escape | `blame`/`context` reject `../`, absolute, cross-drive, and symlink-escape paths before touching the filesystem. | `isInsideRepo` + tests |
| ANSI / control-char injection in rendered provenance | Public strings sanitized (control chars, ANSI, HTML comments, mention spam) and length-limited before PR comments/Check Runs. | `sanitize*` in App, pr-comment tests |
| Malformed trailers | Trailer parser is strict (`DRIFT_INTENT_ID_RE`); invalid `Drift-Intent:` values are surfaced, never silently ignored; ambiguous/replayed/duplicate states preserved. | `trailers.ts`, association tests |
| CRLF/LF divergence | Trailers parsed on normalized lines; CI normalizes CRLF for aggregate assertions. | tests |
| Oversized files / JSON bombs | `MANIFEST_MAX_BYTES = 256 KiB` cap before parse; bounded recursion depth (24); webhook body capped at 8 MB; queue rows bounded. | `public.ts`, `server.ts` |
| Symlink attacks on `.drift` | Private dirs are gitignored; manifest reads are within the repo; index stat-validated. | ADR-009 |

### 2.2 Malicious contributor

| Attack | Mitigation |
|---|---|
| Forge provenance via an unverified manifest field | V2 association is derived ONLY from `Drift-Intent:` git trailers, never an embedded commit field; the manifest + trailer are introduced in ONE atomic commit. |
| Replay a manifest | Trailer scan in chronological order: `replayed` state surfaced, introduction = oldest reference. |
| Obfuscate via duplicate trailers | `duplicate-in-commit` surfaced; `blame` never picks an arbitrary first intent. |
| Runner abuse | Persistent runner executes only trusted events (OWNER/MEMBER/COLLABORATOR same-repo User PRs, protected pushes, manual dispatch); everything else on GitHub-hosted; `pull_request_target` never used. |
| Comment/check spam | Only comments owned by the exact Drift App ID / expected Actions bot are updated; writes are idempotent. |

### 2.3 Compromised GitHub token

| Attack | Mitigation |
|---|---|
| Forge Check Runs | Check Run is created/updated by the App with its own installation token; a stolen token is bounded by the App's permissions. |
| Read private data via App | App never receives or renders prompts; logs never contain prompt/secret fields (structured-log allowlist). |

### 2.4 Compromised App installation

| Attack | Mitigation |
|---|---|
| Tenant cross-talk | Every GitHub call is scoped to that installation's token; rate-limit state per installation; no shared mutable tenant data. |
| Rate-limit exhaustion | Per-installation serialization + secondary-limit backoff; circuit-breaker pattern; intake never consumes GitHub API. |

### 2.5 Malicious manifest

| Attack | Mitigation |
|---|---|
| Unknown fields | Strict versioned schema; unknown fields REJECTED (no silent extension); future extensions must be signed, versioned, and enumerated. |
| Input-size DoS | `MANIFEST_MAX_BYTES` cap; oversized files never parsed by the index (recorded invalid, surfaced by status/doctor). |
| State divergence | All trust states computed from the FILE (never the index); status/doctor re-verify the whole tree; contract fixtures shared across Core/CLI/MCP/Action/App. |
| Poisoned index (cache) | **RESIDUAL(low):** the index is selection metadata only; a poisoned `valid=1` row cannot inject a corrupt manifest into `log` output (re-read + re-validate on selection, regression-tested); status/doctor always re-read files. A poisoned row could hide a manifest from a bounded listing, but trust states remain correct. |

### 2.6 Key replacement

| Attack | Mitigation |
|---|---|
| Replace trust root in a fresh clone | `drift init` PRESERVES the committed `.drift/public/key.pem` byte-for-byte; never regenerates it; read-only signer mode until the matching key is imported. |
| Key import of a wrong key | `drift key import` verifies an exact match; wrong/mismatched keys are rejected. |
| RSA/EC/certificate/private/malformed/oversized keys | Trust-root parser accepts only canonical Ed25519 SPKI keys; identity = canonical SPKI-DER hash; everything else is `untrusted-key`/`malformed`, never valid. |
| Key rotation | Controlled, explicit single-signer rotation (ADR-009); multi-signer keyring is a documented release blocker for multi-maintainer production use (**RESIDUAL**). |

### 2.7 Stale/replayed webhook

| Attack | Mitigation |
|---|---|
| Stale delivery audits a moved head | One audit = one immutable PR snapshot; head-SHA mismatch → skip/retry, fail closed on incomplete commit/file enumeration. |
| Replayed/duplicate delivery | `X-GitHub-Delivery` idempotency (unique index); duplicates return 202 with no re-audit; a job is processed at most once per delivery id. |
| Forged job injected into the queue DB | The intake server verifies the HMAC and persists the signature on the job; the worker RE-verifies the HMAC over the stored raw body before auditing — a forged or tampered queued delivery is rejected exactly like a forged webhook (fail closed). |
| GitHub rate limits (429 and secondary 403) | Both are classified transient and retried with the server's Retry-After as the backoff floor; verified by the e2e fault-injection benchmark (rate-limit scenario). |
| Partial API responses / pagination truncation | Commit/file enumeration compares returned count vs metadata; interruption → `incomplete-commit-audit` (failing check, never truncated success). |

### 2.8 Verification-command execution

Executable only via explicit `--run` + validly signed manifest + trust-root
verification (or an explicit dangerous flag with a loud warning). Environment
is filtered to a minimal allowlist; docs state clearly that filtering is not
an OS sandbox. `drift verify` stays informational by default. The composite
Action exposes only structured, allowlisted operations — never arbitrary
shell commands.

### 2.9 Local prompt theft

| Attack | Mitigation |
|---|---|
| Read `.drift/drift.db` / `objects/` | Optional AES-256-GCM encryption at rest (`DRIFT_MASTER_KEY`); `none` mode stores no prompt anywhere; private dirs gitignored. |
| Prompt in logs/errors/crash reports | Structured-log allowlist; error messages never embed prompt text; storage-privacy tests. |

### 2.10 Supply-chain compromise

| Attack | Mitigation |
|---|---|
| Malicious npm dependency | Production dependency surface is minimal: `@modelcontextprotocol/sdk` + `zod` (MCP), `typescript` (drift-ast), internal `@drift/*` workspace packages; everything else is Node built-ins. `npm audit` = 0 vulnerabilities (checked at every CI run); dependencies pinned via lockfile; CI installs with `--no-audit --no-fund` from the lockfile. |
| Malicious action versions | Every `uses:` reference across all workflows is pinned to an immutable commit SHA (resolved from the official release tags); a workflow self-audit fails if a mutable tag ever returns; `persist-credentials: false`; minimal permissions (`contents: read`; `security-events: write` only in CodeQL). |

---

## 3. Residual risks (accepted, documented)

| # | Risk | Why accepted | Planned treatment |
|---|---|---|---|
| R1 | Single-signer key model | Multi-maintainer rotation requires a keyring; documented as a release blocker for multi-maintainer production use. | Multi-signer/keyring model. |
| R2 | Local manifest-index stat collision could hide a manifest from a bounded listing | Stat (mtime+size+ctime) freshness + re-read-on-selection makes trust divergence impossible; listing staleness is bounded and surfaced by status/doctor. | Content-addressed index (hashes) if ever needed. |
| R3 | macOS not claimed as supported | No macOS CI runner or evidence. | State explicitly in README support policy. |
| R4 | 100k-manifest CLI envelope | Executed end-to-end (docs/PERFORMANCE_REPORT.md) with the stat-validated index: cold build O(N) one time, bounded commands O(limit) memory thereafter. | Re-measured every CI benchmark run. |
| R5 | Production shared durable queue not implemented | The App's durable queue is SQLite — correct, crash-safe, and measured locally, but a SINGLE-NODE adapter. Horizontal scaling of the App (multi-replica) requires a shared durable queue/storage adapter; this is a release blocker for multi-replica production deployments (see PRODUCTION_READINESS_REPORT.md). | Postgres (or equivalent) `QueueAdapter` with the same lease/claim/retry semantics. |
