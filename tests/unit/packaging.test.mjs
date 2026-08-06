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

test("internal @drift/* dependencies stay pinned to the current version (fresh-clone install regression)", () => {
  // Human E2E bug: the 0.1.0 → 0.1.1 bump left internal deps pinned at
  // 0.1.0, so a fresh clone + npm install tried to fetch @drift/core@0.1.0
  // from the registry (404) instead of linking the workspace package — the
  // quickstart install broke end-to-end. Every internal dependency must
  // match the monorepo version so npm links the workspace copy.
  const rootVersion = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  ).version;
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(ROOT, pkg, "package.json"), "utf8"));
    const deps = { ...(manifest.dependencies ?? {}) };
    for (const [name, spec] of Object.entries(deps)) {
      if (name.startsWith("@drift/")) {
        assert.equal(
          spec,
          rootVersion,
          `${pkg} depends on ${name}@${spec}, expected ${rootVersion} so npm links the workspace package`,
        );
      }
    }
  }
});
