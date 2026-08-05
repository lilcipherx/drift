#!/usr/bin/env node
/**
 * Drift CLI (PRD §14.1).
 *   drift init | realize | log | blame | context | verify | replay | doctor | export
 * Exit codes: 0 ok, 1 error, 2 syntax, 3 no changes, 4 key, 5 corrupt.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Drift, DriftError, EXIT } from "@drift/core";
const require_ = createRequire(import.meta.url);
let VERSION = "0.0.0";
try {
    // dist/cli.js → ../package.json (works both in the monorepo and in the
    // installed @drift/cli under node_modules)
    VERSION = require_("../package.json").version ?? VERSION;
}
catch {
    // packaged without package.json (e.g. bundled) — fall back
}
const USAGE = `Drift — Intent-Driven Versioning

Usage:
  drift init                       Initialize .drift metadata for this repository
  drift realize -p "prompt" [files...] [--model m] [--agent] [--state b64] [--verify-cmd cmd] [--no-ast]
                                   Commit changes with semantic intent (rejects broken syntax)
  drift log [--author x] [--model m] [--file f] [--limit n] [--json]
  drift blame <file> --line N | --function name [--json]
  drift context <file> [--limit 5] [--json]
  drift verify <intent-id> [--json]
  drift replay <intent-id> [--checkout] [--json]
  drift doctor [--fix] [--json]
  drift export [--out file]
  drift verify-intent <intent-id>  Check an intent's Ed25519 signature

Options:
  --json       machine-readable output
  --no-color   disable ANSI colors
`;
function parseArgs(argv) {
    const positional = [];
    const flags = new Map();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            if (eq !== -1) {
                flags.set(a.slice(2, eq), a.slice(eq + 1));
            }
            else {
                const next = argv[i + 1];
                if (next !== undefined && !next.startsWith("-")) {
                    flags.set(a.slice(2), next);
                    i++;
                }
                else {
                    flags.set(a.slice(2), true);
                }
            }
        }
        else if (a === "-p" || a === "-n" || a === "-f") {
            // short flags taking values
            const next = argv[i + 1];
            flags.set(a === "-p" ? "prompt" : a === "-n" ? "line" : "file", next ?? "");
            if (next !== undefined)
                i++;
        }
        else if (!a.startsWith("-")) {
            positional.push(a);
        }
    }
    return { command: positional[0] ?? "", positional: positional.slice(1), flags };
}
const COLOR = {
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    dim: "\x1b[2m",
    bold: "\x1b[1m",
    reset: "\x1b[0m",
};
function colorize(enabled, code, text) {
    return enabled ? `${COLOR[code]}${text}${COLOR.reset}` : text;
}
function printTable(rows) {
    const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
    for (const row of rows) {
        console.log(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
    }
}
function run(argv) {
    const { command, positional, flags } = parseArgs(argv);
    const json = flags.get("json") === true;
    const noColor = flags.get("no-color") === true || process.env.NO_COLOR !== undefined;
    if (!command || command === "help" || command === "--help" || command === "-h") {
        console.log(USAGE);
        return EXIT.OK;
    }
    const fail = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const exit = err instanceof DriftError ? err.exitCode : EXIT.ERROR;
        const type = exit === EXIT.SYNTAX
            ? "syntax"
            : exit === EXIT.NO_CHANGES
                ? "no_changes"
                : exit === EXIT.KEY
                    ? "key"
                    : exit === EXIT.CORRUPT
                        ? "corrupt"
                        : "error";
        if (json) {
            console.error(JSON.stringify({ status: "error", type, message, exitCode: exit }));
        }
        else {
            console.error(colorize(!noColor, "red", `error: ${message}`));
        }
        return exit;
    };
    try {
        switch (command) {
            case "init": {
                const result = Drift.init(process.cwd(), { author: stringFlag(flags, "author") });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    console.log(colorize(!noColor, "green", "✓ Drift initialized"));
                    console.log(`  repo:   ${result.repoRoot}`);
                    console.log(`  key:    ${result.driftDir}\\keys\\ed25519.pem`);
                    console.log(`  pubkey: ${result.publicKeyPem.slice(0, 40)}…`);
                    console.log("\nNext: edit a file, then run:");
                    console.log(colorize(!noColor, "bold", "  drift realize -p \"what you changed and why\""));
                }
                return EXIT.OK;
            }
            case "realize": {
                const prompt = stringFlag(flags, "prompt");
                if (!prompt) {
                    console.log(colorize(!noColor, "yellow", "missing -p \"prompt\" — describe your change"));
                    console.log(USAGE);
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.realize({
                    prompt,
                    files: positional,
                    model: stringFlag(flags, "model"),
                    author: stringFlag(flags, "author"),
                    authorType: flags.has("agent") ? "AGENT" : undefined,
                    agentState: stringFlag(flags, "state"),
                    verifyCmd: stringFlag(flags, "verify-cmd"),
                    noAst: flags.has("no-ast"),
                });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    console.log(colorize(!noColor, "green", "✓ intent committed"));
                    console.log(`  intent: ${result.intentId}`);
                    console.log(`  git:    ${result.gitSha}`);
                    for (const d of result.astDelta) {
                        console.log(colorize(!noColor, "dim", `  ${d.type.padEnd(8)} ${d.filePath} — ${d.summary}`));
                    }
                    if (result.redactions > 0) {
                        console.log(colorize(!noColor, "yellow", `  ⚠ ${result.redactions} secret(s) redacted`));
                    }
                }
                return EXIT.OK;
            }
            case "log": {
                const drift = Drift.fromCwd(process.cwd());
                const entries = drift.log({
                    author: stringFlag(flags, "author") ?? undefined,
                    model: stringFlag(flags, "model") ?? undefined,
                    file: stringFlag(flags, "file") ?? undefined,
                    limit: numberFlag(flags, "limit"),
                });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", intents: entries }));
                }
                else if (entries.length === 0) {
                    console.log(colorize(!noColor, "yellow", "No intents yet. Run `drift realize -p \"...\"` after your next change."));
                }
                else {
                    printTable([
                        ["ID", "AUTHOR", "MODEL", "TIME", "PROMPT"],
                        ...entries.map((e) => [
                            e.id,
                            `${e.authorId}(${e.authorType})`,
                            e.model ?? "-",
                            new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " "),
                            e.prompt.slice(0, 60),
                        ]),
                    ]);
                }
                return EXIT.OK;
            }
            case "blame": {
                const file = positional[0];
                if (!file) {
                    console.log(colorize(!noColor, "yellow", "usage: drift blame <file> --line N | --function NAME"));
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const line = numberFlag(flags, "line");
                const functionName = stringFlag(flags, "function");
                const result = drift.blame(file, { line, functionName });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    console.log(`${colorize(!noColor, "bold", result.file)}:${result.line}${result.functionName ? ` (${result.functionName})` : ""}`);
                    if (!result.committed) {
                        console.log(colorize(!noColor, "yellow", "  uncommitted change — not yet part of any intent"));
                    }
                    else if (result.baseline) {
                        console.log(colorize(!noColor, "yellow", "  pre-Drift baseline (no intent recorded)"));
                    }
                    else if (result.intent) {
                        console.log(colorize(!noColor, "green", `  ${result.intent.author.type} @ ${result.intent.author.identifier}`));
                        if (result.intent.author.model) {
                            console.log(`  model:   ${result.intent.author.model}`);
                        }
                        console.log(`  prompt:  ${result.intent.prompt}`);
                        console.log(`  intent:  ${result.intent.id}`);
                        console.log(`  commit:  ${result.gitSha}  signature: ${result.intent.signatureValid ? "valid" : "INVALID"}`);
                    }
                }
                return EXIT.OK;
            }
            case "context": {
                const file = positional[0];
                if (!file) {
                    console.log(colorize(!noColor, "yellow", "usage: drift context <file> [--limit N]"));
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const entries = drift.context(file, numberFlag(flags, "limit") ?? 5);
                if (json) {
                    console.log(JSON.stringify({ status: "ok", file, intents: entries }));
                }
                else if (entries.length === 0) {
                    console.log(colorize(!noColor, "yellow", `No intents touch ${file}.`));
                }
                else {
                    printTable([
                        ["ID", "TIME", "PROMPT"],
                        ...entries.map((e) => [
                            e.id,
                            new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " "),
                            e.prompt.slice(0, 80),
                        ]),
                    ]);
                }
                return EXIT.OK;
            }
            case "verify": {
                const id = positional[0];
                if (!id) {
                    console.log(colorize(!noColor, "yellow", "usage: drift verify <intent-id>"));
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.verify(id);
                if (json) {
                    console.log(JSON.stringify({
                        status: "ok",
                        intentId: result.intentId,
                        verifyStatus: result.status,
                        verifyCmd: result.verifyCmd,
                        exitCode: result.exitCode,
                        stdout: result.stdout,
                        stderr: result.stderr,
                    }));
                }
                else {
                    const ok = result.status === "pass";
                    const label = result.status === "no-command"
                        ? colorize(!noColor, "yellow", "no verification command recorded")
                        : ok
                            ? colorize(!noColor, "green", "PASS")
                            : colorize(!noColor, "red", "FAIL");
                    console.log(`${id}: ${label}`);
                    if (result.stdout)
                        console.log(result.stdout.trimEnd());
                    if (result.stderr)
                        console.error(result.stderr.trimEnd());
                }
                return EXIT.OK;
            }
            case "replay": {
                const id = positional[0];
                if (!id) {
                    console.log(colorize(!noColor, "yellow", "usage: drift replay <intent-id> [--checkout]"));
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.replay(id, { checkout: flags.has("checkout") });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    console.log(`intent:   ${result.intentId}`);
                    console.log(`git sha:  ${result.gitSha}`);
                    if (result.checkedOut)
                        console.log(colorize(!noColor, "green", "checked out"));
                    if (result.agentState)
                        console.log(`state:    ${result.agentState.slice(0, 80)}…`);
                    else
                        console.log("state:    (none recorded)");
                }
                return EXIT.OK;
            }
            case "doctor": {
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.doctor({ fix: flags.has("fix") });
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    for (const c of result.checks) {
                        const icon = c.ok
                            ? colorize(!noColor, "green", "✓")
                            : colorize(!noColor, "red", "✗");
                        console.log(`${icon} ${c.name}: ${c.detail}`);
                    }
                    if (result.fixed.length) {
                        console.log(colorize(!noColor, "yellow", `fixed: ${result.fixed.join(", ")}`));
                    }
                }
                return EXIT.OK;
            }
            case "export": {
                const drift = Drift.fromCwd(process.cwd());
                const data = drift.exportJson();
                const out = stringFlag(flags, "out");
                if (out) {
                    writeFileSync(out, data);
                    if (!json)
                        console.log(colorize(!noColor, "green", `exported to ${out}`));
                }
                else {
                    console.log(data);
                }
                return EXIT.OK;
            }
            case "verify-intent": {
                const id = positional[0];
                if (!id) {
                    console.log(colorize(!noColor, "yellow", "usage: drift verify-intent <intent-id>"));
                    return EXIT.ERROR;
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.verifyIntentSignature(id);
                if (json) {
                    console.log(JSON.stringify({ status: result.ok ? "ok" : "error", ...result }));
                }
                else {
                    console.log(result.ok ? colorize(!noColor, "green", `✓ ${id} — ${result.detail}`) : colorize(!noColor, "red", `✗ ${id} — ${result.detail}`));
                }
                return result.ok ? EXIT.OK : EXIT.ERROR;
            }
            case "version": {
                console.log(`drift ${VERSION}`);
                return EXIT.OK;
            }
            default:
                console.log(colorize(!noColor, "red", `unknown command: ${command}`));
                console.log(USAGE);
                return EXIT.ERROR;
        }
    }
    catch (err) {
        return fail(err);
    }
}
function stringFlag(flags, key) {
    const v = flags.get(key);
    return typeof v === "string" ? v : undefined;
}
function numberFlag(flags, key) {
    const v = stringFlag(flags, key);
    if (v === undefined)
        return undefined;
    const n = Number(v);
    // Reject Infinity/NaN (e.g. `--limit 1e999`) instead of propagating them
    // into SQL "LIMIT Infinity".
    return Number.isFinite(n) ? n : undefined;
}
const code = run(process.argv.slice(2));
process.exitCode = code;
//# sourceMappingURL=cli.js.map