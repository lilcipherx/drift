#!/usr/bin/env node
/**
 * End-to-end GitHub App benchmark + fault-injection harness
 * (docs/PERFORMANCE_REPORT.md §4, PRD §16).
 *
 * Exercises the FULL production path per delivery:
 *
 *   real HTTP webhook (HMAC) → delivery-ID idempotency → durable SQLite queue
 *   → worker (re-verifies HMAC, bounded concurrency, lease/retry) → GitHub
 *   API mock → Check Run + comment
 *
 * Scenarios (each on a fresh queue/server/mock):
 *   happy            — 150 unique deliveries, p50/p95/p99 intake + e2e latency
 *   rate-limit       — 429 and 403-with-Retry-After faults: retried, never dropped
 *   transient        — network error + 500 faults: retried, never dropped
 *   duplicates       — same delivery-id posted twice (queued) + redelivery after
 *                      completion: exactly one check run per delivery
 *   stale            — payload head differs from the current PR head: skipped
 *                      without a check run (never a trust conclusion)
 *   worker-crash     — worker A hangs on the first job (simulated crash); worker B
 *                      re-claims after the lease expires: zero loss, zero dupes
 *   parallel-workers — 3 workers on one queue: every delivery processed exactly once
 *
 * Assertions run inline and the script exits non-zero on any failure, so CI can
 * gate on it. `--json` emits machine-readable results (benchmarks/results/).
 *
 * Usage: node scripts/bench-app-e2e.mjs [--scenario happy|rate-limit|transient|
 *        duplicates|stale|worker-crash|parallel-workers|all] [--json]
 */

import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appDist = join(root, "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const args = process.argv.slice(2);
const scIdx = args.indexOf("--scenario");
const want = scIdx !== -1 ? args[scIdx + 1] ?? "all" : "all";
const asJson = args.includes("--json");
const pgIdx = args.indexOf("--pg");
const pgUrl = pgIdx !== -1 ? args[pgIdx + 1] : process.env.DRIFT_TEST_PG_URL ?? "";
const SECRET = "bench-secret";

const shaOf = (i) => `e2e${i.toString(16).padStart(37, "0")}`;
const didOf = (i) => `did_${i.toString(16).padStart(32, "0")}`;

function sign(raw) {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

function manifest(i) {
  return JSON.stringify({
    schemaVersion: 2,
    id: didOf(i),
    summary: `E2E intent ${i}`,
    timestamp: 1_700_000_000_000 + i,
    agent: { type: "AGENT", identifier: "bench" },
    signingKeyId: "0123456789abcdef",
    signature: "QUJDREVGR0g=",
    files: [{ path: `src/feature-${i}.ts`, mutationType: "ADDED", summary: `feature ${i}` }],
  });
}

function payload(deliveryId, prNumber, headSha, i) {
  return JSON.stringify({
    action: "opened",
    installation: { id: 42 },
    repository: { name: "demo", owner: { login: "lilcipherx" } },
    pull_request: {
      number: prNumber,
      title: `feat: e2e ${i}`,
      head: { sha: headSha },
      base: { sha: "0".repeat(40) },
    },
  });
}

/**
 * In-process GitHub API mock with per-method fault injection. Serves the
 * exact data the audit needs to reach the write stage: one commit carrying
 * the Drift-Intent trailer, the manifest at head/introduction, no key.pem
 * (trust root absent → key change "none"), one changed file.
 */
class MockGitHub {
  constructor(faults = {}, opts = {}) {
    this.faults = faults;
    this.opts = opts;
    this.prs = new Map();
    this.calls = new Map();
    this.checkRuns = [];
    this.comments = 0;
    this.commentUpdates = 0;
    this.commentIds = new Map();
  }

  addPr(prNumber, headSha, i) {
    this.prs.set(prNumber, {
      headSha,
      baseSha: "0".repeat(40),
      commitShas: [headSha],
      message: `feat: e2e ${i}\n\nDrift-Intent: ${didOf(i)}`,
      manifestRaw: manifest(i),
      changedFiles: 1,
    });
  }

  async maybeFault(method) {
    const list = this.faults[method];
    if (!list || list.length === 0) return;
    const n = (this.calls.get(method) ?? 0) + 1;
    this.calls.set(method, n);
    const f = list.find((x) => n <= x.times);
    if (!f) return;
    const { RateLimitError } = await mod("github.js");
    if (f.type === "429") throw new RateLimitError(`${method} failed: 429 rate limited (retry in 1s)`, 200, 429);
    if (f.type === "403") throw new RateLimitError(`${method} failed: 403 secondary rate limited (retry in 1s)`, 200, 403);
    if (f.type === "500") throw new Error(`${method} failed: 500 Internal Server Error`);
    if (f.type === "network") throw new Error(`fetch failed: connect ECONNREFUSED 127.0.0.1:1`);
  }

  pr(owner, repo, number) {
    const p = this.prs.get(number);
    if (!p) throw new Error(`getPullRequest failed: 404 ${owner}/${repo}#${number} not found in mock`);
    return p;
  }

  setInstallation() {}
  getAppId() {
    return "12345";
  }

  async getPullRequest(owner, repo, number) {
    await this.maybeFault("getPullRequest");
    const p = this.pr(owner, repo, number);
    return { headSha: p.headSha, baseSha: p.baseSha, commits: p.commitShas.length, changedFiles: p.changedFiles, title: "t" };
  }
  async getPullCommits(owner, repo, number) {
    await this.maybeFault("getPullCommits");
    const p = this.pr(owner, repo, number);
    return {
      commits: p.commitShas.map((sha) => ({ sha, message: p.message })),
      expectedCount: p.commitShas.length,
      complete: true,
    };
  }
  async getCompareCommits(_o, _r, _b, headSha) {
    await this.maybeFault("getCompareCommits");
    return [headSha];
  }
  async getPullFiles(owner, repo, number) {
    await this.maybeFault("getPullFiles");
    const p = this.pr(owner, repo, number);
    const id = p.message.match(/Drift-Intent: (did_[0-9a-f]{32})/)?.[1];
    return { files: [{ filename: `.drift/public/intents/${id}.json`, status: "added" }], truncated: false };
  }
  async getFileContent(_o, _r, path, ref) {
    await this.maybeFault("getFileContent");
    if (path === ".drift/public/key.pem") return null;
    const m = /^\.drift\/public\/intents\/(did_[0-9a-f]{32})\.json$/.exec(path);
    if (!m) return null;
    const id = m[1];
    for (const p of this.prs.values()) {
      if (p.commitShas.includes(ref) && p.message.includes(id)) return p.manifestRaw;
    }
    return null;
  }
  async listDirectory() {
    return [];
  }
  async listIssueComments() {
    return [];
  }
  async postComment(_o, _r, number) {
    await this.maybeFault("postComment");
    const id = ++this.comments;
    this.commentIds.set(number, id);
    return id;
  }
  async updateComment() {
    await this.maybeFault("updateComment");
    this.commentUpdates++;
  }
  async createCheckRun(_o, _r, input) {
    await this.maybeFault("createCheckRun");
    this.checkRuns.push({ headSha: input.headSha, conclusion: input.conclusion, at: Date.now() });
    return this.checkRuns.length;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentiles(sorted) {
  if (sorted.length === 0) return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const pick = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((sorted.length * p) / 100) - 1))] ?? 0;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50: pick(50),
    p95: pick(95),
    p99: pick(99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: Math.round((sum / sorted.length) * 10) / 10,
  };
}

async function waitDrain(queue, expected, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await queue.stats();
    if (s.done + s.dead >= expected) {
      // One extra settle tick: in_progress jobs that are about to ack.
      await sleep(100);
      return await queue.stats();
    }
    await sleep(25);
  }
  throw new Error(`drain timeout: expected ${expected} done+dead, got ${JSON.stringify(await queue.stats())}`);
}

async function post(port, raw, deliveryId) {
  const t0 = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
      "x-github-delivery": deliveryId,
    },
    body: raw,
  });
  const intakeMs = performance.now() - t0;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  if (res.status !== 202) {
    console.error(`[e2e] POST ${deliveryId} -> ${res.status} ${JSON.stringify(data)}`);
  }
  return { status: res.status, data, intakeMs };
}async function makeQueue(pgUrl) {
  if (pgUrl) {
    const { PostgresQueue } = await mod("queue-pg.js");
    return new PostgresQueue({ url: pgUrl, maxAttempts: 6 });
  }
  const { SqliteQueue } = await mod("queue.js");
  return new SqliteQueue({ path: join(mkdtempSync(join(tmpdir(), "drift-e2e-")), "queue.db"), maxAttempts: 6 });
}

/** Each scenario needs an empty queue table (SQLite gets a fresh file). */
async function resetQueueTable(pgUrl) {
  if (!pgUrl) return;
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString: pgUrl });
  await pool.query("DROP TABLE IF EXISTS webhook_jobs");
  await pool.end();
}

async function runScenario(sc, pgUrl) {
  const dir = mkdtempSync(join(tmpdir(), "drift-e2e-"));
  await resetQueueTable(pgUrl);
  const { createWebhookServer } = await mod("server.js");
  const { Worker } = await mod("worker.js");
  const mock = new MockGitHub(sc.faults, {});
  const deps = {
    github: mock,
    webhookSecret: SECRET,
    appId: "12345",
    log: console.error,
    // Surface enqueue/readiness failures (the default nullLogger hides them).
    logger: { error: console.error, warn: console.error, info: () => {}, debug: () => {} },
  };

  // Multi-instance: two SEPARATE queue objects + servers + worker pools share
  // one Postgres database — the production horizontal-scaling topology.
  const instances = sc.multiInstance ? 2 : 1;
  const queues = [];
  const srvs = [];
  const workers = [];
  for (let inst = 0; inst < instances; inst++) {
    const queue = await makeQueue(pgUrl);
    queues.push(queue);
    const srv = await createWebhookServer({ ...deps, port: 0, queue });
    srvs.push(srv);
    for (let w = 0; w < Math.max(1, Math.ceil(sc.workers / instances)); w++) {
      const workerOpts = {
        queue,
        deps,
        concurrency: sc.concurrency ?? 2,
        pollIntervalMs: 20,
        leaseMs: sc.leaseMs ?? 30_000,
        baseBackoffMs: sc.baseBackoffMs ?? 100,
        maxBackoffMs: sc.maxBackoffMs ?? 2_000,
      };
      if (sc.crashWorker && inst === 0 && w === 0) {
        // Simulated crash: this worker claims the first job and never finishes
        // (a dead process). The lease expires and another worker re-claims.
        workerOpts.process = async (job) => {
          if (job.id === sc.crashOnJob) return new Promise(() => {});
          const { processDelivery } = await mod("worker.js");
          return processDelivery(deps, job);
        };
      }
      const worker = new Worker(workerOpts);
      if (!(sc.crashWorker && inst === 0 && w === 0 && sc.crashJoinDelayMs > 0)) worker.start();
      workers.push(worker);
    }
  }
  if (sc.crashWorker) {
    // Worker B joins shortly after A has claimed (and hung on) the first job.
    const joinDelay = sc.crashJoinDelayMs ?? 300;
    setTimeout(() => workers[1]?.start(), joinDelay);
  }

  const N = sc.deliveries;
  const intake = [];
  const enqueuedAt = new Map();
  const t0 = performance.now();
  let duplicateResponses = 0;
  for (let i = 0; i < N; i++) {
    const deliveryId = `delivery-${sc.name}-${i}`;
    const prNumber = 1000 + i;
    const headSha = shaOf(i);
    mock.addPr(prNumber, headSha, i);
    if (sc.stale) {
      // The mock's PR head diverges from the payload head → stale delivery.
      mock.prs.set(prNumber, { ...mock.prs.get(prNumber), headSha: `stale${i.toString(16).padStart(36, "0")}` });
    }
    const raw = payload(deliveryId, prNumber, headSha, i);
    // Multi-instance: round-robin across the two servers.
    const srv = srvs[i % srvs.length];
    const res = await post(srv.port, raw, deliveryId);
    intake.push(res.intakeMs);
    if (res.status !== 202) throw new Error(`${sc.name}: expected 202, got ${res.status}`);
    enqueuedAt.set(headSha, Date.now());
    if (sc.duplicates) {
      const dup = await post(srv.port, raw, deliveryId);
      if (dup.data?.duplicate === true) duplicateResponses++;
      if (dup.status !== 202) throw new Error(`${sc.name}: duplicate POST expected 202, got ${dup.status}`);
    }
  }
  const postWallMs = performance.now() - t0;

  // Redelivery AFTER completion (GitHub retries an already-processed event).
  let redeliveredDeduped = 0;
  if (sc.redeliverAfterDone) {
    const stats = await waitDrain(queues[0], N);
    for (let i = 0; i < N; i++) {
      const deliveryId = `delivery-${sc.name}-${i}`;
      const prNumber = 1000 + i;
      const headSha = shaOf(i);
      const raw = payload(deliveryId, prNumber, headSha, i);
      const res = await post(srvs[i % srvs.length].port, raw, deliveryId);
      if (res.data?.duplicate === true && res.data?.alreadyProcessed === true) redeliveredDeduped++;
    }
  }

const finalStats = await waitDrain(queues[0], N);
  for (const s of srvs) await s.close();
  for (const w of workers) {
    if (w === workers[0] && sc.crashWorker) continue; // abandoned (simulated crash)
    await w.stop();
  }
  for (const q of queues) q.close();

  // E2E latency: enqueue (202) → check run recorded by the mock.
  const e2e = [];
  for (const cr of mock.checkRuns) {
    const t = enqueuedAt.get(cr.headSha);
    if (t !== undefined) e2e.push(cr.at - t);
  }

  const result = {
    name: sc.name,
    deliveries: N,
    intakeMs: percentiles(intake.sort((a, b) => a - b)),
    e2eMs: percentiles(e2e.sort((a, b) => a - b)),
    postWallMs: Math.round(postWallMs),
    stats: finalStats,
    checkRuns: mock.checkRuns.length,
    comments: mock.comments,
    commentUpdates: mock.commentUpdates,
    duplicateResponses,
    redeliveredDeduped,
    mockCalls: Object.fromEntries(mock.calls),
    assertions: {},
  };

  const check = (name, cond, detail) => {
    result.assertions[name] = cond;
    if (!cond) result.failures = [...(result.failures ?? []), `${name}: ${detail}`];
  };
  switch (sc.name) {
    case "happy":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-dead", finalStats.dead === 0, `dead=${finalStats.dead}`);
      check("check-runs", mock.checkRuns.length === N, `got ${mock.checkRuns.length}`);
      check("comments", mock.comments === N, `got ${mock.comments}`);
      break;
    case "rate-limit":
    case "transient":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-dead", finalStats.dead === 0, `dead=${finalStats.dead}`);
      check("check-runs", mock.checkRuns.length === N, `got ${mock.checkRuns.length}`);
      const faultMethods = Object.keys(sc.faults ?? {});
      check(
        "retried",
        faultMethods.some((m) => (mock.calls.get(m) ?? 0) > N),
        `calls=${JSON.stringify(Object.fromEntries(mock.calls))}`,
      );
      break;
    case "duplicates":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-dead", finalStats.dead === 0, `dead=${finalStats.dead}`);
      check("one-check-run-per-delivery", mock.checkRuns.length === N, `got ${mock.checkRuns.length}`);
      check("queued-dupes-detected", duplicateResponses === N, `${duplicateResponses}/${N}`);
      break;
    case "stale":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-check-run", mock.checkRuns.length === 0, `got ${mock.checkRuns.length}`);
      break;
    case "worker-crash":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-dead", finalStats.dead === 0, `dead=${finalStats.dead}`);
      check("crashed-job-recovered", mock.checkRuns.length === N, `got ${mock.checkRuns.length}`);
      break;
    case "parallel-workers":
      check("all-done", finalStats.done === N, `done=${finalStats.done}`);
      check("no-dead", finalStats.dead === 0, `dead=${finalStats.dead}`);
      check("exactly-once", mock.checkRuns.length === N, `got ${mock.checkRuns.length}`);
      break;
  }

  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(50);
    }
  }
  return result;
}

const SCENARIOS = [
  { name: "happy", deliveries: 150, workers: 1, concurrency: 2 },
  {
    name: "rate-limit",
    deliveries: 30,
    workers: 1,
    concurrency: 1,
    baseBackoffMs: 30,
    maxBackoffMs: 400,
    faults: {
      getPullCommits: [{ type: "429", times: 2 }],
      getPullRequest: [{ type: "403", times: 1 }],
    },
  },
  {
    name: "transient",
    deliveries: 30,
    workers: 1,
    concurrency: 1,
    baseBackoffMs: 30,
    maxBackoffMs: 400,
    faults: {
      getPullFiles: [
        { type: "network", times: 1 },
        { type: "500", times: 1 },
      ],
    },
  },
  { name: "duplicates", deliveries: 20, workers: 1, concurrency: 2, duplicates: true, redeliverAfterDone: true },
  { name: "stale", deliveries: 1, workers: 1, concurrency: 1, stale: true },
  { name: "worker-crash", deliveries: 20, workers: 2, concurrency: 1, crashWorker: true, crashOnJob: 1, crashJoinDelayMs: 250, leaseMs: 700 },
  { name: "parallel-workers", deliveries: 60, workers: 3, concurrency: 2 },
  // True multi-instance: two servers + worker pools over ONE Postgres database
  // (production horizontal scaling; only valid with --pg).
  { name: "multi-instance", deliveries: 60, workers: 2, concurrency: 2, multiInstance: true },
];

async function main() {
  // multi-instance requires a SHARED database (Postgres); without --pg it is
  // excluded from `all` and refused when selected explicitly.
  if (want === "multi-instance" && !pgUrl) {
    console.error("multi-instance requires --pg <postgres-url>");
    process.exit(1);
  }
  const selected = SCENARIOS.filter((s) => (want === "all" ? s.name !== "multi-instance" || !!pgUrl : s.name === want));
  if (selected.length === 0) {
    console.error(`unknown scenario: ${want} (expected one of ${SCENARIOS.map((s) => s.name).join(", ")} or all)`);
    process.exit(1);
  }
  const results = [];
  for (const sc of selected) {
    const r = await runScenario(sc, pgUrl);
    results.push(r);
    const failed = Object.values(r.assertions).filter((v) => !v).length;
    console.error(
      `[e2e] ${r.name}: ${r.checkRuns}/${r.deliveries} check runs, done=${r.stats.done}, dead=${r.stats.dead}, e2e p50=${r.e2eMs.p50}ms p99=${r.e2eMs.p99}ms, ${failed === 0 ? "PASS" : "FAIL " + JSON.stringify(r.failures)}`,
    );
  }
  const passed = results.every((r) => Object.values(r.assertions).every((v) => v === true));
  const out = { scenario: want, adapter: pgUrl ? "postgres" : "sqlite", machine: `${process.platform} ${process.arch}`, results, passed };
  if (asJson) {
    const json = JSON.stringify(out, null, 2);
    console.log(json);
    const outPath = join(root, "benchmarks", "results", "bench-app-e2e.json");
    writeFileSync(outPath, json, "utf8");
    console.error(`saved ${outPath}`);
  } else {
    console.log(`\n# App end-to-end benchmark (${want})\n`);
    for (const r of results) {
      console.log(`## ${r.name}`);
      console.log(`| metric | value |`);
      console.log(`|---|---|`);
      console.log(`| intake p50/p95/p99 | ${r.intakeMs.p50}/${r.intakeMs.p95}/${r.intakeMs.p99} ms |`);
      console.log(`| e2e p50/p95/p99 | ${r.e2eMs.p50}/${r.e2eMs.p95}/${r.e2eMs.p99} ms |`);
      console.log(`| e2e max | ${r.e2eMs.max} ms |`);
      console.log(`| check runs | ${r.checkRuns}/${r.deliveries} |`);
      console.log(`| dead letters | ${r.stats.dead} |`);
      console.log(`| assertions | ${Object.values(r.assertions).every(Boolean) ? "PASS" : "FAIL " + JSON.stringify(r.failures)} |\n`);
    }
  }
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`[e2e] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
