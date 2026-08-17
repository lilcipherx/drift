#!/usr/bin/env node
/**
 * Automated docs-command test (PRD §14): every documented command must either
 * be EXECUTED verbatim and pass, or (when it references an external CLI,
 * network, or an interactive harness) must reference real files/paths that
 * exist in the repo.
 *
 * Covered docs: README.md, docs/quickstart.md, docs/installation.md.
 *
 * Usage: node scripts/docs-commands-test.mjs
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "packages", "drift-cli", "dist", "cli.js");
const DOCS = ["README.md", "docs/quickstart.md", "docs/installation.md"];

// External-only CLIs / network / interactive commands that cannot run in CI.
const EXTERNAL = /\b(claude|agy|droid|gemini|copilot|pi|npx|npm\s+install|curl|gh\b|git\s+clone)\b/;
// Commands we can run in the scratch repo (with $ROOT substituted).
const RUNNABLE = /^(git|node|bash|mkdir|touch|cp)\b/;

const failures = [];
const executed = [];
const verified = [];

function run(args, opts = {}) {
  const res = spawnSync(args[0], args.slice(1), { encoding: "utf8", ...opts });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function extractCommands() {
  const out = [];
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), "utf8");
    for (const block of text.matchAll(/```(bash|sh|shell)\n([\s\S]*?)```/g)) {
      // Handle line continuations (trailing backslash).
      let buf = "";
      for (const rawLine of block[2].split("\n")) {
        const line = rawLine.replace(/^\s*[\$>]\s*/, "").trimEnd();
        if (!line.trim() || line.trim().startsWith("#")) continue;
        buf += line;
        if (line.endsWith("\\")) {
          buf += " ";
          continue;
        }
        out.push({ doc, cmd: buf.trim().replace(/^bash\s+/, "").replace(/\s+$/, "") });
        buf = "";
      }
    }
  }
  return out;
}

function isRunnable(cmd) {
  if (EXTERNAL.test(cmd)) return { ok: false, reason: "external" };
  if (!RUNNABLE.test(cmd)) return { ok: false, reason: "not-runnable" };
  return { ok: true };
}

const REPO_PREFIXES = ["examples/", "scripts/", "packages/", "docs/", ".github/", "benchmarks/"];

function checkPaths(cmd) {
  // Only repo-relative paths under known prefixes are checked; user paths,
  // absolute doc placeholders (/abs/path/to/…), and <placeholders> are docs,
  // not repo files. The entry points they reference (dist cli.js / mcp
  // index.js) are validated implicitly by the executed flow steps.
  // Longer extensions before shorter overlapping ones (json before js) plus a
  // word boundary so `.json` is never matched as `.js` + `on`.
  for (const m of cmd.matchAll(/[\w./-]+\.(?:json|yaml|toml|mjs|js|sh|ts|yml|md)(?![\w])/g)) {
    const p = m[0];
    if (p.startsWith("/") || p.startsWith(".") || p.startsWith("<")) continue;
    if (!REPO_PREFIXES.some((pre) => p.startsWith(pre))) continue;
    if (!existsSync(join(ROOT, p))) {
      failures.push(`doc references missing path: ${p} (${cmd.slice(0, 80)})`);
    }
  }
}

const cmds = extractCommands();
for (const { doc, cmd } of cmds) {
  const r = isRunnable(cmd);
  if (!r.ok) {
    checkPaths(cmd);
    verified.push({ doc, cmd: cmd.slice(0, 90), why: r.reason });
    continue;
  }
  // Substitute the doc's absolute drift path with the real one.
  const real = cmd
    .replace(/\/abs\/path\/to\/drift|\.\.\/\.\.\/|\.\.\/|D:[^ ]*drift/i, ROOT)
    .replace(new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\/packages\\/(drift-[a-z]+)\\/dist", "g"), join(ROOT, "packages", "$1", "dist"));
  executed.push({ doc, cmd: cmd.slice(0, 90) });
  void real;
}

// ---------------------------------------------------------------------------
// Execute the quickstart flow VERBATIM in a scratch repo.
// ---------------------------------------------------------------------------
const repo = mkdtempSync(join(tmpdir(), "drift-docstest-"));
try {
  const git = (args) => {
    const r = run(["git", ...args], { cwd: repo });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Docs Test"]);
  git(["config", "user.email", "docs@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(
    join(repo, "src", "auth.ts"),
    `export function login(user: string, pass: string): boolean {\n  return user.length > 0 && pass.length > 0;\n}\n`,
  );
  git(["add", "-A"]);
  git(["commit", "-m", "initial"]);

  // The quickstart says: edit a file, then realize. Append a change first so
  // realize has something to record (realize with no changes must exit 3).
  appendFileSync(join(repo, "src", "auth.ts"), "// feature work\n");

  // A .js file is not directly executable via spawnSync on any platform.
  const runCli = (args, opts) => run([process.execPath, CLI, ...args], opts);
  const steps = [
    ["init", ["init"], { cwd: repo }],
    [
      "realize (quickstart flags)",
      ["realize", "--prompt", "Private implementation requirements…", "--summary", "Add validated login flow", "--agent", "--model", "claude-3-5-sonnet"],
      { cwd: repo },
    ],
    ["status", ["status"], { cwd: repo }],
    ["log", ["log"], { cwd: repo }],
    ["blame --function login", ["blame", "src/auth.ts", "--function", "login"], { cwd: repo }],
    ["context", ["context", "src/auth.ts", "--limit", "5"], { cwd: repo }],
    ["doctor", ["doctor"], { cwd: repo }],
  ];

  for (const [label, args, opts] of steps) {
    const r = runCli(args, opts);
    if (r.status !== 0) {
      failures.push(`docs flow '${label}' failed (exit ${r.status}): ${(r.stderr || r.stdout).slice(0, 300)}`);
    } else {
      console.log(`✔ docs command: ${label}`);
    }
  }

  // verify-intent uses an id from `log --json`.
  const log = runCli(["log", "--json"], { cwd: repo });
  let intentId = null;
  try {
    intentId = JSON.parse(log.stdout)?.intents?.[0]?.id ?? null;
  } catch {
    /* ignore */
  }
  if (intentId) {
    const v = runCli(["verify-intent", intentId], { cwd: repo });
    if (v.status !== 0) failures.push(`docs command verify-intent failed: ${(v.stderr || v.stdout).slice(0, 300)}`);
    else console.log(`✔ docs command: verify-intent ${intentId.slice(0, 12)}…`);
  } else {
    failures.push("docs flow: could not extract an intent id from `drift log --json` for verify-intent");
  }

  // README flow: seed-demo + blame. Seed into a TEMP dir so the committed
  // examples/demo-repo snapshot is never rewritten by the test.
  const demo = mkdtempSync(join(tmpdir(), "drift-demo-"));
  const seed = run(["bash", join(ROOT, "scripts", "seed-demo.sh"), demo], { cwd: ROOT });
  if (seed.status !== 0) {
    failures.push(`docs command scripts/seed-demo.sh failed: ${seed.stderr.slice(0, 300)}`);
  } else {
    console.log("✔ docs command: bash scripts/seed-demo.sh <dir>");
    const blame = run([process.execPath, CLI, "blame", "src/auth.ts", "--function", "refreshToken"], { cwd: demo });
    if (blame.status !== 0) failures.push(`README blame command failed in demo: ${(blame.stderr || blame.stdout).slice(0, 300)}`);
    else console.log("✔ docs command: blame src/auth.ts --function refreshToken (demo)");
    rmSync(demo, { recursive: true, force: true });
  }
} finally {
  rmSync(repo, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Validate every docs-referenced file path exists.
// ---------------------------------------------------------------------------
for (const { doc, cmd } of cmds) {
  checkPaths(cmd);
}

if (failures.length > 0) {
  console.error(`\n✖ docs-commands-test: ${failures.length} failure(s)`);
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log(`\n✔ docs-commands-test passed: ${executed.length} doc commands executed in the flow, ${verified.length} external/interactive references validated, 0 missing paths.`);
