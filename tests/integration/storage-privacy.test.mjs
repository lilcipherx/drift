/**
 * ADR-009 privacy guarantees, proven with real git commands:
 *
 *  1. `.drift/.gitignore` ignores the private store; `git add .` can never
 *     stage prompts, the database, objects or keys.
 *  2. A one-line raw prompt NEVER becomes the public summary: an explicit
 *     `--summary` is separate, and without one a generic non-prompt fallback
 *     is used. A unique secret marker in a one-line raw prompt never reaches
 *     git history, tracked files, or default JSON under the safe default mode.
 *  3. `none` mode persists the marker nowhere.
 *  4. Committed public manifests are canonical: a fresh clone (no private DB)
 *     serves `log`/`blame`/`verify`, and `drift init` in a clone must NOT let
 *     the newly created empty local store shadow the public intents.
 *  5. `drift doctor` detects legacy tracked private files and reports safe
 *     untrack commands.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(process.cwd(), "packages", "drift-cli", "dist", "cli.js");
// Part 7 markers — one per scenario, all on ONE-LINE raw prompts.
const MARKER = "DRIFT_PRIVATE_SECRET_ONE_LINE_91f2";
const MARKER_NO_SUMMARY = "DRIFT_PRIVATE_SECRET_NO_SUMMARY_47ac";
const MARKER_NONE = "DRIFT_PRIVATE_SECRET_NONE_3f8a";

function run(repo, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout;
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-priv-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

/** Recursively collect absolute paths of regular files under `dir`. */
function collectFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { recursive: true })) {
    const abs = join(dir, name);
    if (!existsSync(abs)) continue;
    try {
      if (statSync(abs).isFile()) out.push(abs);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function realizeWithMarker(repo, prompt = `do the thing with ${MARKER} in it`) {
  writeFileSync(join(repo, "src", "a.ts"), `export const a = ${Date.now()};\n`);
  const res = run(repo, ["realize", "-p", prompt, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  return res;
}

// ------------------------------------------------------------ storage rules
test("drift init writes a .drift/.gitignore that ignores all private data and keeps only public files trackable", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);

  // every private path must be ignored
  for (const p of [".drift/drift.db", ".drift/objects", ".drift/keys/ed25519.pem", ".drift/private"]) {
    const res = spawnSync("git", ["check-ignore", "-q", "--", p], { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, `${p} must be ignored`);
  }
  // public files must NOT be ignored
  for (const p of [".drift/.gitignore", ".drift/config.toml", ".drift/public/key.pem"]) {
    const res = spawnSync("git", ["check-ignore", "-q", "--", p], { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 1, `${p} must be trackable (not ignored)`);
  }
});

test("git add . never stages private Drift data", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  realizeWithMarker(repo);
  git(repo, ["add", "-A"]);
  const tracked = git(repo, ["ls-files", "--", ".drift"]).split("\n").filter(Boolean);
  for (const f of tracked) {
    assert.ok(
      f === ".drift/.gitignore" || f === ".drift/config.toml" || f.startsWith(".drift/public/"),
      `unexpected tracked .drift file: ${f}`,
    );
  }
  // and nothing private is even staged
  const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  for (const f of staged) {
    assert.ok(!f.startsWith(".drift/objects/") && f !== ".drift/drift.db", `private file staged: ${f}`);
  }
});

test("repeated drift init is idempotent and preserves a user-edited .drift/.gitignore", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const first = readFileSync(join(repo, ".drift", ".gitignore"), "utf8");
  // simulate a user addition
  writeFileSync(join(repo, ".drift", ".gitignore"), `${first}\n# user rule\nmy-local-file.tmp\n`);
  assert.equal(run(repo, ["init"]).status, 0);
  const second = readFileSync(join(repo, ".drift", ".gitignore"), "utf8");
  assert.ok(second.includes("# user rule"), "user lines must be preserved");
  assert.ok(second.includes("my-local-file.tmp"), "user lines must be preserved");
  // running init again changes nothing further (idempotent)
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(readFileSync(join(repo, ".drift", ".gitignore"), "utf8"), second);
  // and private data is still ignored afterwards
  const res = spawnSync("git", ["check-ignore", "-q", "--", ".drift/drift.db"], { cwd: repo, encoding: "utf8" });
  assert.equal(res.status, 0);
});

test("the root .gitignore of the repo itself is never touched by drift init", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, ".gitignore"), "# my root rules\nbuild/\n");
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "# my root rules\nbuild/\n");
});

// ------------------------------------------------------------ secret markers
test("one-line prompt + explicit public summary: the raw prompt never enters git history, tracked files, or default JSON", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // Part 7 Test A — a ONE-LINE raw prompt (the whole prompt could be
  // sensitive) plus a separate PUBLIC summary.
  const prompt = `Implement authentication using ${MARKER}`;
  const summary = "Improve authentication handling";
  writeFileSync(join(repo, "src", "a.ts"), `export const a = ${Date.now()};\n`);
  const res = run(repo, ["realize", "-p", prompt, "--summary", summary, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "intent"]);

  // the safe public summary IS public — present in history, log and manifest
  const messages = git(repo, ["log", "--all", "--format=%B"]);
  assert.ok(messages.includes("Intent: Improve authentication handling"), messages);
  // but the raw prompt marker is absent from EVERY public/tracked surface
  assert.ok(!git(repo, ["log", "--all", "-p"]).includes(MARKER), "marker leaked into git history patch");
  assert.ok(!git(repo, ["log", "--all", "--format=%B"]).includes(MARKER), "marker leaked into commit messages");
  assert.ok(!git(repo, ["show", "HEAD"]).includes(MARKER), "marker leaked into git show HEAD");
  const grep = spawnSync("git", ["grep", "-n", MARKER, "--", "."], { cwd: repo, encoding: "utf8" });
  assert.equal(grep.status, 1, "marker must not be found by git grep");
  assert.ok(!git(repo, ["ls-tree", "-r", "HEAD"]).includes(MARKER), "marker leaked into the HEAD tree");
  for (const f of git(repo, ["ls-files"]).split("\n").filter(Boolean)) {
    assert.ok(!readFileSync(join(repo, f), "utf8").includes(MARKER), `marker leaked into tracked file ${f}`);
  }
  // every tracked .drift/public file is clean
  for (const f of git(repo, ["ls-files", "--", ".drift"]).split("\n").filter(Boolean)) {
    const content = readFileSync(join(repo, f), "utf8");
    assert.ok(!content.includes(MARKER), `marker leaked into tracked file ${f}`);
  }

  // default CLI outputs: safe summary, no prompt, no marker
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].summary, "Improve authentication handling");
  assert.ok(!("prompt" in log.intents[0]), "default log JSON must not contain the prompt");
  assert.ok(!JSON.stringify(log).includes(MARKER), "marker leaked into default log JSON");
  const ctx = JSON.parse(run(repo, ["context", "src/a.ts", "--json"]).stdout);
  assert.ok(!JSON.stringify(ctx).includes(MARKER), "marker leaked into default context JSON");
  const blame = JSON.parse(run(repo, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blame.intent.summary, "Improve authentication handling");
  assert.ok(!JSON.stringify(blame).includes(MARKER), "marker leaked into default blame JSON");

  // the marker MAY exist only in the ignored private store
  assert.ok(existsSync(join(repo, ".drift", "drift.db")), "private DB exists locally");
  const objectsDir = join(repo, ".drift", "objects");
  const objectFiles = readdirSync(objectsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
  assert.ok(objectFiles.length >= 1, "private objects exist locally");
  const anyPrivate = objectFiles.some((f) => readFileSync(join(objectsDir, f), "utf8").includes(MARKER));
  assert.ok(anyPrivate, "marker may live in the IGNORED private objects — that is the design");
});

test("one-line prompt without a summary: generic non-prompt fallback, marker absent everywhere", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // Part 7 Test B — no explicit summary at all.
  const prompt = `Refactor payment validation using ${MARKER_NO_SUMMARY}`;
  writeFileSync(join(repo, "src", "a.ts"), `export const a = ${Date.now()};\n`);
  const res = run(repo, ["realize", "-p", prompt, "--json"]);
  assert.equal(res.status, 0, res.stderr);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "intent"]);

  // generic fallback derived only from non-prompt metadata
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.ok(
    log.intents[0].summary.startsWith("Drift intent "),
    `generic fallback expected, got: ${log.intents[0].summary}`,
  );
  assert.ok(!log.intents[0].summary.includes("Refactor payment"), "fallback must not contain prompt text");

  // commit subject is the generic fallback, never prompt text
  const messages = git(repo, ["log", "--all", "--format=%B"]);
  assert.ok(messages.includes("Intent: Drift intent "), messages);
  assert.ok(!messages.includes("Refactor payment validation"), "prompt text must not appear in commit messages");

  // marker absent from every public surface
  assert.ok(!git(repo, ["log", "--all", "-p"]).includes(MARKER_NO_SUMMARY));
  assert.ok(!git(repo, ["log", "--all", "--format=%B"]).includes(MARKER_NO_SUMMARY));
  const grep = spawnSync("git", ["grep", "-n", MARKER_NO_SUMMARY, "--", "."], { cwd: repo, encoding: "utf8" });
  assert.equal(grep.status, 1);
  assert.ok(!git(repo, ["ls-tree", "-r", "HEAD"]).includes(MARKER_NO_SUMMARY));
  assert.ok(!JSON.stringify(log).includes(MARKER_NO_SUMMARY), "marker leaked into default log JSON");
});

test("secret marker is absent everywhere under none mode", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"none\"\n");
  const prompt = `secret ${MARKER_NONE} that must persist nowhere`;
  realizeWithMarker(repo, prompt);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "intent"]);

  assert.ok(!git(repo, ["log", "--all", "-p"]).includes(MARKER_NONE));
  assert.ok(!git(repo, ["log", "--all", "--format=%B"]).includes(MARKER_NONE));
  const grep = spawnSync("git", ["grep", "-n", MARKER_NONE, "--", "."], { cwd: repo, encoding: "utf8" });
  assert.equal(grep.status, 1);
  assert.ok(!git(repo, ["ls-tree", "-r", "HEAD"]).includes(MARKER_NONE));

  // private DB + objects must also be clean in none mode (marker absent
  // from EVERY file under .drift, tracked or not)
  const allDriftFiles = collectFiles(join(repo, ".drift"));
  assert.ok(allDriftFiles.length > 0, "there must be .drift files to inspect");
  for (const abs of allDriftFiles) {
    assert.ok(!readFileSync(abs, "utf8").includes(MARKER_NONE), `marker leaked into ${abs}`);
  }
  // summary is empty too (none mode persists nothing derived from the prompt)
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].summary, "");
});

// -------------------------------------------------------------- fresh clone
test("fresh clone serves log/blame from public manifests; an empty local store cannot shadow them", () => {
  const origin = makeRepo();
  assert.equal(run(origin, ["init"]).status, 0);
  // one-line private raw prompt + separate safe public summary (Part 5)
  const prompt = `Implement auth using ${MARKER}`;
  const summary = "Implement authentication";
  writeFileSync(join(origin, "src", "a.ts"), `export const a = ${Date.now()};\n`);
  const realize = run(origin, ["realize", "-p", prompt, "--summary", summary, "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  // commit the intent + public provenance (the private store stays untracked)
  git(origin, ["add", "-A"]);
  git(origin, ["commit", "-m", "intent commit"]);

  const bare = mkdtempSync(join(tmpdir(), "drift-bare-"));
  git(origin, ["clone", "--bare", "-q", ".", bare]);
  const clone = mkdtempSync(join(tmpdir(), "drift-clone-"));
  git(bare, ["clone", "-q", bare, clone]);
  // the private DB must NOT exist in the clone
  assert.ok(!existsSync(join(clone, ".drift", "drift.db")), "clone must not contain the private DB");
  // committed public provenance exists in the clone
  assert.ok(existsSync(join(clone, ".drift", "public", "intents")), "public manifests must be cloned");
  assert.ok(existsSync(join(clone, ".drift", "public", "key.pem")), "committed public key must be cloned");

  // log works BEFORE init (public manifests only), no crash
  const logBefore = JSON.parse(run(clone, ["log", "--json"]).stdout);
  assert.equal(logBefore.status, "ok");
  assert.equal(logBefore.intents.length, 1);
  assert.equal(logBefore.intents[0].summary, "Implement authentication");

  // verify-intent BEFORE init verifies against the committed public key
  const sigBefore = JSON.parse(run(clone, ["verify-intent", logBefore.intents[0].id, "--json"]).stdout);
  assert.equal(sigBefore.status, "ok");
  assert.equal(sigBefore.ok, true, sigBefore.detail);

  // REGRESSION: `drift init` in a clone creates an empty local store that
  // must NOT shadow the committed public manifests. It must create only the
  // missing private dirs/keys and leave public provenance untouched.
  const initClone = run(clone, ["init"]);
  assert.equal(initClone.status, 0, initClone.stderr);
  assert.ok(existsSync(join(clone, ".drift", "keys", "ed25519.pem")), "init must create the signing key in a clone");

  // log still lists the committed public intent after init
  const log = JSON.parse(run(clone, ["log", "--json"]).stdout);
  assert.equal(log.status, "ok");
  assert.equal(log.intents.length, 1, "an empty private store must not hide committed public intents");
  assert.equal(log.intents[0].summary, "Implement authentication");
  assert.ok(!("prompt" in log.intents[0]), "prompt unavailable in a clone");
  assert.ok(log.intents[0].id.startsWith("did_"), "intent id available");
  assert.ok(log.intents[0].gitSha, "commit available");
  assert.ok(!JSON.stringify(log).includes(MARKER), "marker leaked into clone log");
  assert.ok(!git(clone, ["ls-tree", "-r", "HEAD"]).includes(MARKER));

  // public manifests were not rewritten or removed by init
  const manifestDir = join(clone, ".drift", "public", "intents");
  const manifestNames = readdirSync(manifestDir).filter((f) => f.endsWith(".json"));
  assert.equal(manifestNames.length, 1);
  const manifest = JSON.parse(readFileSync(join(manifestDir, manifestNames[0]), "utf8"));
  assert.equal(manifest.summary, "Implement authentication");
  assert.ok(manifest.signature, "manifest still signed");

  // SECOND init is idempotent: the same public intent stays visible
  assert.equal(run(clone, ["init"]).status, 0);
  const log2 = JSON.parse(run(clone, ["log", "--json"]).stdout);
  assert.equal(log2.intents.length, 1, "second init must keep public intents visible");
  assert.equal(log2.intents[0].summary, "Implement authentication");

  // blame works and resolves the manifest
  const blame = JSON.parse(run(clone, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blame.status, "ok");
  assert.ok(blame.intent, "blame resolves via the public manifest");
  assert.equal(blame.intent.summary, "Implement authentication");
  assert.ok(!JSON.stringify(blame).includes(MARKER), "marker leaked into clone blame");

  // status reports merged counts without the shadow bug
  const status = JSON.parse(run(clone, ["status", "--json"]).stdout);
  assert.equal(status.initialized, true);
  assert.equal(status.intents, 1, "status must count committed public intents even with an empty store");
  assert.equal(status.publicIntents, 1);
  assert.equal(status.localIntents, 0);
  assert.equal(status.lastIntent.summary, "Implement authentication");

  // doctor works in read-only mode
  const doctor = JSON.parse(run(clone, ["doctor", "--json"]).stdout);
  assert.equal(doctor.status, "ok");

  // after init the signing key was regenerated (it never leaves the origin
  // machine) — the OLD signature must NOT be reported valid against the new
  // key. Truthful state: it no longer verifies. This is the documented
  // key-rotation limitation of ADR-009.
  const sigAfter = JSON.parse(run(clone, ["verify-intent", log.intents[0].id, "--json"]).stdout);
  assert.equal(sigAfter.ok, false, "a regenerated local key must never validate an old signature");
  assert.equal(sigAfter.detail, "invalid", "old signature no longer verifies against the rotated key");
});

// ------------------------------------------------------- legacy detection
test("drift doctor detects legacy tracked private files and reports safe untrack commands", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  realizeWithMarker(repo);
  // simulate the pre-ADR-009 state: private files force-added to the index
  git(repo, ["add", "-f", ".drift/drift.db", ".drift/objects"]);
  git(repo, ["commit", "-m", "legacy commit with private data"]);

  const doctor = JSON.parse(run(repo, ["doctor", "--json"]).stdout);
  const tracked = doctor.checks.find((c) => c.name === "tracked-private");
  assert.ok(tracked, "doctor must include a tracked-private check");
  assert.equal(tracked.ok, false);
  assert.ok(tracked.detail.includes("git rm --cached"), "doctor must suggest the safe untrack command");
  assert.ok(tracked.detail.includes("old commits"), "doctor must warn about history");
  const legacy = doctor.checks.find((c) => c.name === "legacy-objects");
  assert.equal(legacy.ok, false, "prompt-bearing tracked objects must be flagged");

  // untracking with the suggested command + new commit must not remove the
  // data from OLD history but must clean the current tree
  git(repo, ["rm", "-r", "--cached", "-q", ".drift/drift.db", ".drift/objects"]);
  git(repo, ["commit", "-m", "untrack private data"]);
  const after = JSON.parse(run(repo, ["doctor", "--json"]).stdout);
  assert.equal(after.checks.find((c) => c.name === "tracked-private").ok, true);
});
