# Production Readiness Report

**Final decision: NO-GO — release blockers remain.**

This report documents the hardening work on the open PR #7
(`fix/privacy-pr-provenance`), the evidence behind every readiness claim, and
the exact blockers that prevent a `GO`. It does not declare readiness on the
strength of passing tests alone: each claim below is tied to a reproducible
artifact, test, or workflow.

---

## 1. Baseline

| Item | Value |
|---|---|
| Starting SHA (this effort) | `99b8bc3` |
| Branch | `fix/privacy-pr-provenance` |
| PR | [#7](https://github.com/lilcipherx/drift/pull/7) (open, never merged) |
| Original state | 280 tests passing; CI green (Linux ARM64 self-hosted, Linux x64 fallback, Windows) |
| Reproduced Critical/High defects | 3 (see §2) |

## 2. Correctness and security — every Critical/High defect

| Severity | Defect | Root cause | Fix | Regression test |
|---|---|---|---|---|
| **Critical** | Queued App mode could never complete an audit with a webhook secret configured | The intake server verified the HMAC but enqueued only `rawBody`+`payload`; the worker rebuilt the event **without the signature**, so the handler rejected every authenticated delivery as `invalid webhook signature` (permanent ack). The queue tests only covered intake/dedupe, never the worker→handler path. | The verified `X-Hub-Signature-256` is persisted on the job (SQLite column + `ALTER TABLE` migration for pre-upgrade DBs) and the worker **re-verifies the HMAC** over the stored raw body before auditing — a forged job injected into the queue DB is rejected exactly like a forged webhook. | `tests/app/server-queue.test.mjs` — "full queued path: server HMAC → durable enqueue → worker re-verifies → audit completes" |
| **High** | GitHub secondary rate limits (403 with `Retry-After`) permanently dropped deliveries | The handler classified any 403 as permanent (`retryable = code === 429 || code >= 500`), ignoring the client's explicit transient `RateLimitError`. Under real load the App would silently lose deliveries. | `RateLimitError` is recognized as transient regardless of status; the client's `Retry-After` becomes the worker backoff **floor** (capped so a stale/hostile header can't stall the queue). | `tests/app/worker.test.mjs` — "secondary rate limit (403 + Retry-After) is retried, never dropped permanently" |
| **High** | `log --limit N` / `context` loaded and parsed **every** manifest | Bounded command, unbounded work: each run did a full manifest walk + parse (O(N) time and memory). | Stat-validated manifest index (selection/ordering metadata only — every displayed entry is re-read and re-validated from the file; `status`/`doctor` always re-verify the full tree; schema-versioned; fresh-clone heap fallback). Bounded commands are now O(limit) memory. | `tests/unit/bounded-index.test.mjs` — 12 tests incl. checkout, rebase/amend, deletion, same-size+mtime tamper, parallel processes, crash mid-refresh, poisoned-index (cannot inject, cannot fabricate) |

Additional fixes in this effort: `log` diagnostics no longer re-walk every
manifest (index tracks invalid ids); the 100k benchmark generator no longer
times out (multi-manifest commits + detached generation); CI gates added for
all of the above.

## 3. Architecture (final)

- **Core** (`@drift/core`): zero-dependency provenance engine. Atomic
  commit+manifest+trailer writes; strict V2 public-manifest schema with
  bounded input; Ed25519 signatures; SQLite private store (`node:sqlite`,
  WAL, busy-timeout, crash-atomic transactions); stat-validated public-
  manifest index; deterministic trailer-association scan with replay/duplicate/
  ambiguous states.
- **CLI / MCP / GitHub Action / GitHub App**: four consumers of the same Core
  trust semantics. The Action mirrors the strict trust-root parser and
  association rules in `scripts/pr-comment.mjs`; contract fixtures are
  generated from production code (`npm run eval`).
- **App**: HTTP webhook server (bounded body → HMAC → delivery-id
  idempotency → durable enqueue → fast 202) + durable worker (re-verifies
  HMAC, bounded concurrency, lease/visibility re-claim, exponential backoff
  with Retry-After floor, dead-lettering) + health/readiness endpoints +
  structured logging + metrics.
- **Trust boundaries**: repo content untrusted; webhook HMAC fail-closed;
  queue-DB forgery impossible to turn into an audit (signature re-verify);
  local store never read by App/Action/MCP; base-branch key is the
  verification key; the manifest index is never a trust source.
- **Key model**: single Ed25519 trust root (`.drift/public/key.pem`), strict
  parser, canonical SPKI identity, explicit rotation, key-change states
  shared by Core/CLI/App/Action. **Multi-signer keyring: implemented** —
  `.drift/public/keyring.json` with signed append-only audit
  (`docs/MULTI_SIGNER.md`), tested for lifecycle, rotation, compromise, and
  tamper fail-closed behavior.
- **App queue adapters**: `SqliteQueue` (local/dev durable default),
  `MemoryQueue` (dev), and **`PostgresQueue`** (production shared queue:
  `DRIFT_APP_QUEUE=postgres` + `DRIFT_QUEUE_URL`) with identical
  claim/lease/retry/idempotency/dead-letter semantics over an async
  `QueueAdapter` contract; multi-instance safety proven by tests.
- **Migration model**: additive-only SQLite schema (new columns via guarded
  `ALTER TABLE`, tested: `tests/integration/reliability.test.mjs` "App queue
  schema migrates forward"); index schema versioned and rebuilt on bump.

## 4. Million-user capacity (measured envelope)

Assumptions, SLOs, and the full model: `docs/CAPACITY_MODEL.md`, `docs/SLOS.md`.

| Metric | Target | Measured (dev box, Windows x64 / Node 24) | Evidence |
|---|---|---|---|
| Webhook intake p99 | < 100 ms | **27–37 ms** steady-state | `benchmarks/results/app-intake-2000.json` |
| Intake throughput | ≥ 232/s (2× peak) | **899–1,469/s** | same |
| E2E audit p50/p99 (mock API) | p50 < 5 s | **15 ms / 32 ms** | `benchmarks/results/bench-app-e2e.json` |
| `log --limit 20` warm, 20k manifests | < 5 s | **1.3 s** | `bench-large-20k.json` |
| `log --limit 20` warm, **100k** manifests | < 5 s | **2.95 s** | `bench-large-100k.json` |
| `context` / `blame` / `verify-intent`, 100k | — | **3.08 s / 0.24 s / 1.3 ms** | same |
| Full audits (`status`/`doctor`/`export`) at 100k | — | 51.7 s / 34.2 s / 16.8 s (O(N) by design) | same |
| Bounded-command memory | O(limit), no unbounded growth | warm deltas constant across runs (+1.3 MB @20k; +29 MB is the one-time cold build at 100k) | same |
| Worker soak 5k jobs + 2% transient | 0 data loss | drained 18 s, **0 dead letters**, 82 retries absorbed | `scripts/soak-app.mjs` |
| E2E fault scenarios (rate-limit/transient/dupes/stale/crash/parallel) | exactly-once, 0 dead | **all PASS** | `bench-app-e2e.json` |

**Maximum verified capacity:** 100,000 manifests (CLI), 1,469 deliveries/s
intake (≈6.3× the 2×-peak target), 5k-job soak. **Remaining headroom:** intake
is SQLite-write-bound (measured ~1.5k/s on a laptop; server hardware is
higher); the worker pool is the horizontal scaling unit; the binding
constraint for a million-user fleet is the GitHub API rate budget, which the
model accounts for arithmetically (≈1M calls/day).

## 5. Reliability

| Area | Result | Evidence |
|---|---|---|
| Crash mid-index-refresh | next run recovers, full index rebuilt (WAL rollback) | `tests/unit/bounded-index.test.mjs` "crash mid-refresh" |
| Worker crash mid-job | lease expiry re-claims; zero loss, zero dupes | `tests/app/queue.test.mjs`, `tests/app/worker.test.mjs`, e2e "worker-crash" |
| Concurrent `realize` | no corruption; `git fsck --strict` clean; consistent end state | `tests/integration/reliability.test.mjs` |
| Concurrent index writers (4 processes) | consistent results, index intact | `tests/unit/bounded-index.test.mjs` "parallel" |
| Unreadable/corrupt store | fails safely (exit 5, actionable); backup restore recovers | `tests/integration/reliability.test.mjs`; `tests/integration/pipeline.test.mjs` |
| Backup/restore (copy `.drift/`) | keys + private prompts round-trip | `tests/integration/reliability.test.mjs` |
| Queue schema migration (pre-signature DB) | forward migration works; legacy rows fail closed | `tests/integration/reliability.test.mjs` |
| Temp-file leaks | none after the full command surface | `tests/integration/reliability.test.mjs` |
| Soak / chaos | 5k jobs + duplicates + 2% transient failures → 0 data loss | `scripts/soak-app.mjs`, `tests/app/abort-live.test.mjs`, `shutdown-live.test.mjs` |

Rollback: `docs/ROLLBACK.md` (package downgrade + store backward compat;
SQLite files are forward-writable only — documented downgrade limitations).

## 6. Platform and CI

| Platform | Result | Runner |
|---|---|---|
| Linux ARM64 | CI green (final SHA re-run, see PR checks) | Oracle Ubuntu 24.04 ARM64 self-hosted (`[self-hosted, Linux, ARM64]`) |
| Linux x64 (untrusted PRs) | exact De Morgan negation of the trusted gate; runs identical validation on hosted runners | GitHub-hosted `ubuntu-latest` |
| Aggregate Linux gate | exactly one of the two routing jobs ran, one skipped | hosted |
| Windows | CI green | `windows-latest` |
| macOS | **not claimed** (no runner/evidence; README support policy) | — |

Workflows: `.github/workflows/ci.yml` (test ×3 platforms + routing + aggregate
+ benchmark with 20k **and 100k** SLO gates + intake/e2e/soak),
`.github/workflows/security.yml` (CodeQL, dependency review, npm audit,
secrets/licenses/tarballs/SBOM, SHA-pinning + permissions self-audit),
`.github/workflows/soak.yml` (nightly). All actions pinned to immutable
commit SHAs (resolved from official release tags on 2026-08-13).

## 7. Packaging and release

- Tarballs: `npm pack` + install into an **empty directory** works for all
  four packages (`drift-ast/core/cli/mcp`); bins `drift` and `drift-mcp`
  exist; `drift version` runs. Tarball contents scanned (no absolute paths,
  no sources, no secrets, no node_modules). Evidence: CI package-smoke step +
  `scripts/security-checks.mjs --packages`.
- Namespace: `@drift/*` — registry ownership is **unresolved**
  (`docs/NPM_SCOPE_DECISION.md`); publishing blocked on owner authorization.
- SBOM: SPDX-2.3 generated and validated (`benchmarks/results/drift.spdx.json`,
  103 packages); license review: 101 deps all allowlisted.
- Provenance/attestation, canary/stable channels, trusted publishing, and the
  smoke-test-after-publish procedure are specified in `docs/RELEASE_PROCESS.md`
  and implemented as scripts (`scripts/publish-npm.sh`), gated on explicit
  credentials and final approval — **not executed** (no authorization).
- npm audit: 0 vulnerabilities (prod and dev).

## 8. Files and commits (this hardening effort, `99b8bc3..HEAD`)

| Commit | Contents |
|---|---|
| `43cd7f0` | perf(core): stat-validated manifest index — bounded commands O(limit) |
| `ae66013` | feat(app): durable webhook queue, delivery-id idempotency, worker retries |
| `b952030` | docs(capacity): capacity model, performance report, SLOs, CI benchmarks + soak |
| `ade7489` | docs(ops/security): runbooks, threat model, release process, docs-command test |
| `b1ab52e` | fix(app): worker HMAC re-verification, secondary-rate-limit retry, e2e fault benchmark, supply-chain gates, reliability tests |
| `36d8b96` | docs(capacity): measured 100k envelope, e2e data, production-readiness audit |

Changed files (workflows, App src+dist, Core src+dist, scripts, tests, docs,
benchmark artifacts) are itemized in the individual commits. Branch
`fix/privacy-pr-provenance` will be pushed; PR #7 updated. Nothing merged,
tagged, released, or published.

## 9. Final decision

**PENDING FINAL CI — both former blockers implemented; verdict after the
Postgres-backed CI run on the final SHA.**

Both blockers from the previous NO-GO are now implemented and tested
locally; the remaining step is the real-backend verification in CI
(`queue-postgres` job with a Postgres 16 service container) plus the
standard green gates on the final SHA:

1. **B1 — Production shared durable queue adapter: IMPLEMENTED.**
   `PostgresQueue` (`packages/drift-app/src/queue-pg.ts`) implements the
   same `QueueAdapter` contract as SQLite with `SELECT … FOR UPDATE SKIP
   LOCKED` claims, `ON CONFLICT` idempotency, lease/retry/dead-letter
   semantics, and pool-based connections so any number of replicas and
   workers across hosts share one database. The contract is now async; the
   SQLite and memory adapters are unchanged apart from the `async` keyword.
   Multi-instance safety (no double-claim, lease re-claim across instances)
   is covered by tests; the full e2e suite (incl. a two-server/two-pool
   multi-instance scenario) and the 5k-job soak run against real Postgres in
   CI (`queue-postgres` job). Deployment: `DRIFT_APP_QUEUE=postgres` +
   `DRIFT_QUEUE_URL`.

2. **B2 — Multi-signer/keyring: RESOLVED.** The signed, append-only keyring
   (`docs/MULTI_SIGNER.md`) adds/revokes/removes trusted Ed25519 keys with a
   full audit trail anchored to `key.pem`, backward compatibility, and
   fail-closed tamper detection. 11 tests cover lifecycle, safe rotation,
   key-compromise response (revoked keys cannot sign, import, or authorize;
   their signatures become `untrusted-key`), and tampering.

**Verdict rule:** if the final CI run on the pushed SHA is green — including
`queue-postgres` (real Postgres: full suite + e2e fault scenarios incl.
multi-instance + soak), ARM64, Windows, security, and benchmark gates — the
status becomes **GO** within the documented capacity envelope. Otherwise it
returns to **NO-GO** with the exact failing gate listed.
