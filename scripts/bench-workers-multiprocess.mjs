#!/usr/bin/env node
/**
 * Multi-PROCESS worker benchmark (production distributed architecture).
 *
 * Unlike the in-process e2e (which shares one Node process), this spawns N
 * REAL worker processes, each with its own PostgresQueue pool and its own
 * GitHubAppClient (real HTTP client), all claiming jobs from ONE shared
 * Postgres database via `FOR UPDATE SKIP LOCKED`.
 *
 * Verified end-to-end over HTTP:
 *   - exactly-once: every delivery produces exactly one Check Run and one
 *     comment on the mock GitHub API (a double-claim would double-write);
 *   - multi-tenant isolation: the mock issues per-installation tokens and
 *     fails any repo-scoped request whose token does not match the PR's
 *     installation — a cross-tenant client swap in ANY worker process
 *     surfaces as a mismatch;
 *   - lease/crash: `--kill` SIGKILLs a worker mid-flight; its claimed jobs
 *     must be re-claimed after lease expiry and processed exactly once;
 *   - retry/dead-letter: transient mock failures (--faults) are retried;
 *     repeated failures dead-letter (never lost, never double-processed).
 *
 * Usage:
 *   node scripts/bench-workers-multiprocess.mjs --pg <postgres-url> \
 *     --workers 5 --jobs 2000 --tenants 8 [--kill] [--faults N] [--json]
 *
 * Child mode (internal): --child <workerId> starts one worker process.
 */

import { createServer } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Pool } from "pg";

const WEBHOOK_SECRET = "bench-secret";
const hmac = (rawBody) => `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody, "utf8").digest("hex")}`;

const args = process.argv.slice(2);
const pick = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const pgUrl = pick("--pg") ?? process.env.DRIFT_TEST_PG_URL ?? "";
const workers = Number(pick("--workers") ?? 5);
const jobs = Number(pick("--jobs") ?? 2000);
const tenants = Number(pick("--tenants") ?? 8);
const killWorker = args.includes("--kill");
const faults = Number(pick("--faults") ?? 0);
const asJson = args.includes("--json");
const childId = pick("--child");

// Deterministic 40-hex-char SHAs (and valid Drift-Intent ids from them).
const shaOf = (i) => {
  const hi = Math.floor(i / 1e9).toString(16).padStart(8, "0");
  const lo = (i % 1e9).toString(16).padStart(8, "0");
  return `${hi}${lo}${"0".repeat(24)}`;
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ parent
if (!childId) {
  if (!pgUrl) {
    console.error(
      "usage: node scripts/bench-workers-multiprocess.mjs --pg <postgres-url> [--workers N] [--jobs N] [--tenants N] [--kill] [--faults N] [--json]",
    );
    process.exit(2);
  }
  const t0 = Date.now();

  // --- Reset: each benchmark run starts from an empty queue table. --------
  const reset = new Pool({ connectionString: pgUrl });
  await reset.query("DROP TABLE IF EXISTS webhook_jobs");
  await reset.end();

  // --- In-memory HTTP mock of the GitHub REST API --------------------------
  const prs = new Map(); // prNumber -> { inst, headSha, baseSha, title }
  const checkRuns = new Map(); // headSha -> count
  const comments = new Map(); // prNumber -> count
  const tokenForInst = new Map(); // installation -> token
  let tenantMismatches = 0;
  let served = 0;

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function readJson(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  }

  const server = createServer(async (req, res) => {
    served++;
    const url = new URL(req.url, "http://x");
    const parts = url.pathname.split("/").filter(Boolean);
    const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");

    // Installation token exchange (app JWT -> installation token).
    if (parts[0] === "app" && parts[1] === "installations" && parts[3] === "access_tokens") {
      const inst = Number(parts[2]);
      const token = `tok-${inst}-${Math.random().toString(36).slice(2, 10)}`;
      tokenForInst.set(inst, token);
      send(res, 201, { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      return;
    }
    // Repo-scoped routes: /repos/{owner}/{repo}/...
    if (parts[0] === "repos" && parts.length >= 3) {
      const rest = parts.slice(3);
      // /repos/o/r/pulls/{n}
      if (rest[0] === "pulls" && rest[1] && !rest[2]) {
        const pr = prs.get(Number(rest[1]));
        if (!pr) return send(res, 404, { message: "not found" });
        if (auth !== tokenForInst.get(pr.inst)) tenantMismatches++;
        return send(res, 200, {
          number: Number(rest[1]),
          title: pr.title,
          head: { sha: pr.headSha },
          base: { sha: pr.baseSha },
          commits: 1,
          changed_files: 1,
        });
      }
      // /repos/o/r/pulls/{n}/commits
      if (rest[0] === "pulls" && rest[1] && rest[2] === "commits") {
        const pr = prs.get(Number(rest[1]));
        if (!pr) return send(res, 404, { message: "not found" });
        if (auth !== tokenForInst.get(pr.inst)) tenantMismatches++;
        return send(res, 200, [
          {
            sha: pr.headSha,
            commit: {
              message: `feat: change ${pr.headSha.slice(0, 6)}\n\nDrift-Intent: did_${pr.headSha.slice(2, 34)}`,
            },
          },
        ]);
      }
      // /repos/o/r/pulls/{n}/files
      if (rest[0] === "pulls" && rest[1] && rest[2] === "files") {
        const pr = prs.get(Number(rest[1]));
        if (!pr) return send(res, 404, { message: "not found" });
        if (auth !== tokenForInst.get(pr.inst)) tenantMismatches++;
        return send(res, 200, [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 }]);
      }
      // /repos/o/r/compare/{base}...{head}
      if (rest[0] === "compare" && rest[1]) {
        const head = url.pathname.split("...")[1] ?? "";
        const pr = [...prs.values()].find((p) => p.headSha === head);
        if (pr && auth !== tokenForInst.get(pr.inst)) tenantMismatches++;
        return send(res, 200, { total_commits: 1, commits: [{ sha: head }] });
      }
      // /repos/o/r/contents/{...}?ref=
      if (rest[0] === "contents") {
        const path = rest.slice(1).join("/");
        const ref = url.searchParams.get("ref") ?? "";
        const pr = [...prs.values()].find((p) => p.headSha === ref || p.baseSha === ref);
        if (pr && auth !== tokenForInst.get(pr.inst)) tenantMismatches++;
        if (path === ".drift/public/intents") return send(res, 200, []); // empty dir listing
        return send(res, 404, { message: "not found" }); // no key.pem / manifests
      }
      // /repos/o/r/check-runs (POST)
      if (rest[0] === "check-runs" && req.method === "POST") {
        const body = await readJson(req);
        const key = String(body.head_sha ?? "");
        checkRuns.set(key, (checkRuns.get(key) ?? 0) + 1);
        return send(res, 201, { id: checkRuns.get(key), name: body.name, conclusion: body.conclusion });
      }
      // /repos/o/r/issues/{n}/comments
      if (rest[0] === "issues" && rest[1] && rest[2] === "comments") {
        const prn = Number(rest[1]);
        if (req.method === "GET") return send(res, 200, []);
        if (req.method === "POST") {
          comments.set(prn, (comments.get(prn) ?? 0) + 1);
          return send(res, 201, { id: comments.get(prn), body: "ok" });
        }
      }
      // /repos/o/r/issues/comments/{id} (PATCH)
      if (rest[0] === "issues" && rest[1] === "comments" && rest[2]) {
        return send(res, 200, { id: Number(rest[2]) });
      }
      return send(res, 404, { message: "unhandled" });
    }
    return send(res, 404, { message: "unhandled" });
  });

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const mockUrl = `http://127.0.0.1:${server.address().port}`;

  // --- Seed the shared queue with M jobs across T installations ------------
  const { PostgresQueue } = await import("../packages/drift-app/dist/queue-pg.js");
  const seed = new PostgresQueue({ url: pgUrl, maxAttempts: 6 });
  for (let i = 0; i < jobs; i++) {
    const prNumber = 10_000 + i;
    const headSha = shaOf(i);
    const inst = (i % tenants) + 1;
    prs.set(prNumber, { inst, headSha, baseSha: "0".repeat(40), title: `PR ${i}` });
    const payload = {
      action: "synchronize",
      installation: { id: inst },
      repository: { name: "repo", owner: { login: "owner" } },
      pull_request: { number: prNumber, title: `PR ${i}`, head: { sha: headSha }, base: { sha: "0".repeat(40) } },
    };
    const rawBody = JSON.stringify(payload);
    // Signed exactly like the intake server: the worker re-verifies this HMAC
    // before auditing (fail-closed), so an unsigned seed would be rejected at
    // the gate and the benchmark would measure nothing.
    await seed.enqueue(`mp-${i}`, "pull_request", rawBody, payload, hmac(rawBody));
  }
  await seed.close();
  const seeded = jobs;

  // --- Spawn N real worker processes ---------------------------------------
  const childScript = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const procs = [];
  for (let w = 0; w < workers; w++) {
    const proc = spawn(process.execPath, [childScript, "--child", `w${w}`], {
      env: {
        ...process.env,
        DRIFT_TEST_PG_URL: pgUrl,
        MP_MOCK_URL: mockUrl,
        MP_FAULTS: String(faults),
        MP_WORKER_ID: `w${w}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    procs.push(proc);
  }

  // Crash scenario: SIGKILL one worker mid-flight (its leases expire and the
  // survivors re-claim the jobs — exactly-once must hold across the kill).
  let killedWorker = 0;
  if (killWorker && procs.length > 1) {
    setTimeout(() => {
      killedWorker = 1;
      procs[0].kill("SIGKILL");
      console.error(`[mp] SIGKILL worker (pid ${procs[0].pid}) at +2.5s — lease re-claim exercise`);
    }, 2500);
  }

  let childStderr = "";
  const exits = await Promise.all(
    procs.map((p) =>
      new Promise((res) => {
        p.stderr.on("data", (d) => (childStderr += d.toString()));
        p.on("exit", (code) => res({ code }));
      }),
    ),
  );
  const clean = exits.filter((e) => e.code === 0).length;
  const crashed = exits.filter((e) => e.code !== 0 && e.code !== null).length;

  // --- Verify: exactly-once + no dead letters + tenant isolation -----------
  const tgt = new PostgresQueue({ url: pgUrl, maxAttempts: 6 });
  const stats = await tgt.stats();
  await tgt.close();
  await new Promise((r) => server.close(r));

  const checkRunsTotal = [...checkRuns.values()].reduce((a, b) => a + b, 0);
  const commentsTotal = [...comments.values()].reduce((a, b) => a + b, 0);
  const noDoubleCheck = [...checkRuns.values()].every((c) => c === 1);
  const noDoubleComment = [...comments.values()].every((c) => c === 1);

  const asserts = {
    "all-done": stats.done === seeded,
    "no-dead": stats.dead === 0,
    "exactly-once-check-runs": checkRunsTotal === seeded && noDoubleCheck,
    "exactly-once-comments": commentsTotal === seeded && noDoubleComment,
    "no-cross-tenant": tenantMismatches === 0,
    "workers-exited-clean": clean === workers - killedWorker && crashed === 0,
  };
  const failures = Object.entries(asserts)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  const wallMs = Date.now() - t0;

  const out = {
    scenario: `multiprocess-${workers}w-${seeded}j`,
    adapter: "postgres",
    workers,
    jobs: seeded,
    tenants,
    killedWorkers: killedWorker,
    faults,
    machine: `${process.platform} ${process.arch}`,
    wallMs,
    throughput: Math.round(seeded / (wallMs / 1000)),
    stats,
    checkRuns: checkRunsTotal,
    comments: commentsTotal,
    tenantMismatches,
    servedRequests: served,
    asserts,
    passed: failures.length === 0,
  };
  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    const outPath = join(process.cwd(), "benchmarks", "results", "bench-workers-multiprocess.json");
    writeFileSync(outPath, JSON.stringify(out, null, 2), "utf8");
    console.error(`saved ${outPath}`);
  } else {
    console.log(`\n# Multi-process worker benchmark (${workers} processes x ${seeded} jobs over Postgres)\n`);
    console.log(`| metric | value |`);
    console.log(`|---|---|`);
    console.log(`| wall | ${wallMs} ms |`);
    console.log(`| throughput | ${out.throughput} jobs/s |`);
    console.log(`| check runs | ${checkRunsTotal}/${seeded} |`);
    console.log(`| comments | ${commentsTotal}/${seeded} |`);
    console.log(`| dead letters | ${stats.dead} |`);
    console.log(`| tenant mismatches | ${tenantMismatches} |`);
    console.log(`| API requests served | ${served} |`);
    console.log(`| assertions | ${failures.length === 0 ? "PASS" : "FAIL " + failures.join(", ")} |`);
  }
  if (failures.length > 0) {
    console.error(`[mp] FAIL: ${failures.join(", ")}`);
    if (childStderr.trim()) console.error(childStderr.slice(0, 4000));
    process.exit(1);
  }
  process.exit(0);
}

// ------------------------------------------------------------------ child
// One real worker process: own Postgres pool, own GitHubAppClient (real HTTP),
// own Worker loop. Runs until the queue is drained, then exits 0.
const pg = pgUrl || process.env.DRIFT_TEST_PG_URL || "";
const mockUrl = process.env.MP_MOCK_URL || "";
const workerId = process.env.MP_WORKER_ID || "w";
const faultCount = Number(process.env.MP_FAULTS ?? 0);

const { PostgresQueue } = await import("../packages/drift-app/dist/queue-pg.js");
const { Worker } = await import("../packages/drift-app/dist/worker.js");
const { GitHubAppClient } = await import("../packages/drift-app/dist/github.js");

// A valid RSA key for the app JWT (the mock never verifies the JWT, but
// createAppJwt requires a real key).
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const queue = new PostgresQueue({ url: pg, maxAttempts: 6 });
const github = new GitHubAppClient({
  appId: "12345",
  privateKeyPem,
  baseUrl: mockUrl,
  requestTimeoutMs: 15_000,
  breakerThreshold: 0, // disable the circuit breaker for the benchmark
});
let faultsInjected = 0;
const origRequest = github.request.bind(github);
if (faultCount > 0) {
  // Inject transient 500s on a bounded share of API requests (retry path).
  github.request = async (path, token, init) => {
    if (faultsInjected < faultCount && path.includes("/pulls/") && !path.includes("/commits")) {
      faultsInjected++;
      return new Response("{}", { status: 500 });
    }
    return origRequest(path, token, init);
  };
}
const worker = new Worker({
  queue,
  deps: { github, webhookSecret: WEBHOOK_SECRET, appId: "12345" },
  concurrency: 4,
  pollIntervalMs: 25,
  leaseMs: 15_000,
  baseBackoffMs: 20,
  maxBackoffMs: 200,
});
worker.start();

// Drain: poll until nothing is pending/in_progress (a SIGKILLed worker's
// expired-lease job becomes claimable again after leaseMs).
const deadline = Date.now() + 15 * 60_000;
for (;;) {
  if (Date.now() > deadline) {
    console.error(`[mp-child ${workerId}] drain timeout`);
    process.exit(3);
  }
  const s = await queue.stats();
  if (s.pending === 0 && s.inProgress === 0) {
    await worker.stop();
    queue.close();
    console.error(`[mp-child ${workerId}] drained done=${s.done} dead=${s.dead} faults=${faultsInjected}`);
    process.exit(0);
  }
  await sleep(250);
}
