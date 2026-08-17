#!/usr/bin/env node
/**
 * Supply-chain security gates (docs/THREAT_MODEL.md §13, SECURITY.md):
 *
 *   --secrets    secret scan over tracked files (no real credentials allowed);
 *   --licenses   license review of every installed dependency;
 *   --packages   package-content scan: tarball file lists have no absolute
 *                paths, no source leakage, no secrets, no dev-machine paths;
 *   --sbom <out> generate an SPDX SBOM of the dependency tree and validate it.
 *
 * Exits non-zero on any finding. `npm audit` is a separate gate in CI
 * (the action also runs dependency review on PRs).
 *
 * Usage: node scripts/security-checks.mjs [--secrets] [--licenses]
 *        [--packages] [--sbom <out>]  (no args = run all)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Portable npm CLI resolution. `npm` is a shell shim on Windows and a symlink
 * elsewhere; the hosted-runners' node layouts differ (bin/node_modules/npm vs
 * lib/node_modules/npm). Try the known layouts, then fall back to spawning
 * `npm` through a shell.
 */
function npmCliPath() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

function runNpm(args, opts = {}) {
  const cli = npmCliPath();
  if (cli) return execFileSync(process.execPath, [cli, ...args], opts);
  return execFileSync("npm", args, { ...opts, shell: true });
}
const args = process.argv.slice(2);
const runSecrets = args.includes("--secrets") || args.length === 0;
const runLicenses = args.includes("--licenses") || args.length === 0;
const runPackages = args.includes("--packages") || args.length === 0;
const sbomIdx = args.indexOf("--sbom");
const sbomOut = sbomIdx !== -1 && !String(args[sbomIdx + 1] ?? "").startsWith("--") ? args[sbomIdx + 1] : undefined;
let failed = false;

const fail = (msg) => {
  failed = true;
  console.error(`[security-checks] FAIL: ${msg}`);
};

// ---------------------------------------------------------------------------
// 1. Secret scan (tracked files only — CI checkout is a fresh clone)
// ---------------------------------------------------------------------------
if (runSecrets) {
  console.error("[security-checks] scanning tracked files for secrets...");
  const files = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);

  const patterns = [
    { name: "github-pat", re: /\bghp_[A-Za-z0-9]{36}\b/g },
    { name: "github-oauth", re: /\bgho_[A-Za-z0-9]{36}\b/g },
    { name: "github-app-token", re: /\bghu_[A-Za-z0-9]{36}\b/g },
    { name: "github-fine-grained-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
    { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/g },
    { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
    { name: "stripe-live", re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
    { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
    { name: "private-key-pem", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
    { name: "hardcoded-webhook-secret", re: /(GITHUB_WEBHOOK_SECRET|webhookSecret|DRIFT_MASTER_KEY)\s*[:=]\s*["'][^"']{8,}["']/g },
  ];

  // Files that legitimately DEFINE or document the patterns (never real creds).
  const exempt = (path) =>
    path.startsWith("tests/") ||
    path.startsWith("eval/") ||
    path.startsWith("docs/") ||
    path === "SECURITY.md" ||
    path === "README.md" ||
    path.startsWith("scripts/bench-") ||
    path.includes("test") ||
    path.endsWith(".test.mjs") ||
    /redact|redaction/.test(path);

  let findings = 0;
  for (const file of files) {
    if (exempt(file)) continue;
    if (/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|eot|lockb)$/.test(file)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const p of patterns) {
      for (const m of text.matchAll(p.re) ?? []) {
        // A PEM marker inside a PEM *parser/validator* (trust-root.ts) is
        // pattern-handling, not a secret — allow only marker-name references
        // (the regex itself), not an actual block start plus content.
        if (p.name === "private-key-pem" && /PRIVATE_KEY_MARKER|marker/.test(text.slice(Math.max(0, m.index - 60), m.index))) continue;
        findings++;
        const line = text.slice(0, m.index).split("\n").length;
        console.error(`[security-checks]   ${file}:${line} ${p.name} pattern`);
      }
    }
  }
  if (findings > 0) fail(`${findings} secret-pattern match(es) outside exempt files`);
  else console.error("[security-checks]   no secrets found in tracked files");
}

// ---------------------------------------------------------------------------
// 2. License review of installed dependencies (allowlist)
// ---------------------------------------------------------------------------
if (runLicenses) {
  console.error("[security-checks] reviewing dependency licenses...");
  const allowed = new Set([
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "ISC",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "BlueOak-1.0.0",
    "MPL-2.0",
  ]);
  const seen = new Map();
  const scanDir = (dir) => {
    const pkgPath = join(dir, "package.json");
    if (!existsSync(pkgPath)) return;
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return;
    }
    if (!pkg.name || !pkg.version) return;
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    const lic = (Array.isArray(pkg.license) ? pkg.license.map((l) => l.type ?? l).join(" OR ") : pkg.license) ?? pkg.licenses?.map((l) => l.type).join(" OR ") ?? "UNKNOWN";
    seen.set(key, lic);
    const base = allowed.has(String(lic)) || (Array.isArray(pkg.license) && pkg.license.every((l) => allowed.has(l.type ?? l)));
    if (!base) {
      // workspace packages ship their own license — check the monorepo root
      const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      if (rootPkg.license && String(rootPkg.license) === String(lic)) return;
      console.error(`[security-checks]   non-allowlisted license: ${key} → ${lic}`);
      findings++;
    }
  };
  let findings = 0;
  const scanTopLevel = (base) => {
    if (!existsSync(base)) return;
    for (const entry of readdirSync(base)) {
      if (entry.startsWith(".")) continue;
      const sub = join(base, entry);
      if (existsSync(join(sub, "package.json"))) scanDir(sub);
      else if (existsSync(sub)) {
        for (const inner of readdirSync(sub)) scanDir(join(sub, inner));
      }
    }
  };
  scanTopLevel(join(ROOT, "node_modules"));
  if (findings > 0) fail(`${findings} dependency(ies) with non-allowlisted licenses`);
  else console.error(`[security-checks]   ${seen.size} dependencies license-checked, all allowlisted`);
}

// ---------------------------------------------------------------------------
// 3. Package-content scan (npm pack tarballs)
// ---------------------------------------------------------------------------
if (runPackages) {
  console.error("[security-checks] scanning package tarball contents...");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const tmp = mkdtempSync(join(tmpdir(), "drift-sec-pkg-"));
  let findings = 0;
  try {
    for (const pkg of ["drift-ast", "drift-core", "drift-cli", "drift-mcp", "drift-app"]) {
      const dir = join(ROOT, "packages", pkg);
      const tarball = runNpm(["pack", "--pack-destination", tmp, "--json"], {
        cwd: dir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const info = JSON.parse(tarball);
      const filename = info[0]?.filename ?? info.filename;
      if (!filename) {
        fail(`${pkg}: npm pack produced no filename`);
        continue;
      }
      const listing = execFileSync("tar", ["--force-local", "-tzf", join(tmp, filename)], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\n")
        .filter(Boolean);
      const bad = [];
      for (const entry of listing) {
        if (entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry) || entry.includes("../") || entry.includes("..\\")) bad.push(`absolute/traversal path: ${entry}`);
        if (/node_modules/.test(entry)) bad.push(`bundled node_modules: ${entry}`);
        if (/\.(ts|mts|cts)$/.test(entry) && !entry.includes("dist/")) bad.push(`source file leaked: ${entry}`);
        if (/(\.env|\.pem$|\.key$|_key\.|drift\.db|\.sqlite|test-fixture|fixtures)/.test(entry)) bad.push(`suspicious file: ${entry}`);
      }
      const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      const pkgJsonInTar = listing.some((e) => e.endsWith("package/package.json"));
      if (!pkgJsonInTar) bad.push("missing package.json");
      if (bad.length > 0) {
        fail(`${pkg} tarball: ${bad.join("; ")}`);
        findings++;
      } else {
        console.error(`[security-checks]   ${pkg}: ${listing.length} entries, clean (${(info[0]?.size ?? 0) / 1024} KiB)`);
      }
    }
  } finally {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(tmp, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }
  if (findings > 0) fail(`${findings} package(s) failed the content scan`);
}

// ---------------------------------------------------------------------------
// 4. SBOM generation + validation (npm sbom, SPDX)
// ---------------------------------------------------------------------------
if (sbomOut) {
  console.error(`[security-checks] generating SPDX SBOM → ${sbomOut}`);
  try {
    const sbom = runNpm(["sbom", "--sbom-format", "spdx"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const parsed = JSON.parse(sbom);
    if (parsed.spdxVersion !== "SPDX-2.3") fail(`unexpected SPDX version: ${parsed.spdxVersion}`);
    const pkgs = parsed.packages ?? [];
    if (pkgs.length < 5) fail(`SBOM has only ${pkgs.length} packages — expected the full dependency tree`);
    const outPath = resolve(ROOT, sbomOut);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(parsed, null, 2), "utf8");
    console.error(`[security-checks]   SBOM: ${pkgs.length} packages, SPDX-2.3, written to ${sbomOut}`);
  } catch (err) {
    fail(`npm sbom failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.exit(failed ? 1 : 0);
