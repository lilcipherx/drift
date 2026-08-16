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
const ID3 = "did_33333333333333333333333333333333"; // manifest missing → subject fallback
const HEAD1 = "a".repeat(40);
const HEAD2 = "b".repeat(40);
const HEAD3 = "c".repeat(40); // PR 8 head
const HEAD4 = "d".repeat(40); // PR 9 head

// per-PR comment stores (id ascending) + global counters
const prComments = { 7: [], 8: [], 9: [] };
let nextCommentId = 1000;
const state = { posted: 0, updated: 0, checkRuns: 0, log: [] };

const manifestObj = (id, summary, file) => ({
  schemaVersion: 1,
  id,
  agent: { type: "AGENT", identifier: "claude", model: "claude-3-5-sonnet" },
  summary,
  files: [{ path: file, mutationType: "ADDED", summary: "add login handler" }],
  timestamp: 123,
  commit: HEAD1,
  signature: "MOCK-SIG",
});

const manifests = {
  [`.drift/public/intents/${ID1}.json`]: manifestObj(ID1, "add login flow with validation", "src/auth.ts"),
  [`.drift/public/intents/${ID2}.json`]: manifestObj(ID2, "wire token refresh middleware", "src/token.ts"),
};

// page 1: 100 commits (pagination) — the FIRST carries the ID1 trailer, the
// rest are plain; page 2: 50 commits — the first carries ID2. Each intent id
// is referenced by exactly one commit (atomic association).
const commit = (n, id) => ({
  sha: `c${String(n).padStart(39, "0")}`,
  commit: {
    message: id
      ? `chore: commit ${n}\n\nDrift-Intent: ${id}`
      : `chore: commit ${n}`,
  },
});
const commitsPage1 = Array.from({ length: 100 }, (_, i) => commit(i, i === 0 ? ID1 : null));
const commitsPage2 = Array.from({ length: 50 }, (_, i) => commit(i + 100, i === 0 ? ID2 : null));
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

const BASE_SHA = "0".repeat(40);
const basePayload = (action, headSha, prNumber = 7) => ({
  action,
  installation: { id: 42 },
  repository: { name: "demo", owner: { login: "lilcipherx" } },
  pull_request: {
    number: prNumber,
    title: "feat: add login",
    head: { sha: headSha },
    base: { sha: BASE_SHA },
  },
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
      // pull request head by number (with metadata for completeness proof)
      if (req.method === "GET" && /\/pulls\/\d+$/.test(path)) {
        const n = Number(path.split("/").pop());
        const sha = { 7: HEAD1, 8: HEAD3, 9: HEAD4 }[n] ?? HEAD1;
        const count = n === 7 ? 150 : n === 8 ? commitsPr8.length : n === 9 ? commitsPr9.length : 150;
        return json(res, 200, {
          head: { sha },
          base: { sha: BASE_SHA },
          commits: count,
          changed_files: 0,
          title: "feat: add login",
        });
      }
      // compare base...head — commits reachable from head but NOT from base
      // (used by the audit to tell a NEW trailer reference from legacy history)
      if (req.method === "GET" && path.includes("/compare/")) {
        const headSha = decodeURIComponent((path.split("...")[1] ?? "").split("?")[0]);
        let list = [];
        if (headSha === HEAD1 || headSha === HEAD2) list = [...commitsPage1, ...commitsPage2];
        else if (headSha === HEAD3) list = commitsPr8;
        else if (headSha === HEAD4) list = commitsPr9;
        return json(res, 200, {
          total_commits: list.length,
          commits: list.map((c) => ({ sha: c.sha })),
        });
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
      // PR files (rename/append-only audit) — none in these fixtures
      const filesMatch = req.method === "GET" && path.match(/\/pulls\/\d+\/files$/);
      if (filesMatch) return json(res, 200, []);
      // contents: public manifests + key.pem only (ADR-009); anything else 404
      if (req.method === "GET" && path.includes("/contents/")) {
        const filePath = decodeURIComponent(path.split("/contents/")[1].split("?")[0]);
        const ref = u.searchParams.get("ref") ?? "";
        const atBase = ref === BASE_SHA;
        // manifests exist only on PR 7's heads (HEAD1/HEAD2); base and the
        // other PR heads have none
        const serveManifests = ref === HEAD1 || ref === HEAD2;
        const manifestObj =
          filePath === ".drift/public/intents"
            ? serveManifests
              ? Object.keys(manifests).map((p) => ({ name: p.split("/").pop() }))
              : []
            : null;
        const obj =
          filePath === ".drift/public/key.pem"
            ? atBase || !serveManifests
              ? null
              : { content: Buffer.from("-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n", "utf8").toString("base64"), encoding: "base64" }
            : manifestObj
              ? manifestObj
              : manifests[filePath] && serveManifests
                ? { content: Buffer.from(JSON.stringify(manifests[filePath]), "utf8").toString("base64"), encoding: "base64" }
                : null;
        if (!obj) return json(res, 404, { message: "Not Found" });
        return json(res, 200, obj);
      }
      // issue comments per PR
      const commentsMatch = path.match(/\/issues\/(\d+)\/comments$/);
      if (commentsMatch) {
        const n = Number(commentsMatch[1]);
        const withOwnership = ({ id, body }) => ({
          id,
          body,
          user: { login: "drift-app[bot]", type: "Bot" },
          performed_via_github_app: { id: 12345 },
        });
        if (req.method === "GET") {
          return json(res, 200, prComments[n].map(withOwnership));
        }
        if (req.method === "POST") {
          const { body: text } = JSON.parse(body || "{}");
          state.posted++;
          prComments[n].push({ id: nextCommentId, body: text });
          return json(res, 201, withOwnership({ id: nextCommentId++, body: text }));
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
  assert.ok(prComments[7].some((c) => c.body.includes("Drift — Why this changed")));
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

// -------------------------------------------- 3d) manifest missing → generic fallback (never the subject)
test("new trailer WITHOUT its manifest is a hard failure (never a neutral fallback)", async () => {
  // PR 8 introduces a Drift-Intent trailer for ID3 but ships NO manifest:
  // the commit is NEW (ahead of base), so this is `trailer-without-manifest`
  // — a failing check run + explicit violation in the comment, while the
  // generic non-prompt fallback still keeps the raw subject out of the body.
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD3, 8));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.conclusion, "failure", "missing manifest for a NEW trailer must fail");
  assert.equal(r.data.intentsFound, 1);
  assert.equal(prComments[8].length, 1);
  assert.ok(prComments[8][0].body.includes("public provenance manifest missing"), prComments[8][0].body);
  assert.ok(prComments[8][0].body.includes("trailer-without-manifest"), "the violation must be visible in the comment");
  assert.ok(!prComments[8][0].body.includes("fallback subject here"), "commit subject must never be rendered as a summary");
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
test("bad HMAC signature: rejected with 401 before any processing", async () => {
  const r = await sendWebhook("pull_request", basePayload("opened", HEAD1), {
    signature: "sha256=deadbeef",
  });
  assert.equal(r.status, 401, JSON.stringify(r.data));
  assert.equal(r.data.error, "invalid or missing webhook signature");
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
