import { test } from "node:test";
import assert from "node:assert/strict";
import { redact, compilePatterns, DEFAULT_PATTERN_SOURCES } from "@drift/core";

test("redacts OpenAI-style keys", () => {
  const r = redact("use key sk-abc123DEF456ghi789JKL0123456789 here");
  assert.equal(r.count, 1);
  assert.ok(!r.text.includes("sk-abc123"));
  assert.ok(r.text.includes("[REDACTED]"));
});

test("redacts AWS keys and PEM blocks", () => {
  const r = redact(
    "AKIAIOSFODNN7EXAMPLE and -----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
  );
  assert.ok(r.count >= 2);
  assert.ok(!r.text.includes("AKIAIOSFODNN7EXAMPLE"));
});

test("redacts JWTs and GitHub tokens", () => {
  const r = redact(
    "token ghp_abcdefghijklmnopqrstuvwxyz1234567890ABCD and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  );
  assert.ok(r.count >= 2);
  assert.ok(!r.text.includes("ghp_"));
  assert.ok(!r.text.includes("eyJhbGci"));
});

test("leaves safe text untouched", () => {
  const r = redact("Fix race condition in token refresh for auth flow");
  assert.equal(r.count, 0);
  assert.equal(r.text, "Fix race condition in token refresh for auth flow");
});

test("custom patterns via compilePatterns", () => {
  const patterns = compilePatterns(["CUSTOM_[A-Z0-9]{6}"]);
  const r = redact("CUSTOM_AB12CD remains", patterns);
  assert.equal(r.count, 1);
  assert.ok(r.text.includes("[REDACTED]"));
});

test("invalid custom pattern is skipped, not fatal", () => {
  const patterns = compilePatterns(["([unclosed"]);
  assert.equal(patterns.length, 0);
  const r = redact("plain text", patterns);
  assert.equal(r.count, 0);
});

test("default patterns compile", () => {
  const patterns = compilePatterns(DEFAULT_PATTERN_SOURCES);
  assert.ok(patterns.length === DEFAULT_PATTERN_SOURCES.length);
});
