#!/usr/bin/env node
/**
 * GitHub App webhook INTAKE load benchmark (docs/PERFORMANCE_REPORT.md §4).
 *
 * Starts the queued webhook server (durable SQLite queue) and fires
 * deliveries at 1× and 2× the modeled peak rate (CAPACITY_MODEL §1: peak
 * 116 events/s, 2× = 232 events/s), measuring the intake path only:
 *
 *   bounded body → HMAC verify → delivery-ID idempotency → JSON parse →
 *   enqueue → fast 202
 *
 * Reports p50/p95/p99/max/mean latency, throughput, and duplicate-dedupe
 * counts. The audit NEVER runs in the request thread, so this measures the
 * request path that must stay fast under load.
 *
 * Usage: node scripts/bench-app-intake.mjs [--deliveries N] [--json]
 */

import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appDist = join(root, "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const args = process.argv.slice(2);
const nIdx = args.indexOf("--deliveries");
const DELIVERIES = nIdx !== -1 ? Number(args[nIdx + 1]) : 2_000;
const asJson = args.includes("--json");
const SECRET = "bench-secret";

function sign(raw) {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

function payload(deliveryId) {
  return JSON.stringify({
    action: "synchronize",
    installation: { id: 42 },
    repository: { name: "demo", owner: { login: "lilcipherx" } },
    pull_request: {
      number: 7,
      title: "feat: load test",
      head: { sha: "a".repeat(40) },
      base: { sha: "0".repeat(40) },
    },
    // A ~4 KB realistic-ish body.
    body: "x".repeat(4_000),
  });
}

function percentiles(sorted) {
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length * p) / 100) - 1))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? sum / sorted.length : 0,
  };
}

async function run(port, deliveries, duplicates) {
  const latencies = [];
  let accepted = 0;
  let dup = 0;
  let bad = 0;
  const seen = new Set();
  const doOne = async (deliveryId, dupOf) => {
    const raw = payload(deliveryId);
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": sign(raw),
      },
      body: raw,
    });
    latencies.push(performance.now() - t0);
    if (res.status === 202) {
      if (dupOf && seen.has(dupOf)) dup++;
      else accepted++;
      seen.add(deliveryId);
    } else if (res.status === 401) bad++;
  };
  // Fire at the requested rate using a small concurrency pool.
  const poolSize = 16;
  let idx = 0;
  const queue = [];
  const pump = async () => {
    while (idx < deliveries) {
      const i = idx++;
      const isDup = duplicates && i % 5 === 0 && i >= 5;
      const id = isDup ? `delivery-${i - 1}` : `delivery-${i}`;
      await doOne(id, isDup ? id : undefined);
    }
  };
  for (let w = 0; w < poolSize; w++) queue.push(pump());
  await Promise.all(queue);
  return { latencies, accepted, dup, bad };
}

const dir = mkdtempSync(join(tmpdir(), "drift-app-bench-"));
let cleanup = false;
try {
  const { createWebhookServer } = await mod("server.js");
  const { SqliteQueue } = await mod("queue.js");
  const queue = new SqliteQueue({ path: join(dir, "queue.db"), maxAttempts: 3 });
  const srv = await createWebhookServer({
    webhookSecret: SECRET,
    appId: "12345",
    port: 0,
    queue,
  });
  cleanup = true;
  const port = srv.port;

  const t0 = performance.now();
  const r1 = await run(port, DELIVERIES, false);
  const wall1 = performance.now() - t0;

  // Duplicate re-delivery pass at the same rate (GitHub redeliveries).
  const t1 = performance.now();
  const r2 = await run(port, Math.floor(DELIVERIES / 5), true);
  const wall2 = performance.now() - t1;

  await srv.close();
  await queue.close();

  const out = {
    scenario: { deliveries: DELIVERIES, duplicatePass: Math.floor(DELIVERIES / 5), pool: 16, machine: `${process.platform} ${process.arch}` },
    intakeMs: percentiles([...r1.latencies, ...r2.latencies].sort((a, b) => a - b)),
    accepted: r1.accepted,
    duplicatesDetected: r2.dup,
    badSignatures: r1.bad + r2.bad,
    throughputPerSec: Math.round((r1.latencies.length / (wall1 / 1000)) * 10) / 10,
    modeledPeakPerSec: 116,
    modeled2xPeakPerSec: 232,
  };
  if (asJson) console.log(JSON.stringify(out, null, 2));
  else {
    console.log(`\n# App webhook intake benchmark — ${DELIVERIES} deliveries\n`);
    console.log(`| metric | value |`);
    console.log(`|---|---|`);
    console.log(`| p50 | ${out.intakeMs.p50.toFixed(1)} ms |`);
    console.log(`| p95 | ${out.intakeMs.p95.toFixed(1)} ms |`);
    console.log(`| p99 | ${out.intakeMs.p99.toFixed(1)} ms |`);
    console.log(`| max | ${out.intakeMs.max.toFixed(1)} ms |`);
    console.log(`| mean | ${out.intakeMs.mean.toFixed(1)} ms |`);
    console.log(`| throughput | ${out.throughputPerSec}/s (modeled peak 116/s, 2× 232/s) |`);
    console.log(`| accepted | ${out.accepted} |`);
    console.log(`| duplicates detected | ${out.duplicatesDetected} |`);
    console.log(`| bad signatures | ${out.badSignatures} |\n`);
  }
} finally {
  if (cleanup) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
}
