#!/usr/bin/env node
/**
 * Large-repository CLI benchmark (docs/PERFORMANCE_REPORT.md, PRD §7).
 *
 * Generates a real git repository with N commits, each atomically introducing
 * a public manifest (`.drift/public/intents/<id>.json`) plus a source change,
 * with a controlled mixture of:
 *   - manifests carrying a `Drift-Intent:` trailer in the same commit (valid
 *     atomic association);
 *   - plain commits without trailers (ordinary source changes);
 *   - malformed manifests (schema violations) at a fixed rate.
 *
 * Then measures wall time AND in-process heap growth for:
 *   drift status · drift log --limit 20 · drift context · drift blame ·
 *   drift verify-intent · drift doctor · export (public-only)
 *
 * Everything is generated locally with `git fast-import` (no network, no
 * GitHub). The working tree is fully checked out, exactly like a real clone.
 *
 * Usage: node scripts/bench-large-repo.mjs [--commits N] [--malformed-rate P]
 *   --commits N          number of commits/manifests (default 20000)
 *   --malformed-rate P   fraction of manifests that are malformed (default 0.02)
 *   --json               emit JSON instead of a markdown table
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const fs = await import("node:fs");

const args = process.argv.slice(2);
const nFlag = args.indexOf("--commits");
const COMMITS = nFlag !== -1 ? Number(args[nFlag + 1]) : 20_000;
const mFlag = args.indexOf("--manifests");
const MANIFESTS = mFlag !== -1 ? Number(args[mFlag + 1]) : COMMITS;
const malformedRate =
  (args[args.indexOf("--malformed-rate") + 1] ?? "0.02").startsWith("--")
    ? 0.02
    : Number(args[args.indexOf("--malformed-rate") + 1] ?? 0.02);
const asJson = args.includes("--json");
const repoIdx = args.indexOf("--repo");
const measureOnlyRepo = repoIdx !== -1 ? args[repoIdx + 1] : undefined;

if (!Number.isInteger(COMMITS) || COMMITS < 10) {
  console.error("--commits must be an integer >= 10");
  process.exit(1);
}
if (!Number.isInteger(MANIFESTS) || MANIFESTS < COMMITS) {
  console.error("--manifests must be an integer >= --commits (multi-manifest commits are allowed; a commit can introduce several manifests with several Drift-Intent trailers in the same message)");
  process.exit(1);
}

const id = (i) => `did_${i.toString(16).padStart(32, "0")}`;
const manifestJson = (i, malformed) => {
  if (malformed) {
    return JSON.stringify({
      schemaVersion: 2,
      id: id(i),
      summary: "malformed entry",
      unknownField: true,
      files: "not-an-array",
    });
  }
  return JSON.stringify({
    schemaVersion: 2,
    id: id(i),
    summary: `Implement feature ${i} with validation and tests across the auth module`,
    timestamp: 1_700_000_000_000 + i,
    agent: { type: "AGENT", identifier: "bench" },
    model: "bench-model",
    verification: `npm test -- --filter feature-${i}`,
    signingKeyId: "0123456789abcdef",
    signature: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=",
    files: [
      { path: `src/feature-${i}.ts`, mutationType: "ADDED", summary: `add feature ${i}` },
      { path: "src/app.ts", mutationType: "MODIFIED", summary: "wire feature into the app" },
    ],
  });
};

const INTENTS_DIR = ".drift/public/intents";
// 1/7 of MANIFESTS carry a `Drift-Intent:` trailer in their introducing
// commit (matches the historical 1-in-7 profile; a commit introducing
// several manifests carries one trailer line per manifested intent).
const malformedIdx = new Set(
  Array.from({ length: Math.floor(MANIFESTS * malformedRate) }, (_, k) => Math.floor((k * 977) % MANIFESTS)),
);

// ---------------------------------------------------------------------------
// Repo generation via git fast-import (fast, no reflog/hooks overhead).
// --repo <path> skips generation entirely and re-measures an existing repo
// (reproducibility / resuming interrupted runs).
// ---------------------------------------------------------------------------

let work;
let repo;
if (measureOnlyRepo) {
  repo = measureOnlyRepo;
  if (!fs.existsSync(join(repo, ".git"))) {
    console.error(`--repo ${repo} is not a git repository`);
    process.exit(1);
  }
  work = dirname(repo);
  console.error(`re-measuring existing repo ${repo} (${COMMITS} commits / ${MANIFESTS} manifests)`);
} else {
  work = mkdtempSync(join(tmpdir(), "drift-bench-repo-"));
  repo = join(work, "repo");
  mkdirSync(repo, { recursive: true });
  const benchRun = (cmd, cwd = repo) => {
    const r = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${cmd.join(" ")} failed: ${(r.stderr || r.stdout).slice(0, 800)}`);
    return r.stdout;
  };

  benchRun(["git", "init", "-q", "-b", "main", repo]);
  benchRun(["git", "config", "user.name", "bench"]);
  benchRun(["git", "config", "user.email", "bench@example.com"]);
  // Windows: fsync dominates packfile writes for large streams; the
  // benchmark measures Drift, not the generator, so disable it.
  benchRun(["git", "config", "core.fsync", "none"]);

  const per = Math.ceil(MANIFESTS / COMMITS);
  console.error(`generating ${COMMITS} commits introducing ${MANIFESTS} manifests (${per}/commit) via fast-import...`);
  const FILE_CONTENT = "export const app = 1;\n";
  const streamFile = join(work, "fi-stream.txt");
  let stream = "";
  const FLUSH = 2_000; // append to the file every N commits (bounded memory)
  let mark = 1;
  for (let i = 1; i <= COMMITS; i++) {
    const start = (i - 1) * per + 1;
    const end = Math.min(i * per, MANIFESTS);
    const window = [];
    for (let m = start; m <= end; m++) window.push(m);
    const trailers = window
      .filter((m) => m % 7 === 0)
      .map((m) => `Drift-Intent: ${id(m)}`)
      .join("\n");
    const msg = `chore(bench): commit ${i}${trailers ? "\n\n" + trailers : ""}`;
    stream += `commit refs/heads/main\nmark :${mark}\nauthor Bench <bench@example.com> 1700000000 +0000\ncommitter Bench <bench@example.com> 1700000000 +0000\ndata ${Buffer.byteLength(msg, "utf8")}\n${msg}\n`;
    for (const m of window) {
      const mf = manifestJson(m, malformedIdx.has(m));
      stream += `M 100644 inline ${INTENTS_DIR}/${id(m)}.json\ndata ${Buffer.byteLength(mf, "utf8")}\n${mf}\n`;
    }
    stream += `M 100644 inline src/app.ts\ndata ${Buffer.byteLength(FILE_CONTENT, "utf8")}\n${FILE_CONTENT}\n`;
    mark++;
    if (i % FLUSH === 0 || i === COMMITS) {
      fs.appendFileSync(streamFile, stream, "utf8");
      stream = "";
    }
  }
  const imp = spawnSync("git", ["-c", "core.fsync=none", "fast-import", "--quiet"], {
    cwd: repo,
    input: fs.readFileSync(streamFile),
    maxBuffer: 512 * 1024 * 1024,
  });
  if (imp.status !== 0) {
    throw new Error(`fast-import failed: ${(imp.stderr || "").slice(0, 800)}`);
  }
  benchRun(["git", "reset", "--hard", "-q", "HEAD"]);
  console.error("checkout done");
}

// ---------------------------------------------------------------------------
// Initialize Drift (creates the local store + signing key)
// ---------------------------------------------------------------------------

const coreDist = join(root, "packages", "drift-core", "dist", "index.js");
const { Drift } = await import(`file://${coreDist.replace(/\\/g, "/")}`);
const init = Drift.init(repo, { author: "bench" });
console.error(`drift initialized (${init.signerState})`);

// ---------------------------------------------------------------------------
// Measure commands: wall time + in-process heap growth
// ---------------------------------------------------------------------------

function measure(label, fn) {
  global.gc?.();
  const before = process.memoryUsage();
  const t0 = performance.now();
  let result;
  try {
    result = fn();
  } catch (err) {
    result = `ERROR: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
  }
  const wallMs = performance.now() - t0;
  const after = process.memoryUsage();
  const heapDeltaMB = (after.heapUsed - before.heapUsed) / 1024 / 1024;
  return { label, wallMs, heapDeltaMB, result };
}

const drift = Drift.fromCwd(repo);
const measurements = [];
measurements.push(measure("status", () => Drift.status(repo).initialized));
// First bounded log builds the stat-validated index (cold); second is warm.
measurements.push(measure("log --limit 20 (cold, index build)", () => drift.log({ limit: 20 }).length));
measurements.push(measure("log --limit 20 (warm)", () => drift.log({ limit: 20 }).length));
measurements.push(measure("context (warm)", () => drift.context("src/app.ts", 5).length));
measurements.push(measure("blame", () => drift.blame("src/app.ts", { line: 1 }).committed));
measurements.push(
  measure("verify-intent", () => {
    const id0 = id(1);
    return drift.verifyIntentSignature(id0).state;
  }),
);
measurements.push(measure("doctor", () => drift.doctor().checks.length));
measurements.push(measure("export", () => drift.exportJson().length > 0));
measurements.push(measure("intentAssociations", () => drift.intentAssociations().size));
let indexStats = null;
if (drift.store) {
  try {
    const store = drift.store;
    indexStats = {
      rows: store.publicManifestIndexRows(),
      validRows: store.publicManifestIndexValidRows(),
    };
  } catch {
    /* not exposed */
  }
}
drift.close();

// Real CLI wall times for the record (spawned process, cold start).
const cli = join(root, "packages", "drift-cli", "dist", "cli.js");
const cliMeasure = (label, argsList) => {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [cli, ...argsList], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  return { label: `${label} (cli)`, wallMs: performance.now() - t0, status: r.status };
};
const cliTimes = [
  cliMeasure("status", ["status"]),
  cliMeasure("log --limit 20", ["log", "--limit", "20"]),
  cliMeasure("doctor", ["doctor"]),
];

const output = {
  scenario: { commits: COMMITS, manifests: MANIFESTS, malformedRate, generator: "git fast-import", machine: `${process.platform} ${process.arch}` },
  engineMeasurements: measurements.map(({ label, wallMs, heapDeltaMB, result }) => ({ label, wallMsMs: Math.round(wallMs * 100) / 100, heapDeltaMB: Math.round(heapDeltaMB * 100) / 100, result })),
  cliMeasurements: cliTimes.map(({ label, wallMs, status }) => ({ label, wallMsMs: Math.round(wallMs * 100) / 100, exit: status })),
  indexStats,
  manifestBytes: Buffer.byteLength(manifestJson(1, false), "utf8"),
  repo,
};

if (asJson) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`\n# Large-repo benchmark — ${COMMITS.toLocaleString()} commits / ${MANIFESTS.toLocaleString()} manifests\n`);
  console.log(`| command | wall (ms) | heap Δ (MB) |`);
  console.log(`|---|---|---|`);
  for (const m of output.engineMeasurements) console.log(`| ${m.label} | ${m.wallMsMs} | ${m.heapDeltaMB} |`);
  console.log(`\n# CLI (cold process) wall times\n`);
  console.log(`| command | wall (ms) | exit |`);
  console.log(`|---|---|---|`);
  for (const m of output.cliMeasurements) console.log(`| ${m.label} | ${m.wallMsMs} | ${m.exit} |`);
  console.log(`\nrepo kept at: ${work}\n`);
}

// Do not clean up — the caller may want to inspect; the tmpdir is ephemeral.
