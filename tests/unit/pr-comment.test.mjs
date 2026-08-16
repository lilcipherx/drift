import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSummary,
  upsertComment,
  SUMMARY_MARKER,
  LEGACY_SUMMARY_MARKERS,
  parseEvent,
  prCommitShas,
  extractDriftIntentIds,
  intentsFromCommits,
  readManifest,
  sanitizeCommentText,
  parseGitTrailers,
  auditPublicProvenance,
  validateManifest,
  signingKeyIdFor,
  parseTrustRootPem,
  hasProvenanceError,
} from "../../scripts/pr-comment.mjs";
import { generateKeyPair, newIntentId, PublicStore } from "@drift/core";

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
    readManifestImpl: (root, id) => (manifests[id] ? { manifest: manifests[id], errors: null } : { manifest: null, errors: null }),
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

test("readManifest: strictly validates — missing/JSON/type/format errors are reported, never rendered as valid", () => {
  const repo = makeRepo();
  const dir = join(repo, ".drift", "public", "intents");
  mkdirSync(dir, { recursive: true });
  const file = (content) => writeFileSync(join(dir, `${ID_A}.json`), content);
  // missing file → manifest null, no errors (absent ≠ malformed)
  assert.deepEqual(readManifest(repo, ID_B), { manifest: null, errors: null });
  // not JSON
  file("not json");
  let r = readManifest(repo, ID_A);
  assert.equal(r.manifest, null);
  assert.ok(r.errors.some((e) => e.field === "$file"));
  // valid JSON but not a valid manifest (missing required fields)
  file('{"summary":"ok"}');
  r = readManifest(repo, ID_A);
  assert.equal(r.manifest, null);
  assert.ok(r.errors.length > 0, "minimal object must fail strict validation");
  // id must match the filename
  file(JSON.stringify({ schemaVersion: 2, id: ID_B, summary: "s", timestamp: 1, signingKeyId: "0123456789abcdef" }));
  r = readManifest(repo, ID_A);
  assert.equal(r.manifest, null);
  assert.ok(r.errors.some((e) => e.field === "id"));
  // files as object → rejected
  file(JSON.stringify({ schemaVersion: 2, id: ID_A, summary: "s", timestamp: 1, signingKeyId: "0123456789abcdef", files: { path: "x" } }));
  r = readManifest(repo, ID_A);
  assert.equal(r.manifest, null);
  assert.ok(r.errors.some((e) => e.field === "files"));
  // valid V2 manifest round-trips
  const valid = { schemaVersion: 2, id: ID_A, summary: "s", timestamp: 1, signingKeyId: "0123456789abcdef" };
  file(JSON.stringify(valid));
  r = readManifest(repo, ID_A);
  assert.deepEqual(r.manifest, valid);
  assert.equal(r.errors, null);
  // oversized file → rejected without parsing
  file(`{"schemaVersion":2,"id":"${ID_A}","summary":"${'x'.repeat(400 * 1024)}","timestamp":1,"signingKeyId":"0123456789abcdef"}`);
  r = readManifest(repo, ID_A);
  assert.equal(r.manifest, null);
  assert.ok(r.errors.some((e) => e.field === "$file"));
});

// ----------------------------------------------------------------- upsertComment
const BOT_COMMENT = (id, body) => ({ id, user: { login: "github-actions[bot]", type: "Bot" }, body, performed_via_github_app: null });

function upsertFetch({ comments, onPatch, onPost }) {
  return async (url, init = {}) => {
    if (init.method === "PATCH") { if (onPatch) onPatch(url); return { ok: true, json: async () => ({ id: 1 }) }; }
    if (init.method === "POST") { if (onPost) onPost(); return { ok: true, json: async () => ({ id: 99 }) }; }
    return { ok: true, json: async () => comments };
  };
}

test("upsertComment: posts when no Drift comment exists, PATCHes the owned comment in place", async () => {
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
    fetchImpl: upsertFetch({
      comments: [BOT_COMMENT(7, `other\n${SUMMARY_MARKER}\nold`)],
      onPost: () => {
        throw new Error("must not POST when an owned marker comment exists");
      },
    }),
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, 7);
});

test("upsertComment: a user-authored spoofed marker is NEVER updated — Drift posts its own comment", async () => {
  let patched = null;
  const res = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "official",
    fetchImpl: upsertFetch({
      comments: [
        { id: 11, user: { login: "alice", type: "User" }, body: `spoofed ${SUMMARY_MARKER}`, performed_via_github_app: null },
      ],
      onPatch: (url) => {
        patched = url;
      },
    }),
  });
  assert.equal(patched, null, "spoofed user comment must never be PATCHed");
  assert.equal(res.action, "commented", "official comment is posted alongside the spoof");
  assert.equal(res.id, 99);
});

test("upsertComment: bot-authored legacy markers are migrated; App-authored comments are never touched by the Action", async () => {
  // legacy v1 marker authored by the composite Action (github-actions[bot]) → migrated
  const legacy = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: upsertFetch({
      comments: [BOT_COMMENT(21, `legacy ${LEGACY_SUMMARY_MARKERS[1]}`)],
      onPost: () => {
        throw new Error("must not POST when an owned legacy comment exists");
      },
    }),
  });
  assert.equal(legacy.action, "updated");
  assert.equal(legacy.id, 21);

  // a genuine App-authored marker comment belongs to the App — the Action must
  // never edit it; it posts its own comment instead
  let patched = null;
  const appOwned = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: upsertFetch({
      comments: [
        {
          id: 22,
          user: { login: "drift-app[bot]", type: "Bot" },
          body: `app ${SUMMARY_MARKER}`,
          performed_via_github_app: { id: 12345, slug: "drift" },
        },
      ],
      onPatch: (url) => {
        patched = url;
      },
    }),
  });
  assert.equal(patched, null, "the Action must never PATCH an App-authored comment");
  assert.equal(appOwned.action, "commented");
});

test("upsertComment: paginates through the Link header to find the owned comment past page 1", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: 1000 + i,
    user: { login: "someone", type: "User" },
    body: `human comment ${i}`,
    performed_via_github_app: null,
  }));
  const page2 = [BOT_COMMENT(2000, `${SUMMARY_MARKER} on page 2`)];
  const page3 = [
    { id: 3000, user: { login: "alice", type: "User" }, body: `spoof ${SUMMARY_MARKER}`, performed_via_github_app: null },
  ];
  const urls = [];
  const res = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: async (url, init = {}) => {
      urls.push(url);
      if (init.method === "PATCH") return { ok: true, json: async () => ({ id: 2000 }) };
      if (init.method === "POST") throw new Error("must not POST — the owned comment exists on page 2");
      const page = /page=(\d+)/.exec(url)?.[1];
      const next = (p) => `https://api.github.com/repos/o/r/issues/3/comments?page=${p}&per_page=100`;
      if (page === "2") return { ok: true, headers: { get: () => `<${next(3)}>; rel="next"` }, json: async () => page2 };
      if (page === "3") return { ok: true, headers: { get: () => null }, json: async () => page3 };
      return { ok: true, headers: { get: () => `<${next(2)}>; rel="next"` }, json: async () => page1 };
    },
  });
  assert.equal(res.action, "updated");
  assert.equal(res.id, 2000);
  assert.ok(urls.some((u) => u.includes("page=2")), "must follow the Link header to page 2");
  assert.ok(urls.some((u) => u.includes("page=3")), "must follow to page 3 (spoofed marker on page 3 is ignored)");
});

test("upsertComment: multiple matching comments → update only the first, never POST", async () => {
  const updated = await upsertComment({
    token: "t",
    repo: "o/r",
    issueNumber: 3,
    body: "new",
    fetchImpl: upsertFetch({
      comments: [
        BOT_COMMENT(1, `${SUMMARY_MARKER} first`),
        BOT_COMMENT(2, `${SUMMARY_MARKER} duplicate`),
        { id: 3, user: { login: "alice", type: "User" }, body: `spoofed ${SUMMARY_MARKER}`, performed_via_github_app: null },
        { id: 4, user: { login: "someone", type: "User" }, body: "human comment", performed_via_github_app: null },
      ],
      onPost: () => {
        throw new Error("must never POST when an owned marker comment exists");
      },
    }),
  });
  assert.equal(updated.action, "updated");
  assert.equal(updated.id, 1, "deterministically update the FIRST owned marker comment");
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
  // a FAILED head signature with no base key is INVALID, never bootstrap
  const tampered = { ...manifest, summary: "tampered" };
  assert.equal(signatureStateFor(tampered, { baseKey: null, headKey: KEY }), "invalid");
  assert.equal(signatureStateFor(tampered, { baseKey: OTHER_KEY, headKey: OTHER_KEY }), "invalid");
  // a V2 manifest with a mismatched signingKeyId is not "valid" even when the
  // signature verifies
  const v2 = signed({ id: ID_A, summary: "s", timestamp: 1, schemaVersion: 2, signingKeyId: "0123456789abcdef" });
  assert.equal(signatureStateFor(v2, { baseKey: KEY, headKey: KEY }), "invalid", "signingKeyId mismatch must not report valid");
  // malformed base key → unverifiable
  assert.equal(signatureStateFor(manifest, { baseKey: "not a key", headKey: KEY }), "unverifiable");
  // explicit malformed flag
  assert.equal(signatureStateFor({ id: ID_A, summary: "s" }, { baseKey: KEY, headKey: KEY, malformed: true }), "malformed");
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

test("buildSummary: full key-change state — replacement blocks, bootstrap is visible+neutral, none is ordinary", () => {
  // replaced: blocking warning, whole body for a key-only PR
  const replaced = buildSummary([], { keyChange: "replaced" });
  assert.ok(replaced.includes("trust-root change detected"), replaced);
  assert.ok(replaced.includes(".drift/public/key.pem"), replaced);
  assert.ok(replaced.startsWith(SUMMARY_MARKER));
  const removed = buildSummary([], { keyChange: "removed" });
  assert.ok(removed.includes("trust-root change detected"), removed);
  const withIntents = buildSummary([{ id: ID_A, summary: "s", files: [] }], { keyChange: "replaced" });
  assert.ok(withIntents.includes("trust-root change detected"));
  assert.ok(withIntents.includes("1 intent on this PR"));
  // bootstrap: VISIBLE and explicitly labeled, never reduced to a boolean
  const boot = buildSummary([], { keyChange: "bootstrap" });
  assert.ok(boot.includes("initial trust-root bootstrap"), boot);
  assert.ok(boot.includes("first Drift public signing key"), boot);
  assert.ok(!boot.includes("trust-root change detected"), "bootstrap is not a replacement warning");
  const bootWithIntents = buildSummary([{ id: ID_A, summary: "s", files: [] }], { keyChange: "bootstrap" });
  assert.ok(bootWithIntents.includes("initial trust-root bootstrap"));
  assert.ok(bootWithIntents.includes("1 intent on this PR"));
  // none / unchanged: ordinary no-summary behavior
  assert.equal(buildSummary([], { keyChange: "none" }), null);
  assert.equal(buildSummary([], { keyChange: "unchanged" }), null);
});

// ------------------------------------------------------ Action allowlist (F)
import { buildCliArgs, tokenizeCommand } from "../../scripts/action-run.mjs";

test("buildCliArgs: allowlisted operations build a safe CLI invocation", () => {
  assert.deepEqual(buildCliArgs({ operation: "log" }), ["log", "--json"]);
  assert.deepEqual(buildCliArgs({ operation: "status" }), ["status", "--json"]);
  assert.deepEqual(buildCliArgs({ operation: "doctor" }), ["doctor", "--json"]);
  assert.deepEqual(buildCliArgs({ operation: "verify-intent", intentId: ID_A }), ["verify-intent", ID_A, "--json"]);
  assert.deepEqual(buildCliArgs({ operation: "verify", intentId: ID_A }), ["verify", ID_A, "--json"]);
});

test("buildCliArgs: legacy command input is tokenized and allowlisted", () => {
  assert.deepEqual(buildCliArgs({ command: "log" }), ["log", "--json"]);
  assert.deepEqual(buildCliArgs({ command: `verify-intent "${ID_A}"` }), ["verify-intent", ID_A, "--json"]);
  assert.deepEqual(buildCliArgs({ command: "doctor" }), ["doctor", "--json"]);
});

test("tokenizeCommand: quote-aware splitting, never shell semantics", () => {
  assert.deepEqual(tokenizeCommand('log  status'), ["log", "status"]);
  assert.deepEqual(tokenizeCommand('verify-intent "did_123"'), ["verify-intent", "did_123"]);
  assert.deepEqual(tokenizeCommand("verify-intent 'did_abc'"), ["verify-intent", "did_abc"]);
  assert.throws(() => tokenizeCommand("log 'unbalanced"), /unbalanced quotes/);
});

test("buildCliArgs: unsafe operations and flags are rejected before any CLI invocation", () => {
  const bad = [
    "export",
    "export --include-private-prompt",
    "replay did_00000000000000000000000000000000",
    "realize -p secret",
    "key import --file /tmp/k",
    "init",
    "log --include-private-prompt",
    "verify did_00000000000000000000000000000000 --run",
    "verify did_00000000000000000000000000000000 --run --allow-untrusted-command",
    "verify did_00000000000000000000000000000000 --inherit-env",
    "doctor --allow-repository-output",
    "status --anything",
    "log; rm -rf /",
    "$(rm -rf /)",
    "verify-intent",
    "verify-intent not-an-id",
    "log extra positional",
  ];
  for (const c of bad) {
    assert.throws(() => buildCliArgs({ command: c }), (err) => {
      assert.ok(/not allowed|not supported|not permitted|requires exactly|does not accept|invalid intent id/.test(err.message), `unexpected message for "${c}": ${err.message}`);
      return true;
    }, `command "${c}" must be rejected`);
  }
  assert.throws(() => buildCliArgs({ operation: "realize", intentId: ID_A }), /not allowed/);
  assert.throws(() => buildCliArgs({ operation: "" }), /no Drift operation/);
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

// ------------------------------------ end-to-end Action runs (immutable head)
import { fileURLToPath } from "node:url";
const SCRIPT = fileURLToPath(new URL("../../scripts/pr-comment.mjs", import.meta.url));

/** Run the REAL Action script with a controlled event file + env. */
function runAction({ repo, event, env = {}, token = "" }) {
  const eventFile = join(repo, ".event.json");
  const summaryFile = join(repo, ".step-summary.md");
  writeFileSync(eventFile, JSON.stringify(event));
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      DRIFT_REPO: repo,
      GITHUB_TOKEN: token,
      ...env,
    },
  });
  const summary = existsSync(summaryFile) ? readFileSync(summaryFile, "utf8") : "";
  return { status: res.status ?? -1, summary, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const eventForSha = (repo, baseSha, headSha, prNumber = 7) => ({
  pull_request: { number: prNumber, base: { sha: baseSha }, head: { sha: headSha } },
  repository: { full_name: "lilcipherx/drift" },
});

function writeKey(repo, pem) {
  const dir = join(repo, ".drift", "public");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "key.pem"), pem);
}

function writeManifestFile(repo, id, manifestObj) {
  const dir = join(repo, ".drift", "public", "intents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(manifestObj, null, 2));
}

test("Action immutable head: synthetic merge checkout cannot affect trust results (scenario A)", () => {
  // base B (key K1) → side commit H (key K2) → synthetic merge M whose TREE
  // has K1 again. The event head.sha is H, so the trust result must reflect
  // K2 (replaced) even though HEAD shows K1.
  const repo = makeRepo();
  const K1 = KEY;
  const K2 = OTHER_KEY;
  writeKey(repo, K1);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base with K1"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-qb", "side"]);
  writeKey(repo, K2);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 5;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "head with K2"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["checkout", "-q", "main"]);
  git(repo, ["merge", "--no-ff", "side", "-m", "merge side"]);
  // synthetic merge: HEAD tree now has K2 — force it back to K1 so HEAD
  // differs from the event head SHA
  git(repo, ["checkout", "-q", baseSha, "--", ".drift/public/key.pem"]);
  git(repo, ["commit", "-qm", "synthetic merge (K1 tree)"]);
  assert.equal((git(repo, ["show", "HEAD:.drift/public/key.pem"]).trim()), K1.trim(), "HEAD shows K1");
  assert.equal((git(repo, ["show", `${headSha}:.drift/public/key.pem`]).trim()), K2.trim(), "event head shows K2");

  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.notEqual(r.status, 0, "replaced trust root must fail the workflow");
  assert.ok(r.summary.includes("trust-root change detected"), r.summary);
  assert.ok(r.stderr.includes("provenance error"), r.stderr);
});

test("Action immutable head: working-tree provenance mutations are ignored (scenario B/C)", () => {
  const repo = makeRepo();
  writeKey(repo, KEY);
  // historical manifest A at base (with its own trailer at base)
  const manifestA = signed({ schemaVersion: 2, id: ID_A, summary: "historical A", timestamp: 1, signingKeyId: signingKeyIdFor(KEY) });
  writeManifestFile(repo, ID_A, manifestA);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base with K + A\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // head ATOMICALLY adds new intent B (manifest + trailer in one commit)
  const manifestB = signed({ schemaVersion: 2, id: ID_B, summary: "immutable intent", timestamp: 2, signingKeyId: signingKeyIdFor(KEY) });
  writeManifestFile(repo, ID_B, manifestB);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 6;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `head adds B\n\nDrift-Intent: ${ID_B}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  // mutate the WORKING TREE (uncommitted): tamper manifest B + append junk to
  // key.pem. The Action must evaluate the immutable head commit instead.
  writeManifestFile(repo, ID_B, { ...manifestB, summary: "tampered in worktree" });
  writeFileSync(join(repo, ".drift", "public", "key.pem"), `${KEY}\n# worktree junk\n`);
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.equal(r.status, 0, `working-tree mutations must not fail the trust check: ${r.stderr}`);
  assert.ok(r.summary.includes("immutable intent"), r.summary);
  assert.ok(r.summary.includes("✓ signed"), r.summary);
  assert.ok(!r.summary.includes("tampered in worktree"), "working-tree manifest content must never be read");
});

test("Action failure policy: invalid provenance fails WITHOUT a token (exit non-zero, summary still written)", () => {
  const repo = makeRepo();
  writeKey(repo, KEY);
  writeManifestFile(repo, ID_A, signed({ schemaVersion: 2, id: ID_A, summary: "orig", timestamp: 1, signingKeyId: signingKeyIdFor(KEY) }));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // head MODIFIES the existing manifest (append-only violation), no trailer
  writeManifestFile(repo, ID_A, signed({ schemaVersion: 2, id: ID_A, summary: "modified on PR", timestamp: 1, signingKeyId: signingKeyIdFor(KEY) }));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 7;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "tamper manifest"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  // no token, default fail-on-provenance-error=true → must still exit non-zero
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.notEqual(r.status, 0, "invalid provenance must fail the workflow even without a token");
  assert.ok(r.summary.includes("integrity"), "safe step summary is still written");
  assert.ok(r.stdout.includes("GITHUB_TOKEN not set"), "token absence is reported");
  assert.ok(r.stderr.includes("provenance error"), "provenance failure is reported");

  // fail-on-provenance-error=false → report-only, exit 0
  const r2 = runAction({ repo, event: eventForSha(repo, baseSha, headSha), env: { FAIL_ON_PROVENANCE_ERROR: "false" } });
  assert.equal(r2.status, 0, "report-only mode must not fail the workflow");
});

test("Action failure policy: comment failures and provenance failures are independent (with token)", () => {
  const repo = makeRepo();
  writeKey(repo, KEY);
  // historical manifest A at base (trailer at base, not re-referenced on the PR)
  writeManifestFile(repo, ID_A, signed({ schemaVersion: 2, id: ID_A, summary: "historical", timestamp: 1, signingKeyId: signingKeyIdFor(KEY) }));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // head atomically adds NEW intent B (valid provenance)
  writeManifestFile(repo, ID_B, signed({ schemaVersion: 2, id: ID_B, summary: "valid", timestamp: 2, signingKeyId: signingKeyIdFor(KEY) }));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 8;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `head adds B\n\nDrift-Intent: ${ID_B}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);

  // valid provenance + garbage token + comment 401: exit 0 unless
  // fail-on-comment-error (a comment failure never causes a provenance fail)
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha), token: "garbage-token" });
  assert.equal(r.status, 0, `valid provenance with a failing comment must stay green: ${r.stderr.slice(0, 300)}`);
  const r2 = runAction({ repo, event: eventForSha(repo, baseSha, headSha), token: "garbage-token", env: { FAIL_ON_COMMENT_ERROR: "true" } });
  assert.notEqual(r2.status, 0, "fail-on-comment-error=true must fail on the 401");
});

test("Action trust-root bootstrap: key-only PR is visible, neutral, and exits 0", () => {
  const repo = makeRepo();
  // base has NO drift key; head introduces K
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writeKey(repo, KEY);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "introduce first key"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.equal(r.status, 0, "bootstrap is neutral, never a failure");
  assert.ok(r.summary.includes("initial trust-root bootstrap"), r.summary);
  assert.ok(r.summary.includes("first Drift public signing key"), r.summary);
});

// ------------------------------------------------ provenance integrity audit
function writePublicProvenance(repo, { key = true, manifests = {} }) {
  const intentsDir = join(repo, ".drift", "public", "intents");
  mkdirSync(intentsDir, { recursive: true });
  if (key) writeFileSync(join(repo, ".drift", "public", "key.pem"), "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n");
  for (const [id, extra] of Object.entries(manifests)) {
    writeFileSync(
      join(intentsDir, `${id}.json`),
      JSON.stringify({ schemaVersion: 2, id, summary: "s", timestamp: 1, signingKeyId: "0123456789abcdef", ...extra }),
    );
  }
}

function auditOf(repo, { baseSha, headSha, commits }) {
  return auditPublicProvenance({ repoRoot: repo, baseSha, headSha, commits });
}

test("auditPublicProvenance: a valid atomic introduction (key + manifest + trailer in one commit) is clean", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `feat\n\nDrift-Intent: ${ID_A}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.replayIds, []);
  assert.deepEqual(audit.ambiguousIds, []);
});

test("auditPublicProvenance: modifying an existing manifest is a violation (append-only)", () => {
  const repo = makeRepo();
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // modify the manifest WITHOUT a trailer
  writePublicProvenance(repo, { manifests: { [ID_A]: { summary: "tampered" } } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "tamper"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(audit.violations.some((v) => v.code === "modified" && v.id === ID_A), JSON.stringify(audit.violations));
});

test("auditPublicProvenance: deleting and renaming existing manifests are violations", () => {
  const repo = makeRepo();
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  // rename ID_A → ID_B (git mv)
  const intentsDir = join(repo, ".drift", "public", "intents");
  const mvOld = join(intentsDir, `${ID_A}.json`);
  const mvNew = join(intentsDir, `${ID_B}.json`);
  git(repo, ["mv", mvOld, mvNew]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "rename"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  let audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(audit.violations.some((v) => v.code === "renamed"), JSON.stringify(audit.violations));

  // delete ID_B → deleted
  const delRepo = makeRepo();
  writePublicProvenance(delRepo, { manifests: { [ID_A]: {} } });
  git(delRepo, ["add", "-A"]);
  git(delRepo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const base2 = git(delRepo, ["rev-parse", "HEAD"]);
  const delManifest = join(delRepo, ".drift", "public", "intents", `${ID_A}.json`);
  git(delRepo, ["rm", "-q", delManifest]);
  git(delRepo, ["add", "-A"]);
  git(delRepo, ["commit", "-qm", "delete"]);
  const head2 = git(delRepo, ["rev-parse", "HEAD"]);
  audit = auditOf(delRepo, { baseSha: base2, headSha: head2, commits: [head2] });
  assert.ok(audit.violations.some((v) => v.code === "deleted" && v.id === ID_A), JSON.stringify(audit.violations));
});

test("auditPublicProvenance: an orphan manifest (added without any trailer) is a violation", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "manifest with no trailer"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(audit.violations.some((v) => v.code === "orphan" && v.id === ID_A), JSON.stringify(audit.violations));
  assert.ok(audit.orphanIds.includes(ID_A));
});

test("auditPublicProvenance: a trailer referencing a manifest that already exists on base is a replay", () => {
  const repo = makeRepo();
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `base\n\nDrift-Intent: ${ID_A}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // a NEW commit re-references the same intent (manifest unchanged at head)
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `reuse\n\nDrift-Intent: ${ID_A}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(audit.replayIds.includes(ID_A), JSON.stringify(audit));
});

test("auditPublicProvenance: one id referenced by two commits is ambiguous (never silently first-wins)", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `one\n\nDrift-Intent: ${ID_A}`]);
  const c1 = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `two\n\nDrift-Intent: ${ID_A}`]);
  const c2 = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha: c2, commits: [c1, c2] });
  assert.ok(audit.ambiguousIds.includes(ID_A), JSON.stringify(audit));
  assert.ok(!audit.violations.some((v) => v.code === "orphan"), "n>1 is ambiguous, not orphan");
});

test("auditPublicProvenance: added-then-modified in the same PR is a violation (mutated)", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // c1: atomic introduction (content X + matching trailer)
  writePublicProvenance(repo, { manifests: { [ID_A]: { summary: "original" } } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `add\n\nDrift-Intent: ${ID_A}`]);
  const c1 = git(repo, ["rev-parse", "HEAD"]);
  // c2: modifies the SAME manifest (content Y) — final diff still shows "A"
  writePublicProvenance(repo, { manifests: { [ID_A]: { summary: "mutated after introduction" } } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "tweak manifest"]);
  const c2 = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha: c2, commits: [c1, c2] });
  assert.ok(audit.violations.some((v) => v.code === "mutated" && v.id === ID_A), JSON.stringify(audit.violations));
});

test("auditPublicProvenance: unchanged introduction is NOT flagged as mutated (byte-identical head blob)", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writePublicProvenance(repo, { manifests: { [ID_A]: {} } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `add\n\nDrift-Intent: ${ID_A}`]);
  const c1 = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 4;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "unrelated source change"]);
  const c2 = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha: c2, commits: [c1, c2] });
  assert.deepEqual(audit.violations, [], JSON.stringify(audit));
});

// ------------------------------------------ contract: real Core → Action
// The Action and Core must agree on key identity and signature validity. A
// real Core-generated V2 manifest (the production writer `PublicStore.write`)
// must be classified VALID by the Action's verification path.
test("contract: a real Core V2 manifest is valid through the Action (fingerprint + signature)", () => {
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  const id = newIntentId();
  // PublicStore is constructed on the `.drift` dir (as the engine does);
  // readManifest (the Action loader) is called on the repo root.
  const root = mkdtempSync(join(tmpdir(), "drift-contract-"));
  const store = new PublicStore(join(root, ".drift"));
  const view = {
    schemaVersion: 2,
    id,
    summary: "contract test intent",
    model: "test-model",
    agent: { type: "AGENT", identifier: "contract-test" },
    verification: "npm test",
    files: [{ path: "src/a.ts", mutationType: "ADDED", summary: "added a" }],
    timestamp: Date.now(),
    signingKeyId: signingKeyIdFor(publicKeyPem),
  };
  store.write(view, privateKeyPem); // the production manifest writer
  const loaded = readManifest(root, id); // the Action's loader
  assert.ok(loaded.manifest, "Action must load the Core-written manifest");
  assert.equal(loaded.errors, null, JSON.stringify(loaded.errors));
  // the manifest's signingKeyId (Core canonical SPKI-DER) must equal the
  // Action's canonical fingerprint — LF/CRLF/whitespace must not change it
  assert.equal(loaded.manifest.signingKeyId, signingKeyIdFor(publicKeyPem));
  assert.equal(
    signingKeyIdFor(publicKeyPem.replace(/\n/g, "\r\n")),
    signingKeyIdFor(publicKeyPem),
    "CRLF PEM must produce the same fingerprint",
  );
  assert.equal(
    signingKeyIdFor(`  ${publicKeyPem}\n\n`),
    signingKeyIdFor(publicKeyPem),
    "surrounding whitespace must produce the same fingerprint",
  );
  const state = signatureStateFor(loaded.manifest, { baseKey: publicKeyPem, headKey: publicKeyPem });
  assert.equal(state, "valid", "a real Core manifest must be VALID in the Action");
  // a different key must NOT validate the same manifest
  const other = generateKeyPair();
  assert.equal(
    signatureStateFor(loaded.manifest, { baseKey: other.publicKeyPem, headKey: other.publicKeyPem }),
    "invalid",
  );
  rmSync(root, { recursive: true, force: true });
});

test("validateManifest: strict unknown-field rejection (top-level, agent, files)", () => {
  const base = {
    schemaVersion: 2,
    id: ID_A,
    summary: "s",
    timestamp: 1,
    signature: "",
    signingKeyId: "0123456789abcdef",
  };
  assert.equal(validateManifest(base).ok, true);
  assert.equal(validateManifest({ ...base, extraTopLevel: 1 }).ok, false);
  assert.equal(validateManifest({ ...base, agent: { type: "AGENT", identifier: "x", extraAgent: true } }).ok, false);
  assert.equal(validateManifest({ ...base, files: [{ path: "a", mutationType: "ADDED", extraFile: 1 }] }).ok, false);
  assert.equal(validateManifest({ ...base, commit: "abc" }).ok, false, "commit is V1-only, rejected on V2");
});

// ---------------------------------------- Core ⇄ Action ⇄ App validator parity
// One schema, three consumers. Every vector below must classify identically
// across the Core parser, the dependency-free Action validator and the App
// loader — a classification difference is a security divergence.
test("validator parity: identical vectors classify identically in Core, Action and App", async () => {
  const core = await import("@drift/core");
  const appUrl = new URL("../../packages/drift-app/dist/intents.js", import.meta.url);
  const { parseLoadedManifest } = await import(appUrl.href);
  const base = {
    schemaVersion: 2,
    id: ID_A,
    summary: "summary text",
    timestamp: 1,
    signature: "",
    signingKeyId: "0123456789abcdef",
  };
  const vectors = [
    { name: "empty summary", manifest: { ...base, summary: "" } },
    { name: "whitespace-only summary", manifest: { ...base, summary: "   \n\t " } },
    { name: "summary with control characters", manifest: { ...base, summary: "ok\x07bell" } },
    { name: "invalid V2 agent type", manifest: { ...base, agent: { type: "ROBOT", identifier: "x" } } },
    { name: "empty agent identifier", manifest: { ...base, agent: { type: "AGENT", identifier: " " } } },
    { name: "agent identifier with control chars", manifest: { ...base, agent: { type: "AGENT", identifier: "x\x00y" } } },
    { name: "model with control chars", manifest: { ...base, model: "m\x1b[31m" } },
    { name: "verification with control chars", manifest: { ...base, verification: "npm \x07test" } },
    { name: "file path with control chars", manifest: { ...base, files: [{ path: "src/a.ts\x00", mutationType: "ADDED" }] } },
    { name: "file summary with control chars", manifest: { ...base, files: [{ path: "a.ts", mutationType: "ADDED", summary: "x\x07" }] } },
    { name: "unknown top-level field", manifest: { ...base, extra: 1 } },
    { name: "unknown nested agent field", manifest: { ...base, agent: { type: "AGENT", identifier: "x", extra: 1 } } },
    { name: "unknown nested file field", manifest: { ...base, files: [{ path: "a.ts", mutationType: "ADDED", extra: 1 }] } },
    { name: "invalid signature encoding", manifest: { ...base, signature: "!!!not-base64!!!" } },
    { name: "wrong signingKeyId format", manifest: { ...base, signingKeyId: "ZZZ" } },
    { name: "oversized summary", manifest: { ...base, summary: "x".repeat(5000) } },
    { name: "signature null (required case)", manifest: { ...base, summary: "", signature: null } },
    { name: "valid V2", manifest: base },
    { name: "valid V1", manifest: { schemaVersion: 1, id: ID_A, summary: "s", timestamp: 1, commit: "abc", signature: "" } },
  ];
  const classify = (m) => {
    const raw = JSON.stringify(m);
    const c = core.parsePublicIntentManifest(JSON.parse(raw), { expectedId: ID_A });
    const a = validateManifest(JSON.parse(raw), { expectedId: ID_A });
    const ap = parseLoadedManifest(raw, ID_A);
    return {
      core: c.ok ? "valid" : "malformed",
      action: a.ok ? "valid" : "malformed",
      app: ap.manifest ? "valid" : "malformed",
    };
  };
  for (const { name, manifest } of vectors) {
    const r = classify(manifest);
    assert.equal(r.action, r.core, `Action vs Core divergence: ${name} — ${JSON.stringify(r)}`);
    assert.equal(r.app, r.core, `App vs Core divergence: ${name} — ${JSON.stringify(r)}`);
  }
  // the required concrete case must be malformed EVERYWHERE
  const required = classify({ schemaVersion: 2, summary: "", signature: null });
  assert.deepEqual(required, { core: "malformed", action: "malformed", app: "malformed" }, JSON.stringify(required));
});

test("hasProvenanceError: trust/integrity state → workflow-failure mapping (issue 13)", () => {
  const intent = (signatureState) => ({ id: ID_A, signatureState });
  // failures
  assert.equal(hasProvenanceError({ intents: [intent("invalid")], keyChange: "unchanged", audit: emptyAudit() }), true);
  assert.equal(hasProvenanceError({ intents: [intent("untrusted-key")], keyChange: "unchanged", audit: emptyAudit() }), true);
  assert.equal(hasProvenanceError({ intents: [intent("malformed")], keyChange: "unchanged", audit: emptyAudit() }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "replaced", audit: emptyAudit() }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "removed", audit: emptyAudit() }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "unchanged", audit: { violations: [{ code: "modified", id: ID_A, detail: "x" }], replayIds: [], ambiguousIds: [] } }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "unchanged", audit: { violations: [], replayIds: [ID_A], ambiguousIds: [] } }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "unchanged", audit: { violations: [], replayIds: [], ambiguousIds: [ID_A] } }), true);
  // neutral states never fail by default
  assert.equal(hasProvenanceError({ intents: [intent("bootstrap")], keyChange: "bootstrap", audit: emptyAudit() }), false);
  assert.equal(hasProvenanceError({ intents: [intent("unsigned")], keyChange: "unchanged", audit: emptyAudit() }), false);
  assert.equal(hasProvenanceError({ intents: [intent("unverifiable")], keyChange: "unchanged", audit: emptyAudit() }), false);
  assert.equal(hasProvenanceError({ intents: [intent("missing")], keyChange: "unchanged", audit: emptyAudit() }), false);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "none", audit: emptyAudit() }), false);
  assert.equal(hasProvenanceError({ intents: [intent("valid")], keyChange: "unchanged", audit: emptyAudit() }), false);
  function emptyAudit() {
    return { violations: [], replayIds: [], ambiguousIds: [] };
  }
});

// --------------------------------------------- final completeness regressions
test("auditPublicProvenance: NEW PR trailer without a manifest is a hard violation", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // head introduces a trailer for ID_NEW but ships NO manifest file
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 90;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `feat\n\nDrift-Intent: ${ID_C}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(
    audit.violations.some((v) => v.code === "trailer-without-manifest" && v.id === ID_C),
    JSON.stringify(audit.violations),
  );
});

test("auditPublicProvenance: a historical legacy trailer (from base history) with no manifest stays neutral", () => {
  const repo = makeRepo();
  // base commit references a legacy pre-V2 intent id with NO manifest — this
  // is historical data, and the PR range carries it in without re-introducing it.
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 90;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `legacy full-mode intent\n\nDrift-Intent: ${ID_B}`]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 91;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "plain source change"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  // PR range includes the legacy commit (ancestor of base) + the new commit
  const audit = auditOf(repo, { baseSha, headSha, commits: [baseSha, headSha] });
  assert.equal(audit.violations.length, 0, JSON.stringify(audit.violations));
  assert.ok(!audit.replayIds.includes(ID_B), "no manifest anywhere → not a replay");
});

test("auditPublicProvenance: a manifest placed at the WRONG filename is a violation", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // the manifest's OWN id is ID_B but it is stored as ID_A.json (and the
  // trailer says ID_B) — the filename/id mismatch must not silently associate
  writePublicProvenance(repo, { manifests: { [ID_A]: { id: ID_B } } });
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `feat\n\nDrift-Intent: ${ID_B}`]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const audit = auditOf(repo, { baseSha, headSha, commits: [headSha] });
  assert.ok(
    audit.violations.some((v) => v.id === ID_B && v.detail.includes("wrong filename")),
    JSON.stringify(audit.violations),
  );
});

test("Action malformed trust-root states: malformed initial key fails, valid bootstrap stays neutral", () => {
  const repo = makeRepo();
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  // head introduces a MALFORMED key file (not a real key)
  writeKey(repo, "-----BEGIN PUBLIC KEY-----\nNOT_A_REAL_KEY\n-----END PUBLIC KEY-----\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "introduce malformed key"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.notEqual(r.status, 0, "a malformed initial key is NOT a bootstrap — it must fail");
  assert.ok(r.summary.includes("initial trust root is malformed"), r.summary);
  assert.ok(!r.summary.includes("unverified bootstrap"), "malformed must never be labeled bootstrap");
  // no token must not bypass the failure either
  const rNoToken = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.notEqual(rNoToken.status, 0);
});

test("Action malformed base trust root: base-malformed fails even with a valid head key", () => {
  const repo = makeRepo();
  writeKey(repo, "-----BEGIN PUBLIC KEY-----\nGARBAGE\n-----END PUBLIC KEY-----\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base with malformed key"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);
  writeKey(repo, KEY);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "head with valid key"]);
  const headSha = git(repo, ["rev-parse", "HEAD"]);
  const r = runAction({ repo, event: eventForSha(repo, baseSha, headSha) });
  assert.notEqual(r.status, 0, "a malformed base root must never silently trust the head key");
  assert.ok(r.summary.includes("trust root is malformed on the base branch"), r.summary);
});

test("hasProvenanceError: malformed key states fail; trailer-without-manifest fails", () => {
  assert.equal(hasProvenanceError({ intents: [], keyChange: "malformed-bootstrap", audit: { violations: [], replayIds: [], ambiguousIds: [] } }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "malformed-replacement", audit: { violations: [], replayIds: [], ambiguousIds: [] } }), true);
  assert.equal(hasProvenanceError({ intents: [], keyChange: "base-malformed", audit: { violations: [], replayIds: [], ambiguousIds: [] } }), true);
  assert.equal(
    hasProvenanceError({
      intents: [],
      keyChange: "unchanged",
      audit: { violations: [{ code: "trailer-without-manifest", id: ID_C, detail: "x" }], replayIds: [], ambiguousIds: [] },
    }),
    true,
  );
});
test("Action parseTrustRootPem: accepts ONLY validated Ed25519 public keys (Core parity)", () => {
  const { privateKey: pk, publicKey: pub } = generateKeyPairSync("ed25519");
  const valid = pub.export({ type: "spki", format: "pem" }).toString();
  const privatePem = pk.export({ type: "pkcs8", format: "pem" }).toString();
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaPem = rsa.publicKey.export({ type: "spki", format: "pem" }).toString();
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const ecPem = ec.publicKey.export({ type: "spki", format: "pem" }).toString();

  assert.equal(parseTrustRootPem(valid).state, "valid", "Ed25519 SPKI PEM is valid");
  assert.equal(parseTrustRootPem(valid.replace(/\n/g, "\r\n")).state, "valid", "CRLF is valid");
  assert.equal(
    parseTrustRootPem(valid).fingerprint,
    parseTrustRootPem(valid.replace(/\n/g, "\r\n")).fingerprint,
    "CRLF never changes the identity",
  );
  // A private key PEM must NOT be accepted even though createPublicKey would
  // derive a public key from it (Node quirk the parser must guard against).
  const priv = parseTrustRootPem(privatePem);
  assert.equal(priv.state, "malformed");
  assert.equal(priv.errorCode, "not-public-key");
  assert.equal(parseTrustRootPem(rsaPem).errorCode, "unsupported-key-type", "RSA is rejected");
  assert.equal(parseTrustRootPem(ecPem).errorCode, "unsupported-key-type", "EC is rejected");
  assert.equal(parseTrustRootPem("garbage").state, "malformed");
  assert.equal(parseTrustRootPem(null).state, "absent");
  assert.equal(parseTrustRootPem("").state, "absent");
  // oversized PEM
  const big = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(20 * 1024)}\n-----END PUBLIC KEY-----`;
  assert.equal(parseTrustRootPem(big).errorCode, "oversized");
});
