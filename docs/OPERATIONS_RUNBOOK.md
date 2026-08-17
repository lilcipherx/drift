# Operations Runbook

Operational procedures for the Drift GitHub App and CLI. Companion documents:
[DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md), [OBSERVABILITY.md](./OBSERVABILITY.md),
[SLOS.md](./SLOS.md), [CAPACITY_MODEL.md](./CAPACITY_MODEL.md).

---

## 1. Topology

```
GitHub webhooks ──► [stateless HTTP replicas]
                        │  POST /webhook: HMAC → delivery-id idempotency →
                        │  JSON parse → durable enqueue → 2xx
                        ▼
              [durable queue (queue.db, SQLite/WAL per node,
               or a shared production adapter)]
                        │  claim/lease
                        ▼
              [workers: bounded concurrency, backoff+jitter,
               dead-letter, per-installation rate-limit awareness]
                        │  GitHub API (installation tokens)
                        ▼
              Check Run + idempotent PR comments
```

- The default deployment is **single-node** (SQLite queue co-located with
  replicas + workers). This is the documented, tested configuration.
- **Horizontal scale** uses the shared-queue production adapter
  **`PostgresQueue`** (`DRIFT_APP_QUEUE=postgres` + `DRIFT_QUEUE_URL`): any
  number of replicas/workers across hosts claim from one Postgres database
  (`SELECT … FOR UPDATE SKIP LOCKED`) with identical semantics. Verified in
  CI (`queue-postgres` job: full suite + e2e incl. multi-instance + soak
  against Postgres 16). See §5 for the migration procedure.

## 2. Deployment

### Env contract (`packages/drift-app/src/index.ts`)

| Env | Required | Notes |
|---|---|---|
| `GITHUB_WEBHOOK_SECRET` | yes (prod) | HMAC secret; server refuses to start without it unless `DRIFT_APP_INSECURE_DEV_MODE=true` (dev only, loud warning). |
| `GITHUB_APP_ID` | yes | numeric App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | PEM; must match the App ID. Never log it. |
| `DRIFT_APP_PORT` | no | default 8787 |
| `DRIFT_APP_QUEUE` | no | `sqlite` (default) \| `postgres` \| `memory` \| `inline` |
| `DRIFT_QUEUE_URL` | when `DRIFT_APP_QUEUE=postgres` | `postgres://…` connection URL (never log it) |
| `DRIFT_APP_QUEUE_PATH` | no | queue.db path (default `./.drift-app-data/queue.db`) |
| `DRIFT_APP_CONCURRENCY` | no | worker concurrency (default 4) |
| `DRIFT_APP_INSECURE_DEV_MODE` | no | exactly `"true"` skips HMAC (dev only) |

### Rollout

1. Build: `npm ci --no-audit --no-fund && npm run build`.
2. Smoke: `bash scripts/verify-app-start.sh` (starts the server, exercises
   `/health`, `/ready`, rejects unsigned webhooks).
3. Start replicas behind a load balancer; wire `/health` to LB checks.
4. Verify `POST /webhook` with a real delivery (GitHub → "Redeliver") and
   confirm intake latency + Check Run creation.

## 3. Day-2 operations

| Task | Procedure |
|---|---|
| Check health | `curl -s localhost:PORT/health` → 200 |
| Check readiness | `curl -s localhost:PORT/ready` → 200 + queueDepth |
| Inspect queue | `SELECT status, COUNT(*) FROM webhook_jobs GROUP BY status;` (same SQL on SQLite or Postgres) |
| Inspect dead letters | `SELECT * FROM webhook_jobs WHERE status='dead' ORDER BY updated_at DESC LIMIT 20;` |
| Replay a dead job | mark back to pending: `UPDATE webhook_jobs SET status='pending', attempts=0, next_attempt_at=0 WHERE id=?;` (operator review first) |
| Scale workers | raise `DRIFT_APP_CONCURRENCY`; add replicas (set `DRIFT_APP_QUEUE=postgres` for >1 replica) |
| Rotate webhook secret | set new secret on all replicas, update GitHub App settings, restart, redeliver a test delivery |
| Rotate App private key | new key in GitHub App settings, update env, restart; old key no longer valid |

## 4. Incidents

### 4.1 Queue backs up (queueDepth rising)

1. Check GitHub API health + `rateLimit.lastRemaining` (per-installation
   429s are expected and self-heal with backoff).
2. If 429-driven: wait; backoff is automatic. If queue still grows >10k,
   scale workers/replicas (shared queue).
3. Do NOT delete queued jobs — the delivery-id dedupe means redelivering is
   safe, but jobs should be drained, not dropped.

### 4.2 Dead letters spike

1. Inspect `last_error` on dead rows; group by error code.
2. GitHub outage → nothing to do; after recovery, replay dead jobs.
3. App bug → deploy fix, then replay.

### 4.3 Webhook intake degraded (intake p99 > 100 ms)

1. Check disk/IO on the queue DB (WAL checkpoint lag).
2. Check replica CPU (HMAC+JSON is cheap; saturation indicates misconfig).
3. `DRIFT_APP_INSECURE_DEV_MODE` must be unset in production — verify.

### 4.4 Data loss question

The zero-loss objective: a delivery accepted with 2xx is either audited or
eventually dead-lettered (never silently dropped). Recovery of accepted-but-
lost work uses the durable queue + delivery-id dedupe; see DISASTER_RECOVERY.

## 5. Migrating to the shared Postgres queue (production horizontal scale)

1. Provision Postgres (managed or self-hosted) and set
   `DRIFT_APP_QUEUE=postgres` + `DRIFT_QUEUE_URL` on every replica/worker.
   The schema is created automatically (idempotent `CREATE TABLE IF NOT
   EXISTS` + indexes) on first use.
2. Contract tests: the entire `tests/app/queue.test.mjs` suite runs against
   every adapter, so `PostgresQueue` passes the same suite as SQLite
   (including the multi-instance claim-safety tests).
3. Verify: `node scripts/bench-app-e2e.mjs --scenario all --pg <url>`
   (includes the two-server/two-pool multi-instance scenario) and
   `node scripts/soak-app.mjs --jobs 5000 --pg <url>`.
4. Rollback: the webhook server is adapter-agnostic; switching back to the
   SQLite adapter requires draining the shared queue first (or accepting
   redelivery, which the dedupe handles).

## 6. CLI operations

| Task | Procedure |
|---|---|
| Repair local state | `drift doctor` → `drift doctor --fix` (orphans, committed-but-db-missing) |
| Rebuild the manifest index | automatic (stat-validated); force rebuild: delete `.drift/drift.db` and run `drift init` (keeps public provenance) |
| Corrupt drift.db | `git clean -fdx .drift` + `drift init` — public provenance survives (ADR-009) |
| Key import | `drift key import --file <path>` (must match an ACTIVE keyring key or the legacy trust root) |
| Keyring operations | `drift keyring init\|add\|revoke\|remove\|list` (see docs/MULTI_SIGNER.md) |
