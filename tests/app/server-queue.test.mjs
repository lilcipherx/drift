/**
 * Queued webhook server tests (production request path):
 *   bounded body → HMAC verify → delivery-ID idempotency → JSON parse →
 *   enqueue → fast 202. The audit NEVER runs in the request thread when a
 *   queue is configured. Covers auth failures, missing delivery id, oversized
 *   body, /health and /ready endpoints, and duplicate-delivery dedupe.
 */

import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const SECRET = "test-secret";
const tmpDirs = [];
const servers = [];

function freshDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "drift-srvq-"));
  tmpDirs.push(dir);
  return join(dir, "queue.db");
}

after(async () => {
  for (const s of servers) {
    try {
      await s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of tmpDirs) {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(d, { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 4) throw err;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
});

function sign(raw) {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

const basePayload = {
  action: "opened",
  installation: { id: 42 },
  repository: { name: "demo", owner: { login: "lilcipherx" } },
  pull_request: {
    number: 7,
    title: "feat: add login",
    head: { sha: "a".repeat(40) },
    base: { sha: "0".repeat(40) },
  },
};

async function startServer(opts = {}) {
  const { createWebhookServer } = await mod("server.js");
  const { MemoryQueue } = await mod("queue.js");
  const { SqliteQueue } = await mod("queue.js");
  const queue =
    opts.kind === "sqlite"
      ? new SqliteQueue({ path: freshDbPath(), maxAttempts: 3 })
      : new MemoryQueue({ maxAttempts: 3 });
  const srv = await createWebhookServer({
    webhookSecret: SECRET,
    appId: "12345",
    port: 0,
    queue,
    ...opts,
  });
  servers.push(srv);
  return { srv, queue };
}

async function post(port, raw, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
      "x-github-delivery": "delivery-uuid-1",
      ...headers,
    },
    body: raw,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-json */
  }
  return { status: res.status, data };
}

test("full queued path: server HMAC → durable enqueue → worker re-verifies → audit completes", async () => {
  // Regression: the queued production flow must complete end-to-end WITH a
  // webhook secret. The server verifies the HMAC and persists the signature
  // on the job; the worker re-verifies it before auditing. Without the
  // persisted signature every authenticated delivery was permanently rejected
  // as "invalid webhook signature" and never audited.
  const { srv, queue } = await startServer({ kind: "sqlite" });
  const { Worker } = await mod("worker.js");

  const did = "did_" + "2".repeat(32);
  const sha = "b".repeat(40);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    id: did,
    summary: "queued e2e",
    timestamp: 1_700_000_000_000,
    agent: { type: "AGENT", identifier: "bench" },
    signingKeyId: "0123456789abcdef",
    signature: "QUJDREVGR0g=",
    files: [{ path: "src/a.ts", mutationType: "ADDED", summary: "a" }],
  });
  let checkRuns = 0;
  const github = {
    setInstallation() {},
    getAppId: () => "12345",
    getPullRequest: async () => ({ headSha: sha, baseSha: "0".repeat(40), commits: 1, changedFiles: 1, title: "t" }),
    getPullCommits: async () => ({
      commits: [{ sha, message: `feat: x\n\nDrift-Intent: ${did}` }],
      expectedCount: 1,
      complete: true,
    }),
    getCompareCommits: async () => [sha],
    getPullFiles: async () => ({
      files: [{ filename: `.drift/public/intents/${did}.json`, status: "added" }],
      truncated: false,
    }),
    getFileContent: async (_o, _r, path) => (path.endsWith(`${did}.json`) ? manifest : null),
    listDirectory: async () => [],
    listIssueComments: async () => [],
    postComment: async () => 1,
    updateComment: async () => {},
    createCheckRun: async () => {
      checkRuns++;
      return checkRuns;
    },
  };
  const worker = new Worker({
    queue,
    deps: { github, webhookSecret: SECRET, appId: "12345" },
    pollIntervalMs: 20,
  });
  worker.start();

  const payload = { ...basePayload, pull_request: { ...basePayload.pull_request, head: { sha } } };
  const raw = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
      "x-github-delivery": "delivery-e2e-1",
    },
    body: raw,
  });
  assert.equal(res.status, 202);

  const deadline = Date.now() + 10_000;
  while (queue.stats().done < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(queue.stats().done, 1, "job completed");
  assert.equal(checkRuns, 1, "audit completed and the Check Run was created");
  assert.equal(queue.stats().dead, 0, "no dead letters");
  await worker.stop();
  queue.close();
});

test("queued server: enqueues and answers 202 fast (no inline audit)", async () => {
  const { srv } = await startServer();
  const raw = JSON.stringify(basePayload);
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
      "x-github-delivery": "delivery-1",
    },
    body: raw,
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.status, 202);
  const data = await res.json();
  assert.equal(data.accepted, true);
  assert.equal(data.duplicate, false);
  // No inline audit: the response must be immediate (no GitHub API calls).
  assert.ok(elapsed < 2000, `intake took ${elapsed}ms`);
});

test("queued server: duplicate delivery id is deduplicated (202, duplicate: true)", async () => {
  const { srv, queue } = await startServer();
  const raw = JSON.stringify(basePayload);
  const h = {
    "x-github-delivery": "delivery-dup",
    "x-hub-signature-256": sign(raw),
  };
  const first = await post(srv.port, raw, h);
  assert.equal(first.status, 202);
  assert.equal(first.data.accepted, true);
  // simulate GitHub redelivery with the SAME delivery id
  const second = await post(srv.port, raw, h);
  assert.equal(second.status, 202);
  assert.equal(second.data.accepted, false);
  assert.equal(second.data.duplicate, true);
  assert.equal(queue.depth(), 1, "only one job may exist per delivery id");
});

test("queued server: rejects bad signatures before enqueueing", async () => {
  const { srv, queue } = await startServer();
  const raw = JSON.stringify(basePayload);
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": "sha256=deadbeef",
      "x-github-delivery": "delivery-bad",
    },
    body: raw,
  });
  assert.equal(res.status, 401);
  assert.equal(queue.depth(), 0);
});

test("queued server: missing delivery id is rejected (cannot guarantee idempotency)", async () => {
  const { srv, queue } = await startServer();
  const raw = JSON.stringify(basePayload);
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
    },
    body: raw,
  });
  assert.equal(res.status, 400);
  assert.equal(queue.depth(), 0);
});

test("queued server: oversized body is rejected with 413", async () => {
  const { srv, queue } = await startServer({ maxBodyBytes: 1024 });
  const big = JSON.stringify({ ...basePayload, junk: "x".repeat(2048) });
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(big),
      "x-github-delivery": "delivery-big",
    },
    body: big,
  });
  assert.equal(res.status, 413);
  assert.equal(queue.depth(), 0);
});

test("queued server: health and readiness endpoints", async () => {
  const { srv, queue } = await startServer();
  const health = await fetch(`http://127.0.0.1:${srv.port}/health`);
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.status, "ok");
  const ready = await fetch(`http://127.0.0.1:${srv.port}/ready`);
  assert.equal(ready.status, 200);
  const r = await ready.json();
  assert.equal(r.status, "ready");
  assert.equal(r.mode, "queued");
  assert.equal(typeof r.queueDepth, "number");
  queue.enqueue("delivery-health", "pull_request", "{}", {});
  const ready2 = await fetch(`http://127.0.0.1:${srv.port}/ready`);
  const r2 = await ready2.json();
  assert.ok(r2.queueDepth >= 1);
});

test("queued server: non-POST /webhook returns 404", async () => {
  const { srv } = await startServer();
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`);
  assert.equal(res.status, 404);
});

test("queued server: sqlite queue survives server restart (durable)", async () => {
  const { createWebhookServer } = await mod("server.js");
  const { SqliteQueue } = await mod("queue.js");
  const path = freshDbPath();
  const queue = new SqliteQueue({ path, maxAttempts: 3 });
  const srv1 = await createWebhookServer({ webhookSecret: SECRET, appId: "1", port: 0, queue });
  const raw = JSON.stringify(basePayload);
  const res = await post(srv1.port, raw, { "x-github-delivery": "delivery-durable" });
  assert.equal(res.status, 202);
  assert.equal(res.data.accepted, true);
  await srv1.close();
  queue.close();
  // restart with a new queue instance over the same file
  const queue2 = new SqliteQueue({ path, maxAttempts: 3 });
  const srv2 = await createWebhookServer({ webhookSecret: SECRET, appId: "1", port: 0, queue: queue2 });
  servers.push(srv2);
  assert.equal(queue2.depth(), 1, "job must survive a server restart");
  await srv2.close();
  queue2.close();
});

test("queued server: malformed JSON is rejected with 400", async () => {
  const { srv, queue } = await startServer();
  const res = await fetch(`http://127.0.0.1:${srv.port}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign("{not json"),
      "x-github-delivery": "delivery-malformed",
    },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  assert.equal(queue.depth(), 0);
});
