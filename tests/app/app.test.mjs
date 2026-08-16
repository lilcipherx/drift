/**
 * drift-app tests: trailer extraction, public-manifest hydration, summary
 * building, HMAC verification, JWT creation, the webhook handler with a fake
 * GitHub client, and an HTTP server smoke test.
 *
 * ADR-009: the app reads ONLY `.drift/public/` manifests; the full prompt is
 * never loaded, never rendered, never posted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { canonicalJson } from "@drift/core";

// The app package exposes its internals via its built dist modules (index.ts
// is the CLI entrypoint and must not be imported).
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const appDist = join(here, "..", "..", "packages", "drift-app", "dist");
const mod = (name) => import(pathToFileURL(join(appDist, name)).href);
const { extractIntentIds, fetchIntents } = await mod("intents.js");
const { summarizeIntents, SUMMARY_MARKER } = await mod("summarize.js");
const { verifyWebhookSignature, handleWebhook } = await mod("handler.js");
const { createAppJwt, decodeJwt } = await mod("jwt.js");
const { createWebhookServer } = await mod("server.js");

// ------------------------------------------------------------- unit: trailers
test("extractIntentIds: parses Drift-Intent trailers across commits, dedupes, ignores invalid ids", () => {
  const commits = [
    { sha: "a", message: "Add TokenPayload\n\nDrift-Intent: did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    { sha: "b", message: "Fix race\n\nDrift-Intent: did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\nDrift-Intent: did_cccccccccccccccccccccccccccccccc" },
    { sha: "c", message: "no trailer here" },
    { sha: "d", message: "bad id\n\nDrift-Intent: did_NOT_A_REAL_ID" },
    { sha: "e", message: "duplicate\n\nDrift-Intent: did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
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

// ------------------------------------------------------- fixtures (real keys)
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

function signedManifest(body) {
  const { signature: _sig, ...unsigned } = body;
  const signature = nodeSign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64");
  return { ...unsigned, signature };
}

const INTENT_ID = "did_43102f533af8feb75e084d07b670c29c";
const MANIFEST_PATH = `.drift/public/intents/${INTENT_ID}.json`;
const MANIFEST = signedManifest({
  schemaVersion: 1,
  id: INTENT_ID,
  summary: "Fix race condition in token refresh by de-duplicating in-flight refreshes",
  model: "claude-3-5-sonnet",
  agent: { type: "AGENT", identifier: "Drift Demo" },
  verification: "npm test",
  files: [{ path: "src/auth.ts", mutationType: "ADDED", summary: 'function "refreshToken" added (line 12)' }],
  commit: "abc123def",
  timestamp: 1786000000000,
});

function manifestJson(extra = {}) {
  return JSON.stringify({ ...MANIFEST, ...extra });
}

// ------------------------------------------------------------- unit: summarize
test("summarizeIntents: groups intents with safe summary, model and file table — never prompt", () => {
  const body = summarizeIntents({
    owner: "lilcipherx",
    repo: "drift",
    prNumber: 7,
    prTitle: "Fix race",
    intents: [
      {
        id: INTENT_ID,
        authorType: "AGENT",
        authorId: "Drift Demo",
        model: "claude-3-5-sonnet",
        summary: "Fix race condition in token refresh",
        verifyCmd: "npm test",
        signature: true,
        files: [{ path: "src/auth.ts", mutationType: "ADDED", summary: 'function "refreshToken" added (line 12)' }],
      },
    ],
  });
  assert.ok(body.includes("Drift — Why this changed"));
  assert.ok(body.includes("did_43102f5…"));
  assert.ok(body.includes("Fix race condition in token refresh"));
  assert.ok(body.includes("claude-3-5-sonnet"));
  assert.ok(body.includes("- `src/auth.ts` (**ADDED**)"), "files are listed");
  assert.ok(!body.includes("prompt"), "the word prompt must not appear as data");
});

test("summarizeIntents: neutralizes injected markdown, HTML comments, mentions and control chars", () => {
  const body = summarizeIntents({
    owner: "o", repo: "r", prNumber: 1, prTitle: "t",
    intents: [{
      id: "did_11111111111111111111111111111111",
      authorType: "AGENT",
      authorId: "alice",
      model: null,
      summary: "real text <!-- hidden --> @everyone @here\n\x1b[31mred\x1b[0m \x07 bell",
      verifyCmd: null,
      signature: false,
      files: [],
    }],
  });
  assert.ok(body.includes("real text"));
  assert.ok(!body.includes("hidden"), "injected HTML comment content must be neutralized");
  assert.ok(!body.includes("\x1b["), "ANSI escapes must be stripped");
  assert.ok(!body.includes("@everyone") || body.includes("@\u200beveryone"), "mention spam must be neutralized");
  assert.ok(!body.includes("\x07"), "control chars must be stripped");
});

test("summarizeIntents: caps intents, files and summary length", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    id: `did_${String(i).padStart(32, "0")}`,
    authorType: "HUMAN",
    authorId: `a${i}`,
    model: null,
    summary: `s${i}`,
    verifyCmd: null,
    signature: false,
    files: Array.from({ length: 30 }, (_, j) => ({ path: `src/f${j}.ts`, mutationType: "ADDED", summary: null })),
  }));
  const body = summarizeIntents({ owner: "o", repo: "r", prNumber: 1, prTitle: "t", intents: many });
  assert.ok(body.includes("not shown"), "extra intents must be reported as truncated");
  assert.ok(body.split("### Intent").length - 1 <= 10, "max 10 intents shown");
  assert.ok(body.length < 15000, "comment stays bounded");
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
  const { privateKey: rsaKey, publicKey: rsaPub } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = rsaKey.export({ type: "pkcs8", format: "pem" }).toString();
  const token = createAppJwt("12345", pem);
  const { header, payload } = decodeJwt(token);
  assert.equal(header.alg, "RS256");
  assert.equal(payload.iss, "12345");
  assert.ok(payload.exp - payload.iat <= 600);
  const long = createAppJwt("12345", pem, 900);
  const longClaims = decodeJwt(long).payload;
  assert.ok(longClaims.exp - longClaims.iat <= 600);
  void rsaPub;
});

// ------------------------------------------------------- handler (fake GH)
class FakeGitHub {
  constructor(commits, manifests, existingComments = [], opts = {}) {
    this.commits = commits;
    this.manifests = manifests; // path -> JSON string
    this.publicKeyPem = opts.publicKeyPem ?? null;
    // issue comments already on the PR (id ascending)
    this.existing = existingComments.map((body, i) => ({ id: i + 1, body }));
    this.nextId = this.existing.length + 1;
    this.calls = { comments: [], checks: [], updates: [] };
    this.installation = null;
  }
  setInstallation(id) { this.installation = id; }
  async getPullCommits() { return this.commits; }
  async getFileContent(owner, repo, path) {
    if (path === ".drift/public/key.pem") return this.publicKeyPem;
    return this.manifests[path] ?? null;
  }
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
  async listIssueComments() {
    this.calls.list = (this.calls.list ?? 0) + 1;
    return [...this.existing];
  }
}

const PAYLOAD = {
  action: "opened",
  installation: { id: 77 },
  repository: { name: "drift", owner: { login: "lilcipherx" } },
  pull_request: { number: 7, title: "Fix race", head: { sha: "abc123def" } },
};

function eventFor(payload, raw = JSON.stringify(payload)) {
  return { event: "pull_request", payload, rawBody: raw };
}

const COMMITS = [{ sha: "abc123def", message: `Fix race condition in token refresh\n\nDrift-Intent: ${INTENT_ID}` }];

function makeGitHub(opts = {}, manifestOverride = null) {
  return new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestOverride ?? manifestJson() }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    ...opts,
  });
}

test("handler: readOnly (dev --dry-run) builds the summary without writing", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), { github, readOnly: true });
  assert.equal(result.action, "dry-run");
  assert.equal(result.intentsFound, 1);
  assert.ok(result.commentBody.includes("Drift — Why this changed"));
  assert.ok(result.commentBody.includes("de-duplicating in-flight refreshes"));
  assert.ok(!result.commentBody.includes("intent.prompt"));
  // nothing was written: no comment, no check run
  assert.equal(github.calls.comments.length, 0);
  assert.equal(github.calls.updates.length, 0);
  assert.equal(github.calls.checks.length, 0);
  // and dry-run does not even list comments — the summary needs only commits
  assert.equal(github.calls.list ?? 0, 0);
});

test("handler: posts intent summary comment + check run, never the prompt", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), { github, checkRun: true });
  assert.equal(result.action, "commented");
  assert.equal(result.intentsFound, 1);
  assert.equal(github.installation, 77);
  assert.equal(github.calls.comments.length, 1);
  assert.equal(github.calls.comments[0].issueNumber, 7);
  assert.ok(github.calls.comments[0].body.includes("Drift — Why this changed"));
  assert.ok(github.calls.comments[0].body.includes("de-duplicating in-flight refreshes"));
  assert.ok(!github.calls.comments[0].body.includes("PRIVATE_MARKER_NEVER_RENDERED"));
  // the summary embeds the idempotency marker
  assert.ok(github.calls.comments[0].body.includes(SUMMARY_MARKER));
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].headSha, "abc123def");
});

test("handler: never renders the full prompt even when the manifest summary is attacker-controlled", async () => {
  // manifest summary is safe by construction (first line, sanitized), but a
  // malicious summary still cannot break out or inject HTML/marker syntax
  const github = makeGitHub(null, manifestJson({ summary: `clean summary\n<!-- injected --> @everyone` }));
  const result = await handleWebhook(eventFor(PAYLOAD), { github, readOnly: true });
  assert.ok(result.commentBody.includes("clean summary"));
  assert.ok(!result.commentBody.includes("injected"), "injected HTML comment must be neutralized");
  assert.ok(!result.commentBody.includes("@everyone") || result.commentBody.includes("@\u200beveryone"));
});

test("handler: signature verified against the committed public key", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), { github, readOnly: true });
  assert.ok(result.commentBody.includes("✓ signed"), "valid manifest signature must be shown");
});

test("handler: no intents → no comment", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "plain commit" }], {});
  const result = await handleWebhook(eventFor(PAYLOAD), { github });
  assert.equal(result.action, "no-intents");
  assert.equal(github.calls.comments.length, 0);
});

test("handler: rejects wrong signature and non-PR events", async () => {
  const github = makeGitHub();
  const bad = await handleWebhook(
    { ...eventFor(PAYLOAD), signature: "sha256=nope" },
    { github, webhookSecret: "s3cret" },
  );
  assert.equal(bad.action, "error");
  const push = await handleWebhook({ ...eventFor(PAYLOAD), event: "push" }, { github });
  assert.equal(push.action, "skipped");
});

test("handler: synchronize updates the existing Drift comment instead of posting", async () => {
  const existing = [`old draft\n${SUMMARY_MARKER}\n(previous summary)`, "a human comment, no marker"];
  const github = new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, existing, {
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  const result = await handleWebhook(
    { ...eventFor(PAYLOAD), payload: { ...PAYLOAD, action: "synchronize" } },
    { github },
  );
  assert.equal(result.action, "updated");
  assert.equal(github.calls.updates.length, 1);
  assert.equal(github.calls.updates[0].commentId, 1);
  assert.ok(github.calls.updates[0].body.includes("de-duplicating in-flight refreshes"));
  // no new comment was posted, the human comment is untouched
  assert.equal(github.calls.comments.length, 0);
  assert.equal(github.existing.length, 2);
  assert.equal(github.existing[1].body, "a human comment, no marker");
});

test("handler: synchronize with no prior Drift comment posts a new one", async () => {
  const github = new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, ["just a human comment"], {
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  const result = await handleWebhook(
    { ...eventFor(PAYLOAD), payload: { ...PAYLOAD, action: "synchronize" } },
    { github },
  );
  assert.equal(result.action, "commented");
  assert.equal(github.calls.comments.length, 1);
  assert.equal(github.calls.updates.length, 0);
});

test("handler: permanent 4xx GitHub API errors are not retryable", async () => {
  const github = makeGitHub();
  github.getPullCommits = async () => {
    throw new Error("getPullCommits failed: 404");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), { github });
  assert.equal(result.action, "error");
  assert.equal(result.retryable, false);
  assert.ok(result.error.includes("404"));
});

test("handler: transient 5xx / network errors are retryable", async () => {
  const github = makeGitHub();
  github.getPullCommits = async () => {
    throw new Error("getPullCommits failed: 503");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), { github });
  assert.equal(result.action, "error");
  assert.equal(result.retryable, true);

  const github2 = makeGitHub();
  github2.getPullCommits = async () => {
    throw new TypeError("fetch failed");
  };
  const result2 = await handleWebhook(eventFor(PAYLOAD), { github: github2 });
  assert.equal(result2.retryable, true);
});

test("fetchIntents: falls back to commit subject when the public manifest is missing", async () => {
  const commits = [{ sha: "s", message: `Fallback subject here\n\nDrift-Intent: ${INTENT_ID}` }];
  const github = new FakeGitHub(commits, {}); // no manifests at all
  const views = await fetchIntents(github, "lilcipherx", "drift", "s", commits, [INTENT_ID]);
  assert.equal(views[0].summary, "Fallback subject here");
  assert.equal(views[0].files.length, 0);
  assert.equal(views[0].signature, false);
});

test("fetchIntents: never loads or returns a prompt from a legacy object", async () => {
  // a legacy repo might still have .drift/objects/ committed — the app must
  // ignore it entirely and use the public manifest instead
  const commits = [{ sha: "s", message: `Subject\n\nDrift-Intent: ${INTENT_ID}` }];
  const legacyObject = `.drift/objects/aa/bb.json`;
  const github = new FakeGitHub(commits, {
    [legacyObject]: JSON.stringify({
      id: INTENT_ID,
      prompt: "DRIFT_PRIVATE_SECRET_7f2c91 legacy prompt must never surface",
    }),
  });
  const views = await fetchIntents(github, "lilcipherx", "drift", "s", commits, [INTENT_ID]);
  assert.ok(!JSON.stringify(views).includes("DRIFT_PRIVATE_SECRET_7f2c91"));
  assert.equal(views[0].summary, "Subject", "falls back to the commit subject, not the object prompt");
});

// ------------------------------------------------------------ server smoke
test("webhook server: POST /webhook with valid signature returns 200 + posts comment", async () => {
  const github = makeGitHub();
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
  const github = makeGitHub();
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
