/**
 * Durable webhook queue tests: delivery-id idempotency, claim/ack lifecycle,
 * lease/visibility timeout (crash recovery), retry with backoff, dead-letter,
 * persistence across reopen, and bounded stats. Both adapters (SQLite and
 * memory) must behave identically.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
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

async function run(adapterFactory) {
  const { SqliteQueue, MemoryQueue } = await mod("queue.js");
  return adapterFactory === "sqlite" ? new SqliteQueue({ path: freshDbPath(), maxAttempts: 3 }) : new MemoryQueue({ maxAttempts: 3 });
}

for (const kind of ["sqlite", "memory"]) {
  describe(`queue (${kind})`, () => {
    test("enqueue is idempotent per delivery id", async () => {
      const q = await run(kind);
      const first = q.enqueue("delivery-1", "pull_request", "{}", payload);
      assert.equal(first.accepted, true);
      assert.equal(first.duplicate, false);
      const dup = q.enqueue("delivery-1", "pull_request", "{}", payload);
      assert.equal(dup.accepted, false);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.alreadyProcessed, false);
      assert.equal(q.depth(), 1);
      q.close();
    });

    test("claim → ack removes the job from depth and marks it done", async () => {
      const q = await run(kind);
      q.enqueue("d-ack", "pull_request", "{}", payload);
      const jobs = q.claim(10, 30_000, "w1");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].status, "in_progress");
      assert.equal(jobs[0].leaseOwner, "w1");
      assert.ok(jobs[0].leaseUntil > Date.now());
      // in-progress jobs still count toward depth (they are being processed)
      assert.equal(q.depth(), 1);
      q.ack(jobs[0].id, "commented");
      assert.equal(q.depth(), 0);
      const stats = q.stats();
      assert.equal(stats.done, 1);
      // redelivery after ack is deduplicated and marked alreadyProcessed
      const dup = q.enqueue("d-ack", "pull_request", "{}", payload);
      assert.equal(dup.duplicate, true);
      assert.equal(dup.alreadyProcessed, true);
      q.close();
    });

    test("lease expiry re-claims an abandoned job (worker crash recovery)", async () => {
      const q = await run(kind);
      q.enqueue("d-lease", "pull_request", "{}", payload);
      const [job] = q.claim(10, 1, "w1"); // 1 ms lease
      assert.equal(job.status, "in_progress");
      await new Promise((r) => setTimeout(r, 10));
      const again = q.claim(10, 30_000, "w2");
      assert.equal(again.length, 1);
      assert.equal(again[0].id, job.id);
      assert.equal(again[0].leaseOwner, "w2");
      q.close();
    });

    test("nack retries with backoff, dead-letters at maxAttempts", async () => {
      const q = await run(kind);
      q.enqueue("d-retry", "pull_request", "{}", payload);
      const [job] = q.claim(10, 30_000, "w1");
      // attempt 1 fails
      assert.equal(q.nack(job.id, "transient boom", 5), "retrying");
      assert.equal(job.attempts + 1, 1);
      // not claimable before next_attempt_at
      assert.equal(q.claim(10, 30_000, "w1").length, 0);
      await new Promise((r) => setTimeout(r, 15));
      const [job2] = q.claim(10, 30_000, "w1");
      assert.equal(job2.id, job.id);
      // attempt 2 fails → 3 max attempts → attempt 3 = dead
      assert.equal(q.nack(job2.id, "transient boom", 0), "retrying");
      const [job3] = q.claim(10, 30_000, "w1");
      assert.equal(q.nack(job3.id, "transient boom", 0), "dead");
      const stats = q.stats();
      assert.equal(stats.dead, 1);
      assert.equal(q.depth(), 0);
      q.close();
    });

    test("deadLetter marks a job dead explicitly", async () => {
      const q = await run(kind);
      q.enqueue("d-dead", "pull_request", "{}", payload);
      const [job] = q.claim(10, 30_000, "w1");
      q.deadLetter(job.id, "permanent failure");
      assert.equal(q.stats().dead, 1);
      // dead jobs are never re-claimed
      assert.equal(q.claim(10, 30_000, "w1").length, 0);
      q.close();
    });

    test("purgeDone removes only old done jobs", async () => {
      const q = await run(kind);
      q.enqueue("d-purge", "pull_request", "{}", payload);
      const [job] = q.claim(10, 30_000, "w1");
      q.ack(job.id, "ok");
      // Ensure `updated_at` is strictly older than the purge cutoff (same-ms
      // timing would leave the row in place).
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(q.purgeDone(0), 1);
      assert.equal(q.stats().total, 0);
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

    test("sqlite queue persists across reopen", async () => {
      const { SqliteQueue } = await mod("queue.js");
      const path = freshDbPath();
      const q1 = new SqliteQueue({ path, maxAttempts: 3 });
      q1.enqueue("d-persist", "pull_request", "{}", payload);
      const [job] = q1.claim(10, 30_000, "w1");
      q1.nack(job.id, "transient", 5);
      q1.close();
      const q2 = new SqliteQueue({ path, maxAttempts: 3 });
      assert.equal(q2.depth(), 1, "job must survive a close/reopen");
      assert.equal(q2.stats().total, 1);
      // The job was nacked with a retry backoff, so it is pending but not due
      // yet — persistence is proven by depth/stats; the claim happens after
      // the retry window elapses.
      await new Promise((r) => setTimeout(r, 20));
      const jobs = q2.claim(10, 30_000, "w2");
      assert.equal(jobs.length, 1);
      assert.equal(jobs[0].deliveryId, "d-persist");
      q2.close();
    });

    test("rejects empty delivery ids", async () => {
      const q = await run(kind);
      assert.throws(() => q.enqueue("", "pull_request", "{}", payload));
      q.close();
    });
  });
}
