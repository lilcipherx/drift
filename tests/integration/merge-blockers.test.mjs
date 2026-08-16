/**
 * Merge-blocker regression tests (docs/PR7_MERGE_BLOCKERS_BASELINE.md).
 *
 * Every test drives the REAL built CLI (packages/drift-cli/dist/cli.js) in a
 * throwaway git repository. The five blockers this pass fixed:
 *   A — `drift realize` now commits source + signed public manifest + key +
 *       `Drift-Intent:` trailer in ONE commit (no manual second commit).
 *   B — `drift init` in a fresh clone preserves the committed trust root,
 *       enters read-only signer mode, and `drift key import` restores signing.
 *   C — default `drift export` is public-only; private prompts need an
 *       explicit flag and refuse in-repo output by default.
 *   D — Action/App never fall back to the commit subject (generic fallback).
 *   E — `drift verify` never executes recorded commands without `--run` and a
 *       validly signed manifest.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "..", "..");
const CLI = join(ROOT, "packages", "drift-cli", "dist", "cli.js");

const MARKER_EXPORT = "DRIFT_EXPORT_PRIVATE_SECRET_6c91";
const MARKER_VERIFY = "DRIFT_UNTRUSTED_VERIFY_EXECUTED";

// ------------------------------------------------------------------- helpers
function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function run(repo, args, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function makeRepo(name = "drift-mb-") {
  const repo = mkdtempSync(join(tmpdir(), name));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Merge Test"]);
  git(repo, ["config", "user.email", "merge@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function lastIntentId(repo) {
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  const m = /Drift-Intent: (did_[0-9a-f]{32})/.exec(msg);
  assert.ok(m, `no Drift-Intent trailer in: ${msg}`);
  return m[1];
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const keyNormalized = (repo) =>
  readFileSync(join(repo, ".drift", "public", "key.pem"), "utf8").replace(/\r\n/g, "\n");

// ----------------------------------------------------------------- blocker A
test("realize commits public provenance atomically — no second manual commit (Part 11)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);

  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n// retry handling\n");
  const prompt = `Improve retry handling using ${MARKER_EXPORT}`;
  const realize = run(repo, ["realize", "-p", prompt, "--summary", "Improve retry handling", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  const out = JSON.parse(realize.stdout);
  assert.equal(out.status, "ok");

  // NO `git add` / `git commit` after realize — the single commit must carry:
  // source change, public manifest, public key (first intro), intent trailer.
  const headFiles = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n").filter(Boolean);
  assert.ok(headFiles.includes("src/a.ts"), "source change in HEAD");
  assert.ok(headFiles.includes(".drift/public/key.pem"), "public key committed");
  const manifestFile = headFiles.find((f) => f.startsWith(".drift/public/intents/"));
  assert.ok(manifestFile, "public manifest committed in the same commit");
  assert.ok(headFiles.includes(".drift/.gitignore"), "drift gitignore committed");

  // no private data in HEAD
  for (const f of headFiles) {
    assert.ok(
      !f.startsWith(".drift/private") && !f.startsWith(".drift/objects") && !f.startsWith(".drift/keys") && f !== ".drift/drift.db",
      `private data must never be committed: ${f}`,
    );
  }

  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(msg.includes(`Drift-Intent: ${out.intentId}`), "intent trailer in the same commit");

  // V2 manifest: no self-referential commit SHA, has signingKeyId, verified
  const manifest = JSON.parse(readFileSync(join(repo, ".drift", "public", "intents", `${out.intentId}.json`), "utf8"));
  assert.equal(manifest.schemaVersion, 2, "manifest is V2");
  assert.ok(!("commit" in manifest), "V2 manifest must NOT embed the containing commit SHA (circular dependency)");
  assert.equal(typeof manifest.signingKeyId, "string", "V2 manifest records the signing key fingerprint");
  assert.equal(manifest.signature.length > 0, true);
  assert.equal(manifest.summary, "Improve retry handling");
  assert.ok(!JSON.stringify(manifest).includes(MARKER_EXPORT), "private prompt never in the public manifest");

  // worktree: the ONLY leftover is the user-owned config.toml. Policy: a
  // pre-existing .drift/config.toml is NEVER auto-staged by realize (staging
  // it could replace a user's staged version A with the working-tree version
  // B); the user commits it deliberately. Everything Drift generated is
  // committed and nothing private is left staged.
  assert.equal(git(repo, ["status", "--porcelain"]), "?? .drift/config.toml", "only the user-owned config.toml remains untracked");
  assert.ok(!headFiles.includes(".drift/config.toml"), "a pre-existing config.toml must not be auto-committed by realize");

  // trailer-derived association: log + export resolve the commit SHA from the
  // trailer, not from any manifest field
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].id, out.intentId);
  assert.equal(log.intents[0].gitSha, out.gitSha, "commit association derived from the trailer");
  const exp = JSON.parse(run(repo, ["export"]).stdout);
  assert.equal(exp.intents[0].gitSha, out.gitSha, "export resolves the commit from the trailer");
});

test("realize failure cleanup: failed git commit restores the EXACT original index and removes the generated manifest", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // The user's state BEFORE realize: a partially staged file (staged hunk +
  // unstaged hunk), a fully staged file, an intent-to-add file, and an
  // unstaged source edit — all of which must survive a commit failure.
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 96;\n");
  git(repo, ["add", "src/a.ts"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 96;\nexport const partial = 1;\n"); // unstaged hunk
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
  git(repo, ["add", "src/b.ts"]);
  writeFileSync(join(repo, "src", "c.ts"), "export const c = 1;\n");
  git(repo, ["add", "-N", "src/c.ts"]); // intent-to-add
  // Force `git commit` to fail deterministically (no identity configured).
  git(repo, ["config", "--unset-all", "user.name"]);
  git(repo, ["config", "--unset-all", "user.email"]);

  const indexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const indexBefore = existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "absent";
  const cachedBefore = git(repo, ["diff", "--cached", "--binary"]);
  const statusBefore = git(repo, ["status", "--porcelain=v2"]);
  const stageBefore = git(repo, ["ls-files", "--stage"]);
  const debugBefore = git(repo, ["ls-files", "--debug"]);

  const res = run(repo, ["realize", "-p", "do the thing", "--summary", "Do the thing"]);
  assert.notEqual(res.status, 0, "commit must fail without identity");
  assert.ok(res.stderr.includes("no history was created"), res.stderr);
  assert.ok(res.stderr.includes("restored exactly"), res.stderr);

  // the generated manifest must not survive as if committed
  const onDisk = readdirSync(join(repo, ".drift", "public", "intents")).filter((f) => f.endsWith(".json"));
  assert.equal(onDisk.length, 0, "failed realize must not leave a manifest behind");
  const tracked = git(repo, ["ls-files", "--", ".drift"]).split("\n").filter(Boolean);
  for (const f of tracked) {
    assert.ok(!f.startsWith(".drift/public/intents"), `no manifest tracked after failure: ${f}`);
  }
  // the index is byte-for-byte identical to the pre-Drift state: staged
  // hunks, intent-to-add, staged files and Drift's own staging all restored
  const indexAfter = existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "absent";
  assert.equal(indexAfter, indexBefore, "index file bytes must be identical after a failed commit");
  assert.equal(git(repo, ["diff", "--cached", "--binary"]), cachedBefore, "staged diff must be byte-identical");
  assert.equal(git(repo, ["status", "--porcelain=v2"]), statusBefore, "porcelain v2 status must be identical");
  assert.equal(git(repo, ["ls-files", "--stage"]), stageBefore, "stage entries must be identical");
  assert.equal(git(repo, ["ls-files", "--debug"]), debugBefore, "index flags (assume-unchanged etc.) must be identical");
  // the working-tree source edit is intact (unstaged)
  assert.ok(readFileSync(join(repo, "src", "a.ts"), "utf8").includes("export const partial = 1;"));
});

test("failed pre-commit hook also restores the exact original index (commit failure after public files staged)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // a pre-commit hook that always fails — the commit lands only AFTER the
  // public files are staged, so this exercises the late-failure path
  const hooksDir = join(repo, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n");
  if (process.platform !== "win32") {
    // executable bit is irrelevant for git hooks (they run via the shell), but
    // keep the file mode honest on POSIX
    chmodSync(join(hooksDir, "pre-commit"), 0o755);
  }
  // user state: one fully staged file + one unstaged edit
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 97;\n");
  git(repo, ["add", "src/a.ts"]);
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n"); // unstaged
  const indexPath = git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const indexBefore = existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "absent";
  const cachedBefore = git(repo, ["diff", "--cached", "--binary"]);

  const res = run(repo, ["realize", "-p", "hooked", "--summary", "Hooked"]);
  assert.notEqual(res.status, 0, "the pre-commit hook must fail the commit");
  assert.ok(res.stderr.includes("no history was created"), res.stderr);

  const indexAfter = existsSync(indexPath) ? sha256(readFileSync(indexPath)) : "absent";
  assert.equal(indexAfter, indexBefore, "index file bytes must be identical after the hook failure");
  assert.equal(git(repo, ["diff", "--cached", "--binary"]), cachedBefore, "staged diff must be byte-identical");
  assert.equal(readdirSync(join(repo, ".drift", "public", "intents")).filter((f) => f.endsWith(".json")).length, 0, "no manifest may survive");
  // the unstaged edit is intact
  assert.ok(readFileSync(join(repo, "src", "b.ts"), "utf8").includes("export const b = 2;"));
});

// ----------------------------------------------------------------- blocker B
test("clone init preserves the trust root; read-only signer mode; key import restores signing", () => {
  const origin = makeRepo();
  assert.equal(run(origin, ["init"]).status, 0);
  writeFileSync(join(origin, "src", "a.ts"), "export const a = 2;\n");
  const realize = run(origin, ["realize", "-p", "tweak a", "--summary", "Tweak a", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  const id = JSON.parse(realize.stdout).intentId;

  const bare = mkdtempSync(join(tmpdir(), "drift-mb-bare-"));
  git(origin, ["clone", "--bare", "-q", ".", bare]);
  const clone = mkdtempSync(join(tmpdir(), "drift-mb-clone-"));
  git(bare, ["clone", "-q", bare, clone]);
  git(clone, ["config", "user.name", "Merge Test"]);
  git(clone, ["config", "user.email", "merge@example.com"]);

  const keyBefore = keyNormalized(clone);
  const sigBefore = JSON.parse(run(clone, ["verify-intent", id, "--json"]).stdout);
  assert.equal(sigBefore.state, "valid", "signature valid in the clone before init");

  // init: creates private dirs/db, preserves the public key, read-only signer
  const initRes = run(clone, ["init"]);
  assert.equal(initRes.status, 0, initRes.stderr);
  assert.equal(keyNormalized(clone), keyBefore, "public key preserved byte-for-byte by clone init");
  assert.equal(sha256(keyNormalized(clone)), sha256(keyBefore));
  assert.ok(!existsSync(join(clone, ".drift", "keys", "ed25519.pem")), "no replacement key generated");
  assert.ok(existsSync(join(clone, ".drift", "drift.db")), "local private db created");

  const sigAfter = JSON.parse(run(clone, ["verify-intent", id, "--json"]).stdout);
  assert.equal(sigAfter.state, "valid", "old signatures remain valid after init preserves the key");

  // read-only signer mode: read commands work, realize is rejected
  const status = JSON.parse(run(clone, ["status", "--json"]).stdout);
  assert.equal(status.signerState, "read-only");
  assert.equal(status.signingAllowed, false);
  assert.equal(status.privateKeyAvailable, false);
  writeFileSync(join(clone, "src", "a.ts"), "export const a = 3;\n");
  const blocked = run(clone, ["realize", "-p", "new intent", "--summary", "New intent"]);
  assert.notEqual(blocked.status, 0, "realize must be rejected in read-only mode");
  assert.ok(blocked.stderr.includes("private signing key is unavailable"), blocked.stderr);

  // git status: only the (reverted) source edit, no unexpected key changes
  git(clone, ["checkout", "--", "src/a.ts"]);

  // wrong key import rejected: generate a DIFFERENT keypair in a throwaway
  // repo and try to import it into the clone
  const other = makeRepo();
  assert.equal(run(other, ["init"]).status, 0);
  const otherPriv = readFileSync(join(other, ".drift", "keys", "ed25519.pem"), "utf8");
  const wrongKey = mkdtempSync(join(tmpdir(), "drift-mb-key-"));
  const wrongPath = join(wrongKey, "wrong.pem");
  writeFileSync(wrongPath, otherPriv, { mode: 0o600 });
  const wrongImport = run(clone, ["key", "import", "--file", wrongPath]);
  assert.notEqual(wrongImport.status, 0, "mismatched private key must be rejected");
  assert.ok(wrongImport.stderr.includes("does not match"), wrongImport.stderr);

  // correct key import → ready, and new signed intents work
  const realPriv = readFileSync(join(origin, ".drift", "keys", "ed25519.pem"), "utf8");
  const goodPath = join(wrongKey, "good.pem");
  writeFileSync(goodPath, realPriv, { mode: 0o600 });
  const okImport = run(clone, ["key", "import", "--file", goodPath]);
  assert.equal(okImport.status, 0, okImport.stderr);
  const status2 = JSON.parse(run(clone, ["status", "--json"]).stdout);
  assert.equal(status2.signerState, "ready");
  assert.equal(status2.signingAllowed, true);
  writeFileSync(join(clone, "src", "a.ts"), "export const a = 42;\n");
  const newIdRes = run(clone, ["realize", "-p", "now signing", "--summary", "Now signing", "--json"]);
  assert.equal(newIdRes.status, 0, newIdRes.stderr);
  assert.ok(JSON.parse(newIdRes.stdout).intentId.startsWith("did_"));
});

test("signing-key mismatch (State E) fails safely without overwriting anything", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(run(repo, ["realize", "-p", "x", "--summary", "X"]).status, 0);

  // replace the private key with a different keypair → mismatch
  const other = makeRepo();
  assert.equal(run(other, ["init"]).status, 0);
  const otherPriv = readFileSync(join(other, ".drift", "keys", "ed25519.pem"), "utf8");
  writeFileSync(join(repo, ".drift", "keys", "ed25519.pem"), otherPriv, { mode: 0o600 });

  const committedBefore = keyNormalized(repo);
  const initRes = run(repo, ["init"]);
  assert.notEqual(initRes.status, 0, "init must fail safely on a key mismatch");
  assert.ok(initRes.stderr.includes("Signing-key mismatch"), initRes.stderr);
  assert.equal(keyNormalized(repo), committedBefore, "neither key overwritten");

  writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
  const realize = run(repo, ["realize", "-p", "y", "--summary", "Y"]);
  assert.notEqual(realize.status, 0, "realize must refuse with a mismatched key");
  assert.ok(realize.stderr.includes("Signing-key mismatch"), realize.stderr);
  git(repo, ["checkout", "--", "src/a.ts"]);

  // read commands still work and report the mismatch truthfully
  const status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.signerState, "mismatch");
  assert.equal(status.signingAllowed, false);
});

// ----------------------------------------------------------------- blocker C
test("default export is public-only; private export requires an explicit flag and refuses in-repo output", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  const realize = run(repo, ["realize", "-p", `add ${MARKER_EXPORT} to the export test`, "--summary", "Export test", "--json"]);
  assert.equal(realize.status, 0, realize.stderr);

  // default: public-only, no prompt anywhere
  const pub = run(repo, ["export"]);
  assert.equal(pub.status, 0);
  const pubJson = JSON.parse(pub.stdout);
  assert.equal(pubJson.schemaVersion, 2);
  assert.equal(pubJson.containsPrivatePrompts, false);
  assert.ok(!pub.stdout.includes(MARKER_EXPORT), "default export must not contain the private prompt");
  assert.ok(!JSON.stringify(pubJson).includes("prompt"), "default export has no prompt field");

  // default --out file is also clean
  const outFile = join(repo, "..", "public-export.json");
  assert.equal(run(repo, ["export", "--out", outFile]).status, 0);
  assert.ok(!readFileSync(outFile, "utf8").includes(MARKER_EXPORT));

  // explicit private export: marked, contains the marker, warns on stderr
  const priv = run(repo, ["export", "--include-private-prompt"]);
  assert.equal(priv.status, 0);
  assert.ok(priv.stderr.includes("warning"), "private export must warn on stderr");
  const privJson = JSON.parse(priv.stdout);
  assert.equal(privJson.containsPrivatePrompts, true);
  assert.ok(priv.stdout.includes(MARKER_EXPORT), "private export contains the marker (explicit flag)");

  // private export refused inside the repository unless overridden
  const inside = run(repo, ["export", "--include-private-prompt", "--out", join(repo, "leak.json")]);
  assert.notEqual(inside.status, 0, "private export inside the repo must be refused");
  assert.ok(inside.stdout.includes("refusing"), inside.stdout);
  assert.ok(!existsSync(join(repo, "leak.json")));
  const override = run(repo, ["export", "--include-private-prompt", "--out", join(repo, "leak.json"), "--allow-repository-output"]);
  assert.equal(override.status, 0, override.stderr);
  assert.ok(existsSync(join(repo, "leak.json")));
  rmSync(join(repo, "leak.json"), { force: true });
});

// ----------------------------------------------------------------- blocker E
test("verify never executes recorded commands by default; --run requires a validly signed manifest", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const markerFile = join(tmpdir(), `drift-verify-marker-${Date.now()}.txt`);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  const realize = run(repo, ["realize", "-p", "verify me", "--summary", "Verify me", "--verify-cmd", `touch ${markerFile}`, "--json"]);
  assert.equal(realize.status, 0, realize.stderr);
  const id = JSON.parse(realize.stdout).intentId;

  // plain informational verify: never executes
  const plain = run(repo, ["verify", id, "--json"]);
  assert.equal(plain.status, 0);
  assert.equal(JSON.parse(plain.stdout).verifyStatus, "not-executed");
  assert.equal(JSON.parse(plain.stdout).signature, "valid");
  assert.ok(!existsSync(markerFile), "plain verify must NOT execute the recorded command");

  // --run with a valid signature executes
  const runRes = run(repo, ["verify", id, "--run", "--json"]);
  assert.equal(JSON.parse(runRes.stdout).verifyStatus, "pass");
  assert.ok(existsSync(markerFile), "--run executes a validly signed command");
  rmSync(markerFile, { force: true });
});

test("verify --run refuses invalid, unsigned, and unverifiable manifests (marker never created)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const markerFile = join(tmpdir(), `drift-verify-marker-${Date.now()}.txt`);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(run(repo, ["realize", "-p", "verify me", "--summary", "Verify me", "--verify-cmd", `touch ${markerFile}`]).status, 0);
  const id = lastIntentId(repo);
  const manifestPath = join(repo, ".drift", "public", "intents", `${id}.json`);

  // invalid: tamper with the manifest summary (breaks the signature)
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.summary = "tampered summary";
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const invalid = run(repo, ["verify", id, "--run", "--json"]);
  assert.equal(JSON.parse(invalid.stdout).verifyStatus, "refused", "invalid signature must refuse execution");
  assert.equal(JSON.parse(invalid.stdout).signature, "invalid");
  assert.ok(!existsSync(markerFile), "invalid manifest must never execute");

  // unsigned: strip the signature
  delete m.signature;
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  const unsigned = run(repo, ["verify", id, "--run", "--json"]);
  assert.equal(JSON.parse(unsigned.stdout).signature, "unsigned");
  assert.equal(JSON.parse(unsigned.stdout).verifyStatus, "refused");
  assert.ok(!existsSync(markerFile));

  // unverifiable: remove the committed public key
  rmSync(join(repo, ".drift", "public", "key.pem"), { force: true });
  writeFileSync(manifestPath, JSON.stringify({ ...m, signature: "c2ln", summary: "x" }, null, 2));
  const unverifiable = run(repo, ["verify", id, "--run", "--json"]);
  assert.equal(JSON.parse(unverifiable.stdout).signature, "unverifiable");
  assert.equal(JSON.parse(unverifiable.stdout).verifyStatus, "refused");
  assert.ok(!existsSync(markerFile), "unverifiable manifest must never execute");

  // dangerous override requires both flags and executes
  const forced = run(repo, ["verify", id, "--run", "--allow-untrusted-command", "--json"]);
  assert.ok(forced.stderr.includes("DANGER"), "the dangerous override must print a prominent warning");
  assert.equal(JSON.parse(forced.stdout).verifyStatus, "pass");
  assert.ok(existsSync(markerFile), "explicit dangerous override executes");
  rmSync(markerFile, { force: true });
});

// --------------------------------------------------------------------- G: env
test("verify --run: sanitized environment by default, --inherit-env opt-in (no secrets by default)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const probe = join(tmpdir(), `drift-env-probe-${Date.now()}.json`);
  // A plain script avoids nested-quote portability issues on Windows cmd.exe.
  const probeScript = join(tmpdir(), `drift-env-probe-${Date.now()}.js`);
  writeFileSync(
    probeScript,
    `const fs = require("fs");
const keys = ["GITHUB_TOKEN","GH_TOKEN","NPM_TOKEN","NODE_AUTH_TOKEN","DRIFT_MASTER_KEY","AWS_SECRET_ACCESS_KEY","SSH_AUTH_SOCK"].filter((k) => process.env[k] !== undefined);
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify(keys));`,
  );
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
  // The verify command runs the probe and records which secrets it can see.
  const cmd = `node "${probeScript}"`;
  assert.equal(run(repo, ["realize", "-p", "env test", "--summary", "Env test", "--verify-cmd", cmd]).status, 0);
  const id = lastIntentId(repo);
  const withSecrets = {
    GITHUB_TOKEN: "DRIFT_ENV_SECRET_GITHUB_61a4",
    GH_TOKEN: "DRIFT_ENV_SECRET_GH",
    NPM_TOKEN: "DRIFT_ENV_SECRET_NPM_72b5",
    NODE_AUTH_TOKEN: "DRIFT_ENV_SECRET_NODE_83c6",
    DRIFT_MASTER_KEY: "DRIFT_ENV_SECRET_MASTER_94d7",
    AWS_SECRET_ACCESS_KEY: "DRIFT_ENV_SECRET_AWS_a5e8",
    SSH_AUTH_SOCK: "/tmp/drift-fake-agent",
  };
  // default --run: sanitized env, secrets must be invisible
  const def = spawnSync(process.execPath, [CLI, "verify", id, "--run", "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...withSecrets },
  });
  assert.equal(JSON.parse(def.stdout).verifyStatus, "pass");
  const seenDefault = JSON.parse(readFileSync(probe, "utf8"));
  assert.deepEqual(seenDefault, [], `secrets leaked into the default verify env: ${seenDefault.join(", ")}`);
  // PATH-based tooling still works (node itself ran)

  // --inherit-env: the same secrets ARE visible (explicit opt-in)
  const inherited = spawnSync(process.execPath, [CLI, "verify", id, "--run", "--inherit-env", "--json"], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, ...withSecrets },
  });
  assert.equal(JSON.parse(inherited.stdout).verifyStatus, "pass");
  const seenInherited = JSON.parse(readFileSync(probe, "utf8"));
  assert.ok(seenInherited.includes("GITHUB_TOKEN"), "--inherit-env exposes the parent environment");
  assert.ok(seenInherited.includes("DRIFT_MASTER_KEY"));
  rmSync(probe, { force: true });
});

// --------------------------------------------------------------------- E: strict
function corruptManifest(repo, id, mutate) {
  const p = join(repo, ".drift", "public", "intents", `${id}.json`);
  const m = JSON.parse(readFileSync(p, "utf8"));
  mutate(m);
  writeFileSync(p, JSON.stringify(m));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "corrupt manifest"]);
}

test("malformed tracked manifests never crash log/status/export and are never rendered as valid", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 4;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const id = lastIntentId(repo);
  // files as object + string timestamp + numeric signature — all invalid
  corruptManifest(repo, id, (m) => {
    m.files = { path: "x" };
    m.timestamp = "not-a-number";
    m.signature = 12345;
  });

  // log must not crash; the malformed manifest is skipped with a warning
  const log = run(repo, ["log", "--json"]);
  assert.equal(log.status, 0, log.stderr);
  assert.equal(JSON.parse(log.stdout).status, "ok");
  assert.ok(log.stderr.includes("malformed public manifest"), "log reports an actionable diagnostic");
  const textLog = run(repo, ["log"]);
  assert.equal(textLog.status, 0, textLog.stderr);
  assert.ok(textLog.stderr.includes("malformed"), textLog.stderr);

  // status reports the malformed count
  const status = run(repo, ["status", "--json"]);
  assert.equal(status.status, 0);
  assert.equal(JSON.parse(status.stdout).malformedManifests.length, 1);

  // export skips the malformed manifest and reports it, never crashes
  const exp = run(repo, ["export"]);
  assert.equal(exp.status, 0, exp.stderr);
  const data = JSON.parse(exp.stdout);
  assert.equal(data.intents.length, 0, "malformed manifest is not exported as valid");
  assert.ok(data.malformed && data.malformed.length === 1, "export reports the malformed manifest");

  // verify reports malformed, never valid, never executes
  const v = run(repo, ["verify", id, "--json"]);
  assert.equal(JSON.parse(v.stdout).signature, "malformed");
  assert.equal(JSON.parse(v.stdout).verifyStatus, "refused");
  const vRun = run(repo, ["verify", id, "--run", "--json"]);
  assert.equal(JSON.parse(vRun.stdout).verifyStatus, "refused");
});

test("malformed manifest with a matching signature is not treated as valid (signingKeyId mismatch)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 5;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const id = lastIntentId(repo);
  // rewrite signingKeyId to a wrong fingerprint WITHOUT touching the signature
  const p = join(repo, ".drift", "public", "intents", `${id}.json`);
  const m = JSON.parse(readFileSync(p, "utf8"));
  m.signingKeyId = "ffffffffffffffff";
  writeFileSync(p, JSON.stringify(m));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "wrong key id"]);
  const v = run(repo, ["verify", id, "--json"]);
  assert.equal(JSON.parse(v.stdout).signature, "invalid", "signingKeyId mismatch must never report valid");
});

// --------------------------------------------------------------------- I: index
test("realize syntax failure preserves the user's staged state exactly (staged, partial, intent-to-add)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // A fully staged with one hunk, B partially staged (staged + unstaged hunks),
  // C intent-to-add, D a brand-new untracked file that fails syntax.
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 6;\n");
  git(repo, ["add", "src/a.ts"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 6;\nexport const b = 1;\n"); // unstaged hunk
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\n");
  git(repo, ["add", "src/b.ts"]);
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 1;\nexport const c = 2;\n"); // unstaged hunk
  writeFileSync(join(repo, "src", "c.ts"), "export const c = 3;\n");
  git(repo, ["add", "-N", "src/c.ts"]); // intent-to-add
  writeFileSync(join(repo, "src", "bad.ts"), "this is not valid typescript ;;;\n"); // untracked, invalid
  const before = git(repo, ["diff", "--cached"]);
  const beforeNameStatus = git(repo, ["diff", "--cached", "--name-status"]);
  const res = run(repo, ["realize", "-p", "boom", "--summary", "Boom"]);
  assert.equal(res.status, 2, res.stderr); // EXIT.SYNTAX
  assert.ok(res.stderr.includes("Syntax error"), res.stderr);
  assert.ok(res.stderr.includes("preserved"), res.stderr);
  const after = git(repo, ["diff", "--cached"]);
  const afterNameStatus = git(repo, ["diff", "--cached", "--name-status"]);
  assert.equal(after, before, "staged hunks must be byte-identical after the failed realize");
  assert.equal(afterNameStatus, beforeNameStatus);
  assert.ok(beforeNameStatus.includes("a.ts"), "the pre-existing staged file is still staged");
  assert.ok(beforeNameStatus.includes("b.ts"), "the partially staged file keeps its staged hunks");
  // the bad file is NOT left staged, and no manifest was written
  const stagedNames = git(repo, ["diff", "--cached", "--name-only"]);
  assert.ok(!stagedNames.split("\n").some((l) => l.includes("bad.ts")), "failed realize must not leave its own staging behind");
  const intentsDir = join(repo, ".drift", "public", "intents");
  assert.equal(readdirSync(intentsDir).length, 0, "no manifest may be written for a failed realize");
  // C remains intent-to-add (porcelain " A" = new-file entry in the index)
  const status = git(repo, ["status", "--porcelain"]);
  assert.ok(status.split("\n").some((l) => l.includes("c.ts") && l.startsWith(" A")), `c.ts should still be intent-to-add: ${status}`);
  assert.ok(status.split("\n").some((l) => l.includes("bad.ts") && l.startsWith("??")), `bad.ts should remain untracked: ${status}`);
});

test("realize stages config.toml only when it is the safe template or already tracked", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // user deliberately untracks config.toml after modifying it
  const configPath = join(repo, ".drift", "config.toml");
  git(repo, ["add", configPath]);
  git(repo, ["commit", "-qm", "track config"]);
  git(repo, ["rm", "--cached", "-q", configPath]);
  git(repo, ["commit", "-qm", "untrack config"]);
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"none\"\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 7;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const inTree = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
  assert.ok(!inTree.includes(".drift/config.toml"), "a deliberately untracked config must stay untracked");
});

test("realize never stages a tracked config with an unstaged user edit", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // config is committed, then the user edits it WITHOUT staging
  const configPath = join(repo, ".drift", "config.toml");
  git(repo, ["add", configPath]);
  git(repo, ["commit", "-qm", "track config"]);
  const edit = "\n[prompts]\nmode = \"full\"\n";
  writeFileSync(configPath, readFileSync(configPath, "utf8") + edit);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 71;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const headConfig = git(repo, ["show", "HEAD:.drift/config.toml"]);
  assert.ok(!headConfig.includes("mode = \"full\""), "an unstaged config edit must not ride into the Drift commit");
  // and the edit is still present in the working tree (untouched)
  assert.ok(readFileSync(configPath, "utf8").includes("mode = \"full\""));
});

test("realize refuses to stage an unapproved working-tree change to the tracked public key", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 72;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0, "first realize commits the key");
  // tamper with the committed trust root in the working tree
  const keyPath = join(repo, ".drift", "public", "key.pem");
  writeFileSync(keyPath, readFileSync(keyPath, "utf8") + "\n# tampered\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 73;\n");
  const res = run(repo, ["realize", "-p", "nope", "--summary", "Nope"]);
  assert.notEqual(res.status, 0, "signing with a tampered trust root must be refused");
  const keyAtHead = git(repo, ["show", "HEAD:.drift/public/key.pem"]);
  assert.ok(!keyAtHead.includes("tampered"), "the tampered key must never be committed");
});

test("realize refuses when the git index has unmerged (conflict) entries", () => {
  const repo = makeRepo("drift-mb-conflict-");
  assert.equal(run(repo, ["init"]).status, 0);
  git(repo, ["checkout", "-q", "-b", "side"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  git(repo, ["commit", "-qam", "side"]);
  git(repo, ["checkout", "-q", "main"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
  git(repo, ["commit", "-qam", "main"]);
  const merged = spawnSync("git", ["merge", "--no-edit", "side"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(merged.status, 0, "expected a merge conflict");
  assert.ok(git(repo, ["ls-files", "-u"]).length > 0, "index should contain unmerged entries");
  const res = run(repo, ["realize", "-p", "x", "--summary", "X"]);
  assert.notEqual(res.status, 0);
  assert.ok(res.stderr.includes("unmerged"), `must refuse with an actionable message: ${res.stderr}`);
});

test("public summaries are never empty: whitespace-only explicit summary falls back to the generic form", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 74;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "   \n\t"]).status, 0);
  const id = lastIntentId(repo);
  const manifest = JSON.parse(readFileSync(join(repo, ".drift", "public", "intents", `${id}.json`), "utf8"));
  assert.ok(manifest.summary.startsWith("Drift intent "), `got: ${JSON.stringify(manifest.summary)}`);
});

test("none mode with an explicit summary keeps the explicit summary and persists no prompt", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const configPath = join(repo, ".drift", "config.toml");
  writeFileSync(configPath, readFileSync(configPath, "utf8") + "\n[prompts]\nmode = \"none\"\n");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 75;\n");
  assert.equal(run(repo, ["realize", "-p", "private prompt text", "--summary", "Explicit safe summary"]).status, 0);
  const id = lastIntentId(repo);
  const manifest = JSON.parse(readFileSync(join(repo, ".drift", "public", "intents", `${id}.json`), "utf8"));
  assert.equal(manifest.summary, "Explicit safe summary");
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  assert.ok(!msg.includes("private prompt text"), msg);
  const log = JSON.parse(run(repo, ["log", "--json", "--include-private-prompt"]).stdout);
  assert.equal(log.intents[0].prompt, "");
});

test("an empty-summary public manifest is malformed (never rendered, never a crash)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 76;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const id = lastIntentId(repo);
  const p = join(repo, ".drift", "public", "intents", `${id}.json`);
  const m = JSON.parse(readFileSync(p, "utf8"));
  m.summary = "   ";
  writeFileSync(p, JSON.stringify(m));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "empty summary"]);
  const log = run(repo, ["log", "--json"]);
  assert.equal(log.status, 0, log.stderr);
  assert.ok(log.stderr.includes("malformed"), "empty summaries are malformed, not valid");
  const v = run(repo, ["verify", id, "--json"]);
  assert.equal(JSON.parse(v.stdout).signature, "malformed");
});

test("canonical key fingerprints: LF/CRLF and whitespace produce the same identity, different keys differ", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { signingKeyIdFor } = await import("../../packages/drift-core/dist/index.js");
  const { publicKey } = generateKeyPairSync("ed25519");
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
  const lf = pem;
  const crlf = pem.replace(/\n/g, "\r\n");
  const padded = `\n\n  ${pem}  \n\n`;
  const fp = signingKeyIdFor(lf);
  assert.equal(signingKeyIdFor(crlf), fp, "CRLF PEM must hash identically to LF");
  assert.equal(signingKeyIdFor(padded), fp, "harmless surrounding whitespace must not change the fingerprint");
  const { publicKey: other } = generateKeyPairSync("ed25519");
  const otherPem = other.export({ type: "spki", format: "pem" }).toString().trim();
  assert.notEqual(signingKeyIdFor(otherPem), fp, "a different key must produce a different fingerprint");
  assert.match(signingKeyIdFor("not a pem"), /^[0-9a-f]{16}$/, "malformed PEM yields a deterministic fallback id");
});

test("an oversized tracked manifest is reported as malformed without crashing or echoing content", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 77;\n");
  assert.equal(run(repo, ["realize", "-p", "ok", "--summary", "OK"]).status, 0);
  const id = lastIntentId(repo);
  const p = join(repo, ".drift", "public", "intents", `${id}.json`);
  const m = JSON.parse(readFileSync(p, "utf8"));
  m.files = Array.from({ length: 20000 }, (_, i) => ({ path: `x${i}.ts`, mutationType: "ADDED", summary: "y".repeat(50) }));
  writeFileSync(p, JSON.stringify(m));
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "oversize"]);
  const log = run(repo, ["log", "--json"]);
  assert.equal(log.status, 0, "log must not crash on oversized manifests");
  assert.ok(log.stderr.includes("malformed"), log.stderr);
  const v = run(repo, ["verify", id, "--json"]);
  assert.equal(JSON.parse(v.stdout).signature, "malformed");
});

// ------------------------------------------- index snapshot lifecycle (issue 10-12)
// The CLI is spawned with its OWN isolated TMPDIR so concurrent test files
// (npm test runs suites in parallel) can never create drift-idx-* entries
// inside the directory we are asserting on.
function isolatedRun(repo, args) {
  const tmp = mkdtempSync(join(tmpdir(), "drift-idxcheck-"));
  const res = run(repo, args, { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
  return { status: res.status, stderr: res.stderr, backups: () => readdirSync(tmp).filter((n) => n.startsWith("drift-idx-")) };
}

test("index snapshots are always discarded: no drift-idx-* backup survives success, failure, or repeated realizations", () => {
  // successful realize discards its snapshot
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 80;\n");
  let r = isolatedRun(repo, ["realize", "-p", "ok", "--summary", "OK"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.backups(), [], "a successful realize must not leave a drift-idx-* backup behind");

  // repeated successful realizations do not accumulate backups
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "src", "a.ts"), `export const a = ${81 + i};\n`);
    r = isolatedRun(repo, ["realize", "-p", "ok", "--summary", "OK"]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.backups(), [], `realize #${i + 1} must not leak a backup (persistent self-hosted runner hygiene)`);
  }

  // pre-commit failure (syntax error) restores AND cleans up its snapshot
  writeFileSync(join(repo, "src", "bad.ts"), "this is not valid typescript ;;;\n");
  r = isolatedRun(repo, ["realize", "-p", "boom", "--summary", "Boom"]);
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(r.backups(), [], "a failed realize must not leave a drift-idx-* backup behind");

  // "no staged changes" failure also cleans up
  const fresh = makeRepo();
  assert.equal(run(fresh, ["init"]).status, 0);
  r = isolatedRun(fresh, ["realize", "-p", "nothing changed"]);
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.backups(), [], "a no-op realize must not leave a drift-idx-* backup behind");
});

test("strict schema: unknown manifest fields are rejected (top-level, agent, files)", async () => {
  const { parsePublicIntentManifest } = await import("../../packages/drift-core/dist/index.js");
  const base = {
    schemaVersion: 2,
    id: "did_11111111111111111111111111111111",
    summary: "s",
    timestamp: 1,
    signature: "",
    signingKeyId: "0123456789abcdef",
  };
  assert.equal(parsePublicIntentManifest(base).ok, true);
  assert.equal(parsePublicIntentManifest({ ...base, stray: 1 }).ok, false);
  assert.equal(
    parsePublicIntentManifest({ ...base, agent: { type: "AGENT", identifier: "x", extra: true } }).ok,
    false,
  );
  assert.equal(
    parsePublicIntentManifest({ ...base, files: [{ path: "a", mutationType: "ADDED", extra: 1 }] }).ok,
    false,
  );
  assert.equal(parsePublicIntentManifest({ ...base, commit: "abc" }).ok, false, "commit is V1-only");
  assert.equal(parsePublicIntentManifest({ ...base, symbols: [] }).ok, false, "symbols is not part of the schema");
});

// ------------------------------------------- orphan private objects + associations
function objectsUnder(repo) {
  const dir = join(repo, ".drift", "objects");
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      try {
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".json")) out.push(full);
      } catch {
        /* unreadable entry — skip */
      }
    }
  };
  walk(dir);
  return out;
}

function writeManifest(repo, id, summary, extra = {}) {
  const dir = join(repo, ".drift", "public", "intents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({
      schemaVersion: 2,
      id,
      summary,
      timestamp: 1,
      signingKeyId: "0123456789abcdef",
      signature: "",
      ...extra,
    }),
  );
}

function validIntentId(seed) {
  // a deterministic, valid-format Drift intent id
  return `did_${createHash("sha256").update(seed).digest("hex").slice(0, 32)}`;
}

test("failed realize (pre-commit hook) removes the prompt-bearing private object it created", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 41;\n");
  // force the commit to fail AFTER the private object is written
  const hooks = join(repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const r = run(repo, ["realize", "-p", `secret ${MARKER_EXPORT} orphan`, "--summary", "Orphan"]);
  assert.notEqual(r.status, 0, "the forced commit failure must fail realize");
  // NO orphan private object may remain: the object was written before the
  // commit and the commit never landed.
  assert.deepEqual(objectsUnder(repo), [], "a failed realize must remove its own private object");
  // and no leftover tmp file either
  const objectsDir = join(repo, ".drift", "objects");
  const allFiles = existsSync(objectsDir) ? readdirSync(objectsDir, { recursive: true }) : [];
  assert.ok(!allFiles.some((f) => String(f).includes(".tmp-")), "no .tmp-* leftover may remain");
});

test("failed realize (syntax error) leaves no private object and no staged manifest", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "bad.ts"), "this is not valid typescript ;;;\n");
  const r = run(repo, ["realize", "-p", "boom", "--summary", "Boom"]);
  assert.equal(r.status, 2, r.stderr); // EXIT.SYNTAX
  assert.deepEqual(objectsUnder(repo), [], "a syntax failure must not leave a private object");
  const intentsDir = join(repo, ".drift", "public", "intents");
  assert.equal(readdirSync(intentsDir).length, 0, "no manifest may be written for a failed realize");
});

test("successful realize keeps its private object (not an orphan) and doctor confirms", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 42;\n");
  const r = run(repo, ["realize", "-p", "ok secret", "--summary", "OK"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(objectsUnder(repo).length, 1, "the committed intent keeps its private object");
  const doctor = JSON.parse(run(repo, ["doctor", "--json"]).stdout);
  assert.equal(doctor.checks.find((c) => c.name === "orphan-objects").ok, true);
});

test("drift doctor detects orphan private objects and --fix removes them safely", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // simulate a leftover from a failed realize: an object with a valid id but
  // no DB row, no public manifest, and no trailer
  const orphanId = validIntentId("orphan");
  const dir = join(repo, ".drift", "objects", "aa");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${createHash("sha256").update("orphan").digest("hex").slice(2)}.json`),
    JSON.stringify({
      id: orphanId,
      parentId: null,
      author: { type: "HUMAN", identifier: "T" },
      prompt: "ORPHAN_PROMPT_MARKER must never be printed",
      astDelta: [],
      timestamp: 1,
      signature: "",
    }),
  );
  const doctor = JSON.parse(run(repo, ["doctor", "--json"]).stdout);
  const check = doctor.checks.find((c) => c.name === "orphan-objects");
  assert.equal(check.ok, false, "doctor must flag the orphan object");
  assert.ok(!check.detail.includes("ORPHAN_PROMPT_MARKER"), "doctor must never print the raw prompt");
  assert.ok(check.detail.includes("drift doctor --fix"), "doctor must suggest the safe cleanup path");
  // --fix removes it
  const fixed = JSON.parse(run(repo, ["doctor", "--fix", "--json"]).stdout);
  assert.ok(fixed.fixed.some((f) => f.includes("orphan object")), JSON.stringify(fixed.fixed));
  const after = JSON.parse(run(repo, ["doctor", "--json"]).stdout);
  assert.equal(after.checks.find((c) => c.name === "orphan-objects").ok, true);
});

test("intent associations: replayed references are visible in log/status, never silently mapped to one commit", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const id = validIntentId("replay");
  // commit 1 introduces manifest + trailer (atomic)
  writeManifest(repo, id, "first");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 50;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `introduce\n\nDrift-Intent: ${id}`]);
  const c1 = git(repo, ["rev-parse", "HEAD"]);
  // commit 2 re-references the SAME id (replay)
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 51;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `replay\n\nDrift-Intent: ${id}`]);
  const c2 = git(repo, ["rev-parse", "HEAD"]);
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  const entry = log.intents.find((e) => e.id === id);
  assert.ok(entry, "the manifest-backed intent is listed");
  assert.equal(entry.gitSha, c1, "log must show the INTRODUCING commit, not the newest reference");
  assert.deepEqual(entry.association, {
    state: "replayed",
    originalCommit: c1,
    laterCommits: [c2],
  });
  const status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.intentAssociations.replayed, 1);
  assert.equal(status.intentAssociations.unique, 0);
  // human output flags it too
  const human = run(repo, ["log"]);
  assert.ok(human.stdout.includes("⚠replayed"), human.stdout);
});

test("realize preserves a STAGED config version A even when the unstaged working-tree version B equals the template", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const configPath = join(repo, ".drift", "config.toml");
  const template = readFileSync(configPath, "utf8");
  // user stages a CUSTOM config version A (e.g. enabling encryption settings)
  const customA = template + "\n[prompts]\nmode = \"full\"\n";
  writeFileSync(configPath, customA);
  git(repo, ["add", configPath]);
  git(repo, ["commit", "-qm", "commit custom config"]);
  // ...then edits the working tree again so the UNSTAGED version B happens
  // to be byte-identical to the safe template (the old code staged B over A
  // — the new policy must preserve staged version A exactly).
  writeFileSync(configPath, template);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 60;\n");
  const stagedBefore = git(repo, ["diff", "--cached", "--", ".drift/config.toml"]);
  assert.equal(stagedBefore, "", "nothing is staged yet");
  const r = run(repo, ["realize", "-p", "ok", "--summary", "OK"]);
  assert.equal(r.status, 0, r.stderr);
  const committedConfig = git(repo, ["show", "HEAD:.drift/config.toml"]);
  assert.ok(
    committedConfig.includes('mode = "full"'),
    "the commit must carry the STAGED custom version A, not the working-tree template B",
  );
  // the working tree still holds B (untouched, unstaged)
  assert.equal(readFileSync(configPath, "utf8"), template);
  // and B is still NOT staged
  const stagedAfter = git(repo, ["diff", "--cached", "--", ".drift/config.toml"]);
  assert.equal(stagedAfter, "", "the working-tree B must not be staged by realize");
});

test("intent associations: duplicate trailer lines in ONE commit are malformed metadata; ambiguous orphans are counted", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const dupId = validIntentId("dup");
  writeManifest(repo, dupId, "dup manifest");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 52;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `dup trailer\n\nDrift-Intent: ${dupId}\nDrift-Intent: ${dupId}`]);
  const status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.intentAssociations.duplicate, 1, "duplicate trailer lines in one commit must be flagged");
  assert.deepEqual(
    status.associationDiagnostics.duplicateTrailers,
    [dupId],
    "duplicate-trailer diagnostics must name the id",
  );
  assert.equal(
    status.associationDiagnostics.trailerWithoutManifest.length,
    0,
    "a duplicated trailer WITH a valid manifest is not a trailer-without-manifest",
  );
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents.find((e) => e.id === dupId).association.state, "duplicate-in-commit");
  assert.equal(log.intents.find((e) => e.id === dupId).association.occurrences, 2);

  // ambiguous: an id referenced by two commits with NO manifest (orphan)
  const ambId = validIntentId("amb");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 53;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `amb 1\n\nDrift-Intent: ${ambId}`]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 54;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `amb 2\n\nDrift-Intent: ${ambId}`]);
  const status2 = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status2.intentAssociations.ambiguous, 1, "ambiguous orphan associations must be visible");
});
// ---------------------------------------------------- status intent-count semantics
test("status counts ONLY valid committed manifests as public intents; anomalies are diagnostics", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);

  // 1. one REAL realize → one valid manifest, one public intent
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 61;\n");
  const r = run(repo, ["realize", "-p", "count semantics", "--summary", "One valid intent", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const id = JSON.parse(r.stdout).intentId;
  let status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.publicIntents, 1, "one valid manifest = one public intent");
  assert.equal(status.intents, 1);
  assert.deepEqual(
    status.associationDiagnostics.trailerWithoutManifest,
    [],
    "a committed manifest is never a trailer-without-manifest",
  );

  // 2. a trailer WITHOUT a manifest must NOT increment publicIntents/intents —
  //    it is a diagnostic only.
  const orphanId = validIntentId("orphan-count");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 62;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `orphan trailer\n\nDrift-Intent: ${orphanId}`]);
  status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.publicIntents, 1, "a trailer without a manifest is not a public intent");
  assert.equal(status.intents, 1, "a trailer without a manifest is not an intent");
  assert.deepEqual(
    status.associationDiagnostics.trailerWithoutManifest,
    [orphanId],
    "the trailer-only id must be visible as a diagnostic",
  );

  // 3. a malformed manifest (empty summary) must NOT increment publicIntents.
  const malId = validIntentId("malformed-count");
  writeManifest(repo, malId, "", {}); // empty summary → schema-invalid
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `malformed manifest\n\nDrift-Intent: ${malId}`]);
  status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.publicIntents, 1, "a malformed manifest is not a public intent");
  assert.equal(status.intents, 1);
  assert.ok(
    status.associationDiagnostics.malformedManifests.some((m) => m.id === malId),
    "the malformed manifest must be listed as a diagnostic",
  );

  // 4. replaying the SAME id must not create a second intent.
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 63;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `replay of ${id}\n\nDrift-Intent: ${id}`]);
  status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.intents, 1, "a replayed id must not create a second intent");
  assert.deepEqual(status.associationDiagnostics.replayed, [id]);

  // 5. a raw commit trailer without a DB row is a diagnostic, not a local
  //    record: localIntents counts ONLY private-store rows (distinguishable
  //    from public intents) and never inflates from raw commits.
  const localId = validIntentId("local-only");
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 64;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `local-only legacy\n\nDrift-Intent: ${localId}`]);
  status = JSON.parse(run(repo, ["status", "--json"]).stdout);
  assert.equal(status.publicIntents, 1, "public intents unchanged");
  assert.equal(status.localIntents, 1, "localIntents = private-store rows only (the single realize)");
  assert.equal(status.intents, 1, "raw trailers never inflate the merged intent count");
  assert.ok(
    status.associationDiagnostics.trailerWithoutManifest.includes(localId),
    "the raw trailer-only id is a diagnostic",
  );
});

test("status human output separates committed public intents, local legacy records and provenance errors", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 65;\n");
  assert.equal(run(repo, ["realize", "-p", "human output", "--summary", "Human output"]).status, 0);
  const out = run(repo, ["status"]).stdout;
  assert.ok(out.includes("committed public intents: 1"), out);
  assert.ok(out.includes("local legacy records:"), out);
  assert.ok(out.includes("provenance errors:  0"), out);
});

// ---------------------------------------------------- blame ambiguity handling
test("blame never picks an arbitrary first intent: file filtering and explicit ambiguous state", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 71;\n");
  writeFileSync(join(repo, "src", "b.ts"), "export const b = 72;\n");
  const r = run(repo, ["realize", "-p", "two intents", "--summary", "Intent A", "src/a.ts"]);
  assert.equal(r.status, 0, r.stderr);
  const idA = JSON.parse(run(repo, ["realize", "-p", "two intents again", "--summary", "Intent B", "--json"]).stdout).intentId;

  // blame each file — each resolves to its own intent, never the first match
  const blameA = JSON.parse(run(repo, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blameA.association.state, "unique", JSON.stringify(blameA.association));
  const blameB = JSON.parse(run(repo, ["blame", "src/b.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blameB.association.state, "unique", JSON.stringify(blameB.association));
  assert.notEqual(blameA.intent.id, blameB.intent.id, "different files resolve to different intents");

  // two intents touching the SAME file (src/a.ts) → ambiguous, no arbitrary pick
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 73;\n");
  writeFileSync(join(repo, "src", "c.ts"), "export const c = 74;\n");
  const amb = run(repo, ["realize", "-p", "same file", "--summary", "Same file A", "--json"]);
  assert.equal(amb.status, 0, amb.stderr);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 75;\n");
  writeFileSync(join(repo, "src", "e.ts"), "export const e = 76;\n");
  const amb2 = run(repo, ["realize", "-p", "same file 2", "--summary", "Same file B", "--json"]);
  assert.equal(amb2.status, 0, amb2.stderr);
  // squash the two commits into ONE carrying two trailers (both touch src/a.ts)
  git(repo, ["reset", "--soft", "HEAD~2"]);
  const ids = [JSON.parse(amb.stdout).intentId, JSON.parse(amb2.stdout).intentId];
  git(repo, ["commit", "-qm", `two intents one commit\n\nDrift-Intent: ${ids[0]}\nDrift-Intent: ${ids[1]}`]);
  const blameAmb = JSON.parse(run(repo, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blameAmb.association.state, "ambiguous", JSON.stringify(blameAmb.association));
  assert.equal(blameAmb.intent, null, "no arbitrary first intent may be presented");
  assert.equal(blameAmb.association.candidates.length, 2, "both candidates are named");

  void idA;
});

test("blame: a malformed candidate manifest is never presented as an arbitrary reason", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const badId = validIntentId("bad-blame");
  writeManifest(repo, badId, "", {}); // empty summary → malformed
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 77;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", `bad manifest\n\nDrift-Intent: ${badId}`]);
  const blame = JSON.parse(run(repo, ["blame", "src/a.ts", "--line", "1", "--json"]).stdout);
  assert.equal(blame.association.state, "missing", "a malformed candidate has no valid match");
  assert.equal(blame.intent, null, "never present a malformed manifest as the reason");
  assert.equal(blame.baseline, true);
});

// ---------------------------------------------------- private-object reference safety
test("failed realize removes its own object but NEVER a pre-existing object (reference-safe)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // a pre-existing decoy object (simulates content already in the store)
  const decoyDir = join(repo, ".drift", "objects", "zz");
  mkdirSync(decoyDir, { recursive: true });
  const decoy = join(decoyDir, `${"c".repeat(38)}.json`);
  writeFileSync(decoy, JSON.stringify({ id: validIntentId("decoy"), prompt: "DECOY PROMPT" }));

  writeFileSync(join(repo, "src", "a.ts"), "export const a = 81;\n");
  const hooks = join(repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  const r = run(repo, ["realize", "-p", "reference safe", "--summary", "Ref safe"]);
  assert.notEqual(r.status, 0);

  const remaining = objectsUnder(repo);
  assert.deepEqual(
    remaining,
    [decoy],
    `only the pre-existing object may survive; got: ${remaining.join(", ")}`,
  );
  // no leftover tmp files from the failed run
  const walkAll = (d) => {
    const out = [];
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) out.push(...walkAll(full));
      else out.push(name);
    }
    return out;
  };
  const files = walkAll(join(repo, ".drift", "objects"));
  assert.ok(files.every((f) => !f.includes(".tmp-")), `no tmp residue: ${files.join(", ")}`);
});

test("repeated failed realizations do not accumulate private objects", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const hooks = join(repo, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const hook = join(hooks, "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "src", "a.ts"), `export const a = ${90 + i};\n`);
    const r = run(repo, ["realize", "-p", `fail ${i}`, "--summary", `Fail ${i}`]);
    assert.notEqual(r.status, 0, `run ${i} must fail`);
    assert.deepEqual(objectsUnder(repo), [], `run ${i} must leave no objects`);
  }
});
