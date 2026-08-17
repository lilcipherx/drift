# Service Level Objectives

Defined **before** optimization; status is measured, never assumed. Targets
cover the App (webhook intake, PR audits), the worker pipeline, and CLI
latency on large repositories. Evidence lives in
[PERFORMANCE_REPORT.md](./PERFORMANCE_REPORT.md) and the committed benchmark
artifacts under `benchmarks/results/`.

---

## 1. Definitions

| Term | Definition |
|---|---|
| Intake | `POST /webhook` → HMAC verify → idempotency check → JSON parse → durable enqueue → 2xx. No GitHub API work. |
| PR audit | Delivery consumed → immutable PR snapshot fetched → provenance analyzed → Check Run created/updated. |
| Error | Non-2xx response, dead-lettered job, or failed Check Run. |
| Data loss | A delivery accepted with 2xx that is never audited and never retried to dead-letter. |

---

## 2. SLO table

| SLO | Target | Measured now | Evidence |
|---|---|---|---|
| Intake latency p99 | < 50 ms | **44–55 ms** (2,400 deliveries, dev box) | `benchmarks/results/app-intake-2000.json` |
| Intake latency p95 | < 20 ms | **28 ms** | same |
| Intake availability (2xx for valid deliveries) | > 99.9 % | 100 % (0 errors in bench) | same |
| Duplicate delivery dedupe | 100 % of repeats return duplicate, no double audit | 100 % (79/79 detected in bench; 0 double audits in tests) | `tests/app/server-queue.test.mjs` |
| End-to-end PR audit p95 | < 60 s of webhook receipt | GitHub-API bound (~1–5 s/audit when API is healthy) | design + `tests/app/worker.test.mjs`; soak in CI |
| Job error rate (dead-letter) | < 1 % of jobs | 0 % in tests; retries with backoff | `tests/app/worker.test.mjs` |
| Queue wait time p95 | < 30 s at ≤ 2× peak | queue drains at worker pace; near-zero steady state | soak workflow |
| Worker throughput | ≥ 1 audit / 5 s per worker (API bound) | — | soak workflow |
| CLI `log --limit 20` (20k manifests, warm) | < 5 s | **1.3 s** | `bench-large-20k.json` |
| CLI `verify-intent` (20k manifests) | < 100 ms | **2.6 ms** | same |
| CLI `status` (20k manifests, full audit) | < 60 s | **16.5 s** | same |
| CLI peak memory, bounded commands | < 64 MB delta | **+1.3 MB** (log --limit 20) | same |
| Recovery: worker restart mid-job | job re-claimed, no loss | lease expiry re-claim (tested) | `tests/app/queue.test.mjs`, `tests/app/shutdown-live.test.mjs` |
| Data-loss objective | **0** accepted deliveries lost without a dead-letter record | SQLite durable queue; crash-consistency tested | `tests/app/queue.test.mjs` |

---

## 3. Measured vs. target status

- **Met with margin:** intake latency, intake throughput (899/s vs. 232/s
  2×-peak target), CLI bounded-command latency and memory, verify-intent.
- **Bound by GitHub API, tracked by soak:** end-to-end audit latency, worker
  throughput, queue wait under sustained load. These cannot be honestly
  measured against the live GitHub API in CI; the soak workflow exercises the
  full worker path against a mock API at 1×/2× modeled load and records
  p50/p95/p99 for the audit pipeline.
- **Always measured, never assumed:** any future claim of improved numbers
  must update the artifacts in `benchmarks/results/` and this table.

---

## 4. Alert recommendations (see docs/OBSERVABILITY.md)

| Alert | Threshold | Meaning |
|---|---|---|
| `queueDepth` > 10,000 sustained 5 min | Saturation | Workers can't keep up; scale workers. |
| `jobs.deadLettered` rate > 1 % / hour | Systemic failure | GitHub outage or app bug. |
| `intakeMs` p99 > 100 ms | Intake degraded | Replica/DB issue. |
| `rateLimit.lastRemaining` < 10 % of 5,000 | Per-installation throttle | Reduce concurrency for that installation. |
| error class counter spikes | Alert per class | See error taxonomy in OBSERVABILITY. |
