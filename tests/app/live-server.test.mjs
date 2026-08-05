/**
 * Live E2E for drift-app webhook server:
 * real `createWebhookServer` + real `GitHubAppClient` (RS256 JWT) pointed at
 * a local mock GitHub API over HTTP. Exercises real pull_request payloads:
 * opened, synchronize (idempotent update), commit pagination via Link header,
 * oversized body → 413, bad HMAC, non-PR events, health.
 */

import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);

const SECRET = "test-webhook-secret";

// ---------------------------------------------------------------- mock GitHub
const state = { comments: [], posted: 0, updated: 0, checkRuns: 0, log: [] };
const ID1 = "did_11111111111111111111111111111111";
const ID2 = "did_22222222222222222222222222222222";
const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const objectPath1 = ".drift/objects/11/1111111111111111111111111111111111111111.json";
const objectPath2 = ".drift/objects/22/2222222222222222222222222222222222222222.json";

const intentObj = (id, prompt, file) => ({
  id,
  parentId: null,
  author: { type: "AGENT", identifier: "claude", model: "claude-3-5-sonnet" },
  prompt,
  astDelta: [{ filePath: file, type: "ADDED", summary: "add login handler" }],
  agentState: null,
  verifyCmd: null,
  timestamp: 123,
  gitCommitSha: "",
  signature: "MOCK-SIG",
});

const objects = {
  [objectPath1]: intentObj(ID1, "add login flow with validation", "src/auth.ts"),
  [objectPath2]: intentObj(ID2, "wire token refresh middleware", "src/token.ts"),
};

// page 1: 100 commits, only ID1 trailer; page 2: 50 commits, only ID2 trailer
const commit = (n, id) => ({
  sha: `c${String(n).padStart(39, "0")}`,
  commit: { message: `chore: commit ${n}\n\nDrift-Intent: ${id}` },
});
const commitsPage1 = Array.from({ length: 100 }, (_, i) => commit(i, ID1));
const commitsPage2 = Array.from({ length: 50 }, (_, i) => commit(i + 100, ID2));

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let mock; // http.Server
let mockPort;
let webhook; // { port, close }
let hookPort;

const basePayload = (action, headSha) => ({
  action,
  installation: { id: 42 },
  repository: { name: "demo", owner: { login: "lilcipherx" } },
  pull_request: { number: 7, title: "feat: add login", head: { sha: headSha } },
});

function sign(raw) {
  return `sha256=${createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;
}

async function sendWebhook(eventName, payload, opts = {}) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`http://127.0.0.1:${hookPort}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventName,
      "x-hub-signature-256": opts.signature ?? sign(raw),
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

before(async () => {
  mock = createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const path = u.pathname;
    state.log.push(`${req.method} ${path}${u.search}`);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && path.endsWith("/access_tokens")) {
        return json(res, 201, {
          token: "mock-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
        return json(res, 200, { head: { sha: HEAD1 }, title: "feat: add login" });
      }
      if (req.method === "GET" && path.includes("/pulls/7/commits")) {
        const page = u.searchParams.get("page") ?? "1";
        if (page === "2") return json(res, 200, commitsPage2);
        const base = `${u.protocol}//${u.host}${path}`;
        res.writeHead(200, {
          "Content-Type": "application/json",
          Link: `<${base}?page=2&per_page=100>; rel="next"`,
        });
        return res.end(JSON.stringify(commitsPage1));
      }
      if (req.method === "GET" && path.includes("/git/trees/")) {
        return json(res, 200, {
          tree: [
            { path: objectPath1, type: "blob" },
            { path: objectPath2, type: "blob" },
          ],
        });
      }
      if (req.method === "GET" && path.includes("/contents/")) {
        const obj = objects[decodeURIComponent(path.split("/contents/")[1].split("?")[0])];
        if (!obj) return json(res, 404, { message: "Not Found" });
        return json(res, 200, {
          content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"),
          encoding: "base64",
        });
      }
      if (req.method === "GET" && path.includes("/issues/7/comments")) {
        return json(res, 200, state.comments.map(({ id, body }) => ({ id, body })));
      }
      if (req.method === "POST" && path.includes("/issues/7/comments")) {
        const { body: text } = JSON.parse(body || "{}");
        state.posted++;
        state.comments.push({ id: 1000 + state.posted, body: text });
        return json(res, 201, { id: 1000 + state.posted, body: text });
      }
      if (req.method === "PATCH" && path.includes("/issues/comments/")) {
        const id = Number(path.split("/").pop());
        const { body: text } = JSON.parse(body || "{}");
        state.updated++;
        const c = state.comments.find((x) => x.id === id);
        if (c) c.body = text;
        return json(res, 200, { id, body: text });
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

// ------------------------------------------------------------- 1) opened
test("opened: posts summary comment, pagination finds page-2 trailer", async () => {
  const { SUMMARY_MARKER } = await mod("summarize.js");
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD1));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.action, "commented");
  assert.equal(r.data.intentsFound, 2, "page-2 trailer must be found via pagination");
  assert.equal(state.posted, 1);
  assert.ok(state.comments.some((c) => c.body.includes(SUMMARY_MARKER)));
  assert.ok(state.comments.some((c) => c.body.includes("Drift intent summary")));
  assert.equal(state.checkRuns, 1);
  assert.ok(state.log.some((l) => l.includes("page=2")), state.log.join(" | "));
  assert.ok(state.log.some((l) => l.includes("access_tokens")));
});

// ------------------------------------------------------------- 2) synchronize
test("synchronize: updates the existing comment in place (PATCH, not POST)", async () => {
  const r = await sendWebhook("pull_request", basePayload("synchronize", HEAD2));
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "updated");
  assert.equal(state.updated, 1);
  assert.equal(state.posted, 1);
  assert.equal(state.comments.length, 1);
});

// ------------------------------------------------------------- 3) idempotent retry
test("retry: repeated delivery still keeps exactly one comment", async () => {
  const r = await sendWebhook("pull_request", basePayload("synchronize", HEAD2));
  assert.equal(r.data.action, "updated");
  assert.equal(state.updated, 2);
  assert.equal(state.posted, 1);
  assert.equal(state.comments.length, 1);
});

// ------------------------------------------------------------- 4) bad signature
test("bad HMAC signature: acked as error, not retryable", async () => {
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD1), {
    signature: "sha256=deadbeef",
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "error");
  assert.equal(r.data.error, "invalid webhook signature");
  assert.equal(r.data.retryable, false);
});

// ------------------------------------------------------------- 5) non-PR event
test("non-PR event (ping): skipped", async () => {
  const r = await sendWebhook("ping", { zen: "keep it simple" });
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "skipped");
});

// ------------------------------------------------------------- 6) oversized body
test("oversized body → HTTP 413 with JSON error", async () => {
  const big = JSON.stringify({ action: "opened", padding: "x".repeat(9 * 1024 * 1024) });
  const res = await fetch(`http://127.0.0.1:${hookPort}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-hub-signature-256": sign(big),
    },
    body: big,
  });
  assert.equal(res.status, 413);
  const data = await res.json();
  assert.equal(data.error, "request body too large");
});

// ------------------------------------------------------------- 7) health
test("GET /health answers 200", async () => {
  const health = await fetch(`http://127.0.0.1:${hookPort}/health`);
  assert.equal(health.status, 200);
});
