/**
 * Worker tests: transient retry → success, permanent failure acked without
 * retry, bounded concurrency, graceful stop waiting for in-flight jobs, and
 * lease expiry re-claiming (crash recovery). Uses a controlled `process`
 * function with the MemoryQueue for deterministic timing.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setup() {
  const { MemoryQueue } = await mod("queue.js");
  const { Worker } = await mod("worker.js");
  const queue = new MemoryQueue({ maxAttempts: 5 });
  return { queue, Worker };
}

test("worker processes a job and acks it", async () => {
  const { queue, Worker } = await setup();
  const processed = [];
  const worker = new Worker({
    queue,
    process: async (job) => {
      processed.push(job.deliveryId);
      return { terminal: true, ok: true, durationMs: 1 };
    },
    pollIntervalMs: 10,
  });
  worker.start();
  queue.enqueue("d-1", "pull_request", "{}", { action: "opened" });
  const deadline = Date.now() + 3000;
  while (queue.stats().done < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 1);
  assert.deepEqual(processed, ["d-1"]);
  await worker.stop();
  queue.close();
});

test("transient failure is retried then succeeds", async () => {
  const { queue, Worker } = await setup();
  let calls = 0;
  const worker = new Worker({
    queue,
    process: async (job) => {
      calls++;
      if (calls < 3) return { terminal: false, ok: false, error: "transient", errorCode: "transient", durationMs: 1 };
      return { terminal: true, ok: true, durationMs: 1 };
    },
    pollIntervalMs: 10,
    baseBackoffMs: 0, // deterministic: no wait between retries
  });
  worker.start();
  queue.enqueue("d-retry", "pull_request", "{}", {});
  const deadline = Date.now() + 5000;
  while (queue.stats().done < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 1, "job should eventually be processed");
  assert.ok(calls >= 3, `expected >=3 calls, got ${calls}`);
  await worker.stop();
  queue.close();
});

test("permanent failure is acked (terminal) without retry", async () => {
  const { queue, Worker } = await setup();
  let calls = 0;
  const worker = new Worker({
    queue,
    process: async () => {
      calls++;
      return { terminal: true, ok: false, errorCode: "permanent", error: "nope", durationMs: 1 };
    },
    pollIntervalMs: 10,
  });
  worker.start();
  queue.enqueue("d-perm", "pull_request", "{}", {});
  const deadline = Date.now() + 3000;
  while (queue.stats().done < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 1);
  assert.equal(calls, 1, "permanent failures must not be retried");
  await worker.stop();
  queue.close();
});

test("repeated transient failures dead-letter at maxAttempts", async () => {
  const { queue, Worker } = await setup();
  const worker = new Worker({
    queue,
    process: async () => ({ terminal: false, ok: false, error: "always", errorCode: "transient", durationMs: 1 }),
    pollIntervalMs: 10,
    baseBackoffMs: 0,
  });
  worker.start();
  queue.enqueue("d-dead", "pull_request", "{}", {});
  const deadline = Date.now() + 5000;
  while (queue.stats().dead < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().dead, 1, "job should be dead-lettered");
  assert.equal(queue.depth(), 0);
  await worker.stop();
  queue.close();
});

test("bounded concurrency: at most N jobs in flight", async () => {
  const { queue, Worker } = await setup();
  let inFlight = 0;
  let maxInFlight = 0;
  const worker = new Worker({
    queue,
    concurrency: 2,
    process: async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(30);
      inFlight--;
      return { terminal: true, ok: true, durationMs: 30 };
    },
    pollIntervalMs: 10,
  });
  worker.start();
  for (let i = 0; i < 6; i++) queue.enqueue(`d-${i}`, "pull_request", "{}", {});
  const deadline = Date.now() + 5000;
  while (queue.stats().done < 6 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 6);
  assert.ok(maxInFlight <= 2, `max concurrency was ${maxInFlight}`);
  await worker.stop();
  queue.close();
});

test("graceful stop waits for in-flight jobs", async () => {
  const { queue, Worker } = await setup();
  let finished = false;
  const worker = new Worker({
    queue,
    concurrency: 1,
    process: async () => {
      await sleep(100);
      finished = true;
      return { terminal: true, ok: true, durationMs: 100 };
    },
    pollIntervalMs: 10,
  });
  worker.start();
  queue.enqueue("d-slow", "pull_request", "{}", {});
  await sleep(30); // let the worker claim it
  assert.equal(worker.busy, 1);
  await worker.stop();
  assert.equal(finished, true, "in-flight job must finish during graceful stop");
  queue.close();
});

test("lease expiry: crashed worker's job is re-claimed and processed", async () => {
  const { queue, Worker } = await setup();
  const attempts = [];
  const worker = new Worker({
    queue,
    process: async (job) => {
      attempts.push(job.attempts);
      return { terminal: true, ok: true, durationMs: 1 };
    },
    pollIntervalMs: 10,
    leaseMs: 30, // very short lease simulates a crashed worker
  });
  worker.start();
  queue.enqueue("d-crash", "pull_request", "{}", {});
  const deadline = Date.now() + 5000;
  while (queue.stats().done < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 1);
  await worker.stop();
  queue.close();
});

test("worker never processes the same delivery id twice", async () => {
  const { queue, Worker } = await setup();
  const seen = [];
  const worker = new Worker({
    queue,
    process: async (job) => {
      seen.push(job.deliveryId);
      return { terminal: true, ok: true, durationMs: 1 };
    },
    pollIntervalMs: 10,
  });
  worker.start();
  // Simulate GitHub redelivery + concurrent fan-out: three enqueues of the
  // same delivery id must collapse into one job.
  const a = queue.enqueue("d-same", "pull_request", "{}", {});
  const b = queue.enqueue("d-same", "pull_request", "{}", {});
  const c = queue.enqueue("d-same", "pull_request", "{}", {});
  assert.equal(a.accepted, true);
  assert.equal(b.duplicate, true);
  assert.equal(c.duplicate, true);
  const deadline = Date.now() + 3000;
  while (queue.stats().done < 1 && Date.now() < deadline) await sleep(10);
  assert.equal(queue.stats().done, 1);
  assert.equal(seen.filter((d) => d === "d-same").length, 1);
  await worker.stop();
  queue.close();
});
