/**
 * Live E2E — graceful shutdown must never hang.
 *
 * Bare `server.close()` waits for EVERY open connection; a client holding an
 * idle keep-alive socket (or a mid-request client) would block shutdown
 * forever. Root cause of a hang observed while verifying SIGTERM shutdown:
 * nothing releases idle connections. Fix: closeIdleConnections() immediately
 * + a bounded force-close of stragglers after a grace period.
 *
 * The race (3 s vs the 5 s force-close grace) keeps the failing state
 * deterministic: without the fix this test fails (close never resolves), with
 * the fix it resolves in milliseconds.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { connect } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const SECRET = "shutdown-test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Any uncaught exception / unhandled rejection in the server process would
// surface here — assert on the array instead of dying mid-run.
const processErrors = [];
process.on("uncaughtException", (e) => processErrors.push(e));
process.on("unhandledRejection", (e) => processErrors.push(e));

test("close() completes despite an idle keep-alive connection (no hang)", async () => {
  const { createWebhookServer } = await mod("server.js");
  const { GitHubAppClient } = await mod("github.js");
  // The GitHub client is never called in this test — the bare mock exists so
  // the server can be constructed (WebhookDeps requires it).
  const mock = createServer(() => {});
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new GitHubAppClient({
    appId: "1",
    privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
    baseUrl: `http://127.0.0.1:${mock.address().port}`,
  });

  const srv = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });

  // Hold an idle keep-alive socket open — no HTTP request is ever sent.
  const sock = connect(srv.port, "127.0.0.1");
  await new Promise((res, rej) => {
    sock.once("connect", res);
    sock.once("error", rej);
  });

  let closed = false;
  const closing = srv.close().then(() => {
    closed = true;
  });
  try {
    // Bounded: 2 s < the 5 s force-close grace, so ONLY closeIdleConnections
    // (the real fix) can resolve close() while the socket is still open. On
    // unfixed code this races to the timeout and the assert fails — red.
    await Promise.race([closing, sleep(2_000)]);
    assert.equal(closed, true, "close() must not hang on an idle keep-alive socket");
  } finally {
    sock.destroy();
    await closing.catch(() => {});
    await new Promise((r) => mock.close(r));
  }
});

test("after close(), the server stops accepting new connections", async () => {
  const { createWebhookServer } = await mod("server.js");
  const { GitHubAppClient } = await mod("github.js");
  const mock = createServer(() => {});
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new GitHubAppClient({
    appId: "1",
    privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
    baseUrl: `http://127.0.0.1:${mock.address().port}`,
  });

  const srv = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });
  await srv.close();
  await new Promise((r) => mock.close(r));

  // connect() must fail now — the listener is gone
  await assert.rejects(
    () =>
      new Promise((res, rej) => {
        const s = connect(srv.port, "127.0.0.1", res);
        s.once("error", rej);
      }),
    "connection to a closed server must be refused",
  );
});

// ---------------------------------------------------------------------------
// In-flight and force-grace semantics (TDD-pinned): close() must spare a
// request that is being processed (response delivered), resolve promptly once
// it completes — NOT wait out the force timer — and still resolve when a
// request never completes, via the grace bound.
// ---------------------------------------------------------------------------

describe("close() in-flight and force-grace semantics", () => {
  let mock;
  let mockPort;
  let mockCfg;
  const HEAD = "2".repeat(40);
  const objectPath = ".drift/objects/bb/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json";
  const prComments = { 78: [] };
  const state = { posted: 0 };
  const intentObj = {
    id: "did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    parentId: null,
    author: { type: "AGENT", identifier: "claude", model: "claude-3-5-sonnet" },
    prompt: "add login flow with validation",
    astDelta: [{ filePath: "src/auth.ts", type: "ADDED", summary: "add login handler" }],
    agentState: null,
    verifyCmd: null,
    timestamp: 123,
    gitCommitSha: "",
    signature: "MOCK-SIG",
  };
  const objects = { [objectPath]: intentObj };
  const basePayload = (action) => ({
    action,
    installation: { id: 42 },
    repository: { name: "demo", owner: { login: "lilcipherx" } },
    pull_request: { number: 78, title: "feat: add login", head: { sha: HEAD } },
  });

  before(async () => {
    mock = createServer((req, res) => {
      const u = new URL(req.url, "http://x");
      const path = u.pathname;
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (req.method === "POST" && path.endsWith("/access_tokens")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ token: "mock-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() }));
        }
        if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ head: { sha: HEAD }, title: "feat: add login" }));
        }
        // the hook under test: slow (ms) or never-finishing commits listing
        if (req.method === "GET" && path.match(/\/pulls\/\d+\/commits$/)) {
          if (mockCfg.commitsDelay === "never") return; // never respond
          await sleep(mockCfg.commitsDelay ?? 0);
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify([
            { sha: "d".repeat(40), commit: { message: `chore: add login\n\nDrift-Intent: ${intentObj.id}` } },
          ]));
        }
        if (req.method === "GET" && path.includes("/git/trees/")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ tree: [{ path: objectPath, type: "blob" }] }));
        }
        if (req.method === "GET" && path.includes("/contents/")) {
          const obj = objects[decodeURIComponent(path.split("/contents/")[1].split("?")[0])];
          if (!obj) {
            res.writeHead(404, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ message: "Not Found" }));
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"), encoding: "base64" }));
        }
        const commentsMatch = path.match(/\/issues\/(\d+)\/comments$/);
        if (commentsMatch) {
          const n = Number(commentsMatch[1]);
          if (req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(prComments[n].map(({ id, body: b }) => ({ id, body: b }))));
          }
          if (req.method === "POST") {
            const { body: text } = JSON.parse(body || "{}");
            state.posted++;
            prComments[n].push({ id: 9100 + state.posted, body: text });
            res.writeHead(201, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ id: 9100 + state.posted, body: text }));
          }
        }
        if (req.method === "POST" && path.includes("/check-runs")) {
          res.writeHead(201, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ id: 1 }));
        }
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: `mock: no route ${req.method} ${path}` }));
      });
    });
    await new Promise((r) => mock.listen(0, "127.0.0.1", r));
    mockPort = mock.address().port;
    mockCfg = { commitsDelay: 0 };
  });

  after(async () => {
    // release any connection still held by a never-answering mock route
    mock.closeAllConnections();
    await new Promise((r) => mock.close(r));
  });

  async function startApp(closeGraceMs) {
    const { createWebhookServer } = await mod("server.js");
    const { GitHubAppClient } = await mod("github.js");
    const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const github = new GitHubAppClient({
      appId: "12345",
      privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
      baseUrl: `http://127.0.0.1:${mockPort}`,
    });
    return createWebhookServer({ github, webhookSecret: SECRET, port: 0, closeGraceMs });
  }

  function sendWebhook(hookPort) {
    const raw = JSON.stringify(basePayload("opened"));
    return fetch(`http://127.0.0.1:${hookPort}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`,
      },
      body: raw,
    });
  }

  test("spares an in-flight request and resolves promptly after it completes", async () => {
    mockCfg.commitsDelay = 800; // handler is mid-upstream-call during close()
    const srv = await startApp(); // default 5s grace
    try {
      const posting = sendWebhook(srv.port).then((r) => r.json());
      await sleep(150); // request parsed; handler awaiting the slow commits call

      let closed = false;
      const closing = srv.close().then(() => {
        closed = true;
      });

      const res = await posting; // in-flight request must NOT be cut — response delivered
      assert.equal(res.action, "commented", JSON.stringify(res));
      assert.equal(res.intentsFound, 1);

      await Promise.race([closing, sleep(1_500)]);
      assert.equal(closed, true, "close() must resolve promptly after the in-flight request completes, not wait out the 5s force timer");
      assert.equal(state.posted, 1, "handler must have run to completion");
      assert.equal(processErrors.length, 0, processErrors.map(String).join("\n"));
    } finally {
      await srv.close().catch(() => {});
    }
  });

  test("force-closes a request that never completes, resolving after the grace bound", async () => {
    mockCfg.commitsDelay = "never";
    const srv = await startApp(500); // short grace so the bound is testable
    try {
      sendWebhook(srv.port).catch(() => {}); // never resolves — ignore
      await sleep(150); // handler is now stuck on the never-answering commits call

      let closed = false;
      const t0 = Date.now();
      const closing = srv.close().then(() => {
        closed = true;
      });
      await Promise.race([closing, sleep(2_000)]);
      const elapsed = Date.now() - t0;

      assert.equal(closed, true, "force-close must resolve close() even for a never-finishing in-flight request");
      assert.ok(elapsed >= 400, `resolution should come from the grace timer, not a fast path (got ${elapsed}ms)`);
      assert.equal(processErrors.length, 0, processErrors.map(String).join("\n"));
    } finally {
      // the webhook handler is still awaiting the never-answering mock route;
      // release the mock's connection so the pending GitHub fetch unwinds
      mock.closeAllConnections();
      await srv.close().catch(() => {});
    }
  });
});
