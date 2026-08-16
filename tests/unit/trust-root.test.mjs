/**
 * Strict trust-root parsing (PR #7 final-completeness correction 3): a Drift
 * trust root must be an Ed25519 PUBLIC key. RSA / EC / DSA / private-key PEM /
 * certificates / malformed text / oversized input are all `malformed` with a
 * stable error code and can never produce bootstrap / unchanged / valid /
 * trusted / signing-allowed. LF / CRLF / harmless surrounding whitespace of
 * the SAME Ed25519 key must produce the same fingerprint (unchanged).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  evaluateTrustRootChange,
  parseTrustRoot,
  tryParseTrustRoot,
  signingKeyIdForValidKey,
  TRUST_ROOT_MAX_BYTES,
} from "@drift/core";

const { publicKey: ed25519Key, privateKey: ed25519Priv } = generateKeyPairSync("ed25519");
const ED_PUB = ed25519Key.export({ type: "spki", format: "pem" }).toString();
const ED_PRIV = ed25519Priv.export({ type: "pkcs8", format: "pem" }).toString();

const { publicKey: rsaKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RSA_PUB = rsaKey.export({ type: "spki", format: "pem" }).toString();

const { publicKey: ecKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const EC_PUB = ecKey.export({ type: "spki", format: "pem" }).toString();

test("trust root: valid Ed25519 public key (LF / CRLF / whitespace) is valid with identical fingerprint", () => {
  const lf = parseTrustRoot(ED_PUB);
  const crlf = parseTrustRoot(ED_PUB.replace(/\n/g, "\r\n"));
  const padded = parseTrustRoot(`\n  \n${ED_PUB}\n\n  `);
  for (const parsed of [lf, crlf, padded]) {
    assert.equal(parsed.state, "valid", "Ed25519 SPKI PEM must parse as valid");
  }
  const fingerprints = [lf, crlf, padded].map((p) => p.state === "valid" && p.fingerprint);
  assert.equal(fingerprints[0], fingerprints[1], "CRLF must not change the identity");
  assert.equal(fingerprints[0], fingerprints[2], "surrounding whitespace must not change the identity");
});

test("trust root: fingerprint is the canonical SPKI-DER hash, never a textual hash", () => {
  const parsed = parseTrustRoot(ED_PUB);
  assert.equal(parsed.state, "valid");
  // signingKeyIdForValidKey accepts the validated KeyObject — same identity.
  assert.equal(
    parsed.state === "valid" ? parsed.fingerprint : "",
    signingKeyIdForValidKey(parsed.publicKey),
  );
  // The textual PEM hash must NOT be the identity (it changes with CRLF).
  const textHash = (pem) =>
    createHash("sha256").update(pem, "utf8").digest("hex").slice(0, 16);
  assert.notEqual(
    parsed.state === "valid" ? parsed.fingerprint : "",
    textHash(ED_PUB.replace(/\n/g, "\r\n")),
  );
});

test("trust root: RSA and EC public keys are unsupported-key-type, never valid", () => {
  const rsa = tryParseTrustRoot(RSA_PUB);
  assert.equal(rsa.state, "malformed");
  assert.equal(rsa.state === "malformed" && rsa.errorCode, "unsupported-key-type");
  const ec = tryParseTrustRoot(EC_PUB);
  assert.equal(ec.state, "malformed");
  assert.equal(ec.state === "malformed" && ec.errorCode, "unsupported-key-type");
  assert.equal(isUsable(rsa), false);
  assert.equal(isUsable(ec), false);
});

test("trust root: an Ed25519 PRIVATE key PEM is not-public-key, never valid", () => {
  const priv = tryParseTrustRoot(ED_PRIV);
  assert.equal(priv.state, "malformed");
  assert.equal(priv.state === "malformed" && priv.errorCode, "not-public-key");
  // Node would happily derive a public key from the private PEM — the parser
  // must reject it BEFORE createPublicKey.
  assert.equal(isUsable(priv), false);
});

test("trust root: malformed text is parse-error, empty is absent", () => {
  const garbage = tryParseTrustRoot("this is not a pem at all");
  assert.equal(garbage.state, "malformed");
  assert.equal(garbage.state === "malformed" && garbage.errorCode, "not-public-key");
  const broken = tryParseTrustRoot("-----BEGIN PUBLIC KEY-----\nnotbase64\n-----END PUBLIC KEY-----");
  assert.equal(broken.state, "malformed");
  assert.equal(broken.state === "malformed" && broken.errorCode, "parse-error");
  assert.equal(tryParseTrustRoot(null).state, "absent");
  assert.equal(tryParseTrustRoot("").state, "absent");
  assert.equal(tryParseTrustRoot("   \n  ").state, "absent");
});

test("trust root: a certificate is not-public-key", () => {
  const cert = tryParseTrustRoot(
    "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----",
  );
  assert.equal(cert.state, "malformed");
  assert.equal(cert.state === "malformed" && cert.errorCode, "not-public-key");
});

test("trust root: oversized PEM is oversized", () => {
  const big = `-----BEGIN PUBLIC KEY-----\n${"A".repeat(TRUST_ROOT_MAX_BYTES)}\n-----END PUBLIC KEY-----`;
  const parsed = tryParseTrustRoot(big);
  assert.equal(parsed.state, "malformed");
  assert.equal(parsed.state === "malformed" && parsed.errorCode, "oversized");
});

test("trust root: full base/head state table", () => {
  const key = ED_PUB;
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
  const malformed = "-----BEGIN PUBLIC KEY-----\nbroken\n-----END PUBLIC KEY-----";
  assert.equal(evaluateTrustRootChange(null, null), "none");
  assert.equal(evaluateTrustRootChange("", ""), "none");
  assert.equal(evaluateTrustRootChange(null, key), "bootstrap");
  assert.equal(evaluateTrustRootChange("", key), "bootstrap");
  assert.equal(evaluateTrustRootChange(null, malformed), "malformed-bootstrap");
  assert.equal(evaluateTrustRootChange(key, key), "unchanged");
  assert.equal(evaluateTrustRootChange(key, key.replace(/\n/g, "\r\n")), "unchanged");
  assert.equal(evaluateTrustRootChange(key, other), "replaced");
  assert.equal(evaluateTrustRootChange(key, null), "removed");
  assert.equal(evaluateTrustRootChange(key, malformed), "malformed-replacement");
  assert.equal(evaluateTrustRootChange(malformed, key), "base-malformed");
  assert.equal(evaluateTrustRootChange(malformed, null), "base-malformed");
});

function isUsable(parsed) {
  return parsed.state === "valid";
}
