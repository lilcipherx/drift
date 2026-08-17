# Observability

Operational visibility for the Drift GitHub App (webhook server, durable
queue, workers) and the CLI. Everything here is implemented in
`packages/drift-app/src/{logger,metrics,server,worker}.ts` and enforced by
tests. Privacy rules are non-negotiable and asserted by the storage-privacy
tests.

---

## 1. Structured logging

Every operational log line is a single JSON object with a fixed allowlisted
field set (`packages/drift-app/src/logger.ts`). There is no free-form message
concatenation; human-readable context goes in the `msg` field.

### Allowed fields

| Field | Meaning | Example |
|---|---|---|
| `ts` | epoch ms | `1723900000000` |
| `level` | `info` / `warn` / `error` | `error` |
| `op` | operation name (allowlist) | `webhook.enqueue` |
| `deliveryId` | GitHub delivery id | `uuid` |
| `installId` | installation id (privacy-conscious: numeric id only) | `42` |
| `repoId` | repository id (numeric only) | `7` |
| `durationMs` | operation duration | `12` |
| `result` | outcome (`ok`/`retrying`/`permanent`/`dead`/`not-ready`) | `dead` |
| `retryCount` | job attempt number | `3` |
| `errorCode` | bounded error code (allowlist, never free text) | `enqueue-failed` |
| `queueDepth` | sampled queue depth | `5` |
| `msg` | short human description, no secrets/prompts | `job dead-lettered` |

### NEVER logged (asserted by tests)

- prompt text, private manifest data, agent state;
- tokens, webhook secrets, authorization headers, private keys;
- child-process environments;
- full webhook bodies or full GitHub API responses.

### Operations

| op | Emitted by |
|---|---|
| `webhook.invalid` | HMAC failure / malformed delivery (with bounded `errorCode`) |
| `webhook.enqueue` | accepted delivery enqueued |
| `webhook.duplicate` | delivery-id dedupe (already queued/processed) |
| `job.process` / `worker.nack` / `worker.claim` / `worker.start` / `worker.stop` | worker lifecycle |
| `readiness` | /ready probe failures |
| `verify` | `drift verify` outcomes (CLI) |

---

## 2. Metrics

`packages/drift-app/src/metrics.ts` exposes an in-memory metrics object with
counters and bounded-memory latency histograms (fixed log buckets
0.5 ms–64 s), aggregated into a `snapshot()`:

| Metric | Type | Meaning |
|---|---|---|
| `deliveries.accepted` / `deduplicated` | counter | intake volume |
| `jobs.acked` / `retried` / `permanent` / `deadLettered` / `nackFailed` | counter | pipeline health |
| `worker.busy` / `idle` | gauge-ish counter | utilization |
| `rateLimit.lastRemaining` / `samples` | gauge/counter | GitHub per-installation budget |
| `queueDepth.last` / `max` | gauge | saturation |
| `auditMs` | histogram | end-to-end audit latency p50/p95/p99 |
| `intakeMs` | histogram | webhook intake latency p50/p95/p99 |

The metrics object is intentionally **in-memory**: a deployment scrapes it by
attaching the log/export hook (the `/metrics` surface is a documented adapter
point; the default is snapshot-to-log at an operator-chosen interval). No
prompts or secrets are ever recorded. SLO thresholds: [docs/SLOS.md](./SLOS.md).

---

## 3. Health / readiness

| Endpoint | Semantics |
|---|---|
| `GET /health` | Liveness: process up, listener accepts. Always 200 when the process runs. |
| `GET /ready` | Readiness: in queue mode, verifies the queue is reachable (`queue.depth()` succeeds) and returns current depth; 503 with `queue-unavailable` otherwise. Inline mode: 200 `mode: "inline"`. |

Deployments should wire `/health` to the load balancer's health check and
`/ready` to pod-readiness / draining gates (see OPERATIONS_RUNBOOK).

---

## 4. Trace hooks

The App uses per-delivery context (deliveryId) threaded through logs and
metrics; a deployment can pass a tracing hook via `WebhookDeps` (the `deps`
object) to emit OpenTelemetry spans keyed by deliveryId without changing the
request path.

---

## 5. Alert recommendations

| Alert | Threshold | Meaning |
|---|---|---|
| `queueDepth` high | `max > 10_000` sustained 5 min | workers saturated → scale out |
| dead-letter rate | `jobs.deadLettered > 1 %`/hour | GitHub outage or app bug |
| intake p99 | `> 100 ms` over 5 min | intake degraded (DB/disk) |
| rate limit | `rateLimit.lastRemaining < 500` for an installation | throttle concurrency |
| readiness | `503` > 3 consecutive probes | queue/DB unavailable |

---

## 6. CLI

CLI telemetry is **disabled by default**; there is no telemetry at all in the
current CLI. Any future telemetry must be explicit opt-in, privacy-documented,
and covered by this policy. CLI operational logs (`drift doctor --verbose`,
`drift verify`) follow the same no-prompt/no-secret rule.

---

## 7. Privacy regression tests

- `tests/integration/storage-privacy.test.mjs`: raw prompts never enter git
  history, public manifests, PR comments, exports, or default CLI JSON.
- `tests/unit/redact.test.mjs`: public summaries never derive from prompts.
- App tests assert structured-log fields never contain prompt/secret text.
