/**
 * Live E2E — client disconnect during webhook processing (PRD §16.3 robustness).
 *
 * The server must survive every abort pattern without an uncaught exception or
 * unhandled rejection (the `sendJson`/timeout guards on `res.destroyed`), and
 * must FINISH processing a delivery whose body it fully read — even though the
 * client is gone and can never receive the response.
 *
 * Determinism: the mock GitHub's commits endpoint for PR 77 sleeps 600 ms, so a
 * client that aborts ~100 ms after sending the body disconnects while the
 * handler is mid-upstream-call. The comment landing afterwards proves the
 * handler ran to completion.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const SECRET = "abort-test-secret";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ID1 = "did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_SLOW = "1".repeat(40); // PR 77 — slow mock commits endpoint
const objectPath = ".drift/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json";

const prComments = { 77: [] };
const state = { posted: 0, checkRuns: 0 };

// Any uncaught exception / unhandled rejection in the server process would
// surface here (Node stops crashing when a listener is attached, so we can
// assert on the array instead of dying mid-run).
const processErrors = [];
process.on("uncaughtException", (e) => processErrors.push(e));
process.on("unhandledRejection", (e) => processErrors.push(e));

const intentObj = {
  id: ID1,
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

const basePayload = (action, headSha) => ({
  action,
  installation: { id: 42 },
  repository: { name: "demo", owner: { login: "lilcipherx" } },
  pull_request: { number: 77, title: "feat: add login", head: { sha: headSha } },
});

function sign(raw) {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let mock;
let mockPort;
let webhook;
let hookPort;

before(async () => {
  mock = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.method === "POST" && path.endsWith("/access_tokens")) {
        return json(res, 201, { token: "mock-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() });
      }
      if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
        return json(res, 200, { head: { sha: HEAD_SLOW }, title: "feat: add login" });
      }
      if (req.method === "GET" && path.match(/\/pulls\/\d+\/files$/)) {
        return json(res, 200, []);
      }
      // PR 77 commits are deliberately slow — the abort window lives here.
      if (req.method === "GET" && path.match(/\/pulls\/\d+\/commits$/)) {
        await sleep(600);
        return json(res, 200, [
          { sha: "c".repeat(40), commit: { message: `chore: add login\n\nDrift-Intent: ${ID1}` } },
        ]);
      }
      if (req.method === "GET" && path.includes("/git/trees/")) {
        return json(res, 200, { tree: [{ path: objectPath, type: "blob" }] });
      }
      if (req.method === "GET" && path.includes("/contents/")) {
        const obj = objects[decodeURIComponent(path.split("/contents/")[1].split("?")[0])];
        if (!obj) return json(res, 404, { message: "Not Found" });
        return json(res, 200, { content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"), encoding: "base64" });
      }
      const commentsMatch = path.match(/\/issues\/(\d+)\/comments$/);
      if (commentsMatch) {
        const n = Number(commentsMatch[1]);
        if (req.method === "GET") return json(res, 200, prComments[n].map(({ id, body: b }) => ({ id, body: b })));
        if (req.method === "POST") {
          const { body: text } = JSON.parse(body || "{}");
          state.posted++;
          prComments[n].push({ id: 9000 + state.posted, body: text });
          return json(res, 201, { id: 9000 + state.posted, body: text });
        }
      }
      if (req.method === "POST" && path.includes("/check-runs")) {
        state.checkRuns++;
        return json(res, 201, { id: state.checkRuns });
      }
      json(res, 404, { message: `mock: no route ${req.method} ${path}` });
    });
  });
  await new Promise((r) => mock.listen(0, "127.0.0.1", r));
  mockPort = mock.address().port;

  const { createWebhookServer } = await mod("server.js");
  const { GitHubAppClient } = await mod("github.js");
  const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const github = new GitHubAppClient({
    appId: "12345",
    privateKeyPem: key.privateKey.export({ type: "pkcs1", format: "pem" }),
    baseUrl: `http://127.0.0.1:${mockPort}`,
  });
  webhook = await createWebhookServer({ github, webhookSecret: SECRET, port: 0 });
  hookPort = webhook.port;
});

after(async () => {
  await webhook.close();
  await new Promise((r) => mock.close(r));
});

function openRawRequest(raw) {
  return httpRequest({
    host: "127.0.0.1",
    port: hookPort,
    path: "/webhook",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(raw),
    },
  });
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${hookPort}/health`);
  return res.status;
}

describe("client abort during webhook processing", () => {
  test("abort after full body, mid-upstream-call: handler finishes, no crash", async () => {
    const raw = JSON.stringify(basePayload("opened", HEAD_SLOW));
    const req = openRawRequest(raw);
    req.on("error", () => {}); // expected after destroy
    req.write(raw);
    req.end();

    // Body lands on loopback in ms; the handler then blocks on the slow mock
    // commits call. Tear the connection down while it is in-flight.
    await sleep(100);
    req.destroy();

    // The handler must still run to completion: slow mock answers at ~600 ms,
    // comment + check run land, and the guarded sendJson drops the response.
    await sleep(900);
    assert.equal(prComments[77].length, 1, "fully-read delivery must be processed despite the disconnect");
    assert.equal(state.posted, 1);
    assert.equal(state.checkRuns, 1);
    assert.equal(processErrors.length, 0, processErrors.map(String).join("\n"));
    assert.equal(await health(), 200, "server must stay up");
  });

  test("abort mid-body: no crash, server stays up and answers", async () => {
    const raw = JSON.stringify(basePayload("opened", HEAD_SLOW));
    const req = openRawRequest(raw);
    req.on("error", () => {});
    req.write(raw.slice(0, Math.floor(raw.length / 2)));
    await sleep(30);
    req.destroy(); // connection torn down before the body completes

    await sleep(400);
    assert.equal(processErrors.length, 0, processErrors.map(String).join("\n"));
    assert.equal(await health(), 200);
  });

  test("RST-style abort (socket destroy) during processing: no crash", async () => {
    const raw = JSON.stringify(basePayload("opened", HEAD_SLOW));
    const req = openRawRequest(raw);
    req.on("error", () => {});
    req.write(raw);
    req.end();
    await sleep(100);
    req.socket.destroy(); // hard reset, not a clean half-close

    await sleep(900);
    assert.equal(processErrors.length, 0, processErrors.map(String).join("\n"));
    assert.equal(await health(), 200);
  });
});
