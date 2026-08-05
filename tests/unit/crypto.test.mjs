import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  generateKeyPair,
  newIntentId,
  sha256Hex,
  signPayload,
  verifyPayload,
} from "@drift/core";

test("sign/verify roundtrip", () => {
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  const payload = canonicalJson({ a: 1, b: "two", nested: { z: true, y: [1, 2] } });
  const sig = signPayload(payload, privateKeyPem);
  assert.ok(verifyPayload(payload, publicKeyPem, sig));
});

test("tampered payload fails verification", () => {
  const { privateKeyPem, publicKeyPem } = generateKeyPair();
  const payload = canonicalJson({ prompt: "add jwt" });
  const sig = signPayload(payload, privateKeyPem);
  assert.ok(!verifyPayload(canonicalJson({ prompt: "add jwt " }), publicKeyPem, sig));
});

test("canonicalJson is key-order stable", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: { y: 1, x: 2 } }), '{"a":{"x":2,"y":1}}');
});

test("sha256Hex is deterministic", () => {
  assert.equal(sha256Hex("hello"), sha256Hex("hello"));
  assert.equal(sha256Hex("hello").length, 64);
  assert.notEqual(sha256Hex("hello"), sha256Hex("hell"));
});

test("newIntentId format", () => {
  const id = newIntentId();
  assert.match(id, /^did_[0-9a-f]{32}$/);
  assert.notEqual(id, newIntentId());
});
