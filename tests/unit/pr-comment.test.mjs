import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSummary,
  upsertComment,
  SUMMARY_MARKER,
  parseEvent,
  prCommitShas,
  extractDriftIntentIds,
  intentsFromCommits,
  readManifest,
  sanitizeCommentText,
  parseGitTrailers,
} from "../../scripts/pr-comment.mjs";

// ------------------------------------------------------------------- helpers
function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-prc-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "root"]);
  return repo;
}

function commit(repo, message, file = "src/a.ts") {
  writeFileSync(join(repo, file), `export const ${file.replace(/[^a-z]/g, "")} = ${Date.now()};\n`);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

const ID_A = "did_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "did_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_C = "did_cccccccccccccccccccccccccccccccc";

// ----------------------------------------------------------------- buildSummary
test("buildSummary: null for no intents", () => {
  assert.equal(buildSummary([]), null);
  assert.equal(buildSummary(undefined), null);
  assert.equal(buildSummary(null), null);
});

test("buildSummary: marker, heading, safe summary, metadata and files — never prompt", () => {
  const body = buildSummary([
    {
      id: ID_A,
      summary: "Add retry handling to the payment webhook",
      model: "claude-3-5-sonnet",
      authorId: "alice",
      authorType: "AGENT",
      verification: "npm test",
      files: [{ path: "src/pay.ts", mutationType: "MODIFIED", summary: "function retry added" }],
      commit: "0123456789abcdef",
    },
  ]);
  assert.ok(body.startsWith(SUMMARY_MARKER), body);
  assert.ok(body.includes("## Drift — Why this changed"), body);
  assert.ok(body.includes("1 intent on this PR"), body);
  assert.ok(body.includes("did_aaaa"), body);
  assert.ok(body.includes("Add retry handling to the payment webhook"), body);
  assert.ok(body.includes("claude-3-5-sonnet"), body);
  assert.ok(body.includes("`0123456`"), body);
  assert.ok(body.includes("- `src/pay.ts` (**MODIFIED**)"), body);
  assert.ok(!body.includes("prompt"), "the private prompt must never appear");
});

test("buildSummary: neutralizes HTML comments, mention spam, ANSI and control chars", () => {
  const body = buildSummary([
    {
      id: ID_B,
      summary: "real text <!-- hidden --> @everyone @here\n\x1b[31mred\x1b[0m\x07",
      files: [],
    },
  ]);
  assert.ok(body.includes("real text"));
  assert.ok(!body.includes("hidden"), "injected HTML comment content must be neutralized");
  assert.ok(!body.includes("\x1b["), "ANSI escapes must be stripped");
  assert.ok(!body.includes("@everyone") || body.includes("@\u200beveryone"));
  assert.ok(!body.includes("\x07"));
});

test("buildSummary: truncates long values and caps intent count with a notice", () => {
  const long = "x".repeat(2000);
  const body = buildSummary([{ id: ID_A, summary: long, files: [] }]);
  assert.ok(!body.includes("x".repeat(600)), "long summary must be truncated");
  assert.ok(body.includes("…"), body);

  const many = Array.from({ length: 15 }, (_, i) => ({
    id: `did_${String(i).padStart(32, "0")}`,
    summary: `s${i}`,
    files: [],
  }));
  const big = buildSummary(many);
  assert.ok(big.includes("not shown"), "extra intents must be reported as truncated");
  assert.ok(big.length < 12000, "comment stays bounded");
});

test("sanitizeCommentText: strips control chars and ANSI but keeps readable text", () => {
  const out = sanitizeCommentText("a\x00b\x1b[1;31mred\x1b[0m\x07c\x7f");
  assert.equal(out, "abredc");
});

// -------------------------------------------------------------------- parseEvent
test("parseEvent: extracts repo, PR number and immutable base/head SHAs", () => {
  const ev = parseEvent(
    JSON.stringify({
      pull_request: { number: 7, base: { sha: "bbbb".repeat(10) }, head: { sha: "aaaa".repeat(10) } },
      repository: { full_name: "lilcipherx/drift" },
    }),
  );
  assert.deepEqual(ev, {
    repo: "lilcipherx/drift",
    prNumber: 7,
    baseSha: "bbbb".repeat(10),
    headSha: "aaaa".repeat(10),
  });
});

test("parseEvent: null for malformed JSON, non-PR events and missing shas", () => {
  assert.equal(parseEvent("not json"), null);
  assert.equal(parseEvent(JSON.stringify({ push: {} })), null);
  assert.equal(parseEvent(JSON.stringify({ pull_request: { number: 1 } })), null);
  assert.equal(parseEvent(JSON.stringify({ pull_request: { number: 1, base: {}, head: {} }, repository: { full_name: "o/r" } })), null);
  assert.equal(parseEvent(JSON.stringify({ pull_request: { number: 1, base: { sha: "a".repeat(40) }, head: { sha: "b".repeat(40) } }, repository: { full_name: "no-repo-name" } })), null);
});

// -------------------------------------------------------------- prCommitShas
test("prCommitShas: selects ONLY feature commits reachable from the merge base", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // feature branch: two intents
  git(repo, ["checkout", "-q", "-b", "feature"]);
  const feat1 = commit(repo, `feat one\n\nDrift-Intent: ${ID_B}`);
  const feat2 = commit(repo, "feat two");
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  // unrelated branch with an intent that must NOT be included
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["checkout", "-q", "-b", "unrelated"]);
  commit(repo, `unrelated\n\nDrift-Intent: ${ID_C}`);

  const { ok, shas } = prCommitShas(repo, baseSha, headSha);
  assert.equal(ok, true);
  assert.deepEqual(shas, [feat1, feat2], "only the feature commits belong to the PR");
  assert.ok(!shas.includes(baseSha), "base commits must not be included");
});

test("prCommitShas: fails safely when the base sha is missing (no merge-base)", () => {
  const repo = makeRepo();
  const { ok, reason } = prCommitShas(repo, "f".repeat(40), git(repo, ["rev-parse", "HEAD"]));
  assert.equal(ok, false);
  assert.equal(reason, "merge-base");
});

// ------------------------------------------------------- trailer extraction
test("parseGitTrailers: parses the last-paragraph trailer block with continuation lines", () => {
  const msg = `Subject line\n\nBody text.\n\nDrift-Intent: ${ID_A}\nModel: claude-3-5-sonnet\nTrailer-With-Continuation: part one\n  part two`;
  const trailers = parseGitTrailers(msg);
  assert.deepEqual(trailers, [
    { token: "Drift-Intent", value: ID_A },
    { token: "Model", value: "claude-3-5-sonnet" },
    { token: "Trailer-With-Continuation", value: "part one part two" },
  ]);
});

test("parseGitTrailers: ignores trailers that are not in the final paragraph", () => {
  const msg = `Subject\n\nDrift-Intent: ${ID_A}\n\nTrailing paragraph without trailers`;
  assert.deepEqual(parseGitTrailers(msg), []);
});

test("extractDriftIntentIds: dedupes, validates format, handles multiple trailers", () => {
  const msg = `Sub\n\nDrift-Intent: ${ID_A}\nDrift-Intent: ${ID_B}\nDrift-Intent: ${ID_A}\nDrift-Intent: did_invalid_NOT_HEX`;
  assert.deepEqual(extractDriftIntentIds(msg, () => ({ status: 1, stdout: "" }), process.cwd()), [ID_A, ID_B]);
});

// ------------------------------------------------------- intentsFromCommits
test("intentsFromCommits: hydrates public manifests for PR commits only; missing manifest → generic non-prompt fallback", () => {
  const repo = makeRepo();
  const manifests = {
    [ID_A]: { summary: "Public summary A", model: "m1", agent: { type: "AGENT", identifier: "bot" }, files: [{ path: "src/a.ts", mutationType: "MODIFIED", summary: null }], verification: "npm test" },
    // ID_B has NO manifest → generic fallback, NEVER the commit subject
    // (a legacy `full`-mode subject may contain the whole private prompt)
  };
  const intents = intentsFromCommits({
    repoRoot: repo,
    commits: [
      commit(repo, `feat A\n\nDrift-Intent: ${ID_A}`),
      commit(repo, `DRIFT_LEGACY_SUBJECT_SECRET_b8e4\n\nDrift-Intent: ${ID_B}\nDrift-Intent: ${ID_B}`),
    ],
    readManifestImpl: (root, id) => manifests[id] ?? null,
  });
  assert.equal(intents.length, 2);
  assert.equal(intents[0].id, ID_A);
  assert.equal(intents[0].summary, "Public summary A");
  assert.equal(intents[0].verification, "npm test");
  assert.equal(intents[1].id, ID_B);
  assert.equal(intents[1].summary, `Drift intent ${ID_B}`, "missing manifest must degrade to the generic fallback");
  assert.equal(intents[1].missingManifest, true);
  assert.ok(!JSON.stringify(intents).includes("DRIFT_LEGACY_SUBJECT_SECRET_b8e4"), "commit subject must never leak");
  assert.equal(intents[1].files.length, 0);
});

test("readManifest: returns null for missing or malformed manifests", () => {
  const repo = makeRepo();
  assert.equal(readManifest(repo, ID_A), null);
  mkdirSync(join(repo, ".drift", "public", "intents"), { recursive: true });
  writeFileSync(join(repo, ".drift", "public", "intents", `${ID_A}.json`), "not json");
  assert.equal(readManifest(repo, ID_A), null);
  writeFileSync(join(repo, ".drift", "public", "intents", `${ID_A}.json`), '{"summary":"ok"}');
  assert.deepEqual(readManifest(repo, ID_A), { summary: "ok" });
});

// ----------------------------------------------------------------- upsertComment
test("upsertComment: posts when no Drift comment exists, PATCHes in place when it does", async () => {
  const calls = [];
  const posted = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? "GET" });
      if (init.method === "POST") return { ok: true, json: async () => ({ id: 42 }) };
      return { ok: true, json: async () => [] };
    },
  });
  assert.equal(posted.action, "commented");
  assert.ok(calls.some((c) => c.method === "POST"), "must POST when no marker comment exists");

  const updated = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      if (init.method === "PATCH") return { ok: true, json: async () => ({ id: 7 }) };
      if (init.method === "POST") throw new Error("must not POST when a marker comment exists");
      return { ok: true, json: async () => [{ id: 7, body: `other\n${SUMMARY_MARKER}\nold` }] };
    },
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, 7);
});

test("upsertComment: multiple matching comments → update only the first, never POST", async () => {
  const updated = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      if (init.method === "POST") throw new Error("must never POST when a marker comment already exists");
      if (init.method === "PATCH") return { ok: true, json: async () => ({ id: 1 }) };
      return {
        ok: true,
        json: async () => [
          { id: 1, body: `${SUMMARY_MARKER} first` },
          { id: 2, body: `${SUMMARY_MARKER} duplicate` },
          { id: 3, body: "human comment" },
        ],
      };
    },
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, 1);
});

test("upsertComment: unrelated comments are never modified", async () => {
  const calls = [];
  await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      calls.push(init.method ?? "GET");
      if (init.method === "POST") return { ok: true, json: async () => ({ id: 9 }) };
      return { ok: true, json: async () => [{ id: 5, body: "a human comment" }] };
    },
  });
  assert.deepEqual(calls, ["GET", "POST"], "no PATCH on non-Drift comments");
});

test("upsertComment: non-ok and malformed responses throw clear errors", async () => {
  await assert.rejects(
    upsertComment({ token: "t", repo: "o/r", issueNumber: 3, body: "b", fetchImpl: async () => ({ ok: false, status: 403 }) }),
    /list comments: HTTP 403/,
  );
  await assert.rejects(
    upsertComment({
      token: "t",
      repo: "o/r",
      issueNumber: 3,
      body: "b",
      fetchImpl: async () => ({ ok: true, json: async () => "not-an-array" }),
    }),
    /list comments: HTTP 403|malformed API response/,
  );
  await assert.rejects(
    upsertComment({
      token: "t",
      repo: "o/r",
      issueNumber: 3,
      body: "b",
      fetchImpl: async (url, init) => ({ ok: true, json: async () => (init.method === "POST" ? { id: "x" } : []) }),
    }),
    /malformed API response/,
  );
});

// ------------------------------------------- trust-root verification (ADR-009)
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import {
  canonicalJson,
  getFileAt,
  verifyManifestSignature,
  signatureStateFor,
} from "../../scripts/pr-comment.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY = publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER_KEY = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();

function signed(body) {
  const { signature: _sig, ...unsigned } = body;
  const signature = nodeSign(null, Buffer.from(canonicalJson(unsigned), "utf8"), privateKey).toString("base64");
  return { ...unsigned, signature };
}

test("verifyManifestSignature: valid for the signing key, false for wrong/missing keys", () => {
  const manifest = signed({ id: ID_A, summary: "s", timestamp: 1 });
  assert.equal(verifyManifestSignature(manifest, KEY), true);
  assert.equal(verifyManifestSignature(manifest, OTHER_KEY), false);
  assert.equal(verifyManifestSignature({ id: ID_A, summary: "s" }, KEY), false, "unsigned");
  assert.equal(verifyManifestSignature(manifest, "not a key"), false);
});

test("signatureStateFor: valid against base, untrusted-key when only the head key signs", () => {
  const manifest = signed({ id: ID_A, summary: "s", timestamp: 1 });
  // valid: verifies against the BASE-branch trust root
  assert.equal(signatureStateFor(manifest, { baseKey: KEY, headKey: KEY }), "valid");
  // the PR REPLACED the key: manifest only verifies against the new (head) key
  assert.equal(signatureStateFor(manifest, { baseKey: OTHER_KEY, headKey: KEY }), "untrusted-key");
  // invalid: no key verifies
  assert.equal(signatureStateFor(manifest, { baseKey: OTHER_KEY, headKey: OTHER_KEY }), "invalid");
  // bootstrap: base has no Drift key, head key verifies
  assert.equal(signatureStateFor(manifest, { baseKey: null, headKey: KEY }), "bootstrap");
  // unsigned / missing / unverifiable
  assert.equal(signatureStateFor({ id: ID_A, summary: "s" }, { baseKey: KEY, headKey: KEY }), "unsigned");
  assert.equal(signatureStateFor(null, { baseKey: KEY, headKey: KEY }), "missing");
  assert.equal(signatureStateFor(signed({ id: ID_A, summary: "s", timestamp: 1 }), { baseKey: null, headKey: null }), "unverifiable");
});

test("getFileAt: reads a file at a git ref, null when absent", () => {
  const repo = makeRepo();
  const sha = commit(repo, "add file");
  assert.ok((getFileAt(repo, sha, "src/a.ts") ?? "").includes("export const"), "file content at ref");
  assert.equal(getFileAt(repo, sha, "does-not-exist.ts"), null);
  assert.equal(getFileAt(repo, "f".repeat(40), "src/a.ts"), null);
});

test("buildSummary: key-rotation and missing-manifest states are rendered, never the prompt", () => {
  const body = buildSummary([
    { id: ID_A, summary: `Drift intent ${ID_A}`, missingManifest: true, signatureState: "missing", files: [] },
    { id: ID_B, summary: "real summary", missingManifest: false, signatureState: "untrusted-key", files: [] },
  ]);
  assert.ok(body.includes("manifest missing"), body);
  assert.ok(body.includes("signed with a different key"), body);
  assert.ok(!body.includes("intent.prompt"));
});
