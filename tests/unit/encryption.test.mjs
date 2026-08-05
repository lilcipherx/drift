import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENCRYPTION_MARKER,
  decryptAesGcm,
  deriveMasterKey,
  encryptAesGcm,
  isEncrypted,
} from "@drift/core";

const KEY = deriveMasterKey("a".repeat(64)); // 64-hex → raw 32 bytes

test("roundtrip: encrypt → decrypt returns original", () => {
  const plain = JSON.stringify({ step: 3, files: ["src/auth.ts"], token: "sk-abc" });
  const enc = encryptAesGcm(plain, KEY);
  assert.ok(enc.startsWith(ENCRYPTION_MARKER));
  assert.ok(!enc.includes("sk-abc"));
  assert.equal(decryptAesGcm(enc, KEY), plain);
});

test("roundtrip: unicode and empty strings", () => {
  assert.equal(decryptAesGcm(encryptAesGcm("Fix race 🚀 «почему»", KEY), KEY), "Fix race 🚀 «почему»");
  assert.equal(decryptAesGcm(encryptAesGcm("", KEY), KEY), "");
});

test("same plaintext encrypts differently each time (random IV)", () => {
  const a = encryptAesGcm("same", KEY);
  const b = encryptAesGcm("same", KEY);
  assert.notEqual(a, b);
  assert.equal(decryptAesGcm(a, KEY), "same");
  assert.equal(decryptAesGcm(b, KEY), "same");
});

test("tampered ciphertext fails authentication", () => {
  const enc = encryptAesGcm("secret payload", KEY);
  const raw = Buffer.from(enc.slice(ENCRYPTION_MARKER.length), "base64");
  raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff; // flip a bit in the auth tag
  const tampered = ENCRYPTION_MARKER + raw.toString("base64");
  assert.throws(() => decryptAesGcm(tampered, KEY));
});

test("wrong key fails to decrypt", () => {
  const enc = encryptAesGcm("classified", KEY);
  const other = deriveMasterKey("b".repeat(64));
  assert.throws(() => decryptAesGcm(enc, other));
});

test("malformed / non-encrypted payloads throw", () => {
  assert.throws(() => decryptAesGcm("plain text", KEY));
  assert.throws(() => decryptAesGcm(ENCRYPTION_MARKER + "c2hvcnQ=", KEY)); // too short
});

test("isEncrypted marker detection", () => {
  assert.equal(isEncrypted(encryptAesGcm("x", KEY)), true);
  assert.equal(isEncrypted("plain legacy prompt"), false);
});

test("AAD: roundtrip with intent-id binding, wrong AAD fails", () => {
  const aad = "did_0123456789abcdef";
  const enc = encryptAesGcm("bound payload", KEY, aad);
  assert.equal(decryptAesGcm(enc, KEY, aad), "bound payload");
  // wrong AAD (ciphertext moved to another intent) fails authentication
  assert.throws(() => decryptAesGcm(enc, KEY, "did_other99999999999"));
  // decrypting with no AAD also fails
  assert.throws(() => decryptAesGcm(enc, KEY));
});

test("deriveMasterKey: 64-hex used verbatim, passphrase hashed", () => {
  const hexKey = deriveMasterKey("ab".repeat(32));
  assert.equal(hexKey.length, 32);
  assert.equal(hexKey.toString("hex"), "ab".repeat(32));
  const phrase = deriveMasterKey("correct horse battery staple");
  assert.equal(phrase.length, 32);
  assert.equal(deriveMasterKey("correct horse battery staple").toString("hex"), phrase.toString("hex"));
  assert.notEqual(deriveMasterKey("correct horse battery staple").toString("hex"), hexKey.toString("hex"));
});
