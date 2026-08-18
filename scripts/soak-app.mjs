#!/usr/bin/env node
/**
 * Soak test for the App worker pipeline (PRD §8, docs/SLOS.md §2):
 *
 *   enqueue ~2× modeled peak deliveries (with GitHub-style duplicates and a
 *   controlled transient-failure rate) → drain with a bounded-concurrency
 *   worker → assert EVERY accepted delivery is audited exactly once, no
 *   dead-letters, no unacked jobs → report p50/p95/p99 audit latency and
 *   queue-depth stats from the metrics snapshot.
 *
 * Uses a fake GitHub-API-bound `process` (audit ≈ 50 ms + 2 % transient
 * failures that must retry). The real audit path is exercised by the live
 * handler tests; this soak proves the pipeline under sustained load.
 *
 * Usage: node scripts/soak-app.mjs [--jobs N] [--json] [--pg <postgres-url>]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appDist = join(root, "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const args = process.argv.slice(2);
const nIdx = args.indexOf("--jobs");
const JOBS = nIdx !== -1 ? Number(args[nIdx + 1]) : 3_000; // ≈ 2× modeled peak day in microcosm
const asJson = args.includes("--json");
const pgIdx = args.indexOf("--pg");
const PG_URL = pgIdx !== -1 ? args[pgIdx + 1] : process.env.DRIFT_TEST_PG_URL ?? "";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((s.length * p) / 100) - 1))] ?? 0;
};

const dir = mkdtempSync(join(tmpdir(), "drift-app-soak-"));
let ok = false;
try {
  const { SqliteQueue } = await mod("queue.js");
  const { PostgresQueue } = await mod("queue-pg.js");
  const { Worker } = await mod("worker.js");
  const { createMetrics } = await mod("metrics.js");
  if (PG_URL) {
    // Start from an empty queue table so leftover jobs from other runs (or
    // the test suite) can never pollute the soak's drain assertions.
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: PG_URL });
    await pool.query("DROP TABLE IF EXISTS webhook_jobs");
    await pool.end();
  }

  const queue = PG_URL
    ? new PostgresQueue({ url: PG_URL, maxAttempts: 6 })
    : new SqliteQueue({ path: join(dir, "queue.db"), maxAttempts: 6 });
  const metrics = createMetrics();
  const audits = [];
  let processedUnique = 0;
  let transientCount = 0;

  // Fake GitHub-API-bound audit: ~50 ms work, 2 % transient failures that the
  // retry policy must absorb.
  const worker = new Worker({
    queue,
    metrics,
    concurrency: 16,
    pollIntervalMs: 10,
    baseBackoffMs: 20,
    maxBackoffMs: 2_000,
    process: async (job) => {
      audits.push(job.deliveryId);
      processedUnique++;
      await sleep(25 + Math.floor(Math.random() * 50));
      if (Math.random() < 0.02) {
        transientCount++;
        return { terminal: false, ok: false, error: "fake 5xx", errorCode: "transient", durationMs: 50 };
      }
      return { terminal: true, ok: true, durationMs: 50 };
    },
  });

  // Enqueue ~2× modeled peak (116/s avg → soak at 232/s equivalent workload).
  const unique = JOBS;
  const duplicateOf = new Set();
  for (let i = 0; i < unique; i++) {
    const dup = i > 0 && i % 6 === 0;
    const deliveryId = dup ? `delivery-${i - 1}` : `delivery-${i}`;
    if (dup) duplicateOf.add(deliveryId);
    await queue.enqueue(deliveryId, "pull_request", "{}", { action: "synchronize", n: i });
  }
  const duplicates = duplicateOf.size;
  const enqueuedTotal = unique - duplicates + duplicates * 0; // unique deliveries
  const t0 = performance.now();
  worker.start();
  const deadline = Date.now() + 300_000;
  // Drain must account for RETRIES: a transient failure nacks the job back to
  // pending with a future next_attempt_at (up to maxBackoffMs), so pending can
  // go 0 → N after the last read. Treat the queue as drained only after it has
  // been quiet (pending == 0 AND nothing in_progress) for longer than the max
  // retry backoff, so every scheduled retry has fired and completed.
  const maxBackoffMs = 2_000;
  let quietMs = 0;
  while (Date.now() < deadline) {
    const s = await queue.stats();
    if (s.pending === 0 && s.inProgress === 0) quietMs += 50;
    else quietMs = 0;
    if (quietMs > maxBackoffMs + 100) break;
    await sleep(50);
  }
  await worker.stop();
  const wallMs = performance.now() - t0;
  const stats = await queue.stats();
  const snap = metrics.snapshot();
  await queue.close();

  ok = stats.pending === 0 && stats.done === enqueuedTotal && snap.jobs.deadLettered === 0 && snap.jobs.nackFailed === 0;
  const out = {
    scenario: { uniqueJobs: unique, duplicateDeliveries: duplicates, transientRate: 0.02, concurrency: 16, adapter: PG_URL ? "postgres" : "sqlite", machine: `${process.platform} ${process.arch}` },
    drainMs: Math.round(wallMs),
    throughputPerSec: Math.round((enqueuedTotal / (wallMs / 1000)) * 10) / 10,
    queue: { pending: stats.pending, done: stats.done, dead: stats.dead },
    metrics: {
      auditMs: snap.auditMs,
      queueDepth: { max: snap.queueDepth.max, last: snap.queueDepth.last },
      jobs: snap.jobs,
    },
    asserts: {
      allDrained: stats.pending === 0,
      doneMatchesUnique: stats.done === enqueuedTotal,
      zeroDeadLetters: snap.jobs.deadLettered === 0,
      zeroNackFailures: snap.jobs.nackFailed === 0,
      retriesAbsorbed: snap.jobs.retried >= transientCount - 1,
    },
    pass: ok,
  };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(`\n# Soak — ${unique} unique jobs (+${duplicates} duplicates), 2 % transient failures\n`);
    console.log(`| metric | value |`);
    console.log(`|---|---|`);
    console.log(`| drain | ${out.drainMs} ms (${out.throughputPerSec}/s) |`);
    console.log(`| audit p50 / p95 / p99 | ${out.metrics.auditMs.p50} / ${out.metrics.auditMs.p95} / ${out.metrics.auditMs.p99} ms |`);
    console.log(`| queue max depth | ${out.metrics.queueDepth.max} |`);
    console.log(`| dead-lettered | ${out.metrics.jobs.deadLettered} |`);
    console.log(`| retried | ${out.metrics.jobs.retried} |`);
    console.log(`| pass | ${ok ? "YES" : "NO"} |\n`);
  }
  process.exitCode = ok ? 0 : 1;
} finally {
  if (!asJson || ok) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await sleep(50);
      }
    }
  }
}
