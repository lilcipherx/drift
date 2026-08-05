import { test } from "node:test";
import assert from "node:assert/strict";
import { parseToml, loadConfig } from "@drift/core";
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
  assert.ok(cfg.redaction.patterns.length > 0);
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
