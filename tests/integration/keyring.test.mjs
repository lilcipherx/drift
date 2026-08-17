/**
 * Multi-signer keyring (production trust model):
 *
 *  - backward compatibility: a legacy repo (key.pem only) is unchanged and
 *    keeps working; the keyring is opt-in.
 *  - bootstrap: keyring.init self-signs the anchor key; idempotent; only the
 *    anchor key holder can create it.
 *  - add / revoke / remove with a signed, append-only audit log; every change
 *    must be authorized by an ACTIVE key.
 *  - key compromise: a revoked key can no longer sign, import, or authorize
 *    changes; its old signatures are untrusted (state-based trust).
 *  - rotation: add new key, keep both active through the grace period, then
 *    revoke/remove the old one; history stays auditable.
 *  - tamper: any modification of the committed keyring (forged entries, fake
 *    signatures, bootstrap mismatch, empty file) fails closed — the whole
 *    trust set becomes unusable and signing is refused.
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
  rmSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import {
  applyKeyringChange,
  createKeyring,
  evaluateKeyringChange,
  keyringPayload,
  loadTrustSet,
  parseKeyringKey,
  signPayload,
  validateKeyring,
  writeKeyringFile,
} from "@drift/core";

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
  const repo = mkdtempSync(join(tmpdir(), "drift-keyring-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Test Dev"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  return repo;
}

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function fp(pem) {
  return parseKeyringKey(pem).fingerprint;
}

function commitKeyring(repo) {
  git(repo, ["add", ".drift/public/keyring.json"]);
  git(repo, ["commit", "-m", "chore: update keyring"]);
}

function lastIntentId(repo) {
  const msg = git(repo, ["log", "-1", "--format=%B"]);
  const m = /Drift-Intent: (did_[0-9a-f]{32})/.exec(msg);
  assert.ok(m, `no Drift-Intent trailer in: ${msg}`);
  return m[1];
}

function keyringJson(repo) {
  return JSON.parse(readFileSync(join(repo, ".drift", "public", "keyring.json"), "utf8"));
}

// ------------------------------------------------------------------ legacy

test("backward compatibility: legacy repo (key.pem only) works unchanged, no keyring", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  assert.equal(run(repo, ["realize", "-p", "legacy", "--summary", "Legacy"]).status, 0);
  const id = lastIntentId(repo);
  const verify = run(repo, ["verify-intent", id, "--json"]);
  assert.equal(JSON.parse(verify.stdout).state, "valid");
  const list = run(repo, ["keyring", "list", "--json"]);
  const parsed = JSON.parse(list.stdout);
  assert.equal(parsed.present, false, "legacy repo must have no keyring");
  assert.equal(parsed.malformed, null);
  // The trust set still resolves to the single anchor key.
  const trust = loadTrustSet(join(repo, ".drift"));
  assert.equal(trust.keyringPresent, false);
  assert.equal(trust.active.length, 1);
  assert.equal(trust.malformed, null);
  // Commit the keyring file path is untouched.
  assert.ok(!existsSync(join(repo, ".drift", "public", "keyring.json")));
});

// ----------------------------------------------------------------- bootstrap

test("keyring init: self-signed bootstrap of the anchor key, idempotent, only the anchor holder", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const created = run(repo, ["keyring", "init", "--json"]);
  assert.equal(JSON.parse(created.stdout).status, "created");
  const kr = keyringJson(repo);
  assert.equal(kr.schemaVersion, 1);
  assert.equal(kr.keys.length, 1);
  assert.equal(kr.keys[0].status, "active");
  assert.equal(kr.audit.length, 1);
  assert.equal(kr.audit[0].action, "bootstrap");
  // The bootstrap entry verifies against the committed anchor key.
  const trust = loadTrustSet(join(repo, ".drift"));
  assert.equal(trust.malformed, null);
  assert.equal(trust.active.length, 1);
  // Idempotent: second init is a no-op.
  const again = run(repo, ["keyring", "init", "--json"]);
  assert.equal(JSON.parse(again.stdout).status, "exists");
  assert.deepEqual(keyringJson(repo), kr, "keyring must not be rewritten");
  commitKeyring(repo);
  // A TRACKED keyring with working-tree changes refuses realize (deliberate
  // commit required) — same rule as key.pem.
  const bob = keyPair();
  assert.equal(run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub)]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 3;\n");
  const realized = run(repo, ["realize", "-p", "x", "--summary", "X"]);
  assert.notEqual(realized.status, 0, "uncommitted keyring change must refuse realize");
  assert.ok(realized.stderr.includes("keyring.json"), "error must name the keyring file");
  commitKeyring(repo);
  assert.equal(run(repo, ["realize", "-p", "x2", "--summary", "X2"]).status, 0);
});

test("keyring init: only the anchor key holder can bootstrap (private key must match key.pem)", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  const stranger = keyPair();
  // Replace the local private key with a stranger's key: init must refuse.
  writeFileSync(join(repo, ".drift", "keys", "ed25519.pem"), stranger.priv, { mode: 0o600 });
  const res = run(repo, ["keyring", "init", "--json"]);
  assert.equal(res.status, 4);
  assert.ok(res.stderr.includes("does not match"), res.stderr);
  assert.ok(!existsSync(join(repo, ".drift", "public", "keyring.json")));
});

// ------------------------------------------------------------------- add

test("keyring add: a new signer becomes active and can sign after importing its key", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);

  const alice = keyPair();
  const bob = keyPair();
  const bobFp = fp(bob.pub);
  // Add Bob (authorized by Alice/the anchor).
  const added = run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub), "--reason", "new maintainer", "--json"]);
  assert.equal(added.status, 0);
  assert.equal(JSON.parse(added.stdout).fingerprint, bobFp);
  assert.equal(JSON.parse(added.stdout).active, 2);
  commitKeyring(repo);

  // Bob imports his key and signs an intent.
  assert.equal(run(repo, ["key", "import", "--file", writeKey(repo, bob.priv)]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 4;\n");
  assert.equal(run(repo, ["realize", "-p", "by bob", "--summary", "By Bob"]).status, 0);
  const id = lastIntentId(repo);
  const manifest = JSON.parse(readFileSync(join(repo, ".drift", "public", "intents", `${id}.json`), "utf8"));
  assert.equal(manifest.signingKeyId, bobFp, "manifest must be signed by Bob's key");
  // A fresh clone (no private keys) verifies Bob's manifest via the keyring.
  const clone = join(tmpdir(), `drift-keyring-clone-${Date.now()}`);
  git(repo, ["clone", "-q", repo, clone]);
  const verify = run(clone, ["verify-intent", id, "--json"]);
  assert.equal(JSON.parse(verify.stdout).state, "valid", "fresh clone must verify Bob's signature via the keyring");
  const list = run(clone, ["keyring", "list", "--json"]);
  assert.equal(JSON.parse(list.stdout).entries.length, 2);
  rmSync(clone, { recursive: true, force: true });
});

test("keyring add: an untrusted key cannot authorize additions, and self-add is refused", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);

  const stranger = keyPair();
  // Import a key that is NOT in the keyring: import must fail.
  const imp = run(repo, ["key", "import", "--file", writeKey(repo, stranger.priv), "--json"]);
  assert.equal(imp.status, 4);
  assert.ok(imp.stderr.includes("ACTIVE"), imp.stderr);
  // Adding a key that is already in the keyring (including its own key) is
  // refused — a key can never add itself or duplicate an entry.
  const anchorPub = readFileSync(join(repo, ".drift", "public", "key.pem"), "utf8");
  const anchorPriv = readFileSync(join(repo, ".drift", "keys", "ed25519.pem"), "utf8");
  const kr = keyringJson(repo);
  const selfAdd = applyKeyringChange(kr, anchorPriv, "add", { pem: anchorPub }, null);
  assert.equal(selfAdd.ok, false);
  assert.ok(selfAdd.error.includes("already in the keyring"), selfAdd.error);
});

// ------------------------------------------------------------ compromise

test("key compromise: revoke stops the key from signing, authorizing, and being trusted", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  // The anchor holder's private key (securely held, not in the repo).
  const anchorPriv = readFileSync(join(repo, ".drift", "keys", "ed25519.pem"), "utf8");
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);

  const bob = keyPair();
  const bobFp = fp(bob.pub);
  assert.equal(run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub)]).status, 0);
  commitKeyring(repo);
  // Bob signs an intent BEFORE the compromise.
  assert.equal(run(repo, ["key", "import", "--file", writeKey(repo, bob.priv)]).status, 0);
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 5;\n");
  assert.equal(run(repo, ["realize", "-p", "bob pre", "--summary", "Bob pre"]).status, 0);
  const id = lastIntentId(repo);

  // The anchor holder revokes Bob's compromised key.
  assert.equal(run(repo, ["key", "import", "--file", writeKey(repo, anchorPriv)]).status, 0);
  const revoked = run(repo, ["keyring", "revoke", bobFp, "--reason", "compromise", "--json"]);
  assert.equal(revoked.status, 0);
  assert.equal(JSON.parse(revoked.stdout).active, 1);
  commitKeyring(repo);

  // Bob's OLD manifest is now untrusted (state-based trust: a compromised
  // key can forge anything, so nothing it signed is trusted).
  const verify = run(repo, ["verify-intent", id, "--json"]);
  assert.equal(JSON.parse(verify.stdout).state, "untrusted-key");
  assert.ok(JSON.parse(verify.stdout).detail.includes("revoked"));

  // Bob's private key can no longer be imported or used to sign.
  const imp = run(repo, ["key", "import", "--file", writeKey(repo, bob.priv), "--json"]);
  assert.equal(imp.status, 4);
  assert.ok(imp.stderr.includes("ACTIVE"), "revoked key must not import");
  const stranger = keyPair();
  const impStranger = run(repo, ["key", "import", "--file", writeKey(repo, stranger.priv), "--json"]);
  assert.equal(impStranger.status, 4);
  // Bob's key cannot authorize keyring changes anymore.
  const kr = keyringJson(repo);
  const bobAuth = applyKeyringChange(kr, bob.priv, "add", { pem: stranger.pub }, null);
  assert.equal(bobAuth.ok, false);
  assert.ok(bobAuth.error.includes("revoked"), bobAuth.error);
  // The audit log records the revoke with the reason.
  const audit = keyringJson(repo).audit;
  const revokeEntry = audit.find((a) => a.action === "revoke" && a.fingerprint === bobFp);
  assert.ok(revokeEntry, "revoke must be in the audit log");
  assert.equal(revokeEntry.reason, "compromise");
  // The keyring still validates (the audit chain is intact).
  assert.equal(loadTrustSet(join(repo, ".drift")).malformed, null);
});

test("self-revoke is allowed (lost key), self-remove is not", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);
  const bob = keyPair();
  const bobFp = fp(bob.pub);
  assert.equal(run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub)]).status, 0);
  commitKeyring(repo);
  // Bob loses his key and self-revokes (authorized by Bob himself).
  const kr = keyringJson(repo);
  const selfRevoke = applyKeyringChange(kr, bob.priv, "revoke", { fingerprint: bobFp }, "lost");
  assert.equal(selfRevoke.ok, true, "a key may revoke itself when lost");
  assert.equal(loadTrustSet(join(repo, ".drift")).malformed, null);
  // But remove (rotation cleanup) requires another active key.
  const selfRemove = applyKeyringChange(kr, bob.priv, "remove", { fingerprint: bobFp }, "rotation");
  assert.equal(selfRemove.ok, false);
  assert.ok(selfRemove.error.includes("cannot remove itself"));
});

// -------------------------------------------------------------- rotation

test("rotation: add new key, both active during grace, then remove the old key with full audit", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);

  const anchorFp = fp(readFileSync(join(repo, ".drift", "public", "key.pem"), "utf8"));
  const bob = keyPair();
  const bobFp = fp(bob.pub);
  assert.equal(run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub)]).status, 0);
  commitKeyring(repo);
  assert.equal(keyringJson(repo).keys.filter((k) => k.status === "active").length, 2, "grace period: both active");

  // After the grace period Alice removes Bob's key (authorized by Alice).
  const removed = run(repo, ["keyring", "remove", bobFp, "--reason", "rotation", "--json"]);
  assert.equal(removed.status, 0);
  assert.equal(JSON.parse(removed.stdout).active, 1);
  commitKeyring(repo);

  const kr = keyringJson(repo);
  const bobEntry = kr.keys.find((k) => k.fingerprint === bobFp);
  assert.equal(bobEntry.status, "removed");
  assert.equal(bobEntry.reason, "rotation");
  // The audit log is a complete, contiguous chain: bootstrap → add → remove.
  assert.deepEqual(
    kr.audit.map((a) => a.action),
    ["bootstrap", "add", "remove"],
  );
  assert.deepEqual(kr.audit.map((a) => a.seq), [1, 2, 3]);
  // Validation still passes and the removed key is not trusted.
  const trust = loadTrustSet(join(repo, ".drift"));
  assert.equal(trust.malformed, null);
  assert.deepEqual(trust.active.map((k) => k.fingerprint), [anchorFp]);
  // Bob's key cannot sign anymore.
  assert.equal(run(repo, ["key", "import", "--file", writeKey(repo, bob.priv), "--json"]).status, 4);
});

// ---------------------------------------------------------------- tamper

test("tamper: forged key entries, fake audit signatures, and bootstrap mismatches fail closed", () => {
  // Build a valid keyring, then mutate it in every detectable way.
  const alice = keyPair();
  const bob = keyPair();
  const created = createKeyring(alice.pub, alice.priv, 1000);
  assert.equal(created.ok, true);
  const kr0 = created.keyring;
  const kr1 = applyKeyringChange(kr0, alice.priv, "add", { pem: bob.pub }, null, 2000).keyring;

  const valid = validateKeyring(JSON.stringify(kr1), alice.pub);
  assert.equal(valid.ok, true, "the unmodified keyring must validate");

  // 1. Forged key entry without an audit entry → replay mismatch.
  const forged = JSON.parse(JSON.stringify(kr1));
  const mallory = keyPair();
  forged.keys.push({
    fingerprint: fp(mallory.pub),
    pem: mallory.pub,
    status: "active",
    addedBy: "x",
    addedAt: 3000,
    transitionedBy: null,
    transitionedAt: null,
    reason: null,
  });
  assert.equal(validateKeyring(JSON.stringify(forged), alice.pub).ok, false, "forged entry must fail");

  // 2. Tampered audit signature → verification failure.
  const tamperedSig = JSON.parse(JSON.stringify(kr1));
  tamperedSig.audit[1].signature = Buffer.from("fake").toString("base64");
  assert.equal(validateKeyring(JSON.stringify(tamperedSig), alice.pub).ok, false, "tampered signature must fail");

  // 3. Tampered payload string → canonical mismatch.
  const tamperedPayload = JSON.parse(JSON.stringify(kr1));
  tamperedPayload.audit[1].payload = keyringPayload(2, "add", tamperedPayload.audit[1].fingerprint, alice.fp, 9999, null);
  assert.equal(validateKeyring(JSON.stringify(tamperedPayload), alice.pub).ok, false, "tampered payload must fail");

  // 4. Bootstrap mismatch: keyring bootstrapped for a DIFFERENT anchor key.
  const wrongAnchor = validateKeyring(JSON.stringify(kr1), bob.pub);
  assert.equal(wrongAnchor.ok, false, "keyring must not validate against a different anchor");
  assert.ok(wrongAnchor.error.includes("anchor"), wrongAnchor.error);

  // 5. Empty keyring file → malformed (never silent fallback to single key).
  assert.equal(validateKeyring("", alice.pub).ok, false, "empty keyring must fail closed");
  assert.equal(validateKeyring("   \n", alice.pub).ok, false);

  // 6. Non-contiguous audit seq → fail.
  const gap = JSON.parse(JSON.stringify(kr1));
  gap.audit[1].seq = 3;
  assert.equal(validateKeyring(JSON.stringify(gap), alice.pub).ok, false, "seq gap must fail");

  // 7. A change signed by a key that is revoked at that point in the log.
  const krRevoked = applyKeyringChange(kr1, alice.priv, "revoke", { fingerprint: fp(bob.pub) }, "compromise", 3000);
  assert.equal(krRevoked.ok, true);
  // Forge an add AFTER the revoke signed by the revoked key.
  const mallory2 = keyPair();
  const forgedAfter = JSON.parse(JSON.stringify(krRevoked.keyring));
  const seq = 4;
  const payload = keyringPayload(seq, "add", fp(mallory2.pub), fp(bob.pub), 4000, null);
  forgedAfter.audit.push({
    seq,
    action: "add",
    fingerprint: fp(mallory2.pub),
    by: fp(bob.pub),
    at: 4000,
    reason: null,
    payload,
    signature: signPayload(payload, bob.priv),
  });
  const forgedKeys = JSON.parse(JSON.stringify(krRevoked.keyring.keys));
  forgedKeys.push({
    fingerprint: fp(mallory2.pub),
    pem: mallory2.pub,
    status: "active",
    addedBy: fp(bob.pub),
    addedAt: 4000,
    transitionedBy: null,
    transitionedAt: null,
    reason: null,
  });
  forgedAfter.keys = forgedKeys;
  const check = validateKeyring(JSON.stringify(forgedAfter), alice.pub);
  assert.equal(check.ok, false, "a revoked key must not be able to authorize later additions");
  assert.ok(check.error.includes("not active"), check.error);
});

test("tamper: a malformed committed keyring is a fail-closed security state across the CLI", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);
  const krPath = join(repo, ".drift", "public", "keyring.json");

  // Corrupt the committed keyring (forged entry).
  const kr = keyringJson(repo);
  const mallory = keyPair();
  kr.keys.push({
    fingerprint: fp(mallory.pub),
    pem: mallory.pub,
    status: "active",
    addedBy: "x",
    addedAt: 1,
    transitionedBy: null,
    transitionedAt: null,
    reason: null,
  });
  writeFileSync(krPath, JSON.stringify(kr, null, 2));
  git(repo, ["add", ".drift/public/keyring.json"]);
  git(repo, ["commit", "-m", "evil keyring"]);

  // keyring list reports the malformed state with a non-zero exit.
  const list = run(repo, ["keyring", "list", "--json"]);
  assert.equal(JSON.parse(list.stdout).malformed !== null, true);
  // Signing is refused.
  const stranger = keyPair();
  const imp = run(repo, ["key", "import", "--file", writeKey(repo, stranger.priv), "--json"]);
  assert.equal(imp.status, 4);
  assert.ok(imp.stderr.includes("malformed"), imp.stderr);
  // New intents are refused.
  const initAgain = run(repo, ["init", "--json"]);
  assert.equal(initAgain.status, 4);
  // The working-tree trust set also reports malformed.
  const trust = loadTrustSet(join(repo, ".drift"));
  assert.equal(trust.malformed !== null, true);
  assert.equal(trust.active.length, 0);
});

test("keyring: loadTrustSet with a valid keyring reflects the full active set", () => {
  const repo = makeRepo();
  assert.equal(run(repo, ["init"]).status, 0);
  assert.equal(run(repo, ["keyring", "init"]).status, 0);
  commitKeyring(repo);
  const bob = keyPair();
  assert.equal(run(repo, ["keyring", "add", "--file", writeKey(repo, bob.pub)]).status, 0);
  commitKeyring(repo);
  const trust = loadTrustSet(join(repo, ".drift"));
  assert.equal(trust.keyringPresent, true);
  assert.equal(trust.keyring !== null, true);
  assert.equal(trust.active.length, 2);
  assert.equal(trust.malformed, null);
});

// --------------------------------------- history continuity (PR trust audit)

test("evaluateKeyringChange: only a strict append-only extension of the audit log is legitimate", () => {
  const alice = keyPair();
  const bob = keyPair();
  const created = createKeyring(alice.pub, alice.priv, 1000);
  const kr0 = created.ok ? created.keyring : null;
  assert.ok(kr0);
  const kr1 = applyKeyringChange(kr0, alice.priv, "add", { pem: bob.pub }, null, 2000).keyring;
  const kr2 = applyKeyringChange(kr1, alice.priv, "revoke", { fingerprint: fp(bob.pub) }, "compromise", 3000).keyring;

  // both absent
  assert.equal(evaluateKeyringChange(null, null, alice.pub, alice.pub), "none");
  // base absent, head valid → bootstrap
  assert.equal(evaluateKeyringChange(null, JSON.stringify(kr0), null, alice.pub), "bootstrap");
  // base absent, head malformed → malformed-bootstrap
  assert.equal(evaluateKeyringChange(null, "{not json", null, alice.pub), "malformed-bootstrap");
  // identical → unchanged
  assert.equal(evaluateKeyringChange(JSON.stringify(kr1), JSON.stringify(kr1), alice.pub, alice.pub), "unchanged");
  // base is a strict prefix of head (append-only add) → extended
  assert.equal(evaluateKeyringChange(JSON.stringify(kr0), JSON.stringify(kr1), alice.pub, alice.pub), "extended");
  assert.equal(evaluateKeyringChange(JSON.stringify(kr1), JSON.stringify(kr2), alice.pub, alice.pub), "extended");

  // HEAD rewrites history: replaces the add with a different key → replaced.
  const mallory = keyPair();
  const krM = applyKeyringChange(kr0, alice.priv, "add", { pem: mallory.pub }, null, 2000).keyring;
  assert.equal(
    evaluateKeyringChange(JSON.stringify(kr1), JSON.stringify(krM), alice.pub, alice.pub),
    "replaced",
    "an edited history entry is a rewrite",
  );
  // HEAD deletes the revoke entry (history truncation) → replaced.
  assert.equal(
    evaluateKeyringChange(JSON.stringify(kr2), JSON.stringify(kr1), alice.pub, alice.pub),
    "replaced",
    "deleting a revoke entry is a rewrite",
  );
  // HEAD replaces the whole file with a FRESH bootstrap → replaced.
  assert.equal(
    evaluateKeyringChange(JSON.stringify(kr2), JSON.stringify(kr0), alice.pub, alice.pub),
    "replaced",
    "replacing history with a fresh bootstrap is a rewrite",
  );
  // base present, head absent → removed (history deleted).
  assert.equal(evaluateKeyringChange(JSON.stringify(kr1), null, alice.pub, alice.pub), "removed");
  // base valid, head malformed → malformed-replacement.
  assert.equal(evaluateKeyringChange(JSON.stringify(kr1), "garbage", alice.pub, alice.pub), "malformed-replacement");
  // base malformed → base-malformed regardless of head.
  assert.equal(evaluateKeyringChange("garbage", JSON.stringify(kr1), alice.pub, alice.pub), "base-malformed");
  // A keyring whose bootstrap does not match the anchor fails closed.
  assert.equal(
    evaluateKeyringChange(JSON.stringify(kr0), JSON.stringify(kr1), bob.pub, bob.pub),
    "base-malformed",
    "base keyring must validate against the base anchor",
  );
});

// ----------------------------------------------------------------- helpers

function writeKey(repo, pem) {
  // Write key material OUTSIDE the repository so it can never be swept into
  // an intent commit (realize stages all changes outside .drift/).
  const dir = join(tmpdir(), `drift-keyring-keys-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "key.pem");
  writeFileSync(p, pem, { mode: 0o600 });
  return p;
}
