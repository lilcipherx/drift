# Disaster Recovery

Recovery procedures for every transaction boundary. Companion:
[OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md). Tested behaviors are noted
with their test files; anything marked *procedure* is operator-driven and
must be rehearsed.

---

## 1. Crash-consistency map (tested)

| Boundary | Behavior | Test |
|---|---|---|
| App killed mid-webhook (before enqueue) | No job; GitHub redelivers; dedupe is safe | `tests/app/abort-live.test.mjs` |
| App killed after enqueue, before audit | Durable job; re-claimed after lease expiry | `tests/app/queue.test.mjs` (persistence) |
| Worker killed mid-audit | Lease (visibility timeout) expires → re-claim | `tests/app/worker.test.mjs` (lease) |
| Server closed with in-flight requests | Graceful: drains in-flight, force-closes stragglers | `tests/app/shutdown-live.test.mjs` |
| CLI killed before manifest write | No partial manifest; index untouched | atomic `writeFileSync` replace pattern |
| CLI killed after manifest write, before commit | New manifest present; `git status` shows it; `drift doctor` reports; next realize/`doctor --fix` recovers | `tests/integration/merge-blockers.test.mjs` |
| CLI killed during staging/commit | `git commit` atomicity; index snapshot restore on failure | PR7 immutable-head rollback audit |
| Commit lands but DB write fails | Manifest + trailer committed; `drift doctor` reindexes (`committed-but-db-missing` is recoverable, never auto-deleted) | `engine.ts` doctor |
| Concurrent `drift realize` | SQLite WAL + busy_timeout; git index snapshot per operation | concurrency tests |

## 2. Backup

| Artifact | Frequency | Method |
|---|---|---|
| App queue DB | continuous (WAL) | SQLite WAL + nightly `VACUUM INTO` / file copy after `PRAGMA wal_checkpoint(FULL)` |
| App config/keys | secret rotation | encrypted secret store (never git) |
| Repo public provenance | inherently backed up | git history IS the backup (manifests + trailers committed atomically) |
| CLI private store | optional | `.drift/drift.db` copy; loss is non-fatal (public provenance reindexes via `drift doctor`) |

## 3. Restore

### 3.1 App queue DB

1. Stop replicas.
2. Restore `queue.db` (+ `-wal`/`-shm` if present) from backup.
3. Start replicas; `/ready` verifies the queue opens.
4. Any deliveries lost between backup and restore are recovered via GitHub
   webhook redelivery (dedupe makes replay safe).

### 3.2 Corrupted CLI store

`drift doctor` reports corruption with a clear remediation. Full reset:
`git clean -fdx .drift` + `drift init` — the committed public manifests and
trust root are preserved byte-for-byte (fresh-clone state), and `drift doctor`
reindexes the local store. **Never** delete `.drift/public/` (the provenance).

### 3.3 Key loss

The signing key is the only irreplaceable secret (`.drift/keys/ed25519.pem`,
local). If lost:
- The repo enters read-only signer mode (public key stays; signatures remain
  verifiable).
- Generate a new key and **explicitly** rotate the trust root (single-signer
  rotation is a controlled operation; see ADR-009 and RELEASE_READINESS).
- All existing intents remain valid (their signatures verify against the
  OLD key, which is why rotation must keep the old key as a secondary trust
  root or re-sign — documented limitation; multi-signer keyring is the
  planned extension).

## 4. Migration / rollback

| Scenario | Procedure |
|---|---|
| Schema migration | SQLite migrations are additive (`CREATE TABLE IF NOT EXISTS`, versioned meta). Roll back = restore pre-migration DB from backup. |
| Partial migration | Migration runs inside one transaction; failure rolls back the transaction (no partial schema). |
| App version rollback | Deploy previous artifact; queue schema is backward-compatible (additive); dead-letter replay after rollback is safe. |
| CLI downgrade | Newer public manifests may use a schema version the old CLI rejects — check `schemaVersion` support before downgrade; V1/V2 manifests are read as-is. |

## 5. Recovery drill (runbook)

1. Kill a worker mid-audit (`kill -9`): job re-claimed after lease; assert
   Check Run eventually created once. (Covered by lease test; rehearse with a
   real delivery.)
2. Kill the app process during a burst: restart; queue drains; dedupe absorbs
   redeliveries.
3. Corrupt `queue.db` by hand: `/ready` returns 503; restore from backup;
   verify.
4. Corrupt `.drift/drift.db` in a dev repo: `drift doctor` → reset → reindex;
   public provenance intact.

## 6. Incident communication

- Record: deliveryId, op, errorCode, durationMs (structured logs).
- Postmortem: root cause, blast radius (queue depth, dead-letter count),
  data-loss check (zero-loss objective: every 2xx accepted delivery is
  audited or dead-lettered), preventive controls.
