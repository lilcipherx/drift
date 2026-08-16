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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function run(repo, args) {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
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

  // worktree clean (nothing left untracked by the atomic flow)
  assert.equal(git(repo, ["status", "--porcelain"]), "", "worktree clean after realize");

  // trailer-derived association: log + export resolve the commit SHA from the
  // trailer, not from any manifest field
  const log = JSON.parse(run(repo, ["log", "--json"]).stdout);
  assert.equal(log.intents[0].id, out.intentId);
  assert.equal(log.intents[0].gitSha, out.gitSha, "commit association derived from the trailer");
  const exp = JSON.parse(run(repo, ["export"]).stdout);
  assert.equal(exp.intents[0].gitSha, out.gitSha, "export resolves the commit from the trailer");
});

test("realize failure cleanup: source changes stay staged, generated manifest is removed (Part 12)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // Force `git commit` to fail deterministically (no identity configured).
  git(repo, ["config", "--unset-all", "user.name"]);
  git(repo, ["config", "--unset-all", "user.email"]);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 99;\n");
  const res = run(repo, ["realize", "-p", "do the thing", "--summary", "Do the thing"]);
  assert.notEqual(res.status, 0, "commit must fail without identity");
  assert.ok(res.stderr.includes("no history was created"), res.stderr);

  // the generated manifest must not survive as if committed
  const onDisk = readdirSync(join(repo, ".drift", "public", "intents")).filter((f) => f.endsWith(".json"));
  assert.equal(onDisk.length, 0, "failed realize must not leave a manifest behind");
  const tracked = git(repo, ["ls-files", "--", ".drift"]).split("\n").filter(Boolean);
  for (const f of tracked) {
    assert.ok(!f.startsWith(".drift/public/intents"), `no manifest tracked after failure: ${f}`);
  }
  // the user's source change is still staged for a safe retry
  const staged = git(repo, ["diff", "--cached", "--name-only"]).split("\n").filter(Boolean);
  assert.ok(staged.includes("src/a.ts"), "user source changes must remain staged");
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
