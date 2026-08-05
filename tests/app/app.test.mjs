/**
 * drift-app tests: trailer extraction, summary building, HMAC verification,
 * JWT creation, the webhook handler with a fake GitHub client, and an HTTP
 * server smoke test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { deriveMasterKey, encryptAesGcm } from "@drift/core";

// The app package exposes its internals via its built dist modules (index.ts
// is the CLI entrypoint and must not be imported).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);
const { extractIntentIds, fetchIntents, decryptPrompt } = await mod("intents.js");
const { summarizeIntents } = await mod("summarize.js");
const { verifyWebhookSignature, handleWebhook } = await mod("handler.js");
const { createAppJwt, decodeJwt } = await mod("jwt.js");
const { createWebhookServer } = await mod("server.js");

// ------------------------------------------------------------- unit: trailers
test("extractIntentIds: parses Drift-Intent trailers across commits, dedupes", () => {
  const commits = [
    { sha: "a", message: "Add TokenPayload\n\nDrift-Intent: did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { sha: "b", message: "Fix race\n\nDrift-Intent: did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nDrift-Intent: did_cccccccccccccccccccccccccccccccc" },
    { sha: "c", message: "no trailer here" },
  ];
  assert.deepEqual(extractIntentIds(commits), [
    "did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "did_cccccccccccccccccccccccccccccccc",
  ]);
});

test("extractIntentIds: empty when no trailers", () => {
  assert.deepEqual(extractIntentIds([{ sha: "x", message: "plain commit" }]), []);
});

// --------------------------------------------------------- unit: decryptPrompt
test("decryptPrompt: plaintext passthrough, encrypted needs key + aad", () => {
  assert.deepEqual(decryptPrompt("plain prompt"), { prompt: "plain prompt", encrypted: false });
  const key = deriveMasterKey("ab".repeat(32));
  const enc = encryptAesGcm("top secret", key, "did_a");
  assert.deepEqual(decryptPrompt(enc), { prompt: "🔒 [encrypted]", encrypted: true });
  assert.deepEqual(decryptPrompt(enc, "ab".repeat(32), "did_a"), { prompt: "top secret", encrypted: true });
  assert.equal(decryptPrompt(enc, "ab".repeat(32), "did_wrong").prompt, "🔒 [encrypted: invalid key]");
});

// ------------------------------------------------------------- unit: summarize
test("summarizeIntents: groups intents with prompt, model and file table", () => {
  const body = summarizeIntents({
    owner: "lilcipherx",
    repo: "drift",
    prNumber: 7,
    prTitle: "Fix race",
    intents: [
      {
        id: "did_43102f533af8feb75e084d07b670c29c",
        authorType: "AGENT",
        authorId: "Drift Demo",
        model: "claude-3-5-sonnet",
        prompt: "Fix race condition in token refresh",
        encryptedPrompt: false,
        verifyCmd: null,
        signature: true,
        files: [{ path: "src/auth.ts", mutationType: "ADDED", summary: 'function "refreshToken" added (line 12)' }],
      },
    ],
  });
  assert.ok(body.includes("Drift intent summary"));
  assert.ok(body.includes("did_4310…"));
  assert.ok(body.includes("Fix race condition in token refresh"));
  assert.ok(body.includes("claude-3-5-sonnet"));
  assert.ok(body.includes("| `src/auth.ts` | **ADDED**"));
});

test("summarizeIntents: marks encrypted prompts", () => {
  const body = summarizeIntents({
    owner: "o", repo: "r", prNumber: 1, prTitle: "t",
    intents: [{ id: "did_11111111111111111111111111111111", authorType: "AGENT", authorId: "a", model: null, prompt: "🔒 [encrypted]", encryptedPrompt: true, verifyCmd: null, signature: true, files: [] }],
  });
  assert.ok(body.includes("🔒"));
});

// ------------------------------------------------------- unit: webhook sig
test("verifyWebhookSignature: valid, invalid, missing", () => {
  const secret = "webhook-secret";
  const body = JSON.stringify({ action: "opened" });
  const good = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
  assert.equal(verifyWebhookSignature(body, good, secret), true);
  assert.equal(verifyWebhookSignature(body, "sha256=deadbeef", secret), false);
  assert.equal(verifyWebhookSignature(body, undefined, secret), false);
});

// ---------------------------------------------------------------- unit: JWT
test("createAppJwt: RS256 header, iss/iat/exp claims, TTL capped at 600s", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = createAppJwt("12345", pem);
  const { header, payload } = decodeJwt(token);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.ok(payload.exp - payload.iat <= 600);
  const long = createAppJwt("12345", pem, 900);
  const longClaims = decodeJwt(long).payload;
  assert.ok(longClaims.exp - longClaims.iat <= 600);
  void publicKey;
});

// ------------------------------------------------------- handler (fake GH)
class FakeGitHub {
  constructor(commits, objects, existingComments = []) {
    this.commits = commits;
    this.objects = objects;
    // issue comments already on the PR (id ascending)
    this.existing = existingComments.map((body, i) => ({ id: i + 1, body }));
    this.nextId = this.existing.length + 1;
    this.calls = { comments: [], checks: [], updates: [] };
    this.installation = null;
  }
  setInstallation(id) { this.installation = id; }
  async getPullCommits() { return this.commits; }
  async getObjectPaths() { return Object.keys(this.objects); }
  async getFileContent(owner, repo, path) { return this.objects[path] ?? null; }
  async listIssueComments() { return [...this.existing]; }
  async postComment(owner, repo, issueNumber, body) {
    this.calls.comments.push({ issueNumber, body });
    this.existing.push({ id: this.nextId++, body });
  }
  async updateComment(owner, repo, commentId, body) {
    this.calls.updates.push({ commentId, body });
    const c = this.existing.find((x) => x.id === commentId);
    if (c) c.body = body;
  }
  async createCheckRun(owner, repo, input) { this.calls.checks.push(input); }
}

const INTENT_ID = "did_43102f533af8feb75e084d07b670c29c";
const PAYLOAD = {
  action: "opened",
  installation: { id: 77 },
  repository: { name: "drift", owner: { login: "lilcipherx" } },
  pull_request: { number: 7, title: "Fix race", head: { sha: "abc123def" } },
};

function eventFor(payload, raw = JSON.stringify(payload)) {
  return { event: "pull_request", payload, rawBody: raw };
}

test("handler: readOnly (dev --dry-run) builds the summary without writing", async () => {
  const commits = [{ sha: "abc123def", message: `Fix race condition in token refresh\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/64/b1.json": JSON.stringify({
      id: INTENT_ID,
      prompt: "Fix race condition in token refresh by de-duplicating in-flight refreshes",
      author: { type: "AGENT", identifier: "Drift Demo", model: "claude-3-5-sonnet" },
      astDelta: [{ filePath: "src/auth.ts", type: "ADDED", nodeIds: [], summary: 'function "refreshToken" added (line 12)' }],
      signature: "fake-ed25519",
    }),
  };
  const github = new FakeGitHub(commits, objects);
  const result = await handleWebhook(eventFor(PAYLOAD), { github, readOnly: true });
  assert.equal(result.action, "dry-run");
  assert.equal(result.intentsFound, 1);
  assert.ok(result.commentBody.includes("Drift intent summary"));
  assert.ok(result.commentBody.includes("de-duplicating in-flight refreshes"));
  // nothing was written: no comment, no check run
  assert.equal(github.calls.comments.length, 0);
  assert.equal(github.calls.updates.length, 0);
  assert.equal(github.calls.checks.length, 0);
});

test("handler: posts intent summary comment + check run", async () => {
  const commits = [{ sha: "abc123def", message: `Fix race condition in token refresh\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/64/b1b7db2e1546464c729a960997cd3eae7af102613f2d66b6ff3062ea3dee5d.json": JSON.stringify({
      id: INTENT_ID,
      prompt: "Fix race condition in token refresh by de-duplicating in-flight refreshes",
      author: { type: "AGENT", identifier: "Drift Demo", model: "claude-3-5-sonnet" },
      astDelta: [{ filePath: "src/auth.ts", type: "ADDED", nodeIds: [], summary: 'function "refreshToken" added (line 12)' }],
      signature: "fake-ed25519",
    }),
  };
  const github = new FakeGitHub(commits, objects);
  const result = await handleWebhook(eventFor(PAYLOAD), { github, checkRun: true });
  assert.equal(result.action, "commented");
  assert.equal(result.intentsFound, 1);
  assert.equal(github.installation, 77);
  assert.equal(github.calls.comments.length, 1);
  assert.equal(github.calls.comments[0].issueNumber, 7);
  assert.ok(github.calls.comments[0].body.includes("Drift intent summary"));
  assert.ok(github.calls.comments[0].body.includes("de-duplicating in-flight refreshes"));
  // the summary embeds the idempotency marker
  assert.ok(github.calls.comments[0].body.includes("<!-- drift:summary -->"));
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].headSha, "abc123def");
});

test("handler: decrypts encrypted prompts with DRIFT_MASTER_KEY", async () => {
  const key = deriveMasterKey("ab".repeat(32));
  const encPrompt = encryptAesGcm("secret agent prompt", key, INTENT_ID);
  const commits = [{ sha: "s1", message: `secret work\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/aa/bb.json": JSON.stringify({
      id: INTENT_ID,
      prompt: encPrompt,
      author: { type: "AGENT", identifier: "Agent", model: "m1" },
      astDelta: [],
      signature: "sig",
    }),
  };
  const github = new FakeGitHub(commits, objects);
  const result = await handleWebhook(eventFor(PAYLOAD), { github, masterKey: "ab".repeat(32) });
  assert.equal(result.action, "commented");
  assert.ok(result.commentBody.includes("secret agent prompt"));
  // without the key the same intent shows as encrypted
  const github2 = new FakeGitHub(commits, objects);
  const result2 = await handleWebhook(eventFor(PAYLOAD), { github: github2 });
  assert.ok(result2.commentBody.includes("🔒"));
});

test("handler: no intents → no comment", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "plain commit" }], {});
  const result = await handleWebhook(eventFor(PAYLOAD), { github });
  assert.equal(result.action, "no-intents");
  assert.equal(github.calls.comments.length, 0);
});

test("handler: rejects wrong signature and non-PR events", async () => {
  const github = new FakeGitHub([], {});
  const bad = await handleWebhook(
    { ...eventFor(PAYLOAD), signature: "sha256=nope" },
    { github, webhookSecret: "s3cret" },
  );
  assert.equal(bad.action, "error");
  const push = await handleWebhook({ ...eventFor(PAYLOAD), event: "push" }, { github });
  assert.equal(push.action, "skipped");
});

test("handler: synchronize updates the existing Drift comment instead of posting", async () => {
  const commits = [{ sha: "abc123def", message: `Fix race condition in token refresh\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/64/b1.json": JSON.stringify({
      id: INTENT_ID,
      prompt: "Fix race condition in token refresh by de-duplicating in-flight refreshes",
      author: { type: "AGENT", identifier: "Drift Demo", model: "claude-3-5-sonnet" },
      astDelta: [],
      signature: "fake-ed25519",
    }),
  };
  const existing = [`old draft\n<!-- drift:summary -->\n(previous summary)`, "a human comment, no marker"];
  const github = new FakeGitHub(commits, objects, existing);
  const result = await handleWebhook(
    { ...eventFor(PAYLOAD), payload: { ...PAYLOAD, action: "synchronize" } },
    { github },
  );
  assert.equal(result.action, "updated");
  // updated in place: 2 updates? no — exactly one PATCH on the marker comment
  assert.equal(github.calls.updates.length, 1);
  assert.equal(github.calls.updates[0].commentId, 1);
  assert.ok(github.calls.updates[0].body.includes("de-duplicating in-flight refreshes"));
  // no new comment was posted, the human comment is untouched
  assert.equal(github.calls.comments.length, 0);
  assert.equal(github.existing.length, 2);
  assert.equal(github.existing[1].body, "a human comment, no marker");
});

test("handler: synchronize with no prior Drift comment posts a new one", async () => {
  const commits = [{ sha: "s", message: `Add validation\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/aa/bb.json": JSON.stringify({
      id: INTENT_ID,
      prompt: "Add JWT validation",
      author: { type: "AGENT", identifier: "Bot", model: "m" },
      astDelta: [],
      signature: "sig",
    }),
  };
  const github = new FakeGitHub(commits, objects, ["just a human comment"]);
  const result = await handleWebhook(
    { ...eventFor(PAYLOAD), payload: { ...PAYLOAD, action: "synchronize" } },
    { github },
  );
  assert.equal(result.action, "commented");
  assert.equal(github.calls.comments.length, 1);
  assert.equal(github.calls.updates.length, 0);
});

test("fetchIntents: falls back to commit subject when object missing", async () => {
  const commits = [{ sha: "s", message: `Fallback subject here\n\nDrift-Intent: ${INTENT_ID}` }];
  const github = new FakeGitHub(commits, {}); // no objects
  const views = await fetchIntents(github, "lilcipherx", "drift", "s", commits, [INTENT_ID]);
  assert.equal(views[0].prompt, "Fallback subject here");
  assert.equal(views[0].files.length, 0);
  assert.equal(views[0].signature, false);
});

// ------------------------------------------------------------ server smoke
test("webhook server: POST /webhook with valid signature returns 200 + posts comment", async () => {
  const commits = [{ sha: "abc123def", message: `Add JWT validation\n\nDrift-Intent: ${INTENT_ID}` }];
  const objects = {
    ".drift/objects/aa/cc.json": JSON.stringify({
      id: INTENT_ID,
      prompt: "Add JWT validation to auth middleware",
      author: { type: "AGENT", identifier: "Bot", model: "deepseek" },
      astDelta: [{ filePath: "src/auth.ts", type: "MODIFIED", nodeIds: [], summary: 'function "verifyToken" modified' }],
      signature: "sig",
    }),
  };
  const github = new FakeGitHub(commits, objects);
  const secret = "webhook-secret";
  const { server, port, close } = await createWebhookServer({ github, webhookSecret: secret, port: 0, log: () => {} });
  try {
    const rawBody = JSON.stringify(PAYLOAD);
    const sig = `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": sig },
      body: rawBody,
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.action, "commented");
    assert.equal(github.calls.comments.length, 1);

    // bad signature → client-side error, acked with 200 (not retryable)
    const bad = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=wrong" },
      body: rawBody,
    });
    assert.equal(bad.status, 200);
    const badData = await bad.json();
    assert.equal(badData.action, "error");
    assert.equal(badData.retryable, false);

    // health check
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);
  } finally {
    await close();
    void server;
  }
});

test("webhook server: oversized body is rejected with 413 (not retryable)", async () => {
  const github = new FakeGitHub([], {});
  const { port, close } = await createWebhookServer({ github, port: 0, log: () => {}, maxBodyBytes: 1024 });
  try {
    const big = JSON.stringify({ action: "opened", padding: "x".repeat(4096) });
    const res = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request" },
      body: big,
    });
    assert.equal(res.status, 413);
  } finally {
    await close();
  }
});
