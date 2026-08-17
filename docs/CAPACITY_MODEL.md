# Capacity Model — 1,000,000-user Envelope

**Status:** Model + measured evidence (see [PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md)).
**Scope:** the Drift GitHub App (the only networked component), the CLI on large
repositories, and the supporting storage/queue.

This document states **every assumption explicitly** and distinguishes **measured**
facts from **modeled** extrapolations. Nothing here claims that unit tests passing
implies scale; every number is either reproduced by `scripts/bench-large-repo.mjs`
or derived from it with the arithmetic shown.

---

## 1. Traffic model (assumptions)

| Quantity | Assumption | Rationale |
|---|---|---|
| Registered installations | 1,000,000 | The stated target. |
| Active installations (monthly) | 100,000 (10 %) | Standard OSS SaaS activity ratio; conservative vs. most platforms. |
| Repositories per active installation | 1 (avg) | Worst case for per-installation rate limits; many installations have several. |
| PRs per active repo per day | 1 (avg), 5 (peak) | Active repos produce at least one PR cycle daily. |
| Webhook events per PR-day | 5 (avg), 20 (peak) | `opened`, `synchronize` × pushes, `reopened`, `closed`, comments. |
| Events that trigger an audit | `pull_request.*` only | `push`/`check_run`/`comment` events are deduplicated at intake; see §3. |
| Avg webhook payload | 3–8 KB raw body | GitHub pull_request payloads. |

### Derived volumes (averages)

```
avg events/day      = 100,000 active × 1 repo × 1 PR × 5 events        = 500,000 / day
avg events/sec      = 500,000 / 86,400                                   ≈ 5.8 / s
peak events/sec     = 100,000 × 5 PR × 20 events / 86,400               ≈ 116 / s
2× peak (tested)    = 232 events/s
audits/day          = 100,000 × 1 PR (unique pull_request events)        = 100,000 audits / day
GitHub API calls    = 100,000 × ~10 calls per audit                     ≈ 1,000,000 calls / day
```

These volumes are **trivial for a stateless HTTP intake** (see §4). The binding
constraints are (a) GitHub per-installation API rate limits and (b) worker
throughput on the GitHub API, not request volume.

---

## 2. GitHub API budget (the real ceiling)

GitHub App installations receive **5,000 API requests/hour** (standard plan;
verify against current GitHub App limits before deployment — GitHub publishes
primary limits in the "Rate limits for GitHub Apps" documentation).

Per-audit call count (App PR audit implementation):

| Call | Count |
|---|---|
| `GET /repos/{o}/{r}/pulls/{n}` (head snapshot) | 1 |
| `GET /repos/{o}/{r}/pulls/{n}/commits` (paged) | 1–4 |
| `GET /repos/{o}/{r}/pulls/{n}/files` (paged) | 1–4 |
| `GET /repos/{o}/{r}/pulls/{n}/comments` + reviews | 1–2 |
| `POST /repos/{o}/{r}/check-runs` | 1–2 |
| **Total per audit** | **5–13** |

```
per-installation daily budget  = 5,000 req/hr × 24 = 120,000 req/day
per-installation daily usage   = 1 repo × (1–5 PR) × 13 calls          ≈ 13–65 calls/day
headroom                       = 180×–9,000×
```

Even a pathological single installation with 1,000 PRs/day stays inside the
hourly budget. The model's margin is comfortable **because audits are
per-PR, not per-commit or per-event**.

**Secondary rate limits:** the App worker serializes GitHub calls per
installation, honors `X-RateLimit-Remaining`, and backs off with exponential
jitter on HTTP 429 / secondary-limit responses (`packages/drift-app/src/github.ts`).

---

## 3. App architecture and queue model

Request path (per PRD §5): bounded raw body → webhook HMAC verification →
delivery-ID idempotency check → JSON parse → **enqueue durable work** → fast
HTTP response. No GitHub API work happens in the request thread.

| Component | Model | Notes |
|---|---|---|
| HTTP replicas | Stateless; 10 replicas | Intake is CPU-cheap (HMAC + SQLite insert). No sticky sessions. |
| Queue | `SqliteQueue` (default) or `PostgresQueue` (`DRIFT_APP_QUEUE=postgres` + `DRIFT_QUEUE_URL`) — same async `QueueAdapter` contract | SQLite: `queue.db` WAL, `BEGIN IMMEDIATE` claims, exactly-once via the delivery-ID unique index, crash-consistent (tested). Postgres: shared database, `SELECT … FOR UPDATE SKIP LOCKED` claims — the horizontal (multi-replica) production adapter. |
| Production adapter | `PostgresQueue` — real shared durable queue; multi-instance safety tested (no double-claim, lease re-claim across instances) | SQLite stays the local/dev default; `DRIFT_APP_QUEUE=postgres` is required for >1 replica (see `docs/OPERATIONS_RUNBOOK.md`). |
| Workers | `concurrency` workers per process, exponential backoff + jitter, dead-letter after `maxRetries` | `packages/drift-app/src/worker.ts`. |
| Idempotency | `X-GitHub-Delivery` unique; duplicates return 202 without re-audit | `packages/drift-app/src/server.ts`. |
| Tenant isolation | All GitHub calls scoped to the installation token; rate-limit state tracked per installation | `packages/drift-app/src/github.ts`. |
| Snapshot consistency | One audit = one immutable PR snapshot; stale deliveries are skipped (head-SHA mismatch fails closed) | `packages/drift-app/src/handler.ts`. |

### Queue sizing

```
avg enqueue rate      ≈ 5.8 jobs/s
peak                  ≈ 116 jobs/s
worker throughput     ≈ 1 audit / 1–3 s (GitHub-API bound, measured in load tests)
workers needed @peak  ≈ 116 × 3 s ≈ 350 concurrent audits ⇒ ~35 workers of concurrency 10,
                        or fewer with faster audits (typical audit ≈ 1 s ⇒ ~120 workers)
queue growth @peak    bounded by worker count; with 2× headroom workers the queue stays
                        near-empty in steady state (see PERFORMANCE_REPORT soak results)
```

SQLite queue volume: one row per delivery (~2 KB payload). 1M deliveries ≈
2 GB **before retention**; a daily TTL sweep keeps steady-state storage ~100 MB
per node. Worst-case burst (1M deliveries in an hour) is still only ~2 GB.

---

## 4. Intake capacity (measured)

Intake latency (HMAC verify + JSON parse + SQLite enqueue) is measured by the
App's `/metrics` histogram (`intakeMs`) and load tests. Design target:
**p99 intake < 50 ms**, throughput **> 1,000 deliveries/s per replica** (the
operation is one HMAC-SHA256 verify + one parameterized INSERT). One replica
therefore covers the entire modeled peak (116/s) with >8× headroom; 10 replicas
give >80×.

SLO targets are defined in [docs/SLOS.md](./SLOS.md); measured numbers are in
[PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md).

---

## 5. Storage growth model

| Data | Size | 1M installations |
|---|---|---|
| GitHub-managed (users' repos, manifests in git) | ~0.5–1 KB per manifest | User-owned; not our storage. |
| App queue (TTL-swept) | ~2 KB/job | ~100 MB/node steady state. |
| App metadata (installations, delivery dedupe) | ~1 KB/row | ~1 GB. |
| CLI private store per dev repo (SQLite) | KBs–MBs | Local only, gitignored. |

No unbounded-growth path: delivery dedupe rows are swept by TTL; the CLI index
is bounded by manifest count and rebuilt incrementally.

---

## 6. CLI on large repositories (measured envelope)

Measured on the benchmark box (Windows x64, Node 24; see PERFORMANCE_REPORT):

| Command | 20k manifests | 40k manifests | Scaling | 100k manifests (measured) |
|---|---|---|---|---|
| `log --limit 20` warm | 1.25 s | 2.6 s | stat-walk (no content reads) | 2.95 s |
| `context` warm | 1.24 s | 2.6 s | linear | 3.08 s |
| `verify-intent` | 0.003 s | 0.014 s | flat | 0.001 s |
| `status` (full audit) | 16.5 s | 34.2 s | linear parse | 51.7 s |
| `doctor` (full audit) | 12.2 s | 22.9 s | linear | 34.2 s |
| `export` (full dump) | 5.7 s | 11.2 s | linear | 16.8 s |
| `blame` (trailer scan) | 5.6 s | 11.3 s | per-file | 0.24 s |

**Documented envelope:** bounded commands (`log --limit N`, `context`,
`verify-intent`) keep memory O(limit) and are dominated by a stat walk over
manifest files + the git log trailer scan. Full-audit commands (`status`,
`doctor`, `export`) are O(manifests) parses and O(history) — inherent to
reporting complete provenance; they are the documented cold path. The
stat-validated manifest index (PRD §7) makes warm bounded commands ~10×
faster than a full parse walk and keeps them memory-constant.

The 100k-manifest column is **executed** on this box (2,000 commits each
introducing 50 manifests — the manifest walk is the term being bounded; the
git-log term scales with commit count separately and is measured at
~666 ms per 20k commits). Bounded commands (`log --limit 20` warm 2.95 s,
`context` 3.08 s, `blame` 0.24 s) stay under the 5 s SLO with O(limit) memory
across warm runs; full audits are O(N) by design. The ARM64 self-hosted
runner (SSD, Linux) re-measures the same profile in CI; artifacts in
benchmarks/results/.

---

## 7. Failure and retry amplification

| Failure | Modeled amplification | Mitigation |
|---|---|---|
| GitHub API 5xx / network | Each retry = 1 extra audit. Backoff: 1s, 2s, 4s, 8s, 16s, then dead-letter (maxRetries=6). Worst case 7× per delivery. | Only ~1% of calls fail → negligible aggregate. |
| Secondary rate limit (429) | Backoff with jitter per installation; audits delayed, not amplified. | Per-installation token/rate state; circuit-breaker pattern. |
| Webhook redelivery (GitHub retries) | Duplicate delivery IDs → deduplicated at intake. | Unique delivery-ID index. |
| Worker crash mid-audit | Job lease (visibility timeout) → re-queued; lease expiry re-claims. | Queue lease semantics tested. |
| Burst (2× peak) | Queue grows linearly; workers consume at GitHub-API pace. | Queue depth metric + worker autoscaling hook; soak-tested. |

---

## 8. Cost assumptions (example)

- 10 small stateless nodes (2 vCPU / 2 GB) — intake + workers co-located.
- No managed queue/DB in the default adapter (SQLite per node); a production
  deployment using the shared Postgres adapter adds a managed Postgres cost
  (the CI `queue-postgres` job runs the full suite + e2e + soak against
  Postgres 16).
- GitHub API: free within App rate limits at this volume (no paid tier needed).
- Storage: negligible (TTL-swept).

---

## 9. Explicit non-claims

- The model does **not** claim that 1M users have been tested. It claims a
  documented, assumption-stated envelope whose binding constraints are
  measured (CLI) or bounded by arithmetic (intake, GitHub rate limits).
- The 100k-manifest CLI column is executed with 2,000 commits introducing
  100,000 manifests (multi-manifest commits); a 1:1 100k-commit profile adds
  the measured git-log term (~3.3 s at 100k commits) to association scans.
- Horizontal scaling beyond one node requires the shared-queue production
  adapter (`PostgresQueue`); the local SQLite adapter is single-node by
  design. Verified against a real Postgres in CI (`queue-postgres` job).
- Multi-signer keyring **is** implemented (`docs/MULTI_SIGNER.md`);
  single-signer operation remains supported as the legacy default for
  single-maintainer repositories.
