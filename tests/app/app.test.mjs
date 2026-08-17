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
const { createWebhookServer, assertWebhookAuthConfigured } = await mod("server.js");
const { deriveProvenanceConclusion, evaluateKeyChange, evaluateKeyringChangeState, isDriftOwnedComment } = await mod("trust.js");
const { signatureStateFor, auditProvenanceIntegrity, parseLoadedManifest } = await mod("intents.js");
const { generateKeyPair, newIntentId, PublicStore, signingKeyIdFor } = await import("@drift/core");

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
const APP_COMMENT = (id, body) => ({
  id,
  body,
  user: { login: "drift-app[bot]", type: "Bot" },
  performed_via_github_app: { id: 12345 },
});

class FakeGitHub {
  constructor(commits, manifests, existingComments = [], opts = {}) {
    this.commits = commits;
    this.manifests = manifests; // path -> JSON string (at HEAD)
    // Base-branch manifests (default: empty — a fresh base, so every head
    // manifest is a legitimate atomic addition).
    this.baseManifests = opts.baseManifests ?? {};
    // Per-commit file content for introduction-commit resolution:
    // ref -> path -> content. Absent refs fall back to head content.
    this.perCommit = opts.perCommit ?? {};
    // The key at the HEAD ref (default). `basePublicKeyPem` (when given)
    // simulates a base-branch key that differs from the head — required for
    // key-only PR / trust-root-change scenarios.
    this.publicKeyPem = opts.publicKeyPem ?? null;
    this.basePublicKeyPem = opts.basePublicKeyPem ?? null;
    // issue comments already on the PR (id ascending) — Drift comments are
    // authored by the App (ownership-verified); plain strings stay user-ish.
    this.existing = existingComments.map((body, i) =>
      typeof body === "string" ? APP_COMMENT(i + 1, body) : body,
    );
    this.nextId = this.existing.length + 1;
    this.calls = { comments: [], checks: [], updates: [] };
    this.installation = null;
    this.pullFiles = opts.pullFiles ?? [];
    this.pullFilesTruncated = opts.pullFilesTruncated ?? false;
    this.appId = opts.appId ?? "12345";
    this.prInfo = opts.prInfo ?? null;
    this.commitCollection = opts.commitCollection ?? null;
    this.compareShas = opts.compareShas ?? null;
    this.postCommentResult = opts.postCommentResult ?? null; // { throw: Error } | { id: n }
    this.checkRunResult = opts.checkRunResult ?? null; // { throw: Error } | { id: n }
    // Defaults mirror the fixed mock head; tests exercising a stale delivery
    // pass a different `headSha` than the payload carries.
    this.headSha = opts.headSha ?? "abc123def";
    this.baseSha = opts.baseSha ?? "base123";
    this.changedFiles = opts.changedFiles ?? 0;
  }
  setInstallation(id) { this.installation = id; }
  getAppId() { return this.appId; }
  async getPullRequest() {
    if (this.prInfo) return this.prInfo;
    // Faithful to GitHub: the API's current PR head equals the head the
    // webhook payload carried (a fresh delivery). Tests that exercise a
    // stale delivery pass an explicit `headSha` that differs.
    return {
      headSha: this.headSha,
      baseSha: this.baseSha,
      commits: this.commits.length,
      changedFiles: this.changedFiles,
      title: "",
    };
  }
  async getPullCommits() {
    if (this.commitCollection) return this.commitCollection;
    return { commits: this.commits, expectedCount: this.commits.length, complete: true };
  }
  async getCompareCommits() {
    if (this.compareShas) return this.compareShas;
    // default: every PR commit is new (ahead of base)
    return this.commits.map((c) => c.sha);
  }
  async getPullFiles() { return { files: this.pullFiles, truncated: this.pullFilesTruncated }; }
  isBaseRef(ref) { return ref === "base123" || ref === "base-sha"; }
  async getFileContent(owner, repo, path, ref) {
    const base = this.isBaseRef(ref);
    if (base) {
      if (path === ".drift/public/key.pem") return this.basePublicKeyPem;
      return this.baseManifests[path] ?? null;
    }
    const per = this.perCommit[ref];
    if (per !== undefined) {
      // A pinned per-commit tree sees ONLY that tree's content.
      if (path in per) return per[path];
      return null;
    }
    if (path === ".drift/public/key.pem") return this.publicKeyPem;
    return this.manifests[path] ?? null;
  }
  async listDirectory(owner, repo, path, ref) {
    if (path !== ".drift/public/intents") return [];
    const src = this.isBaseRef(ref) ? this.baseManifests : this.manifests;
    return Object.keys(src)
      .filter((p) => p.startsWith(".drift/public/intents/"))
      .map((p) => p.split("/").pop());
  }
  async postComment(owner, repo, issueNumber, body) {
    if (this.postCommentResult?.throw) throw this.postCommentResult.throw;
    this.calls.comments.push({ issueNumber, body });
    const id = this.nextId++;
    this.existing.push(APP_COMMENT(id, body));
    return this.postCommentResult?.id ?? id;
  }
  async updateComment(owner, repo, commentId, body) {
    if (this.postCommentResult?.throwUpdate) throw this.postCommentResult.throwUpdate;
    this.calls.updates.push({ commentId, body });
    const c = this.existing.find((x) => x.id === commentId);
    if (c) c.body = body;
  }
  async createCheckRun(owner, repo, input) {
    if (this.checkRunResult?.throw) throw this.checkRunResult.throw;
    this.calls.checks.push(input);
    return this.checkRunResult?.id ?? 1;
  }
  async listIssueComments() {
    this.calls.list = (this.calls.list ?? 0) + 1;
    return [...this.existing];
  }
}

/** Default deps for handler tests not exercising auth (explicit dev mode). */
const DEV_DEPS = { insecureDevMode: true };
const devDeps = (github, extra = {}) => ({ github, ...DEV_DEPS, ...extra });

const PAYLOAD = {
  action: "opened",
  installation: { id: 77 },
  repository: { name: "drift", owner: { login: "lilcipherx" } },
  pull_request: { number: 7, title: "Fix race", head: { sha: "abc123def" }, base: { sha: "base123" } },
};

function eventFor(payload, raw = JSON.stringify(payload)) {
  return { event: "pull_request", payload, rawBody: raw };
}

const COMMITS = [{ sha: "abc123def", message: `Fix race condition in token refresh\n\nDrift-Intent: ${INTENT_ID}` }];

function makeGitHub(opts = {}, manifestOverride = null) {
  return new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestOverride ?? manifestJson() }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    // default: same trust root on base and head (no trust-root change)
    basePublicKeyPem: PUBLIC_KEY_PEM,
    ...opts,
  });
}

test("handler: readOnly (dev --dry-run) builds the summary without writing", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { readOnly: true }));
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
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { checkRun: true }));
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
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { readOnly: true }));
  assert.ok(result.commentBody.includes("clean summary"));
  assert.ok(!result.commentBody.includes("injected"), "injected HTML comment must be neutralized");
  assert.ok(!result.commentBody.includes("@everyone") || result.commentBody.includes("@\u200beveryone"));
});

test("handler: signature verified against the committed public key", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { readOnly: true }));
  assert.ok(result.commentBody.includes("✓ signed"), "valid manifest signature must be shown");
});

test("handler: no intents → no comment", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "plain commit" }], {});
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
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
  const push = await handleWebhook({ ...eventFor(PAYLOAD), event: "push" }, devDeps(github));
  assert.equal(push.action, "skipped");
  // production mode without a secret fails CLOSED before any event processing
  const closed = await handleWebhook({ ...eventFor(PAYLOAD), event: "push" }, { github });
  assert.equal(closed.action, "error");
  assert.ok(closed.error.includes("webhook secret missing"));
});

test("handler: synchronize updates the existing Drift comment instead of posting", async () => {
  const existing = [`old draft\n${SUMMARY_MARKER}\n(previous summary)`, "a human comment, no marker"];
  const github = new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, existing, {
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  const result = await handleWebhook(
    { ...eventFor(PAYLOAD), payload: { ...PAYLOAD, action: "synchronize" } },
    devDeps(github),
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
    devDeps(github),
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
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.action, "error");
  assert.equal(result.retryable, false);
  assert.ok(result.error.includes("404"));
});

test("handler: transient 5xx / network errors are retryable", async () => {
  const github = makeGitHub();
  github.getPullCommits = async () => {
    throw new Error("getPullCommits failed: 503");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.action, "error");
  assert.equal(result.retryable, true);

  const github2 = makeGitHub();
  github2.getPullCommits = async () => {
    throw new TypeError("fetch failed");
  };
  const result2 = await handleWebhook(eventFor(PAYLOAD), devDeps(github2));
  assert.equal(result2.retryable, true);
});

test("fetchIntents: missing manifest uses a generic non-prompt fallback (never the commit subject)", async () => {
  // A legacy `full`-mode commit subject may contain a complete private prompt
  // (e.g. DRIFT_LEGACY_SUBJECT_SECRET_b8e4) — it must NEVER be rendered.
  const commits = [{ sha: "s", message: `DRIFT_LEGACY_SUBJECT_SECRET_b8e4\n\nDrift-Intent: ${INTENT_ID}` }];
  const github = new FakeGitHub(commits, {}); // no manifests at all
  const views = await fetchIntents(github, "lilcipherx", "drift", "s", commits, [INTENT_ID]);
  assert.equal(views[0].summary, `Drift intent ${INTENT_ID}`);
  assert.equal(views[0].missingManifest, true);
  assert.ok(!JSON.stringify(views).includes("DRIFT_LEGACY_SUBJECT_SECRET_b8e4"));
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
  assert.equal(views[0].summary, `Drift intent ${INTENT_ID}`, "generic fallback, never the commit subject or object prompt");
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

    // bad signature → rejected with 401 BEFORE any processing (fail closed)
    const bad = await fetch(`http://127.0.0.1:${port}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-github-event": "pull_request", "x-hub-signature-256": "sha256=wrong" },
      body: rawBody,
    });
    assert.equal(bad.status, 401);

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

// ------------------------------------------- A: check conclusion policy
const state = (signatureState, id = INTENT_ID) => ({ id, signatureState });

test("deriveProvenanceConclusion: table-driven state → conclusion mapping", () => {
  const cases = [
    { intents: [state("valid")], keyChange: "unchanged", expect: "success" },
    { intents: [state("valid"), state("valid")], keyChange: "unchanged", expect: "success" },
    { intents: [state("invalid")], keyChange: "unchanged", expect: "failure" },
    { intents: [state("untrusted-key")], keyChange: "replaced", expect: "failure" },
    { intents: [state("untrusted-key")], keyChange: "unchanged", expect: "failure" },
    { intents: [state("malformed")], keyChange: "unchanged", expect: "failure" },
    { intents: [state("valid")], keyChange: "replaced", expect: "failure" },
    { intents: [state("valid")], keyChange: "removed", expect: "failure" },
    { intents: [state("bootstrap")], keyChange: "bootstrap", expect: "neutral" },
    { intents: [state("unsigned")], keyChange: "unchanged", expect: "neutral" },
    { intents: [state("unverifiable")], keyChange: "unchanged", expect: "neutral" },
    { intents: [state("missing")], keyChange: "unchanged", expect: "neutral" },
    { intents: [state("valid"), state("unsigned")], keyChange: "unchanged", expect: "neutral" },
    { intents: [], keyChange: "none", expect: "neutral" },
    { intents: [], keyChange: "unchanged", expect: "neutral" },
    { intents: [], keyChange: "bootstrap", expect: "neutral" },
    { intents: [], keyChange: "replaced", expect: "failure" },
    { intents: [], keyChange: "removed", expect: "failure" },
  ];
  for (const c of cases) {
    const r = deriveProvenanceConclusion({ intents: c.intents, keyChange: c.keyChange });
    assert.equal(r.conclusion, c.expect, `intents=[${c.intents.map((i) => i.signatureState).join(",")}] key=${c.keyChange}`);
  }
  // a failure summary explains the reason
  const f = deriveProvenanceConclusion({ intents: [state("invalid")], keyChange: "unchanged" });
  assert.ok(f.summary.includes("Invalid: 1"));
  assert.ok(f.title.includes("untrusted provenance"));
});

test("deriveProvenanceConclusion: mixed valid+invalid is a failure, not a green check", () => {
  const r = deriveProvenanceConclusion({
    intents: [state("valid"), state("invalid")],
    keyChange: "unchanged",
  });
  assert.equal(r.conclusion, "failure");
});

test("evaluateKeyChange: strict states — bootstrap, removal, replacement AND malformed keys never get a fallback identity", () => {
  const pairA = generateKeyPairSync("ed25519");
  const pairB = generateKeyPairSync("ed25519");
  const A = pairA.publicKey.export({ type: "spki", format: "pem" }).toString();
  const B = pairB.publicKey.export({ type: "spki", format: "pem" }).toString();
  const garbage = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";
  assert.equal(evaluateKeyChange(null, null), "none");
  assert.equal(evaluateKeyChange(null, A), "bootstrap");
  assert.equal(evaluateKeyChange(A, null), "removed");
  assert.equal(evaluateKeyChange(A, A), "unchanged");
  assert.equal(evaluateKeyChange(A, B), "replaced");
  // Strict parsing: a malformed initial key is NOT a bootstrap, a malformed
  // replacement is NOT a replacement, and a malformed base root always fails.
  assert.equal(evaluateKeyChange(null, garbage), "malformed-bootstrap");
  assert.equal(evaluateKeyChange(A, garbage), "malformed-replacement");
  assert.equal(evaluateKeyChange(garbage, A), "base-malformed");
  assert.equal(evaluateKeyChange(garbage, garbage), "base-malformed");
});

test("deriveProvenanceConclusion: keyring history continuity (append-only trust set)", () => {
  const pair = generateKeyPairSync("ed25519");
  const pem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const kr = JSON.stringify({ schemaVersion: 1, keys: [], audit: [{ seq: 1, action: "bootstrap", fingerprint: "x", by: "x", at: 1, reason: null, payload: "p", signature: "s" }] });

  // A legitimate append-only extension never blocks.
  let r = deriveProvenanceConclusion({ intents: [state("valid")], keyChange: "unchanged", keyringChange: "extended" });
  assert.equal(r.conclusion, "success", "a signed keyring extension must not block valid provenance");
  r = deriveProvenanceConclusion({ intents: [], keyChange: "unchanged", keyringChange: "extended" });
  assert.equal(r.conclusion, "neutral");

  // History attacks always fail the check, even with zero intents.
  for (const bad of ["replaced", "removed", "malformed-bootstrap", "malformed-replacement", "base-malformed"]) {
    const r1 = deriveProvenanceConclusion({ intents: [state("valid")], keyChange: "unchanged", keyringChange: bad });
    assert.equal(r1.conclusion, "failure", `keyringChange=${bad} must fail even with valid intents`);
    assert.ok(r1.summary.includes("keyring"), `summary must mention the keyring for ${bad}`);
    const r2 = deriveProvenanceConclusion({ intents: [], keyChange: "unchanged", keyringChange: bad });
    assert.equal(r2.conclusion, "failure", `key-only keyringChange=${bad} must fail`);
  }
  // The reason text explains the append-only rule.
  const f = deriveProvenanceConclusion({ intents: [], keyChange: "unchanged", keyringChange: "replaced" });
  assert.ok(f.summary.includes("append"), "replaced history reason must state the append-only rule");
  void kr;
});

// ----------------------------------------------- B: key-only PR visibility
const OTHER = generateKeyPairSync("ed25519");
const OTHER_PUBLIC_KEY_PEM = OTHER.publicKey.export({ type: "spki", format: "pem" }).toString();

test("handler: a stale delivery (payload head ≠ current API head) is skipped, never audited mixed", async () => {
  // The payload claims head "oldhead" but the API now reports "newhead" (a
  // newer push landed while this delivery was queued). The audit must NOT mix
  // the stale payload head with fresh commit/file listings — it fails closed
  // with action "stale" and writes NOTHING.
  const github = makeGitHub({ headSha: "newhead" });
  const payload = {
    ...PAYLOAD,
    pull_request: { ...PAYLOAD.pull_request, base: { sha: "base123" }, head: { sha: "oldhead" } },
  };
  const result = await handleWebhook(eventFor(payload), devDeps(github));
  assert.equal(result.action, "stale");
  assert.equal(result.retryable, false, "a stale delivery must not be retried");
  assert.equal(github.calls.comments.length, 0, "no comment may be written for a stale delivery");
  assert.equal(github.calls.checks.length, 0, "no check run may be created for a stale delivery");
  assert.equal(github.calls.checks.length, 0);
});

test("handler: key-only PR (replaced key, zero intents) → warning comment + failing check run", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "rotate key only" }], {}, [], {
    publicKeyPem: OTHER_PUBLIC_KEY_PEM, // head key
    basePublicKeyPem: PUBLIC_KEY_PEM, // base trust root — differs → replaced
    headSha: "head456", // payload head == current API head (fresh delivery)
  });
  const payload = {
    ...PAYLOAD,
    pull_request: { ...PAYLOAD.pull_request, base: { sha: "base123" }, head: { sha: "head456" } },
  };
  const result = await handleWebhook(eventFor(payload), devDeps(github));
  assert.equal(result.action, "key-change");
  assert.equal(result.intentsFound, 0);
  assert.equal(result.conclusion, "failure");
  assert.ok(result.commentBody.includes("trust-root change detected"), "warning must be visible");
  assert.equal(github.calls.comments.length, 1, "a warning comment is posted even with zero intents");
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].conclusion, "failure");
});

test("handler: initial bootstrap (no base key, zero intents) → visible neutral check run", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "add drift" }], {}, [], {
    publicKeyPem: PUBLIC_KEY_PEM, // head introduces the first key
    headSha: "head456", // payload head == current API head (fresh delivery)
  });
  const payload = {
    ...PAYLOAD,
    pull_request: { ...PAYLOAD.pull_request, base: { sha: "base123" }, head: { sha: "head456" } },
  };
  const result = await handleWebhook(eventFor(payload), devDeps(github));
  assert.equal(result.action, "key-change");
  assert.equal(result.conclusion, "neutral");
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].conclusion, "neutral");
});

// ------------------------------------------------ C: bootstrap semantics
test("signatureStateFor: a failed head signature with no base key is INVALID, never bootstrap", async () => {
  const manifest = signedManifest({
    schemaVersion: 1,
    id: INTENT_ID,
    summary: "s",
    commit: "abc",
    timestamp: 1786000000000,
  });
  const tampered = { ...manifest, summary: "tampered" }; // signature no longer verifies
  const loaded = { manifest: tampered, errors: null };
  assert.equal(signatureStateFor(loaded, null, PUBLIC_KEY_PEM), "invalid");
  assert.equal(signatureStateFor({ manifest, errors: null }, null, PUBLIC_KEY_PEM), "bootstrap");
  assert.equal(signatureStateFor({ manifest: null, errors: null }, PUBLIC_KEY_PEM, PUBLIC_KEY_PEM), "missing");
});

test("handler: invalid bootstrap signature fails the check run (never labeled bootstrap)", async () => {
  const github = makeGitHub({ headSha: "head456" }, JSON.stringify({ ...MANIFEST, summary: "tampered-after-signing" }));
  const payload = {
    ...PAYLOAD,
    pull_request: { ...PAYLOAD.pull_request, base: { sha: "base123" }, head: { sha: "head456" } },
  };
  const result = await handleWebhook(eventFor(payload), devDeps(github, { readOnly: true }));
  assert.equal(result.action, "dry-run");
  assert.ok(result.commentBody.includes("invalid signature"), "tampered signature must show as invalid");
});

// -------------------------------------------------- D: comment ownership
test("isDriftOwnedComment: requires EXACT configured App id — never an arbitrary positive id, never bot, never a user marker", () => {
  const marker = SUMMARY_MARKER;
  // a github-actions[bot] comment is the ACTION's, which the App must never edit
  assert.equal(isDriftOwnedComment({ body: `${marker} action`, user: { login: "github-actions[bot]", type: "Bot" }, performed_via_github_app: null }, "12345"), false);
  // a real App-authored comment carries performed_via_github_app.id (GitHub-set)
  assert.equal(isDriftOwnedComment({ body: `${marker} app`, user: { login: "drift-app[bot]", type: "Bot" }, performed_via_github_app: { id: 12345 } }, "12345"), true);
  // ANY other positive app id is NOT ownership — a different GitHub App that
  // happens to use the marker must never be edited (issue 7)
  assert.equal(isDriftOwnedComment({ body: `${marker} other app`, user: { login: "other[bot]", type: "Bot" }, performed_via_github_app: { id: 999 } }, "12345"), false);
  // a user-authored body that merely contains the marker is a spoof
  assert.equal(isDriftOwnedComment({ body: `${marker} spoofed`, user: { login: "alice", type: "User" }, performed_via_github_app: null }, "12345"), false);
  assert.equal(isDriftOwnedComment({ body: "no marker", user: { login: "drift-app[bot]", type: "Bot" }, performed_via_github_app: { id: 12345 } }, "12345"), false);
  // fail-safe: when the configured App id is unavailable, NO comment is owned
  assert.equal(isDriftOwnedComment({ body: `${marker} app`, user: { login: "drift-app[bot]", type: "Bot" }, performed_via_github_app: { id: 12345 } }, null), false);
  assert.equal(isDriftOwnedComment({ body: `${marker} app`, user: { login: "drift-app[bot]", type: "Bot" }, performed_via_github_app: { id: 12345 } }, ""), false);
});

test("handler: a user-authored spoofed marker is never updated — the App posts its own", async () => {
  const spoof = {
    id: 5,
    body: `spoofed ${SUMMARY_MARKER}`,
    user: { login: "alice", type: "User" },
    performed_via_github_app: null,
  };
  const github = new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, [spoof], {
    publicKeyPem: PUBLIC_KEY_PEM,
  });
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.action, "commented", "official comment is POSTed (not a spoof update)");
  assert.equal(github.calls.updates.length, 0, "spoofed comment must never be PATCHed");
  assert.equal(github.calls.comments.length, 1);
});

// ----------------------------------------- integrity audit (append-only)
test("auditProvenanceIntegrity: modified / deleted / orphan / replay / ambiguous are detected; valid atomic addition is clean", async () => {
  const base = { [MANIFEST_PATH]: manifestJson() };
  // valid atomic addition (base empty, head has the manifest, one trailer)
  let audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, [], { publicKeyPem: PUBLIC_KEY_PEM, basePublicKeyPem: PUBLIC_KEY_PEM }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.deepEqual(audit, { violations: [], replayIds: [], ambiguousIds: [] }, JSON.stringify(audit));

  // unchanged: byte-identical content on base AND head is NOT a modification
  // (issue 4 — the changed-files listing does not even contain the file)
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, [], { baseManifests: base, publicKeyPem: PUBLIC_KEY_PEM }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.deepEqual(audit, { violations: [], replayIds: [INTENT_ID], ambiguousIds: [] }, JSON.stringify(audit));

  // modified: the PR changed an existing manifest (append-only violation)
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson({ summary: "tampered content" }) }, [], {
      baseManifests: base,
      publicKeyPem: PUBLIC_KEY_PEM,
      pullFiles: [{ filename: MANIFEST_PATH, status: "modified" }],
    }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.ok(audit.violations.some((v) => v.code === "modified" && v.id === INTENT_ID), JSON.stringify(audit));

  // deleted: on base, absent on head
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, {}, [], {
      baseManifests: base,
      publicKeyPem: PUBLIC_KEY_PEM,
      pullFiles: [{ filename: MANIFEST_PATH, status: "deleted" }],
    }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.ok(audit.violations.some((v) => v.code === "deleted" && v.id === INTENT_ID), JSON.stringify(audit));

  // orphan: added without any trailer
  const noTrailer = [{ sha: "x", message: "plain commit" }];
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(noTrailer, { [MANIFEST_PATH]: manifestJson() }, [], {
      publicKeyPem: PUBLIC_KEY_PEM,
      pullFiles: [{ filename: MANIFEST_PATH, status: "added" }],
    }),
    "lilcipherx",
    "drift",
    7,
    noTrailer,
    "base123",
    "abc123def",
  );
  assert.ok(audit.violations.some((v) => v.code === "orphan" && v.id === INTENT_ID), JSON.stringify(audit));

  // ambiguous: two commits reference the same id
  const twoCommits = [
    { sha: "a1", message: `one\n\nDrift-Intent: ${INTENT_ID}` },
    { sha: "a2", message: `two\n\nDrift-Intent: ${INTENT_ID}` },
  ];
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(twoCommits, { [MANIFEST_PATH]: manifestJson() }, [], {
      publicKeyPem: PUBLIC_KEY_PEM,
      pullFiles: [{ filename: MANIFEST_PATH, status: "added" }],
    }),
    "lilcipherx",
    "drift",
    7,
    twoCommits,
    "base123",
    "abc123def",
  );
  assert.ok(audit.ambiguousIds.includes(INTENT_ID), JSON.stringify(audit));

  // renamed via the PR files API
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, [], {
      publicKeyPem: PUBLIC_KEY_PEM,
      pullFiles: [
        {
          filename: `.drift/public/intents/did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json`,
          status: "renamed",
          previous_filename: MANIFEST_PATH,
        },
      ],
    }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.ok(audit.violations.some((v) => v.code === "renamed"), JSON.stringify(audit));

  // replay: a commit references an id whose manifest already exists on base
  audit = await auditProvenanceIntegrity(
    new FakeGitHub(COMMITS, { [MANIFEST_PATH]: manifestJson() }, [], { baseManifests: base, publicKeyPem: PUBLIC_KEY_PEM }),
    "lilcipherx",
    "drift",
    7,
    COMMITS,
    "base123",
    "abc123def",
  );
  assert.ok(audit.replayIds.includes(INTENT_ID), JSON.stringify(audit));
});

test("auditProvenanceIntegrity: added-then-modified in the same PR is a violation (issue 5)", async () => {
  // commit c1 introduces the manifest with content X (and carries the single
  // matching trailer); commit c2 later modifies it to content Y. The final
  // diff may still report "added", so head-vs-introduction blob comparison
  // must catch the post-introduction mutation.
  const commits = [
    { sha: "c1", message: `add intent\n\nDrift-Intent: ${INTENT_ID}` },
    { sha: "c2", message: "tweak manifest" },
  ];
  const introContent = manifestJson();
  const headContent = manifestJson({ summary: "mutated after introduction" });
  const github = new FakeGitHub(commits, { [MANIFEST_PATH]: headContent }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    pullFiles: [{ filename: MANIFEST_PATH, status: "added" }],
    perCommit: { c1: { [MANIFEST_PATH]: introContent }, c2: { [MANIFEST_PATH]: headContent } },
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.ok(audit.violations.some((v) => v.code === "mutated" && v.id === INTENT_ID), JSON.stringify(audit));
});

test("auditProvenanceIntegrity: trailer on a different commit than the introduction is a violation (issue 5)", async () => {
  // c1 introduces the file with NO trailer; c2 carries the trailer. Atomic
  // association requires the introducing commit to carry exactly one matching
  // Drift-Intent trailer.
  const commits = [
    { sha: "c1", message: "add manifest without trailer" },
    { sha: "c2", message: `claim intent\n\nDrift-Intent: ${INTENT_ID}` },
  ];
  const content = manifestJson();
  const github = new FakeGitHub(commits, { [MANIFEST_PATH]: content }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    pullFiles: [{ filename: MANIFEST_PATH, status: "added" }],
    perCommit: { c1: { [MANIFEST_PATH]: content }, c2: { [MANIFEST_PATH]: content } },
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.ok(audit.violations.some((v) => v.code === "intro-mismatch" && v.id === INTENT_ID), JSON.stringify(audit));
});

// ------------------------------------------- contract: real Core → App
test("contract: a real Core V2 manifest is valid through the App (production writer → app loader)", async () => {
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  const id = newIntentId();
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(join(tmpdir(), "drift-app-contract-"));
  const store = new PublicStore(join(root, ".drift"));
  const view = {
    schemaVersion: 2,
    id,
    summary: "app contract test",
    agent: { type: "AGENT", identifier: "contract" },
    files: [{ path: "src/a.ts", mutationType: "ADDED", summary: "added" }],
    timestamp: Date.now(),
    signingKeyId: signingKeyIdFor(publicKeyPem),
  };
  store.write(view, privateKeyPem); // the production manifest writer
  const raw = await import("node:fs").then((m) => m.readFileSync(join(root, ".drift", "public", "intents", `${id}.json`), "utf8"));
  const loaded = parseLoadedManifest(raw, id); // the App's loader
  assert.equal(loaded.errors, null, JSON.stringify(loaded.errors));
  assert.ok(loaded.manifest, "App must load the Core-written manifest");
  const state = signatureStateFor(loaded, publicKeyPem, publicKeyPem);
  assert.equal(state, "valid", "a real Core manifest must be VALID in the App");
  // formatting invariance: CRLF + whitespace PEM produce the same fingerprint
  assert.equal(signingKeyIdFor(publicKeyPem.replace(/\n/g, "\r\n")), signingKeyIdFor(publicKeyPem));
  assert.equal(signingKeyIdFor(`  ${publicKeyPem}\n`), signingKeyIdFor(publicKeyPem));
  rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------ App audit scalability
function historicalManifests(count, sizeBytes = 0) {
  const out = {};
  const pad = (n) => `did_${String(n).padStart(32, "0")}`;
  for (let i = 0; i < count; i++) {
    const id = pad(i);
    const summary = sizeBytes > 0 ? "x".repeat(sizeBytes) : `historical ${i}`;
    out[`.drift/public/intents/${id}.json`] = JSON.stringify({
      schemaVersion: 1,
      id,
      summary,
      commit: "c",
      timestamp: i,
      signature: "",
    });
  }
  return out;
}

test("App audit scalability: >200 unchanged historical manifests never fail a source-only PR (issue 8)", async () => {
  // base and head both contain 201 byte-identical historical manifests; the
  // PR changes only README.md. Unchanged history must not be enumerated or
  // counted — the check stays clean.
  const manifests = historicalManifests(201);
  const commits = [{ sha: "s", message: "docs: update README" }];
  const github = new FakeGitHub(commits, manifests, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    baseManifests: manifests,
    pullFiles: [{ filename: "README.md", status: "modified" }],
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.deepEqual(audit, { violations: [], replayIds: [], ambiguousIds: [] }, JSON.stringify(audit));
});

test("App audit scalability: 1000 unchanged historical manifests + one valid atomic addition → success", async () => {
  const ID_B = "did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const MANIFEST_B = `.drift/public/intents/${ID_B}.json`;
  const historical = historicalManifests(1000);
  const bContent = JSON.stringify(
    signedManifest({ schemaVersion: 1, id: ID_B, summary: "new feature", commit: "c2", timestamp: 1001 }),
  );
  const commits = [{ sha: "c2", message: `feat: add feature\n\nDrift-Intent: ${ID_B}` }];
  const github = new FakeGitHub(commits, { ...historical, [MANIFEST_B]: bContent }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    baseManifests: historical,
    pullFiles: [{ filename: MANIFEST_B, status: "added" }],
    perCommit: { c2: { [MANIFEST_B]: bContent } },
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.deepEqual(audit, { violations: [], replayIds: [], ambiguousIds: [] }, JSON.stringify(audit));
});

test("App audit scalability: large historical provenance total never counts against a source-only PR", async () => {
  // >50 MiB of unchanged historical manifests; the PR changes one tiny file.
  // Historical size must not be loaded or counted.
  const historical = historicalManifests(300, 180 * 1024); // ~52 MiB total history
  const commits = [{ sha: "s", message: "fix: typo" }];
  const github = new FakeGitHub(commits, historical, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    baseManifests: historical,
    pullFiles: [{ filename: "src/a.ts", status: "modified" }],
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.deepEqual(audit, { violations: [], replayIds: [], ambiguousIds: [] }, JSON.stringify(audit));
});

test("App audit limits apply ONLY to changed PR provenance; incomplete pagination fails safely", async () => {
  // 201 public manifests changed by ONE PR → bounded-audit violation
  const many = [];
  for (let i = 0; i < 201; i++) {
    many.push({ filename: `.drift/public/intents/did_${String(i).padStart(32, "0")}.json`, status: "added" });
  }
  const github = new FakeGitHub([], {}, [], { publicKeyPem: PUBLIC_KEY_PEM, pullFiles: many });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, [], "base123", "head123");
  assert.ok(audit.violations.length > 0, JSON.stringify(audit));
  assert.ok(audit.violations.some((v) => v.detail.includes("bounded audit")), JSON.stringify(audit));

  // incomplete changed-files listing → audit cannot conclude, never success
  const trunc = new FakeGitHub([], {}, [], { publicKeyPem: PUBLIC_KEY_PEM, pullFilesTruncated: true });
  const auditTrunc = await auditProvenanceIntegrity(trunc, "lilcipherx", "drift", 7, [], "base123", "head123");
  assert.ok(auditTrunc.violations.length > 0, JSON.stringify(auditTrunc));
  assert.ok(auditTrunc.violations.some((v) => v.detail.includes("incomplete")), JSON.stringify(auditTrunc));
});

test("deriveProvenanceConclusion: any integrity violation fails the check, even with zero intents", () => {
  const r = deriveProvenanceConclusion({
    intents: [],
    keyChange: "unchanged",
    audit: { violations: [{ code: "modified", id: INTENT_ID, detail: "append-only" }], replayIds: [], ambiguousIds: [] },
  });
  assert.equal(r.conclusion, "failure");
  assert.ok(r.title.includes("integrity"), r.title);
  const replay = deriveProvenanceConclusion({
    intents: [],
    keyChange: "unchanged",
    audit: { violations: [], replayIds: [INTENT_ID], ambiguousIds: [] },
  });
  assert.equal(replay.conclusion, "failure");
  const ambiguous = deriveProvenanceConclusion({
    intents: [],
    keyChange: "unchanged",
    audit: { violations: [], replayIds: [], ambiguousIds: [INTENT_ID] },
  });
  assert.equal(ambiguous.conclusion, "failure");
  const clean = deriveProvenanceConclusion({
    intents: [state("valid")],
    keyChange: "unchanged",
    audit: { violations: [], replayIds: [], ambiguousIds: [] },
  });
  assert.equal(clean.conclusion, "success");
});

test("handler: an integrity-only PR (tampered manifest, zero new trailers) still gets a failing check run + warning", async () => {
  // base has the manifest; head carries it with DIFFERENT content and commits
  // carry no trailers — the changed-files listing flags the modification
  const noTrailer = [{ sha: "x", message: "tamper without trailer" }];
  const github = new FakeGitHub(noTrailer, { [MANIFEST_PATH]: manifestJson({ summary: "tampered content" }) }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    basePublicKeyPem: PUBLIC_KEY_PEM,
    baseManifests: { [MANIFEST_PATH]: manifestJson() },
    pullFiles: [{ filename: MANIFEST_PATH, status: "modified" }],
  });
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "failure", JSON.stringify(result));
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].conclusion, "failure");
  assert.ok(result.commentBody.includes("integrity"), "the violation must be visible in the comment");
});

test("handler: ordinary PR with an unchanged historical manifest is NOT flagged as modified (issue 4)", async () => {
  // base already has intent A's manifest; the PR changes only an ordinary
  // source file and atomically adds a NEW intent B. A is byte-identical on
  // base and head ⇒ unchanged, no violation; the check is success.
  const ID_B = "did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const MANIFEST_B = `.drift/public/intents/${ID_B}.json`;
  const commits = [
    { sha: "c1", message: "fix(src): ordinary source change" },
    { sha: "c2", message: `feat(src): add feature\n\nDrift-Intent: ${ID_B}` },
  ];
  const baseContent = manifestJson();
  const bContent = JSON.stringify(
    signedManifest({
      schemaVersion: 1,
      id: ID_B,
      summary: "new feature",
      commit: "c2",
      timestamp: 1786000000000,
    }),
  );
  const github = new FakeGitHub(commits, { [MANIFEST_PATH]: baseContent, [MANIFEST_B]: bContent }, [], {
    publicKeyPem: PUBLIC_KEY_PEM,
    basePublicKeyPem: PUBLIC_KEY_PEM,
    baseManifests: { [MANIFEST_PATH]: baseContent },
    perCommit: { c1: {}, c2: { [MANIFEST_B]: bContent } },
    headSha: "head123", // payload head == current API head (fresh delivery)
  });
  const payload = {
    ...PAYLOAD,
    pull_request: { ...PAYLOAD.pull_request, base: { sha: "base123" }, head: { sha: "head123" } },
  };
  const result = await handleWebhook(eventFor(payload), devDeps(github));
  assert.equal(result.conclusion, "success", JSON.stringify(result));
  assert.equal(github.calls.checks.length, 1);
  assert.equal(github.calls.checks[0].conclusion, "success");
  assert.ok(!result.commentBody.includes("integrity violation"), "no false modified violation");
});

test("handler: check-run creation is independent from the comment — a comment failure never loses the check result", async () => {
  const github = makeGitHub();
  github.postComment = async () => {
    throw new Error("comment POST failed");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "success", JSON.stringify(result));
  assert.equal(github.calls.checks.length, 1, "check run must still be created when the comment fails");
  assert.equal(github.calls.checks[0].conclusion, "success");

  // and the reverse: a check-run failure must not suppress the comment
  const github2 = makeGitHub();
  github2.createCheckRun = async () => {
    throw new Error("check run failed");
  };
  const result2 = await handleWebhook(eventFor(PAYLOAD), devDeps(github2));
  assert.equal(result2.conclusion, "success");
  assert.equal(github2.calls.comments.length, 1, "comment must still be posted when the check run fails");

  // both fail → surfaced as an error (not silently green)
  const github3 = makeGitHub();
  github3.postComment = async () => {
    throw new Error("comment POST failed");
  };
  github3.createCheckRun = async () => {
    throw new Error("check run failed");
  };
  const result3 = await handleWebhook(eventFor(PAYLOAD), devDeps(github3));
  assert.equal(result3.action, "error", JSON.stringify(result3));
});

// ------------------------------------------------ E: malformed manifests
test("handler: malformed tracked manifest → malformed state, failing check, no crash, actionable message", async () => {
  const malformed = JSON.stringify({ ...MANIFEST, files: { path: "src/x.ts" }, timestamp: "not-a-number" });
  const github = makeGitHub({}, malformed);
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { readOnly: true }));
  assert.equal(result.intentsFound, 1);
  assert.ok(result.commentBody.includes("malformed public manifest"), result.commentBody);
  assert.ok(!result.commentBody.includes("not-a-number"), "raw garbage is not rendered as data");
  // a real (non-readOnly) delivery produces a failing check run
  const github2 = makeGitHub({}, malformed);
  const live = await handleWebhook(eventFor(PAYLOAD), devDeps(github2));
  assert.equal(live.conclusion, "failure");
  assert.equal(github2.calls.checks[0].conclusion, "failure");
  assert.ok(github2.calls.checks[0].title.includes("untrusted provenance") || github2.calls.checks[0].title.includes("malformed"));
});

// ------------------------------------------------ H: webhook fail-closed
test("webhook auth: production without a secret fails closed (startup + request)", () => {
  assert.throws(() => assertWebhookAuthConfigured(undefined, undefined), /GITHUB_WEBHOOK_SECRET is required/);
  assert.throws(() => assertWebhookAuthConfigured("", "false"), /GITHUB_WEBHOOK_SECRET is required/);
  // explicit dev mode passes (and is the only escape hatch)
  const dev = assertWebhookAuthConfigured(undefined, "true");
  assert.equal(dev.insecureDevMode, true);
  assert.equal(dev.webhookSecret, undefined);
  // a real secret always wins
  const prod = assertWebhookAuthConfigured("s3cret", "true");
  assert.equal(prod.insecureDevMode, false);
  assert.equal(prod.webhookSecret, "s3cret");
});

test("webhook auth: missing/invalid signatures are rejected when a secret is configured", async () => {
  const github = makeGitHub();
  const noSig = await handleWebhook(eventFor(PAYLOAD), { github, webhookSecret: "s3cret" });
  assert.equal(noSig.action, "error");
  assert.ok(noSig.error.includes("invalid webhook signature"));
  const badSig = await handleWebhook(
    { ...eventFor(PAYLOAD), signature: "sha256=deadbeef" },
    { github, webhookSecret: "s3cret" },
  );
  assert.equal(badSig.action, "error");
  // explicit dev mode bypasses the requirement
  const dev = await handleWebhook(eventFor(PAYLOAD), { github, insecureDevMode: true });
  assert.equal(dev.action, "commented");
});

// ------------------------------------------- F: final completeness regressions
const manyCommits = (n) =>
  Array.from({ length: n }, (_, i) => ({
    sha: `${String(i).padStart(39, "0")}`,
    message: "chore: fill",
  }));

const ID_NEW = "did_99999999999999999999999999999999";

test("App audit: complete 250-commit enumeration audits normally (no false incomplete)", async () => {
  const commits = manyCommits(250);
  const github = new FakeGitHub(commits, {}, [], {
    commitCollection: { commits, expectedCount: 250, complete: true },
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123");
  assert.equal(audit.violations.length, 0);
});

test("App commit completeness: 251 commits (endpoint cap) → incomplete-commit-audit, never success", async () => {
  const commits = manyCommits(251);
  const truncated = commits.slice(0, 250);
  const github = new FakeGitHub(truncated, {}, [], {
    commitCollection: { commits: truncated, expectedCount: 251, complete: false, reason: "returned 250 commits but metadata reports 251" },
  });
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, truncated, "base123", "head123", {
    commitAuditIncomplete: true,
  });
  assert.ok(audit.violations.some((v) => v.code === "incomplete-commit-audit"), JSON.stringify(audit.violations));
});

test("App commit completeness: count mismatch, duplicates and blank SHAs are incomplete", async () => {
  const commits = manyCommits(10);
  for (const bad of [
    { commits: commits.slice(0, 5), expectedCount: 10, complete: false, reason: "returned 5 commits but metadata reports 10" },
    { commits: [...commits, commits[0]], expectedCount: 11, complete: false, reason: "duplicate commit entries" },
    { commits: [{ sha: "", message: "no sha" }, ...commits], expectedCount: 11, complete: false, reason: "entries without a SHA" },
  ]) {
    const github = new FakeGitHub(bad.commits, {}, [], { commitCollection: bad });
    const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, bad.commits, "base123", "head123", {
      commitAuditIncomplete: true,
    });
    assert.ok(audit.violations.some((v) => v.code === "incomplete-commit-audit"), JSON.stringify(bad));
  }
});

test("App commit completeness: the handler fails the check on an incomplete listing (never green)", async () => {
  const commits = manyCommits(10);
  const github = new FakeGitHub(commits, {}, [], {
    commitCollection: { commits: commits.slice(0, 4), expectedCount: 10, complete: false, reason: "interrupted pagination" },
  });
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "failure", JSON.stringify(result));
  assert.ok((result.commentBody ?? "").includes("incomplete-commit-audit"), result.commentBody);
});

test("App audit: NEW trailer without manifest is a violation; a legacy base-history reference stays neutral", async () => {
  const commits = [{ sha: "new1", message: `feat\n\nDrift-Intent: ${ID_NEW}` }];
  // NEW: the referencing commit is ahead of base → hard violation
  const github = new FakeGitHub(commits, {}, [], {});
  const audit = await auditProvenanceIntegrity(github, "lilcipherx", "drift", 7, commits, "base123", "head123", {
    aheadShas: new Set(["new1"]),
  });
  assert.ok(audit.violations.some((v) => v.code === "trailer-without-manifest" && v.id === ID_NEW), JSON.stringify(audit.violations));
  // LEGACY: the referencing commit is carried in from base history (not ahead)
  const github2 = new FakeGitHub(commits, {}, [], {});
  const audit2 = await auditProvenanceIntegrity(github2, "lilcipherx", "drift", 7, commits, "base123", "head123", {
    aheadShas: new Set(),
  });
  assert.equal(audit2.violations.length, 0, JSON.stringify(audit2.violations));
  assert.ok(!audit2.replayIds.includes(ID_NEW), "no manifest anywhere → not a replay");
});

test("handler: key-only PR with a MALFORMED initial key fails the check (never a bootstrap)", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "introduce key" }], {}, [], {
    publicKeyPem: "-----BEGIN PUBLIC KEY-----\nGARBAGE\n-----END PUBLIC KEY-----\n", // malformed head key
    basePublicKeyPem: null, // no base key
  });
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "failure", JSON.stringify(result));
  assert.ok((result.commentBody ?? "").includes("malformed"), result.commentBody);
  assert.equal(github.calls.checks[0].conclusion, "failure");
  assert.ok(!(result.commentBody ?? "").includes("unverified bootstrap"), "malformed must never be labeled bootstrap");
});

test("handler: malformed BASE trust root fails even when the head key is valid (base-malformed)", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "fix key" }], {}, [], {
    publicKeyPem: PUBLIC_KEY_PEM, // valid head key
    basePublicKeyPem: "-----BEGIN PUBLIC KEY-----\nGARBAGE\n-----END PUBLIC KEY-----\n", // malformed base
  });
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "failure", JSON.stringify(result));
  assert.equal(github.calls.checks[0].conclusion, "failure");
});

test("handler: a failed Check Run is never hidden by a successful comment (transient → retryable)", async () => {
  const github = makeGitHub();
  github.createCheckRun = async () => {
    throw new Error("createCheckRun failed: 500"); // transient
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "success", JSON.stringify(result));
  assert.equal(github.calls.comments.length, 1, "comment must still be written");
  assert.equal(result.action, "error", "a failed check run must never be acked as fully successful");
  assert.equal(result.retryable, true, "transient check failure must be retryable (webhook 500 → redelivery)");
  assert.ok(result.writeResult.checkRun.state === "failed");
  assert.ok(result.writeResult.comment.state === "success");
});

test("handler: permanent check-run failure (403) is acknowledged, not silently green", async () => {
  const github = makeGitHub();
  github.createCheckRun = async () => {
    throw new Error("createCheckRun failed: 403"); // permanent
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.action, "error");
  assert.equal(result.retryable, false, "permanent 4xx is acknowledged so GitHub stops redelivering");
});

test("handler: comment failure with a successful check is reported (retryable when transient)", async () => {
  // transient comment failure (500) → retryable so the comment gets another chance
  const github = makeGitHub();
  github.postComment = async () => {
    throw new Error("postComment failed: 500");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.conclusion, "success");
  assert.equal(github.calls.checks.length, 1, "the check result is preserved");
  assert.equal(result.action, "error");
  assert.equal(result.retryable, true);
  // permanent comment failure (403) → acknowledged
  const github2 = makeGitHub();
  github2.postComment = async () => {
    throw new Error("postComment failed: 403");
  };
  const result2 = await handleWebhook(eventFor(PAYLOAD), devDeps(github2));
  assert.equal(result2.action, "error");
  assert.equal(result2.retryable, false);
});

test("handler: key-only PR follows the same check-run reliability policy (check 500 → retryable error)", async () => {
  const github = new FakeGitHub([{ sha: "s", message: "rotate key only" }], {}, [], {
    publicKeyPem: OTHER_PUBLIC_KEY_PEM,
    basePublicKeyPem: PUBLIC_KEY_PEM, // replaced
  });
  github.createCheckRun = async () => {
    throw new Error("createCheckRun failed: 500");
  };
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github));
  assert.equal(result.action, "error", JSON.stringify(result));
  assert.equal(result.retryable, true, "a transient check failure on a key-only PR must be retryable");
});

test("handler: read-only mode returns the computed result and writes nothing (check + comment untouched)", async () => {
  const github = makeGitHub();
  const result = await handleWebhook(eventFor(PAYLOAD), devDeps(github, { readOnly: true }));
  assert.equal(result.action, "dry-run");
  assert.equal(result.conclusion, "success");
  assert.equal(github.calls.checks.length, 0);
  assert.equal(github.calls.comments.length, 0);
});
