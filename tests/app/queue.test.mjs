/**
 * Durable webhook queue tests: delivery-id idempotency, claim/ack lifecycle,
 * lease/visibility timeout (crash recovery), retry with backoff, dead-letter,
 * persistence across reopen, and bounded stats. Every adapter (SQLite,
 * memory, and — when DRIFT_TEST_PG_URL is set — Postgres) must behave
 * identically, so the whole suite runs against each one.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const tmpDirs = [];
function freshDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "drift-queue-test-"));
  tmpDirs.push(dir);
  return join(dir, "queue.db");
}

after(() => {
  for (const d of tmpDirs) {
    // Windows may hold SQLite WAL handles briefly after close() — retry
    // instead of failing the whole suite with EPERM.
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 4) throw err;
        // busy: wait and retry
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
});

const payload = { action: "opened", installation: { id: 1 } };

async function run(kind) {
  const { SqliteQueue, MemoryQueue } = await mod("queue.js");
  if (kind === "sqlite") return new SqliteQueue({ path: freshDbPath(), maxAttempts: 3 });
  if (kind === "memory") return new MemoryQueue({ maxAttempts: 3 });
  const { PostgresQueue } = await mod("queue-pg.js");
  return new PostgresQueue({ url: process.env.DRIFT_TEST_PG_URL, maxAttempts: 3 });
}

async function freshPg() {
  // Fresh table per Postgres run so tests never collide across suites.
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: process.env.DRIFT_TEST_PG_URL });
  await pool.query("DROP TABLE IF EXISTS webhook_jobs");
  await pool.end();
}

const kinds = ["sqlite", "memory", ...(process.env.DRIFT_TEST_PG_URL ? ["postgres"] : [])];

for (const kind of kinds) {
  describe(`queue (${kind})`, () => {
    test("enqueue is idempotent per delivery id", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      const first = await q.enqueue("delivery-1", "pull_request", "{}", payload);
      assert.equal(first.accepted, true);
      assert.equal(first.duplicate, false);
      const dup = await q.enqueue("delivery-1", "pull_request", "{}", payload);
      assert.equal(dup.accepted, false);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.alreadyProcessed, false);
      assert.equal(await q.depth(), 1);
      q.close();
    });

    test("enqueue records the tenant (installation id) on the job for DB-level isolation", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("t-1", "pull_request", "{}", { action: "synchronize", installation: { id: 42 } });
      await q.enqueue("t-2", "pull_request", "{}", { action: "synchronize", installation: { id: 7 } });
      await q.enqueue("t-3", "pull_request", "{}", { action: "synchronize" }); // no installation
      const jobs = await q.claim(10, 30_000, "w1");
      const byDelivery = new Map(jobs.map((j) => [j.deliveryId, j]));
      assert.equal(byDelivery.get("t-1").tenantId, "42");
      assert.equal(byDelivery.get("t-2").tenantId, "7");
      assert.equal(byDelivery.get("t-3").tenantId, "");
      for (const j of jobs) await q.ack(j.id, "ok");
      q.close();
    });

    test("claim → ack removes the job from depth and marks it done", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("d-ack", "pull_request", "{}", payload);
      const jobs = await q.claim(10, 30_000, "w1");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "in_progress");
      assert.equal(jobs[0].leaseOwner, "w1");
      assert.ok(jobs[0].leaseUntil > Date.now());
      // in-progress jobs still count toward depth (they are being processed)
      assert.equal(await q.depth(), 1);
      await q.ack(jobs[0].id, "commented");
      assert.equal(await q.depth(), 0);
      const stats = await q.stats();
      assert.equal(stats.done, 1);
      // redelivery after ack is deduplicated and marked alreadyProcessed
      const dup = await q.enqueue("d-ack", "pull_request", "{}", payload);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.alreadyProcessed, true);
      q.close();
    });

    test("lease expiry re-claims an abandoned job (worker crash recovery)", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("d-lease", "pull_request", "{}", payload);
      const [job] = await q.claim(10, 1, "w1"); // 1 ms lease
      assert.equal(job.status, "in_progress");
      await new Promise((r) => setTimeout(r, 10));
      const again = await q.claim(10, 30_000, "w2");
      assert.equal(again.length, 1);
      assert.equal(again[0].id, job.id);
      assert.equal(again[0].leaseOwner, "w2");
      q.close();
    });

    test("nack retries with backoff, dead-letters at maxAttempts", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("d-retry", "pull_request", "{}", payload);
      const [job] = await q.claim(10, 30_000, "w1");
      // attempt 1 fails (backoff 250 ms — a larger margin than connection
      // setup latency, so the not-yet-claimable assertion is deterministic
      // even on a cold/busy CI runner)
      assert.equal(await q.nack(job.id, "transient boom", 250), "retrying");
      assert.equal(job.attempts + 1, 1);
      // not claimable before next_attempt_at
      assert.equal((await q.claim(10, 30_000, "w1")).length, 0);
      await new Promise((r) => setTimeout(r, 320));
      const [job2] = await q.claim(10, 30_000, "w1");
      assert.equal(job2.id, job.id);
      // attempt 2 fails → 3 max attempts → attempt 3 = dead
      assert.equal(await q.nack(job2.id, "transient boom", 0), "retrying");
      const [job3] = await q.claim(10, 30_000, "w1");
      assert.equal(await q.nack(job3.id, "transient boom", 0), "dead");
      const stats = await q.stats();
      assert.equal(stats.dead, 1);
      assert.equal(await q.depth(), 0);
      q.close();
    });

    test("deadLetter marks a job dead explicitly", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("d-dead", "pull_request", "{}", payload);
      const [job] = await q.claim(10, 30_000, "w1");
      await q.deadLetter(job.id, "permanent failure");
      assert.equal((await q.stats()).dead, 1);
      // dead jobs are never re-claimed
      assert.equal((await q.claim(10, 30_000, "w1")).length, 0);
      q.close();
    });

    test("purgeDone removes only old done jobs", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await q.enqueue("d-purge", "pull_request", "{}", payload);
      const [job] = await q.claim(10, 30_000, "w1");
      await q.ack(job.id, "ok");
      // Ensure `updated_at` is strictly older than the purge cutoff (same-ms
      // timing would leave the row in place).
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(await q.purgeDone(0), 1);
      assert.equal((await q.stats()).total, 0);
      q.close();
    });

    test("backoff is bounded and random (full jitter)", async () => {
      const { backoffMs } = await mod("queue.js");
      for (let i = 0; i < 50; i++) {
        const b = backoffMs(i % 8, 1000, 60_000);
        assert.ok(b >= 0 && b <= 60_000, `backoff out of range: ${b}`);
      }
      // attempt 0 → [0, base]
      const early = backoffMs(0, 1000, 60_000);
      assert.ok(early <= 1000, `attempt 0 backoff ${early} exceeds base`);
    });

    test("queue persists across reopen", async () => {
      if (kind === "postgres") await freshPg();
      const { SqliteQueue } = await mod("queue.js");
      const path = freshDbPath();
      const q1 = new SqliteQueue({ path, maxAttempts: 3 });
      await q1.enqueue("d-persist", "pull_request", "{}", payload);
      const [job] = await q1.claim(10, 30_000, "w1");
      await q1.nack(job.id, "transient", 5);
      q1.close();
      const q2 = new SqliteQueue({ path, maxAttempts: 3 });
      assert.equal(await q2.depth(), 1, "job must survive a close/reopen");
      assert.equal((await q2.stats()).total, 1);
      // The job was nacked with a retry backoff, so it is pending but not due
      // yet — persistence is proven by depth/stats; the claim happens after
      // the retry window elapses.
      await new Promise((r) => setTimeout(r, 20));
      const jobs = await q2.claim(10, 30_000, "w2");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].deliveryId, "d-persist");
      q2.close();
    });

    test("rejects empty delivery ids", async () => {
      if (kind === "postgres") await freshPg();
      const q = await run(kind);
      await assert.rejects(() => q.enqueue("", "pull_request", "{}", payload));
      q.close();
    });
  });
}

// ------------------------------------------------------------------ Postgres
// Multi-instance behavior: two SEPARATE queue objects (as two replicas or two
// worker processes would construct) share one Postgres database without
// double-claiming or losing jobs.

describe("postgres queue: multi-instance claim safety", { skip: !process.env.DRIFT_TEST_PG_URL }, () => {
  test("two instances never double-claim and both drain the same jobs", async () => {
    const { PostgresQueue } = await mod("queue-pg.js");
    const url = process.env.DRIFT_TEST_PG_URL;
    await freshPg();
    const q1 = new PostgresQueue({ url, maxAttempts: 3 });
    const q2 = new PostgresQueue({ url, maxAttempts: 3 });
    for (let i = 0; i < 20; i++) {
      await q1.enqueue(`multi-${i}`, "pull_request", "{}", payload);
    }
    const seen = new Set();
    const claims = [];
    // Both instances claim from the same table; with concurrency the union
    // of claimed ids must be exactly the 20 jobs and each id must appear
    // exactly once (SKIP LOCKED prevents double-claim).
    for (let round = 0; round < 5; round++) {
      const [a, b] = await Promise.all([q1.claim(10, 30_000, "inst1"), q2.claim(10, 30_000, "inst2")]);
      for (const job of [...a, ...b]) {
        assert.ok(!seen.has(job.id), `job ${job.id} double-claimed`);
        seen.add(job.id);
        claims.push(job);
        await q1.ack(job.id, "ok");
      }
    }
    assert.equal(claims.length, 20, "all jobs claimed exactly once");
    assert.equal((await q1.stats()).done, 20);
    q1.close();
    q2.close();
  });

  test("postgres lease expiry lets another instance re-claim a crashed job", async () => {
    const { PostgresQueue } = await mod("queue-pg.js");
    const url = process.env.DRIFT_TEST_PG_URL;
    await freshPg();
    const q1 = new PostgresQueue({ url, maxAttempts: 3 });
    await q1.enqueue("crash-reclaim", "pull_request", "{}", payload);
    const [job] = await q1.claim(10, 1, "inst1"); // 1 ms lease
    await new Promise((r) => setTimeout(r, 15));
    const q2 = new PostgresQueue({ url, maxAttempts: 3 });
    const again = await q2.claim(10, 30_000, "inst2");
    assert.equal(again.length, 1);
    assert.equal(again[0].id, job.id, "expired lease must be re-claimable by another instance");
    await q2.ack(again[0].id, "recovered");
    assert.equal((await q2.stats()).done, 1);
    q1.close();
    q2.close();
  });

  test("SQLite → Postgres migration copies every job state with matching counts", async () => {
    const { SqliteQueue, MemoryQueue: _mem } = await mod("queue.js");
    const { PostgresQueue } = await mod("queue-pg.js");
    const url = process.env.DRIFT_TEST_PG_URL;
    await freshPg();

    // Build a source SQLite queue with jobs in every lifecycle state.
    const dir = mkdtempSync(join(tmpdir(), "drift-queue-migrate-"));
    const src = new SqliteQueue({ path: join(dir, "queue.db"), maxAttempts: 3 });
    // NOTE: claim(batchSize) with a batch > 1 would claim ALL eligible jobs,
    // so each lifecycle state is built with its own batch-1 claim.
    await src.enqueue("mig-done", "pull_request", "{}", { n: 2 });
    const doneJob = (await src.claim(1, 30_000, "w1"))[0];
    assert.equal(doneJob.deliveryId, "mig-done");
    await src.ack(doneJob.id, "ok");
    await src.enqueue("mig-dead", "pull_request", "{}", { n: 3 });
    const deadJob = (await src.claim(1, 30_000, "w1"))[0];
    assert.equal(deadJob.deliveryId, "mig-dead");
    await src.deadLetter(deadJob.id, "permanent");
    // An in_progress job with an EXPIRED lease (crashed worker) must migrate
    // as in_progress and become re-claimable on the target.
    await src.enqueue("mig-inflight", "pull_request", "{}", { n: 4 });
    const inflight = (await src.claim(1, 1, "w1"))[0]; // 1 ms lease
    assert.equal(inflight.deliveryId, "mig-inflight");
    await src.enqueue("mig-pending", "pull_request", "{}", { n: 1 });
    const srcStats = await src.stats();
    assert.deepEqual(
      { pending: srcStats.pending, inProgress: srcStats.inProgress, done: srcStats.done, dead: srcStats.dead },
      { pending: 1, inProgress: 1, done: 1, dead: 1 },
    );
    src.close();

    // Run the actual migration script (idempotent, ON CONFLICT DO NOTHING).
    const script = resolve(process.cwd(), "scripts", "migrate-queue-sqlite-to-pg.mjs");
    const res = spawnSync(process.execPath, [script, "--sqlite", join(dir, "queue.db"), "--pg", url], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(res.status, 0, `migration failed: ${res.stderr}`);
    // Idempotent: re-running must not duplicate rows.
    const res2 = spawnSync(process.execPath, [script, "--sqlite", join(dir, "queue.db"), "--pg", url], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(res2.status, 0, `re-run failed: ${res2.stderr}`);

    // The target honors the migrated state exactly.
    const tgt = new PostgresQueue({ url, maxAttempts: 3 });
    const tgtStats = await tgt.stats();
    assert.deepEqual(
      { pending: tgtStats.pending, inProgress: tgtStats.inProgress, done: tgtStats.done, dead: tgtStats.dead },
      { pending: 1, inProgress: 1, done: 1, dead: 1 },
      "migrated counts must match the source exactly",
    );
    // Both the pending job and the expired-lease in-flight job are claimable
    // on Postgres; the expired-lease job proves crash recovery across adapters.
    const reclaimed = await tgt.claim(10, 30_000, "new-instance");
    assert.equal(reclaimed.length, 2, "pending + expired-lease jobs both claimable");
    const reclaimedInflight = reclaimed.find((j) => j.deliveryId === "mig-inflight");
    assert.ok(reclaimedInflight, "expired-lease in-flight job is re-claimable (crash recovery)");
    await tgt.ack(reclaimedInflight.id, "recovered");
    // The done/dead rows are untouched; dedupe still works after migration.
    const dup = await tgt.enqueue("mig-done", "pull_request", "{}", { n: 2 });
    assert.equal(dup.duplicate, true);
    assert.equal(dup.alreadyProcessed, true);
    tgt.close();
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  test("migration is crash-safe: an interrupted partial copy converges on re-run (no dupes, no loss)", async () => {
    const { SqliteQueue } = await mod("queue.js");
    const { PostgresQueue } = await mod("queue-pg.js");
    const url = process.env.DRIFT_TEST_PG_URL;
    await freshPg();

    // A source queue with N jobs spanning all lifecycle states.
    const dir = mkdtempSync(join(tmpdir(), "drift-queue-crash-"));
    const src = new SqliteQueue({ path: join(dir, "queue.db"), maxAttempts: 3 });
    const N = 60;
    for (let i = 0; i < N; i++) {
      await src.enqueue(`crash-${i}`, "pull_request", "{}", { n: i, installation: { id: (i % 3) + 1 } });
    }
    // Move a third of them through claim → ack/dead to mix states.
    const batch = await src.claim(20, 30_000, "w1");
    for (const [idx, j] of batch.entries()) {
      if (idx % 2 === 0) await src.ack(j.id, "ok");
      else await src.deadLetter(j.id, "permanent");
    }
    src.close();

    // Simulate a migration process KILLED midway: copy only the first half of
    // the rows to Postgres directly (the crash left a partial table).
    const { DatabaseSync } = await import("node:sqlite");
    const read = new DatabaseSync(join(dir, "queue.db"), { readOnly: true });
    const rows = read.prepare("SELECT * FROM webhook_jobs ORDER BY id").all();
    read.close();
    const cols = Object.keys(rows[0]);
    const half = rows.slice(0, Math.floor(rows.length / 2));
    const pool = new (await import("pg")).Pool({ connectionString: url });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_jobs (
        id BIGSERIAL PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL, raw_body TEXT NOT NULL, signature TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
        next_attempt_at BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0,
        lease_owner TEXT NOT NULL DEFAULT '', last_error TEXT, last_result TEXT,
        created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, tenant_id TEXT NOT NULL DEFAULT ''
      );
    `);
    for (const r of half) {
      await pool.query(
        `INSERT INTO webhook_jobs (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT (delivery_id) DO NOTHING`,
        cols.map((c) => r[c]),
      );
    }
    await pool.end();

    // Re-run the real migration over the partial table: it must fill the
    // missing rows, keep the copied ones (idempotent), and converge to the
    // source counts exactly.
    const script = resolve(process.cwd(), "scripts", "migrate-queue-sqlite-to-pg.mjs");
    const res = spawnSync(process.execPath, [script, "--sqlite", join(dir, "queue.db"), "--pg", url], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(res.status, 0, `resume migration failed: ${res.stderr}`);
    const res2 = spawnSync(process.execPath, [script, "--sqlite", join(dir, "queue.db"), "--pg", url], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(res2.status, 0, `re-run after resume failed: ${res2.stderr}`);

    const tgt = new PostgresQueue({ url, maxAttempts: 3 });
    const tgtStats = await tgt.stats();
    const srcStats = new SqliteQueue({ path: join(dir, "queue.db"), maxAttempts: 3 });
    const s = await srcStats.stats();
    srcStats.close();
    assert.equal(tgtStats.total, s.total, "target total equals source total (no dupes, no loss)");
    assert.equal(tgtStats.pending, s.pending);
    assert.equal(tgtStats.inProgress, s.inProgress);
    assert.equal(tgtStats.done, s.done);
    assert.equal(tgtStats.dead, s.dead);
    tgt.close();
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });

  test("postgres queue: per-tenant DB queries never cross tenants; tenant index exists", async () => {
    const { PostgresQueue } = await mod("queue-pg.js");
    const { Pool } = await import("pg");
    const url = process.env.DRIFT_TEST_PG_URL;
    await freshPg();
    const q = new PostgresQueue({ url, maxAttempts: 3 });
    for (let i = 0; i < 30; i++) {
      await q.enqueue(`pt-${i}`, "pull_request", "{}", { action: "synchronize", installation: { id: (i % 2) + 1 } });
    }
    const pool = new Pool({ connectionString: url });
    const tenant1 = await pool.query("SELECT COUNT(*) AS n FROM webhook_jobs WHERE tenant_id = '1'");
    const tenant2 = await pool.query("SELECT COUNT(*) AS n FROM webhook_jobs WHERE tenant_id = '2'");
    assert.equal(Number(tenant1.rows[0].n), 15);
    assert.equal(Number(tenant2.rows[0].n), 15);
    const index = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'webhook_jobs' AND indexname = 'idx_webhook_jobs_tenant'`,
    );
    assert.equal(index.rows.length, 1, "tenant index must exist");
    const unique = await pool.query(
      `SELECT COUNT(*) AS n FROM pg_indexes WHERE tablename = 'webhook_jobs' AND indexdef ILIKE '%delivery_id%'`,
    );
    assert.ok(Number(unique.rows[0].n) >= 1, "UNIQUE(delivery_id) constraint must exist");
    await pool.end();
    q.close();
  });
});

test("sqlite queue: an old-schema DB (no tenant_id) opens and upgrades in place", async () => {
  const { SqliteQueue } = await mod("queue.js");
  const dir = mkdtempSync(join(tmpdir(), "drift-queue-upgrade-"));
  const path = join(dir, "queue.db");
  // Create a DB with the PRE-tenant_id schema (as shipped before the column).
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE webhook_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      delivery_id TEXT NOT NULL UNIQUE,
      event TEXT NOT NULL,
      raw_body TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 8,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT NOT NULL DEFAULT '',
      last_error TEXT,
      last_result TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO webhook_jobs (delivery_id, event, raw_body, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    "legacy-1",
    "pull_request",
    "{}",
    "{}",
    Date.now(),
    Date.now(),
  );
  db.close();

  // Opening with the current adapter must add the column and keep the row.
  const q = new SqliteQueue({ path, maxAttempts: 3 });
  const stats = await q.stats();
  assert.equal(stats.total, 1, "legacy row survives the upgrade");
  const jobs = await q.claim(10, 30_000, "w1");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].deliveryId, "legacy-1");
  assert.equal(jobs[0].tenantId, "", "legacy rows default to empty tenant");
  await q.ack(jobs[0].id, "ok");
  q.close();
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});
