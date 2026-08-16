/**
 * ADR-009 privacy guarantees, proven with real git commands:
 *
 *  1. `.drift/.gitignore` ignores the private store; `git add .` can never
 *     stage prompts, the database, objects or keys.
 *  2. A unique secret marker in a raw prompt never reaches git history,
 *     tracked files, or default JSON under the safe default mode.
 *  3. `none` mode persists the marker nowhere.
 *  4. A fresh clone (no private DB) still serves `log`/`blame` from the
 *     committed public manifests without crashing.
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
const MARKER = "DRIFT_PRIVATE_SECRET_7f2c91";

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
test("secret marker never enters git history, tracked files, or default JSON (commit-summary mode)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const prompt = `first line summary\n\nsecond line with ${MARKER} and secrets sk-abc123DEF456ghi789JKL0123456789`;
  realizeWithMarker(repo, prompt);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "intent"]);

  // 1. git history (patch + messages)
  assert.ok(!git(repo, ["log", "--all", "-p"]).includes(MARKER), "marker leaked into git history patch");
  assert.ok(!git(repo, ["log", "--all", "--format=%B"]).includes(MARKER), "marker leaked into commit messages");
  // 2. working tree grep (tracked content)
  const grep = spawnSync("git", ["grep", "-n", MARKER, "--", "."], { cwd: repo, encoding: "utf8" });
  assert.equal(grep.status, 1, "marker must not be found by git grep");
  // 3. HEAD tree
  assert.ok(!git(repo, ["ls-tree", "-r", "HEAD"]).includes(MARKER), "marker leaked into the HEAD tree");
  // 4. tracked .drift files
  const trackedDrift = git(repo, ["ls-files", "--", ".drift"]).split("\n").filter(Boolean);
  for (const f of trackedDrift) {
    const content = readFileSync(join(repo, f), "utf8");
    assert.ok(!content.includes(MARKER), `marker leaked into tracked file ${f}`);
    assert.ok(!content.includes("sk-abc123"), `secret leaked into tracked file ${f}`);
  }
  // 5. default JSON
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].summary, "first line summary");
  assert.ok(!("prompt" in log.intents[0]), "default log JSON must not contain the prompt");
  const blame = JSON.parse(run(repo, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.ok(!JSON.stringify(blame).includes(MARKER), "default blame JSON must not contain the marker");

  // the marker MAY exist only in the ignored private store
  assert.ok(existsSync(join(repo, ".drift", "drift.db")), "private DB exists locally");
  const objectsDir = join(repo, ".drift", "objects");
  const objectFiles = readdirSync(objectsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
  assert.ok(objectFiles.length >= 1, "private objects exist locally");
  const anyPrivate = objectFiles.some((f) => readFileSync(join(objectsDir, f), "utf8").includes(MARKER));
  assert.ok(anyPrivate, "marker may live in the IGNORED private objects — that is the design");
});

test("secret marker is absent everywhere under none mode", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"none\"\n");
  const prompt = `secret ${MARKER} that must persist nowhere`;
  realizeWithMarker(repo, prompt);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "intent"]);

  assert.ok(!git(repo, ["log", "--all", "-p"]).includes(MARKER));
  assert.ok(!git(repo, ["log", "--all", "--format=%B"]).includes(MARKER));
  const grep = spawnSync("git", ["grep", "-n", MARKER, "--", "."], { cwd: repo, encoding: "utf8" });
  assert.equal(grep.status, 1);
  assert.ok(!git(repo, ["ls-tree", "-r", "HEAD"]).includes(MARKER));

  // private DB + objects must also be clean in none mode (marker absent
  // from EVERY file under .drift, tracked or not)
  const allDriftFiles = collectFiles(join(repo, ".drift"));
  assert.ok(allDriftFiles.length > 0, "there must be .drift files to inspect");
  for (const abs of allDriftFiles) {
    assert.ok(!readFileSync(abs, "utf8").includes(MARKER), `marker leaked into ${abs}`);
  }
  // summary is empty too
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].summary, "");
});

// -------------------------------------------------------------- fresh clone
test("fresh clone serves log/blame from public manifests without the private DB and without crashing", () => {
  const origin = makeRepo();
  assert.equal(run(origin, ["init"]).status, 0);
  // multi-line prompt: the marker lives in the SECOND line so it stays private
  const markerPrompt = `Safe first line summary\n\n${MARKER} stays private in the second line`;
  writeFileSync(join(origin, "src", "a.ts"), `export const a = ${Date.now()};\n`);
  const realize = run(origin, ["realize", "-p", markerPrompt, "--json"]);
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

  // log works (public manifests), prompt unavailable, no crash
  const log = JSON.parse(run(clone, ["log", "--json"]).stdout);
  assert.equal(log.status, "ok");
  assert.equal(log.intents.length, 1);
  assert.equal(log.intents[0].summary, "Safe first line summary");
  assert.ok(!("prompt" in log.intents[0]), "prompt unavailable in a clone");
  assert.ok(log.intents[0].id.startsWith("did_"), "intent id available");
  assert.ok(log.intents[0].gitSha, "commit available");

  // the marker must not exist anywhere in the clone
  assert.ok(!JSON.stringify(log).includes(MARKER), "marker leaked into clone log");
  assert.ok(!git(clone, ["ls-tree", "-r", "HEAD"]).includes(MARKER));

  // blame works and resolves the manifest
  const blame = JSON.parse(run(clone, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blame.status, "ok");
  assert.ok(blame.intent, "blame resolves via the public manifest");
  assert.equal(blame.intent.summary, "Safe first line summary");
  assert.ok(!JSON.stringify(blame).includes(MARKER), "marker leaked into clone blame");

  // verify-intent works against the committed public key
  const sig = JSON.parse(run(clone, ["verify-intent", log.intents[0].id, "--json"]).stdout);
  assert.equal(sig.status, "ok");
  assert.equal(sig.ok, true);

  // status works and never crashes
  const status = JSON.parse(run(clone, ["status", "--json"]).stdout);
  assert.equal(status.initialized, true);
  assert.equal(status.intents, 1);
  assert.equal(status.lastIntent.summary, "Safe first line summary");

  // doctor works in read-only mode
  const doctor = JSON.parse(run(clone, ["doctor", "--json"]).stdout);
  assert.equal(doctor.status, "ok");
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
