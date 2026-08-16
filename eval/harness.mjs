#!/usr/bin/env node
/**
 * Drift evaluation harness (PRD §22).
 *
 * Drift's core operations are deterministic and make no LLM calls, so the
 * "mock LLM" is the real CLI driven with mock file states — no network, no
 * API keys, CI-safe. MCP tools delegate to the CLI (PRD §11 contract), so
 * exercising the CLI is exercising the agent-facing surface.
 *
 * Usage:
 *   node eval/harness.mjs              # run + compare against baseline (gate)
 *   node eval/harness.mjs --record     # run + write eval/baseline.json
 *   node eval/harness.mjs --no-gate    # run, report metrics, no comparison
 *
 * Metrics (PRD §22.2):
 *   syntaxRejectionRate  — broken code rejected before commit (must be 1.0)
 *   blameAccuracy        — drift blame resolves the originating prompt (1.0)
 *   replayFidelity       — agent state roundtrips byte-identical (1.0)
 *   realizeOverheadMs    — `drift realize` vs raw `git commit` (informational;
 *                          Node cold start is the ADR-006 tradeoff, not a gate)
 *
 * Regression gate (PRD §22.3): any metric regressing >5% vs baseline fails.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(EVAL_DIR, "..");
const CLI = join(REPO_ROOT, "packages", "drift-cli", "dist", "cli.js");
const BASELINE_PATH = join(EVAL_DIR, "baseline.json");
const GATE_TOLERANCE = 0.05; // PRD §22.3: >5% regression fails

if (!process.versions.node) throw new Error("node required");

// ---------------------------------------------------------------- helpers
function run(cwd, cmd, args, env = {}) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...env },
    windowsHide: true,
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function drift(cwd, args, env) {
  const res = run(cwd, process.execPath, [CLI, ...args], env);
  // Machine output may land on stdout (usage errors, JSON results) or stderr
  // (runtime errors like the syntax gate, PRD §14.1 exit codes) — try both.
  let json = null;
  for (const stream of [res.stdout, res.stderr]) {
    try {
      const parsed = JSON.parse(stream);
      if (parsed && typeof parsed === "object") {
        json = parsed;
        break;
      }
    } catch {
      /* non-JSON output (human mode) */
    }
  }
  return { ...res, json };
}

function git(cwd, args) {
  const res = run(cwd, "git", args);
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function freshRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-eval-"));
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.name", "Eval Dev"]);
  git(repo, ["config", "user.email", "eval@drift.dev"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  return repo;
}

// ------------------------------------------------------------- tool mapping
/** MCP tool name → CLI subcommand. */
const TOOL_TO_CMD = {
  drift_realize: "realize",
  drift_log: "log",
  drift_blame: "blame",
};

function cliArgsFor(tool, input) {
  const cmd = TOOL_TO_CMD[tool];
  if (!cmd) throw new Error(`unknown eval tool: ${tool}`);
  const args = [cmd];
  if (cmd === "realize") {
    args.push("-p", String(input.prompt));
    if (input.summary) args.push("--summary", String(input.summary));
    for (const f of input.files ?? []) args.push(f);
    if (input.model) args.push("--agent", "--model", String(input.model));
    if (input.agentState) args.push("--state", String(input.agentState));
    if (input.verifyCmd) args.push("--verify-cmd", String(input.verifyCmd));
    args.push("--json");
  } else if (cmd === "log") {
    if (input.limit) args.push("--limit", String(input.limit));
    if (input.file) args.push("--file", String(input.file));
    args.push("--json");
  } else if (cmd === "blame") {
    args.push(String(input.file));
    if (input.functionName) args.push("--function", String(input.functionName));
    if (input.line) args.push("--line", String(input.line));
    args.push("--json");
  }
  return args;
}

// -------------------------------------------------------------- scenarios
function loadScenarios() {
  const dir = join(EVAL_DIR, "scenarios");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function expectMatches(actual, expect) {
  if (expect.status && actual.json?.status !== expect.status) return false;
  if (expect.type && actual.json?.type !== expect.type) return false;
  if (expect.exitCode !== undefined && actual.status !== expect.exitCode) return false;
  if (expect.intents !== undefined && actual.json?.intents?.length !== expect.intents) return false;
  if (expect.baseline !== undefined && actual.json?.baseline !== expect.baseline) return false;
  return true;
}

/** Run one scenario. Returns { pass, steps, failures, syntaxExpected, syntaxRejected }. */
function runScenario(scenario) {
  const repo = freshRepo();
  drift(repo, ["init"]);
  const steps = [];
  const failures = [];
  let syntaxExpected = 0;
  let syntaxRejected = 0;
  let lastRealizeSummary = null;
  let blameSummaryHits = 0;
  let blameSummaryTotal = 0;

  for (const step of scenario.steps) {
    // apply mock file state to the working tree
    for (const [path, content] of Object.entries(step.mock_files ?? {})) {
      const abs = join(repo, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    if (step.tool === "drift_realize") lastRealizeSummary = step.input.summary ?? null;

    const args = cliArgsFor(step.tool, step.input);
    const actual = drift(repo, args);
    const ok = expectMatches(actual, step.expect);
    steps.push({ tool: step.tool, input: step.input, ok, actualStatus: actual.status, json: actual.json });

    if (step.expect.type === "syntax") {
      syntaxExpected++;
      if (ok && actual.json?.type === "syntax") syntaxRejected++;
    }
    if (step.tool === "drift_blame" && step.expect.baseline === false) {
      blameSummaryTotal++;
      // ADR-009: blame exposes the safe public `summary` (the explicit
      // `--summary` passed to realize), never the private prompt.
      if (
        ok &&
        actual.json?.intent &&
        lastRealizeSummary !== null &&
        actual.json.intent.summary === lastRealizeSummary
      ) {
        blameSummaryHits++;
      }
    }
    if (!ok) failures.push({ step, actual });
  }

  return {
    name: scenario.name,
    pass: failures.length === 0,
    steps: steps.length,
    failures,
    syntaxExpected,
    syntaxRejected,
    blameSummaryHits,
    blameSummaryTotal,
  };
}

// ------------------------------------------------------------- measurements
/** Replay fidelity: agent state must roundtrip byte-identical (PRD §22.2). */
function measureReplayFidelity() {
  const repo = freshRepo();
  drift(repo, ["init"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "f.ts"), "export const f = 1;\n");
  const state = Buffer.from(JSON.stringify({ step: 7, goal: "resume the refactor", seen: [1, 2, 3] })).toString("base64");
  const realize = drift(repo, ["realize", "-p", "checkpoint", "--state", state, "--json"]);
  if (realize.json?.status !== "ok") return { ok: false, detail: "realize failed" };
  const replay = drift(repo, ["replay", realize.json.intentId, "--json"]);
  const ok = replay.json?.status === "ok" && replay.json.agentState === state;
  return { ok, detail: ok ? "state roundtrip byte-identical" : "state mismatch" };
}

/** Realize overhead vs raw git commit on an identical change (informational). */
function measureRealizeOverhead() {
  const repo = freshRepo();
  drift(repo, ["init"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "f.ts"), "export const f = 1;\n");

  // raw baseline: git add + commit
  git(repo, ["add", "-A"]);
  const t0 = performance.now();
  git(repo, ["commit", "-q", "-m", "baseline"]);
  const gitMs = performance.now() - t0;

  // drift path: modify + realize
  writeFileSync(join(repo, "src", "f.ts"), "export const f = 1;\nexport const g = 2;\n");
  const t1 = performance.now();
  drift(repo, ["realize", "-p", "add g", "--json"]);
  const driftMs = performance.now() - t1;

  return { driftMs: Math.round(driftMs), gitMs: Math.round(gitMs), overheadMs: Math.round(Math.max(0, driftMs - gitMs)) };
}

// ------------------------------------------------------------------- main
const args = new Set(process.argv.slice(2));
const record = args.has("--record");
const noGate = args.has("--no-gate");

const scenarios = loadScenarios();
const scenarioResults = scenarios.map(runScenario);
const replay = measureReplayFidelity();
const overhead = measureRealizeOverhead();

const syntaxTotal = scenarioResults.reduce((s, r) => s + r.syntaxExpected, 0);
const syntaxOk = scenarioResults.reduce((s, r) => s + r.syntaxRejected, 0);
const blameTotal = scenarioResults.reduce((s, r) => s + r.blameSummaryTotal, 0);
const blameOk = scenarioResults.reduce((s, r) => s + r.blameSummaryHits, 0);

const metrics = {
  syntaxRejectionRate: syntaxTotal > 0 ? syntaxOk / syntaxTotal : 1,
  blameAccuracy: blameTotal > 0 ? blameOk / blameTotal : 1,
  replayFidelity: replay.ok ? 1 : 0,
  realizeOverheadMs: overhead.overheadMs,
};

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  toolchain: { node: process.version, git: git(REPO_ROOT, ["--version"]).replace(/^git version /, "") },
  scenariosPassed: scenarioResults.filter((r) => r.pass).length,
  scenariosTotal: scenarioResults.length,
  scenarios: Object.fromEntries(scenarioResults.map((r) => [r.name, { pass: r.pass, steps: r.steps, failures: r.failures }])),
  metrics,
};

// --------------------------------------------------------------- baseline
let gate = { passed: true, messages: [] };
if (record) {
  writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2) + "\n");
} else if (!noGate) {
  let baseline = null;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    gate = { passed: false, messages: ["eval/baseline.json missing — run `node eval/harness.mjs --record` first"] };
  }
  if (baseline) {
    for (const key of ["syntaxRejectionRate", "blameAccuracy", "replayFidelity"]) {
      const cur = metrics[key];
      const prev = baseline.metrics[key] ?? cur;
      if (cur < prev - GATE_TOLERANCE) {
        gate.passed = false;
        gate.messages.push(`${key}: ${cur} regressed below ${prev} by >5%`);
      }
    }
    // realizeOverheadMs is wall-clock on a shared machine — reported for
    // observability (ADR-006 TS-first tradeoff), never gated for flakiness.
  }
}

// ---------------------------------------------------------------- output
const allPassed = scenarioResults.every((r) => r.pass) && replay.ok && gate.passed;
console.log(JSON.stringify({ ...report, gate }, null, 2));
process.exitCode = allPassed ? 0 : 1;
