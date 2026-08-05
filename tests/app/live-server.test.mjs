/**
 * Live E2E for drift-app webhook server:
 * real `createWebhookServer` + real `GitHubAppClient` (RS256 JWT) pointed at
 * a local mock GitHub API over HTTP. Exercises real pull_request payloads:
 * opened, reopened, synchronize (idempotent update), commit pagination via
 * Link header, missing installation.id, missing intent object (subject
 * fallback), no Drift-Intent trailers, oversized body → 413, bad HMAC,
 * non-PR events, health.
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
const ID1 = "did_11111111111111111111111111111111";
const ID2 = "did_22222222222222222222222222222222";
const ID3 = "did_33333333333333333333333333333333"; // object missing → subject fallback
const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const HEAD3 = "c".repeat(40); // PR 8 head
const HEAD4 = "d".repeat(40); // PR 9 head
const objectPath1 = ".drift/objects/11/1111111111111111111111111111111111111111.json";
const objectPath2 = ".drift/objects/22/2222222222222222222222222222222222222222.json";
// NOTE: objectPath3 deliberately has NO entry in `objects` below
const objectPath3 = ".drift/objects/33/3333333333333333333333333333333333333333.json";

// per-PR comment stores (id ascending) + global counters
const prComments = { 7: [], 8: [], 9: [] };
let nextCommentId = 1000;
const state = { posted: 0, updated: 0, checkRuns: 0, log: [] };

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
// PR 8: one commit with a trailer whose object is missing
const commitsPr8 = [
  { sha: "e".repeat(40), commit: { message: `fallback subject here\n\nDrift-Intent: ${ID3}` } },
];
// PR 9: one commit with no Drift-Intent trailer
const commitsPr9 = [{ sha: "f".repeat(40), commit: { message: "plain chore without intents" } }];

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

let mock; // http.Server
let mockPort;
let webhook; // { port, close }
let hookPort;

const basePayload = (action, headSha, prNumber = 7) => ({
  action,
  installation: { id: 42 },
  repository: { name: "demo", owner: { login: "lilcipherx" } },
  pull_request: { number: prNumber, title: "feat: add login", head: { sha: headSha } },
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
      // pull request head by number
      if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
        const n = Number(path.split("/").pop());
        const sha = { 7: HEAD1, 8: HEAD3, 9: HEAD4 }[n] ?? HEAD1;
        return json(res, 200, { head: { sha }, title: "feat: add login" });
      }
      // commits by PR: 7 → paginated (100 + 50), 8 → fallback, 9 → no trailers
      const commitsMatch = req.method === "GET" && path.match(/\/pulls\/(\d+)\/commits$/);
      if (commitsMatch) {
        const n = Number(commitsMatch[1]);
        if (n === 8) return json(res, 200, commitsPr8);
        if (n === 9) return json(res, 200, commitsPr9);
        const page = u.searchParams.get("page") ?? "1";
        if (page === "2") return json(res, 200, commitsPage2);
        const base = `${u.protocol}//${u.host}${path}`;
        res.writeHead(200, {
          "Content-Type": "application/json",
          Link: `<${base}?page=2&per_page=100>; rel="next"`,
        });
        return res.end(JSON.stringify(commitsPage1));
      }
      // trees: PR 8 head references the missing object path, others the two real ones
      if (req.method === "GET" && path.includes("/git/trees/")) {
        const tree =
          path.includes(HEAD3) ? [{ path: objectPath3, type: "blob" }] :
          [
            { path: objectPath1, type: "blob" },
            { path: objectPath2, type: "blob" },
          ];
        return json(res, 200, { tree });
      }
      if (req.method === "GET" && path.includes("/contents/")) {
        const obj = objects[decodeURIComponent(path.split("/contents/")[1].split("?")[0])];
        if (!obj) return json(res, 404, { message: "Not Found" });
        return json(res, 200, {
          content: Buffer.from(JSON.stringify(obj), "utf8").toString("base64"),
          encoding: "base64",
        });
      }
      // issue comments per PR
      const commentsMatch = path.match(/\/issues\/(\d+)\/comments$/);
      if (commentsMatch) {
        const n = Number(commentsMatch[1]);
        if (req.method === "GET") {
          return json(res, 200, prComments[n].map(({ id, body }) => ({ id, body })));
        }
        if (req.method === "POST") {
          const { body: text } = JSON.parse(body || "{}");
          state.posted++;
          prComments[n].push({ id: nextCommentId, body: text });
          return json(res, 201, { id: nextCommentId++, body: text });
        }
      }
      if (req.method === "PATCH" && path.includes("/issues/comments/")) {
        const id = Number(path.split("/").pop());
        const { body: text } = JSON.parse(body || "{}");
        state.updated++;
        for (const list of Object.values(prComments)) {
          const c = list.find((x) => x.id === id);
          if (c) {
            c.body = text;
            break;
          }
        }
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
  assert.ok(prComments[7].some((c) => c.body.includes(SUMMARY_MARKER)));
  assert.ok(prComments[7].some((c) => c.body.includes("Drift intent summary")));
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
  assert.equal(prComments[7].length, 1);
});

// ------------------------------------------------------------- 3) idempotent retry
test("retry: repeated delivery still keeps exactly one comment", async () => {
  const r = await sendWebhook("pull_request", basePayload("synchronize", HEAD2));
  assert.equal(r.data.action, "updated");
  assert.equal(state.updated, 2);
  assert.equal(state.posted, 1);
  assert.equal(prComments[7].length, 1);
});

// ------------------------------------------------------------- 3b) reopened
test("reopened: treated like opened (updates the existing comment)", async () => {
  const r = await sendWebhook("pull_request", basePayload("reopened", HEAD2));
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "updated");
  assert.equal(state.updated, 3);
  assert.equal(state.posted, 1);
  assert.equal(prComments[7].length, 1);
});

// ------------------------------------------------------------- 3c) missing installation.id
test("payload without installation.id: clean error, not retryable", async () => {
  const payload = basePayload("opened", HEAD1);
  delete payload.installation;
  const postedBefore = state.posted;
  const checkRunsBefore = state.checkRuns;
  const r = await sendWebhook("pull_request", payload);
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "error");
  assert.equal(r.data.error, "no installation id in payload");
  assert.equal(r.data.retryable, false);
  // nothing was written for this request
  assert.equal(state.posted, postedBefore);
  assert.equal(state.checkRuns, checkRunsBefore);
});

// ------------------------------------------------------------- 3d) object missing → subject fallback
test("intent object missing: falls back to the commit subject as prompt", async () => {
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD3, 8));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.action, "commented");
  assert.equal(r.data.intentsFound, 1);
  assert.equal(prComments[8].length, 1);
  assert.ok(prComments[8][0].body.includes("fallback subject here"), prComments[8][0].body);
  assert.equal(state.posted, 2);
});

// ------------------------------------------------------------- 3e) no Drift-Intent trailers
test("PR without Drift-Intent trailers: no-intents, nothing written", async () => {
  const postedBefore = state.posted;
  const checkRunsBefore = state.checkRuns;
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD4, 9));
  assert.equal(r.status, 200);
  assert.equal(r.data.action, "no-intents");
  assert.equal(r.data.intentsFound, 0);
  assert.equal(prComments[9].length, 0);
  assert.equal(state.posted, postedBefore, "no comment must be posted");
  assert.equal(state.checkRuns, checkRunsBefore, "no check run must be created");
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
