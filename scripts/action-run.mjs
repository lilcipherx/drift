#!/usr/bin/env node
/**
 * Safe launcher for the composite Drift GitHub Action.
 *
 * The Action surface is INFORMATIONAL ONLY: the CLI is invoked through a
 * strict allowlist and never with an arbitrary shell string. A legacy
 * free-form `command` input is parsed with a real tokenizer (no shell word
 * splitting) and every operation/flag outside the allowlist is rejected
 * BEFORE the CLI is spawned. The following can never be reached through the
 * Action:
 *
 *   --run / --allow-untrusted-command / --inherit-env   (command execution)
 *   --include-private-prompt / --allow-repository-output (private export)
 *   export / replay / realize / key import / key rotation (unsafe surface)
 *
 * The CLI also never receives a provenance-recorded verification command:
 * `verify` here is informational only.
 */

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "..", "packages", "drift-cli", "dist", "cli.js");

const ALLOWED_OPS = new Set(["log", "doctor", "status", "verify-intent", "verify"]);

/** Tokenize a command string with quote support — never shell-split. */
export function tokenizeCommand(input) {
  const out = [];
  let cur = "";
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      hasToken = true;
    } else if (c === " " || c === "\t") {
      if (hasToken) {
        out.push(cur);
        cur = "";
        hasToken = false;
      }
    } else {
      cur += c;
      hasToken = true;
    }
  }
  if (quote) throw new Error("unbalanced quotes in command input");
  if (hasToken) out.push(cur);
  return out;
}

/**
 * Validate the requested operation + positional args. Returns the CLI
 * argument list or throws a clear, actionable error.
 */
export function buildCliArgs({ operation, intentId, command }) {
  let op = operation;
  let positionals = [];
  if (intentId && intentId.trim().length > 0) positionals.push(intentId.trim());

  if (command && command.trim().length > 0) {
    process.stderr.write(
      "drift-action: warning: the `command` input is deprecated — use `operation` (and `intent-id` for verify-intent).\n",
    );
    let tokens;
    try {
      tokens = tokenizeCommand(command);
    } catch (err) {
      throw new Error(`invalid command input: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (tokens.length === 0) {
      throw new Error("command input is empty — nothing to run");
    }
    if (op && op !== "log") {
      // Both `operation` and `command` supplied: the structured input wins.
      process.stderr.write("drift-action: warning: both `operation` and `command` were set — using `operation`.\n");
    } else {
      op = tokens[0];
      positionals = tokens.slice(1);
    }
  }

  if (!op || op.trim().length === 0) {
    throw new Error("no Drift operation requested — set `operation` (log | doctor | status | verify-intent)");
  }
  op = op.trim();
  if (!ALLOWED_OPS.has(op)) {
    throw new Error(
      `operation "${op}" is not allowed in the GitHub Action. Allowed: ${[...ALLOWED_OPS].join(", ")}. ` +
        "Command execution (verify --run), private export, replay, realize, and key operations are never available in CI.",
    );
  }
  for (const a of positionals) {
    if (a.startsWith("-")) {
      throw new Error(`flag "${a}" is not allowed in the GitHub Action — only an intent id positional is supported`);
    }
    if (!/^did_[0-9a-f]{32}$/.test(a)) {
      throw new Error(`invalid intent id "${a}" — expected did_<32 hex chars>`);
    }
  }
  if ((op === "verify-intent" || op === "verify") && positionals.length !== 1) {
    throw new Error(`${op} requires exactly one intent id (e.g. operation: verify-intent, intent-id: did_...)`);
  }
  if ((op === "log" || op === "doctor" || op === "status") && positionals.length > 0) {
    throw new Error(`${op} does not accept positional arguments in the GitHub Action`);
  }
  return [op, ...positionals, "--json"];
}

function main() {
  const operation = process.env.DRIFT_OPERATION ?? "";
  const intentId = process.env.DRIFT_INTENT_ID ?? "";
  const command = process.env.DRIFT_COMMAND ?? "";
  let cliArgs;
  try {
    cliArgs = buildCliArgs({ operation, intentId, command });
  } catch (err) {
    process.stderr.write(`drift-action: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
  const cwd = process.env.DRIFT_WORKSPACE || process.cwd();
  const res = spawnSync(process.execPath, [CLI, ...cliArgs], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  process.exit(res.status ?? 1);
}

// Run only when executed as a script, not when imported by tests.
const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) main();

export { main as runActionMain };
