import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, loadConfig, redact, compilePatterns } from "@drift/core";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("parseToml basic sections and values", () => {
  const parsed = parseToml(`
[core]
version = 1
default_model = "claude-3-5-sonnet"

[ast]
parsers = ["typescript", "python"]
fallback_to_text_on_error = true

[telemetry]
enabled = false
`);
  assert.equal(parsed.core.version, 1);
  assert.equal(parsed.core.default_model, "claude-3-5-sonnet");
  assert.deepEqual(parsed.ast.parsers, ["typescript", "python"]);
  assert.equal(parsed.ast.fallback_to_text_on_error, true);
  assert.equal(parsed.telemetry.enabled, false);
});

test("loadConfig defaults when no file", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-config-"));
  const cfg = loadConfig(dir);
  assert.equal(cfg.core.version, 1);
  assert.equal(cfg.telemetry.enabled, false);
  assert.equal(cfg.encryption.enabled, false);
  assert.equal(cfg.encryption.key_provider, "env:DRIFT_MASTER_KEY");
  assert.ok(cfg.redaction.patterns.length > 0);
});

test("DEFAULT_CONFIG includes the Anthropic sk-ant- pattern (audit fix #2)", () => {
  const cfg = loadConfig(mkdtempSync(join(tmpdir(), "drift-config-")));
  const all = cfg.redaction.patterns.join("\n");
  assert.ok(all.includes("sk-ant-"), "sk-ant- must be a default redaction pattern");
  // and it actually matches an Anthropic-style key
  const r = redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz123456", compilePatterns(cfg.redaction.patterns));
  assert.equal(r.count, 1);
  assert.ok(!r.text.includes("sk-ant-api03"));
});

test("loadConfig merges [encryption] section", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-config-"));
  writeFileSync(join(dir, "config.toml"), "[encryption]\nenabled = true\nkey_provider = \"env:DRIFT_MASTER_KEY\"\n");
  const cfg = loadConfig(dir);
  assert.equal(cfg.encryption.enabled, true);
  assert.equal(cfg.encryption.key_provider, "env:DRIFT_MASTER_KEY");
});

test("parseToml strips inline comments outside strings", () => {
  const parsed = parseToml(
    "[encryption]\n" +
      "enabled = false # inline comment\n" +
      'key_provider = "env:DRIFT_MASTER_KEY" # keep the value\n' +
      "[redaction]\n" +
      'patterns = ["a#b", "c"] # array with hashes\n',
  );
  assert.equal(parsed.encryption.enabled, false);
  assert.equal(parsed.encryption.key_provider, "env:DRIFT_MASTER_KEY");
  assert.deepEqual(parsed.redaction.patterns, ["a#b", "c"]);
});

test("prompts mode defaults to commit-summary and parses full/none", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-config-"));
  assert.equal(loadConfig(dir).prompts.mode, "commit-summary");
  for (const mode of ["full", "none", "commit-summary"]) {
    const d2 = mkdtempSync(join(tmpdir(), "drift-config-"));
    writeFileSync(join(d2, "config.toml"), `[prompts]\nmode = "${mode}"\n`);
    assert.equal(loadConfig(d2).prompts.mode, mode);
  }
  // invalid value falls back to the safe default, never crashes
  const d3 = mkdtempSync(join(tmpdir(), "drift-config-"));
  writeFileSync(join(d3, "config.toml"), `[prompts]\nmode = "banana"\n`);
  assert.equal(loadConfig(d3).prompts.mode, "commit-summary");
});

test("loadConfig merges file over defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-config-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.toml"),
    `[core]\nversion = 2\n\n[redaction]\npatterns = ["MY_SECRET_[A-Z0-9]+"]\n`,
  );
  const cfg = loadConfig(dir);
  assert.equal(cfg.core.version, 2);
  assert.deepEqual(cfg.redaction.patterns, ["MY_SECRET_[A-Z0-9]+"]);
});
