/**
 * End-to-end tests: spawn temp git repos, run the actual CLI binary,
 * and assert the PRD MVS acceptance flow
 *   init → realize → log → blame (with syntax rejection).
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
  symlinkSync as fsSymlink,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const CLI = resolve(process.cwd(), "packages", "drift-cli", "dist", "cli.js");

function run(repo, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-e2e-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "auth.ts"),
    `export function verifyToken(token: string): boolean {
  return token.length > 0;
}
`,
  );
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "initial scaffold"]);
  return repo;
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

test("full MVS flow: init → realize → log → blame → verify → doctor → export", () => {
  const repo = makeRepo();

  // 1. init
  const init = run(repo, ["init"]);
  assert.equal(init.status, 0, init.stderr);
  assert.ok(existsSync(join(repo, ".drift", "drift.db")));
  assert.ok(existsSync(join(repo, ".drift", "config.toml")));
  assert.ok(existsSync(join(repo, ".drift", "keys", "ed25519.pem")));

  // 2. realize an agent intent
  writeFileSync(
    join(repo, "src", "auth.ts"),
    `export function verifyToken(token: string): boolean {
  return token.length > 0;
}

export function refreshToken(expired: string): string {
  return expired;
}
`,
  );
  const realize = run(repo, [
    "realize",
    "-p",
    "Fix race condition in token refresh",
    "--agent",
    "--model",
    "claude-3-5-sonnet",
    "--verify-cmd",
    "node -e \"process.exit(0)\"",
    "--json",
  ]);
  assert.equal(realize.status, 0, realize.stderr);
  const realizeOut = parseJson(realize.stdout);
  assert.equal(realizeOut.status, "ok");
  assert.match(realizeOut.intentId, /^did_[0-9a-f]{32}$/);
  assert.match(realizeOut.gitSha, /^[0-9a-f]{40}$/);
  assert.ok(realizeOut.astDelta.some((d) => d.type === "ADDED" && d.summary.includes("refreshToken")));

  // git trailer present
  const lastMessage = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(lastMessage.includes(`Drift-Intent: ${realizeOut.intentId}`));

  // 3. log
  const log = run(repo, ["log", "--json"]);
  assert.equal(log.status, 0, log.stderr);
  const logOut = parseJson(log.stdout);
  assert.equal(logOut.status, "ok");
  assert.equal(logOut.intents.length, 1);
  assert.equal(logOut.intents[0].prompt, "Fix race condition in token refresh");
  assert.equal(logOut.intents[0].authorType, "AGENT");

  // 4. blame by function
  const blame = run(repo, ["blame", "src/auth.ts", "--function", "refreshToken", "--json"]);
  assert.equal(blame.status, 0, blame.stderr);
  const blameOut = parseJson(blame.stdout);
  assert.equal(blameOut.status, "ok");
  assert.equal(blameOut.intent.prompt, "Fix race condition in token refresh");
  assert.equal(blameOut.intent.author.model, "claude-3-5-sonnet");
  assert.equal(blameOut.intent.signatureValid, true);

  // blame on untouched pre-drift code → baseline
  const baseline = run(repo, ["blame", "src/auth.ts", "--function", "verifyToken", "--json"]);
  const baselineOut = parseJson(baseline.stdout);
  assert.equal(baselineOut.status, "ok");
  assert.equal(baselineOut.baseline, true);

  // 5. verify
  const verify = run(repo, ["verify", realizeOut.intentId, "--json"]);
  assert.equal(verify.status, 0, verify.stderr);
  assert.equal(parseJson(verify.stdout).status, "ok");
  assert.equal(parseJson(verify.stdout).verifyStatus, "pass");

  // 6. context
  const ctx = run(repo, ["context", "src/auth.ts", "--json"]);
  assert.equal(parseJson(ctx.stdout).intents.length, 1);

  // 7. signature verification
  const sig = run(repo, ["verify-intent", realizeOut.intentId, "--json"]);
  assert.equal(parseJson(sig.stdout).status, "ok");

  // 8. doctor
  const doctor = run(repo, ["doctor", "--json"]);
  const doctorOut = parseJson(doctor.stdout);
  assert.equal(doctorOut.status, "ok");
  assert.ok(doctorOut.checks.every((c) => c.ok), JSON.stringify(doctorOut.checks));

  // 9. export
  const exp = run(repo, ["export"]);
  assert.equal(exp.status, 0);
  const exported = JSON.parse(exp.stdout);
  assert.equal(exported.intents.length, 1);
});

test("blame --function on a body-modified function resolves to the intent (PRD §4.2 acceptance)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);

  // modify ONLY the body — the signature line keeps its pre-Drift sha
  writeFileSync(
    join(repo, "src", "auth.ts"),
    `export function verifyToken(token: string): boolean {
  const parts = token.split(".");
  return parts.length === 3 && parts[2].length > 10;
}
`,
  );
  const realize = run(repo, ["realize", "-p", "Fix race condition in token refresh", "--agent", "--model", "claude-3-5-sonnet", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);

  // the function existed before Drift, so its SIGNATURE line is baseline —
  // but the intent modified its body, so --function blame must attribute
  const blame = parseJson(run(repo, ["blame", "src/auth.ts", "--function", "verifyToken", "--json"]).stdout);
  assert.equal(blame.status, "ok");
  assert.equal(blame.baseline, false, JSON.stringify(blame));
  assert.ok(blame.intent, "intent must be resolved, got baseline: " + JSON.stringify(blame));
  assert.equal(blame.intent.prompt, "Fix race condition in token refresh");
  assert.equal(blame.intent.author.model, "claude-3-5-sonnet");
  assert.equal(blame.intent.signatureValid, true);
  // the resolved line is inside the function body (where the change landed)
  assert.ok(blame.line >= 2, `resolved line ${blame.line} should be in the body`);
});

test("syntax errors are rejected and history stays clean (PRD §9.2)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const before = git(repo, ["rev-parse", "HEAD"]);

  writeFileSync(join(repo, "src", "auth.ts"), "export const broken = ;\n");
  const realize = run(repo, ["realize", "-p", "broken change"]);
  assert.equal(realize.status, 2, realize.stderr);
  assert.ok(realize.stderr.includes("Syntax error"));

  const after = git(repo, ["rev-parse", "HEAD"]);
  assert.equal(after, before, "no commit must be created on syntax error");
  assert.equal(git(repo, ["status", "--porcelain"]).split("\n").length >= 1, true);

  // no intents recorded
  const log = parseJson(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents.length, 0);
});

test("E_NO_CHANGES when nothing staged (exit 3)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const res = run(repo, ["realize", "-p", "nothing changed"]);
  assert.equal(res.status, 3);
});

test("blame/context reject paths that escape the repository root", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  // real file OUTSIDE the repo (would be read before the fix)
  const outside = mkdtempSync(join(tmpdir(), "drift-outside-"));
  writeFileSync(join(outside, "secret.ts"), "export function secretFn() { return 42; }\n");
  const outsideAbs = join(outside, "secret.ts");

  // relative traversal from the repo root: `../<outside-dir>/secret.ts` (both
  // live under os.tmpdir(), so the repo's parent is the outside file's parent)
  const outsideRel = join("..", outside.split(/[\\/]/).pop() ?? "outside", "secret.ts");

  for (const [label, args] of [
    ["absolute outside path", ["blame", outsideAbs, "--line", "1", "--json"]],
    ["relative ../ traversal", ["blame", outsideRel, "--line", "1", "--json"]],
    ["--function on outside file", ["blame", outsideAbs, "--function", "secretFn", "--json"]],
    ["context outside path", ["context", outsideRel, "--json"]],
  ]) {
    const res = run(repo, args);
    assert.equal(res.status, 1, `${label}: expected exit 1, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout + res.stderr, /escapes the repository root/, `${label}: ${res.stdout}${res.stderr}`);
  }

  // realize with an outside file is rejected by git itself (nothing staged)
  writeFileSync(join(repo, "src", "auth.ts"), "export const g = 3;\n");
  const realize = run(repo, ["realize", "-p", "outside ref", outsideAbs, "--json"]);
  assert.equal(realize.status, 1, realize.stderr);
  const log = parseJson(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents.length, 0, "no intent must be recorded for a rejected realize");
});

test("symlink/junction pointing outside the repo is rejected by blame/context", async (t) => {
  const repo = makeRepo();
  run(repo, ["init"]);
  // real file OUTSIDE the repo
  const outside = mkdtempSync(join(tmpdir(), "drift-outside-link-"));
  writeFileSync(join(outside, "secret.ts"), "export function secretFn() { return 42; }\n");

  // symlink INSIDE the repo → outside dir. Junction on Windows (no admin
  // rights needed for dirs), plain symlink elsewhere.
  const linkPath = join(repo, "escape");
  try {
    fsSymlink(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    // e.g. Windows without developer mode / admin: EPERM — the live POSIX
    // runner covers this case; skip here so CI stays green everywhere.
    t.skip(`cannot create symlink on this platform: ${e.code}`);
    return;
  }

  for (const [label, args] of [
    ["blame through symlink", ["blame", "escape/secret.ts", "--line", "1", "--json"]],
    ["context through symlink", ["context", "escape/secret.ts", "--json"]],
  ]) {
    const res = run(repo, args);
    assert.equal(res.status, 1, `${label}: expected exit 1, got ${res.status}: ${res.stderr}`);
    assert.match(res.stdout + res.stderr, /escapes the repository root/, `${label}: ${res.stdout}${res.stderr}`);
  }

  // a junction/symlink pointing INSIDE the repo is not an escape
  mkdirSync(join(repo, "real"));
  writeFileSync(join(repo, "real", "inner.ts"), "export const inner = 1;\n");
  git(repo, ["add", "real/inner.ts"]);
  git(repo, ["commit", "-m", "add inner file"]);
  const innerLink = join(repo, "inner-link");
  try {
    fsSymlink(join(repo, "real"), innerLink, process.platform === "win32" ? "junction" : "dir");
  } catch {
    /* ignore */
  }
  // positive: the same file via its real path is NOT an escape
  const ok = run(repo, ["blame", "real/inner.ts", "--line", "1", "--json"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(parseJson(ok.stdout).status, "ok");

  // positive: blame through a link that stays inside the repo is allowed by
  // the guard (git itself may still refuse unknown paths like a junction —
  // that is a git limitation, not a containment rejection)
  if (existsSync(innerLink)) {
    const inner = run(repo, ["blame", "inner-link/inner.ts", "--line", "1", "--json"]);
    assert.notEqual(inner.status, 0); // git refuses — fine
    assert.doesNotMatch(inner.stdout + inner.stderr, /escapes the repository root/);
  }
});

test("fuzz: special chars in paths/prompts and unknown-command stay machine-readable", () => {
  const repo = makeRepo();
  run(repo, ["init"]);

  // --- prompts with special characters roundtrip (engine trims by design) ---
  const prompts = [
    "with $(sub) ${braces} and `backticks`",
    "unicode Привет 中文 🚀😀 café",
    "line one\nline two\nline three",
    "tab\tseparated",
  ];
  for (let i = 0; i < prompts.length; i++) {
    const prompt = prompts[i];
    writeFileSync(join(repo, "src", `fuzz${i}.ts`), "export const f = 1;\n");
    const realize = run(repo, ["realize", "-p", prompt, "--json"]);
    assert.equal(realize.status, 0, realize.stderr);
    assert.ok(JSON.parse(realize.stdout).intentId);
    const log = parseJson(run(repo, ["log", "--limit", "1", "--json"]).stdout);
    assert.equal(log.intents[0].prompt, prompt.trim());
  }

  // --- special file names: blame/context/log --file work ---
  const weird = join(repo, "src", "weird name $(x) 🚀 unicode.ts");
  writeFileSync(weird, "export function weirdFn() { return 1; }\n");
  const rel = "src/weird name $(x) 🚀 unicode.ts";
  assert.equal(run(repo, ["realize", "-p", "add weird file", "--json"]).status, 0);
  const blame = parseJson(
    run(repo, ["blame", rel, "--function", "weirdFn", "--json"]).stdout,
  );
  assert.equal(blame.intent.prompt, "add weird file");
  const ctx = parseJson(run(repo, ["context", rel, "--json"]).stdout);
  assert.equal(ctx.intents.length, 1);
  const logF = parseJson(run(repo, ["log", "--file", rel, "--json"]).stdout);
  assert.equal(logF.intents.length, 1);

  // --- unknown command under --json: JSON error on stdout, not plain text ---
  const unknown = run(repo, ["frobnicate", "--json"]);
  assert.equal(unknown.status, 1);
  const parsed = parseJson(unknown.stdout);
  assert.equal(parsed.status, "error");
  assert.match(parsed.message, /unknown command/);
  assert.ok(!unknown.stdout.includes("Usage:"), "usage text must not leak into JSON stdout");
});

test("blame reports uncommitted changes", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  // realize once, then edit without committing
  writeFileSync(join(repo, "src", "auth.ts"), readFileSync(join(repo, "src", "auth.ts"), "utf8") + "\nexport const x = 1;\n");
  run(repo, ["realize", "-p", "add const x"]);
  writeFileSync(join(repo, "src", "auth.ts"), readFileSync(join(repo, "src", "auth.ts"), "utf8") + "\nexport const y = 2;\n");
  const blame = parseJson(run(repo, ["blame", "src/auth.ts", "--line", "6", "--json"]).stdout);
  assert.equal(blame.status, "ok");
  assert.equal(blame.committed, false);
});

test("redaction: secrets in prompts never hit git history", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export const a = 1;\n");
  const realize = run(repo, ["realize", "-p", "use sk-abc123DEF456ghi789JKL0123456789 in config", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  const log = parseJson(run(repo, ["log", "--json"]).stdout);
  assert.ok(!log.intents[0].prompt.includes("sk-abc123"));
  assert.ok(log.intents[0].prompt.includes("[REDACTED]"));
});

test("encryption (v0.2.0): prompt+state encrypted at rest, roundtrip, E_KEY without key", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  // enable encryption-at-rest in the repo config
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8") +
      "\n[encryption]\nenabled = true\nkey_provider = \"env:DRIFT_MASTER_KEY\"\n",
  );
  const MASTER_KEY = "ab".repeat(32); // 64-hex
  const env = { DRIFT_MASTER_KEY: MASTER_KEY };

  // realize with the key — must succeed
  writeFileSync(join(repo, "src", "auth.ts"), "export const encrypted = () => 1;\n");
  const state = Buffer.from(JSON.stringify({ step: 1, goal: "top secret" })).toString("base64");
  const realize = run(
    repo,
    ["realize", "-p", "super secret prompt: rotate the token", "--agent", "--state", state, "--json"],
    env,
  );
  assert.equal(realize.status, 0, realize.stderr);
  const out = parseJson(realize.stdout);

  // at rest: every object file is encrypted, plaintext prompt nowhere on disk
  const objectsDir = join(repo, ".drift", "objects");
  const allFiles = readdirSync(objectsDir, { recursive: true }).map(String).filter((f) => f.endsWith(".json"));
  assert.ok(allFiles.length >= 1);
  for (const f of allFiles) {
    const content = readFileSync(join(objectsDir, f), "utf8");
    assert.ok(content.includes("encv1:"), `object ${f} should be encrypted`);
    assert.ok(!content.includes("super secret prompt"), `plaintext prompt leaked into ${f}`);
    assert.ok(!content.includes("top secret"), `plaintext state leaked into ${f}`);
  }

  // read paths decrypt with the key
  const log = parseJson(run(repo, ["log", "--json"], env).stdout);
  assert.equal(log.intents[0].prompt, "super secret prompt: rotate the token");

  const blame = parseJson(
    run(repo, ["blame", "src/auth.ts", "--function", "encrypted", "--json"], env).stdout,
  );
  assert.equal(blame.intent.prompt, "super secret prompt: rotate the token");
  assert.equal(blame.intent.signatureValid, true);

  const replay = parseJson(run(repo, ["replay", out.intentId, "--json"], env).stdout);
  assert.equal(replay.agentState, state);

  // doctor reports the key check
  const doctor = parseJson(run(repo, ["doctor", "--json"], env).stdout);
  const encCheck = doctor.checks.find((c) => c.name === "encryption-key");
  assert.ok(encCheck, "doctor should report encryption-key check");
  assert.equal(encCheck.ok, true);

  // without the key: realize → E_KEY (exit 4); replay → E_KEY (exit 4)
  const NO_KEY = { DRIFT_MASTER_KEY: "" }; // explicitly unset (run() merges process.env)
  writeFileSync(join(repo, "src", "auth.ts"), "export const encrypted2 = () => 2;\n");
  const noKeyRealize = run(repo, ["realize", "-p", "no key here", "--json"], NO_KEY);
  assert.equal(noKeyRealize.status, 4, noKeyRealize.stderr);
  const noKeyReplay = run(repo, ["replay", out.intentId, "--json"], NO_KEY);
  assert.equal(noKeyReplay.status, 4, noKeyReplay.stderr);

  // read paths degrade gracefully without a key: prompt placeholder, exit 0
  const noKeyLog = parseJson(run(repo, ["log", "--json"], NO_KEY).stdout);
  assert.equal(noKeyLog.status, "ok");
  assert.equal(noKeyLog.intents[0].prompt, "[encrypted]");

  // doctor reports the missing key
  const noKeyDoctor = parseJson(run(repo, ["doctor", "--json"], NO_KEY).stdout);
  assert.equal(noKeyDoctor.checks.find((c) => c.name === "encryption-key").ok, false);

  // wrong key: replay fails with the decrypt error (still exit 4)
  const wrongKeyReplay = run(repo, ["replay", out.intentId, "--json"], { DRIFT_MASTER_KEY: "cd".repeat(32) });
  assert.equal(wrongKeyReplay.status, 4, wrongKeyReplay.stderr);
  assert.ok(wrongKeyReplay.stderr.includes("Failed to decrypt"));
});

test("encryption: legacy plaintext intents pass through untouched (backward compat)", () => {
  const repo = makeRepo();
  run(repo, ["init"]); // encryption stays disabled (default)
  writeFileSync(join(repo, "src", "auth.ts"), "export const legacy = () => 0;\n");
  run(repo, ["realize", "-p", "legacy plaintext prompt", "--json"]);

  // enable encryption afterwards
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8") + "\n[encryption]\nenabled = true\n",
  );
  const env = { DRIFT_MASTER_KEY: "ab".repeat(32) };

  // new intent is encrypted; old one still readable as plaintext (no key needed for it)
  writeFileSync(join(repo, "src", "auth.ts"), "export const legacy = () => 0;\nexport const fresh = () => 1;\n");
  run(repo, ["realize", "-p", "new encrypted prompt", "--json"], env);

  const log = parseJson(run(repo, ["log", "--json"], env).stdout);
  assert.equal(log.intents.length, 2);
  const prompts = log.intents.map((i) => i.prompt);
  assert.ok(prompts.includes("legacy plaintext prompt"));
  assert.ok(prompts.includes("new encrypted prompt"));

  const noKeyLog = parseJson(run(repo, ["log", "--json"], { DRIFT_MASTER_KEY: "" }).stdout);
  const byPrompt = Object.fromEntries(noKeyLog.intents.map((i) => [i.prompt, i.id]));
  assert.ok(byPrompt["legacy plaintext prompt"], "legacy prompt must stay visible without a key");
  assert.ok(byPrompt["[encrypted]"], "new prompt must degrade to placeholder without a key");
});

test("deleted files produce a DELETED intent delta", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "extra.ts"), "export const tmp = 1;\n");
  run(repo, ["realize", "-p", "add extra file"]);
  // delete the file, then realize
  spawnSync("rm", [join(repo, "src", "extra.ts")]);
  const realize = run(repo, ["realize", "-p", "remove extra file", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  const out = parseJson(realize.stdout);
  assert.ok(
    out.astDelta.some((d) => d.type === "DELETED" && d.filePath === "src/extra.ts"),
    JSON.stringify(out.astDelta),
  );
});

test("log --limit clamps negative values instead of returning unbounded rows", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "src", "auth.ts"), `export const v${i} = ${i};\n`);
    assert.equal(run(repo, ["realize", "-p", `change ${i}`, "--json"]).status, 0);
  }
  // --limit 0 is clamped to 1 (documented safeLimit contract)
  const lim0 = parseJson(run(repo, ["log", "--limit", "0", "--json"]).stdout);
  assert.equal(lim0.status, "ok");
  assert.equal(lim0.intents.length, 1, `--limit 0 should clamp to 1 row, got ${lim0.intents.length}`);
  // --limit -3 must clamp too (a user typo must never return ALL rows)
  const limNeg = parseJson(run(repo, ["log", "--limit", "-3", "--json"]).stdout);
  assert.equal(limNeg.status, "ok");
  assert.equal(limNeg.intents.length, 1, `--limit -3 should clamp to 1 row, got ${limNeg.intents.length}`);
});

test("log --file filters intents touching a file", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export const a = () => 1;\n");
  run(repo, ["realize", "-p", "touch auth"]);
  writeFileSync(join(repo, "src", "other.ts"), "export const o = () => 2;\n");
  run(repo, ["realize", "-p", "touch other"]);
  const filtered = parseJson(run(repo, ["log", "--file", "src/other.ts", "--json"]).stdout);
  assert.equal(filtered.intents.length, 1);
  assert.equal(filtered.intents[0].prompt, "touch other");
});

test("corrupted .drift/drift.db → exit 5 (CORRUPT), not a generic error", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const db = join(repo, ".drift", "drift.db");
  writeFileSync(db, "this is not a sqlite database at all\n");
  const res = run(repo, ["log", "--json"]);
  assert.equal(res.status, 5, `expected exit 5, got ${res.status}: ${res.stderr}`);
  assert.match(res.stdout + res.stderr, /corrupt|unreadable/i);
  const parsed = parseJson(res.stdout + res.stderr);
  assert.equal(parsed.type, "corrupt");
});

test("prompt modes: default commit-summary keeps the full prompt out of git history", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const prompt =
    "Fix race condition in token refresh\n\nFull details: rotate keys via the vault and backfill the audit log.";
  writeFileSync(join(repo, "src", "auth.ts"), "export const a = () => 1;\n");
  const realize = run(repo, [
    "realize",
    "-p",
    prompt,
    "--agent",
    "--model",
    "claude-3-5-sonnet",
    "--json",
  ]);
  assert.equal(realize.status, 0, realize.stderr);

  // commit message: safe summary + trailers only, never the full prompt
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(msg.includes("Intent: Fix race condition in token refresh"), msg);
  assert.ok(msg.includes("Model: claude-3-5-sonnet"), msg);
  assert.ok(msg.includes("Drift-Intent: "), msg);
  assert.ok(!msg.includes("rotate keys via the vault"), "full prompt leaked into the commit message");

  // the full prompt is still available locally through drift (.drift store)
  const log = parseJson(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].prompt, prompt);
});

test("prompt modes: full mode restores prompt-in-commit-message (legacy opt-in)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"full\"\n");
  const prompt = "Rotate the token and backfill the audit log";
  writeFileSync(join(repo, "src", "auth.ts"), "export const b = () => 2;\n");
  assert.equal(run(repo, ["realize", "-p", prompt, "--json"]).status, 0);
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(msg.startsWith(prompt), msg);
});

test("prompt modes: none stores no prompt anywhere (db, objects, commit)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"none\"\n");
  writeFileSync(join(repo, "src", "auth.ts"), "export const c = () => 3;\n");
  const realize = run(repo, ["realize", "-p", "top secret prompt that must not persist", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);

  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(!msg.includes("top secret prompt"), msg);

  const log = parseJson(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].prompt, "");

  const objectsDir = join(repo, ".drift", "objects");
  for (const f of readdirSync(objectsDir, { recursive: true }).map(String).filter((x) => x.endsWith(".json"))) {
    const content = readFileSync(join(objectsDir, f), "utf8");
    assert.ok(!content.includes("top secret prompt"), `prompt leaked into ${f}`);
  }
});

test("prompt modes: secrets are redacted before the summary reaches the commit message", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export const d = () => 4;\n");
  const realize = run(repo, [
    "realize",
    "-p",
    "Use key sk-abc123DEF456ghi789JKL0123456789 in the config now",
    "--json",
  ]);
  assert.equal(realize.status, 0, realize.stderr);
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(!msg.includes("sk-abc123"), msg);
  assert.ok(msg.includes("[REDACTED]"), msg);
});

test("drift status: friendly state report and graceful degradation before init", () => {
  // outside any git repo
  const plain = mkdtempSync(join(tmpdir(), "drift-status-"));
  const noGit = run(plain, ["status", "--json"]);
  assert.equal(noGit.status, 1);
  assert.equal(parseJson(noGit.stdout).reason, "no-git");

  // git repo without drift
  const repo = makeRepo();
  const notInit = run(repo, ["status", "--json"]);
  assert.equal(notInit.status, 1);
  assert.equal(parseJson(notInit.stdout).reason, "not-initialized");

  // initialized
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export const e = () => 5;\n");
  assert.equal(run(repo, ["realize", "-p", "first intent", "--json"]).status, 0);
  const st = parseJson(run(repo, ["status", "--json"]).stdout);
  assert.equal(st.status, "ok");
  assert.equal(st.initialized, true);
  assert.equal(st.intents, 1);
  assert.equal(st.promptMode, "commit-summary");
  assert.equal(st.encryption, false);
  assert.equal(st.lastIntent.prompt, "first intent");

  // human output explains the next step
  const human = run(repo, ["status"]);
  assert.equal(human.status, 0);
  assert.ok(human.stdout.includes("drift realize -p"), human.stdout);
});

test("blame human output is self-explanatory (Why / Generated by / Intent / Commit)", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export function why() { return 1; }\n");
  const realize = run(repo, [
    "realize",
    "-p",
    "Add the why function",
    "--agent",
    "--model",
    "claude-3-5-sonnet",
    "--verify-cmd",
    "npm test",
    "--json",
  ]);
  assert.equal(realize.status, 0, realize.stderr);
  const out = run(repo, ["blame", "src/auth.ts", "--function", "why"]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(out.stdout.includes("Why:"), out.stdout);
  assert.ok(out.stdout.includes("Add the why function"), out.stdout);
  assert.ok(out.stdout.includes("Generated by:"), out.stdout);
  assert.ok(out.stdout.includes("model: claude-3-5-sonnet"), out.stdout);
  assert.ok(out.stdout.includes("Verification:"), out.stdout);
  assert.ok(out.stdout.includes("Intent:"), out.stdout);
  assert.ok(out.stdout.includes("signature: valid"), out.stdout);
});

test("replay restores agent state and checkout", () => {
  const repo = makeRepo();
  run(repo, ["init"]);
  writeFileSync(join(repo, "src", "auth.ts"), "export const b = 2;\n");
  const state = Buffer.from(JSON.stringify({ step: 3, filesDone: ["auth.ts"] })).toString("base64");
  const realize = run(repo, ["realize", "-p", "checkpoint", "--state", state, "--json"]);
  const id = parseJson(realize.stdout).intentId;
  const replay = parseJson(run(repo, ["replay", id, "--json"]).stdout);
  assert.equal(replay.agentState, state);
  const checkout = parseJson(run(repo, ["replay", id, "--checkout", "--json"]).stdout);
  assert.equal(checkout.checkedOut, true);
});
