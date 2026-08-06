/**
 * Packaging consistency (audit fix #1 regression): every package's
 * `types`, `main`, and `bin` targets must resolve to a file that actually
 * exists in the repo (dist/ is committed). A dangling types path (e.g.
 * `dist/index.d.ts` when only `cli.d.ts` is emitted) breaks consumers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd());
const PACKAGES = [
  "packages/drift-app",
  "packages/drift-ast",
  "packages/drift-cli",
  "packages/drift-core",
  "packages/drift-mcp",
  "packages/drift-sdk",
];

test("every package types/main/bin points at an existing file", () => {
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
    for (const field of ["main", "types"]) {
      const target = manifest[field];
      if (target) {
        assert.ok(
          existsSync(join(ROOT, pkg, target)),
          `${pkg} ${field} → ${target} does not exist`,
        );
      }
    }
    for (const [binName, target] of Object.entries(manifest.bin ?? {})) {
      assert.ok(
        existsSync(join(ROOT, pkg, target)),
        `${pkg} bin ${binName} → ${target} does not exist`,
      );
    }
  }
});

test("every package version matches the monorepo root version", () => {
  const rootVersion = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).version;
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
    assert.equal(manifest.version, rootVersion, `${pkg} version out of sync`);
  }
});
