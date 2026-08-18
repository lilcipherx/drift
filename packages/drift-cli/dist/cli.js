#!/usr/bin/env node
/**
 * Drift CLI (PRD §14.1).
 *   drift init | realize | log | blame | context | verify | replay | doctor | export
 * Exit codes: 0 ok, 1 error, 2 syntax, 3 no changes, 4 key, 5 corrupt.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, sep } from "node:path";
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

Git tracks what changed. Drift tracks why.

Usage:
  drift init                       Initialize .drift metadata for this repository
  drift status                     Show repository state and the next step
  drift realize -p "prompt" [--summary "safe public text"] [files...] [--model m] [--agent] [--state b64] [--verify-cmd cmd] [--no-ast]
                                   Commit changes with semantic intent (rejects broken syntax)
  drift log [--author x] [--model m] [--file f] [--limit n] [--json]
  drift blame <file> --line N | --function name [--json]
  drift context <file> [--limit 5] [--json]
  drift verify <intent-id> [--run] [--allow-untrusted-command] [--json]
                                   Information by default (no execution); --run executes the
                                   recorded command only when the manifest is validly signed
  drift replay <intent-id> [--checkout] [--json]
  drift doctor [--fix] [--json]
  drift export [--out file] [--include-private-prompt] [--allow-repository-output]
  drift verify-intent <intent-id>  Check an intent's Ed25519 signature
  drift key import --file <path>   Import the repository private signing key (read-only clone)
  drift keyring init               Bootstrap the multi-signer keyring (anchor = key.pem)
  drift keyring add --file <pem> [--reason <text>]
                                   Add a trusted maintainer key (authorized by an active key)
  drift keyring revoke <fp> [--reason <text>]   Revoke a key (compromised key: stop trust immediately)
  drift keyring remove <fp> [--reason <text>]   Remove a revoked/retired key from the active set
  drift keyring list               Show all keys + the append-only audit history

Options:
  --json       machine-readable output
  --no-color   disable ANSI colors
  --summary TEXT   public summary for the intent (realize). Redacted, sanitized
                   and length-limited; never derived from the prompt.
  --include-private-prompt   ALSO output the full local prompt (log/blame/context/export)
                             — sensitive; never use in CI or on public surfaces
  --allow-repository-output  permit drift export --out inside the git repository
                             (private exports should go outside the repo)
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
                // A following token is this flag's value unless it looks like another
                // flag. Negative numbers (`--limit -3`) ARE values, never flags.
                if (next !== undefined && (!next.startsWith("-") || /^-\d/.test(next))) {
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
    const includePrompt = flags.has("include-private-prompt");
    if (includePrompt) {
        // Never pollute JSON stdout — warn on stderr, and only when the flag is
        // actually used. The Action/App never pass this flag.
        console.error(colorize(!noColor, "yellow", "warning: --include-private-prompt exposes the full local prompt — do not use in CI or public surfaces"));
    }
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
    // Usage errors stay machine-readable under --json so MCP tool calls never
    // receive plain-text output on stdout.
    const usageError = (message) => {
        if (json) {
            console.log(JSON.stringify({ status: "error", type: "error", message, exitCode: EXIT.ERROR }));
        }
        else {
            console.log(colorize(!noColor, "yellow", message));
        }
        return EXIT.ERROR;
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
                    console.log(`  repo:    ${result.repoRoot}`);
                    console.log(`  key:     ${result.driftDir}\\keys\\ed25519.pem`);
                    console.log(`  pubkey:  ${result.publicKeyPem.slice(0, 40)}…`);
                    console.log(`  signer:  ${result.signerState}`);
                    if (result.signerState === "read-only") {
                        console.log(colorize(!noColor, "yellow", "  note: clone has public provenance but no private signing key — read commands work, new signed intents need `drift key import --file <path>`"));
                    }
                    console.log("\nNext: edit a file, then run:");
                    console.log(colorize(!noColor, "bold", "  drift realize -p \"what you changed and why\""));
                }
                return EXIT.OK;
            }
            case "status": {
                const result = Drift.status(process.cwd());
                if (json) {
                    console.log(JSON.stringify({ status: result.initialized ? "ok" : "error", ...result }));
                }
                else if (!result.initialized) {
                    if (result.reason === "no-git") {
                        console.log(colorize(!noColor, "yellow", "Not inside a git repository."));
                    }
                    else {
                        console.log(colorize(!noColor, "yellow", "Not a Drift repository yet."));
                    }
                    console.log("\nNext:");
                    console.log(colorize(!noColor, "bold", "  drift init"));
                    console.log("  (creates .drift/ — SQLite intent store, config, signing key)");
                }
                else {
                    console.log(colorize(!noColor, "green", "✓ Drift repository"));
                    console.log(`  repo:        ${result.repoRoot}`);
                    console.log(`  intents:     ${result.intents ?? 0}`);
                    console.log(`    committed public intents: ${result.publicIntents ?? 0}`);
                    console.log(`    local legacy records:    ${result.localIntents ?? 0}`);
                    const diag = result.associationDiagnostics;
                    const provenanceErrors = (result.malformedManifests?.length ?? 0) +
                        (diag?.trailerWithoutManifest.length ?? 0) +
                        (diag?.ambiguous.length ?? 0) +
                        (diag?.replayed.length ?? 0) +
                        (diag?.duplicateTrailers.length ?? 0);
                    console.log(provenanceErrors > 0
                        ? colorize(!noColor, "yellow", `    provenance errors:  ${provenanceErrors}`)
                        : `    provenance errors:  ${provenanceErrors}`);
                    if (result.lastIntent) {
                        console.log(`  last intent: ${result.lastIntent.id} (${new Date(result.lastIntent.timestamp).toISOString().slice(0, 19).replace("T", " ")})`);
                    }
                    console.log(`  prompt mode: ${result.promptMode}`);
                    console.log(`  encryption:  ${result.encryption ? "on (AES-256-GCM)" : "off"}`);
                    console.log(`  signer:      ${result.signerState ?? "?"}`);
                    if (result.publicKeyFingerprint) {
                        console.log(`  pubkey fp:   ${result.publicKeyFingerprint}${result.privateKeyAvailable ? "" : " (private key absent — read-only)"}`);
                    }
                    console.log(`  signing:     ${result.signingAllowed ? "allowed" : "blocked"}`);
                    if (result.malformedManifests && result.malformedManifests.length > 0) {
                        for (const m of result.malformedManifests) {
                            const first = m.errors[0];
                            console.error(colorize(!noColor, "yellow", `  warning: malformed public manifest .drift/public/intents/${m.id}.json (${first?.field}: ${first?.message})`));
                        }
                    }
                    if (result.associationDiagnostics) {
                        const d = result.associationDiagnostics;
                        const problems = [];
                        if (d.trailerWithoutManifest.length > 0) {
                            problems.push(`${d.trailerWithoutManifest.length} trailer-without-manifest (${d.trailerWithoutManifest.join(", ")})`);
                        }
                        if (d.ambiguous.length > 0)
                            problems.push(`${d.ambiguous.length} ambiguous (${d.ambiguous.join(", ")})`);
                        if (d.replayed.length > 0)
                            problems.push(`${d.replayed.length} replayed (${d.replayed.join(", ")})`);
                        if (d.duplicateTrailers.length > 0)
                            problems.push(`${d.duplicateTrailers.length} duplicate-trailer (${d.duplicateTrailers.join(", ")})`);
                        if (d.orphanManifests.length > 0)
                            problems.push(`${d.orphanManifests.length} orphan-manifest`);
                        console.log(problems.length > 0
                            ? colorize(!noColor, "yellow", `  association diagnostics: ${problems.join("; ")} — inspect with \`drift log --json\``)
                            : `  associations: ${result.intentAssociations?.unique ?? 0} unique, ${result.intentAssociations?.missing ?? 0} missing`);
                    }
                    else if (result.intentAssociations) {
                        const a = result.intentAssociations;
                        console.log(`  associations: ${a.unique} unique, ${a.missing} missing`);
                    }
                    const branch = result.gitBranch ?? "(detached)";
                    console.log(`  git:         ${branch} @ ${result.gitHead ?? "?"}${result.gitDirty ? " (uncommitted changes)" : " (clean)"}`);
                    if (result.signerState === "read-only") {
                        console.log(colorize(!noColor, "yellow", "  note: no private signing key — new signed intents require `drift key import --file <path>`"));
                    }
                    console.log("\nNext:");
                    console.log(colorize(!noColor, "bold", "  drift realize -p \"what you changed and why\""));
                    console.log(colorize(!noColor, "bold", "  drift blame <file> --function <name>"));
                }
                return result.initialized ? EXIT.OK : EXIT.ERROR;
            }
            case "realize": {
                const prompt = stringFlag(flags, "prompt");
                if (!prompt) {
                    return usageError("missing -p \"prompt\" — describe your change");
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.realize({
                    prompt,
                    summary: stringFlag(flags, "summary") ?? undefined,
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
                const manifestDiagnostics = drift.publicManifestDiagnostics();
                if (manifestDiagnostics.length > 0) {
                    for (const d of manifestDiagnostics) {
                        const first = d.errors[0];
                        const where = first ? `${first.field}: ${first.message}` : "invalid manifest";
                        const line = `drift: warning: skipping malformed public manifest .drift/public/intents/${d.id}.json (${where})`;
                        if (json)
                            process.stderr.write(`${line}\n`);
                        else
                            console.error(colorize(!noColor, "yellow", line));
                    }
                }
                if (json) {
                    const serializable = entries.map((e) => includePrompt ? e : omitKey(e, "prompt"));
                    const out = { status: "ok", intents: serializable };
                    if (manifestDiagnostics.length > 0)
                        out.warnings = manifestDiagnostics;
                    console.log(JSON.stringify(out));
                }
                else if (entries.length === 0) {
                    console.log(colorize(!noColor, "yellow", "No intents yet. Run `drift realize -p \"...\"` after your next change."));
                }
                else {
                    printTable([
                        ["ID", "AUTHOR", "MODEL", "TIME", "SUMMARY"],
                        ...entries.map((e) => {
                            // Ambiguous/replayed/duplicate trailer associations are a
                            // provenance red flag — never silently collapse them to one
                            // commit in human output.
                            const flag = e.association?.state === "ambiguous"
                                ? " ⚠ambiguous"
                                : e.association?.state === "replayed"
                                    ? " ⚠replayed"
                                    : e.association?.state === "duplicate-in-commit"
                                        ? " ⚠duplicate-trailer"
                                        : "";
                            return [
                                `${e.id}${flag}`,
                                `${e.authorId}(${e.authorType})`,
                                e.model ?? "-",
                                new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " "),
                                (includePrompt ? e.prompt : e.summary ?? "").slice(0, 60),
                            ];
                        }),
                    ]);
                }
                return EXIT.OK;
            }
            case "blame": {
                const file = positional[0];
                if (!file) {
                    return usageError("usage: drift blame <file> --line N | --function NAME");
                }
                const drift = Drift.fromCwd(process.cwd());
                const line = numberFlag(flags, "line");
                const functionName = stringFlag(flags, "function");
                const result = drift.blame(file, { line, functionName });
                if (json) {
                    const serializable = {
                        status: "ok",
                        file: result.file,
                        line: result.line,
                        functionName: result.functionName,
                        gitSha: result.gitSha,
                        committed: result.committed,
                        baseline: result.baseline,
                        ...(result.association ? { association: result.association } : {}),
                        intent: result.intent
                            ? {
                                ...omitKey(result.intent, "prompt"),
                                ...(includePrompt ? { prompt: result.intent.prompt } : {}),
                            }
                            : null,
                    };
                    console.log(JSON.stringify(serializable));
                }
                else {
                    console.log(`${colorize(!noColor, "bold", result.file)}:${result.line}${result.functionName ? ` (${result.functionName})` : ""}`);
                    if (!result.committed) {
                        console.log(colorize(!noColor, "yellow", "  uncommitted change — not yet part of any intent"));
                    }
                    else if (result.association?.state === "ambiguous") {
                        console.log(colorize(!noColor, "yellow", `  commit association: ambiguous — ${result.association.candidates?.length ?? 0} intents touch this file; no single intent is presented as the reason`));
                        console.log(colorize(!noColor, "yellow", `    candidates: ${(result.association.candidates ?? []).join(", ")}`));
                    }
                    else if (result.baseline) {
                        console.log(colorize(!noColor, "yellow", "  pre-Drift baseline (no intent recorded)"));
                    }
                    else if (result.intent) {
                        console.log("");
                        console.log("  Why:");
                        const why = includePrompt
                            ? result.intent.prompt
                            : result.intent.summary || "_(no summary recorded — private prompt unavailable)";
                        console.log(`    ${why}`);
                        console.log("");
                        console.log("  Generated by:");
                        const who = `${result.intent.author.type} @ ${result.intent.author.identifier}`;
                        console.log(`    ${who}${result.intent.author.model ? ` (model: ${result.intent.author.model})` : ""}`);
                        if (result.intent.verifyCmd) {
                            console.log("");
                            console.log("  Verification:");
                            console.log(`    ${result.intent.verifyCmd}`);
                            console.log(`    (run \`drift verify ${result.intent.id} --run\` to execute the recorded verification command)`);
                        }
                        console.log("");
                        console.log("  Intent:");
                        console.log(`    ${result.intent.id}`);
                        console.log("");
                        console.log("  Commit:");
                        console.log(`    ${result.gitSha}  signature: ${result.intent.signatureValid ? "valid" : "INVALID"}`);
                    }
                }
                return EXIT.OK;
            }
            case "context": {
                const file = positional[0];
                if (!file) {
                    return usageError("usage: drift context <file> [--limit N]");
                }
                const drift = Drift.fromCwd(process.cwd());
                const entries = drift.context(file, numberFlag(flags, "limit") ?? 5);
                if (json) {
                    const serializable = entries.map((e) => includePrompt ? e : omitKey(e, "prompt"));
                    console.log(JSON.stringify({ status: "ok", file, intents: serializable }));
                }
                else if (entries.length === 0) {
                    console.log(colorize(!noColor, "yellow", `No intents touch ${file}.`));
                }
                else {
                    printTable([
                        ["ID", "TIME", "SUMMARY"],
                        ...entries.map((e) => [
                            e.id,
                            new Date(e.timestamp).toISOString().slice(0, 19).replace("T", " "),
                            (includePrompt ? e.prompt : e.summary ?? "").slice(0, 80),
                        ]),
                    ]);
                }
                return EXIT.OK;
            }
            case "verify": {
                const id = positional[0];
                if (!id) {
                    return usageError("usage: drift verify <intent-id> [--run] [--allow-untrusted-command]");
                }
                const drift = Drift.fromCwd(process.cwd());
                const run = flags.has("run");
                const allowUntrusted = flags.has("allow-untrusted-command");
                const inheritEnv = flags.has("inherit-env");
                if (allowUntrusted && !run) {
                    console.error(colorize(!noColor, "yellow", "warning: --allow-untrusted-command has no effect without --run (nothing is executed by default)"));
                }
                if (run && allowUntrusted) {
                    console.error(colorize(!noColor, "red", "⚠ DANGER: --run --allow-untrusted-command will execute a repository-provided command that may be untrusted. Only proceed if you trust this repository."));
                }
                if (inheritEnv && !run) {
                    console.error(colorize(!noColor, "yellow", "warning: --inherit-env has no effect without --run (nothing is executed by default)"));
                }
                if (run && inheritEnv) {
                    console.error(colorize(!noColor, "red", "⚠ DANGER: --run --inherit-env passes the full process environment (including credentials) to a repository-provided command."));
                }
                const result = drift.verify(id, { run, allowUntrustedCommand: allowUntrusted, inheritEnv });
                if (json) {
                    console.log(JSON.stringify({
                        status: "ok",
                        intentId: result.intentId,
                        verifyStatus: result.status,
                        signature: result.signature,
                        verifyCmd: result.verifyCmd,
                        exitCode: result.exitCode,
                        stdout: result.stdout,
                        stderr: result.stderr,
                        message: result.message,
                    }));
                }
                else {
                    const statusLabel = {
                        pass: colorize(!noColor, "green", "PASS"),
                        fail: colorize(!noColor, "red", "FAIL"),
                        timeout: colorize(!noColor, "red", "TIMEOUT"),
                        "no-command": colorize(!noColor, "yellow", "no verification command recorded"),
                        "not-executed": colorize(!noColor, "yellow", "NOT EXECUTED"),
                        refused: colorize(!noColor, "red", "REFUSED"),
                    };
                    console.log(`${id}: ${statusLabel[result.status] ?? result.status}  [signature: ${result.signature}]`);
                    console.log(result.message);
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
                    return usageError("usage: drift replay <intent-id> [--checkout]");
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
                const includePrivate = flags.has("include-private-prompt");
                if (includePrivate) {
                    console.error(colorize(!noColor, "yellow", "warning: --include-private-prompt exports the full local prompt — treat the output as secret, keep it outside the git repository"));
                }
                const drift = Drift.fromCwd(process.cwd());
                if (!includePrivate) {
                    const diagnostics = drift.publicManifestDiagnostics();
                    for (const d of diagnostics) {
                        const first = d.errors[0];
                        console.error(colorize(!noColor, "yellow", `drift: warning: skipping malformed public manifest .drift/public/intents/${d.id}.json (${first?.field}: ${first?.message})`));
                    }
                }
                const data = drift.exportJson({ includePrivatePrompt: includePrivate });
                const out = stringFlag(flags, "out");
                if (out) {
                    // Private exports must not be written inside the repository where a
                    // stray `git add .` could commit them — refuse unless the user
                    // explicitly overrides.
                    const absOut = resolve(out);
                    const inside = absOut.startsWith(drift.repoRoot + sep) || absOut === drift.repoRoot;
                    if (includePrivate && inside && !flags.has("allow-repository-output")) {
                        return usageError(`refusing to write a private prompt export inside the repository (${out}). Write it outside the repo or pass --allow-repository-output to override.`);
                    }
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
                    return usageError("usage: drift verify-intent <intent-id>");
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.verifyIntentSignature(id);
                if (json) {
                    console.log(JSON.stringify({ status: result.ok ? "ok" : "error", ...result }));
                }
                else {
                    const icon = result.ok ? colorize(!noColor, "green", "✓") : colorize(!noColor, "red", "✗");
                    console.log(`${icon} ${id} — ${result.detail} [${result.state}]`);
                }
                return result.ok ? EXIT.OK : EXIT.ERROR;
            }
            case "key": {
                const sub = positional[0];
                if (sub !== "import") {
                    return usageError("usage: drift key import --file <path-to-private-key.pem>");
                }
                const file = stringFlag(flags, "file");
                if (!file) {
                    return usageError("usage: drift key import --file <path-to-private-key.pem>");
                }
                const drift = Drift.fromCwd(process.cwd());
                const result = drift.keyImport(file);
                if (json) {
                    console.log(JSON.stringify({ status: "ok", ...result }));
                }
                else {
                    console.log(colorize(!noColor, "green", "✓ repository signing key imported"));
                    console.log(`  signer:    ${result.signerState}`);
                    console.log(`  pubkey fp: ${result.publicKeyFingerprint ?? "?"}`);
                    console.log("  New signed intents can now be created with `drift realize`.");
                }
                return EXIT.OK;
            }
            case "keyring": {
                const sub = positional[0];
                const drift = Drift.fromCwd(process.cwd());
                const reason = stringFlag(flags, "reason") ?? null;
                if (sub === "init") {
                    const result = drift.keyringInit();
                    if (json) {
                        console.log(JSON.stringify({ ...result, ok: true }));
                    }
                    else if (result.status === "created") {
                        console.log(colorize(!noColor, "green", "✓ multi-signer keyring created"));
                        console.log(`  keyring:   ${result.keyringPath}`);
                        console.log("  Add a maintainer key with:  drift keyring add --file <public-key.pem>");
                    }
                    else {
                        console.log(`Keyring already exists at ${result.keyringPath} (${result.active} active key${result.active === 1 ? "" : "s"}).`);
                    }
                    return EXIT.OK;
                }
                if (sub === "add") {
                    const file = stringFlag(flags, "file");
                    if (!file) {
                        return usageError("usage: drift keyring add --file <path-to-public-key.pem> [--reason <text>]");
                    }
                    const result = drift.keyringAdd(file, reason);
                    if (json) {
                        console.log(JSON.stringify({ status: "ok", ...result }));
                    }
                    else {
                        console.log(colorize(!noColor, "green", `✓ key ${result.fingerprint} added (seq ${result.seq})`));
                        console.log(`  active keys: ${result.active}`);
                    }
                    return EXIT.OK;
                }
                if (sub === "revoke") {
                    const fp = positional[1];
                    if (!fp) {
                        return usageError("usage: drift keyring revoke <fingerprint> [--reason <text>]");
                    }
                    const result = drift.keyringRevoke(fp, reason);
                    if (json) {
                        console.log(JSON.stringify({ status: "ok", ...result }));
                    }
                    else {
                        console.log(colorize(!noColor, "green", `✓ key ${result.fingerprint} revoked (seq ${result.seq})`));
                        console.log(`  active keys: ${result.active}`);
                        console.log("  The revoked key can no longer sign or authorize keyring changes.");
                    }
                    return EXIT.OK;
                }
                if (sub === "remove") {
                    const fp = positional[1];
                    if (!fp) {
                        return usageError("usage: drift keyring remove <fingerprint> [--reason <text>]");
                    }
                    const result = drift.keyringRemove(fp, reason);
                    if (json) {
                        console.log(JSON.stringify({ status: "ok", ...result }));
                    }
                    else {
                        console.log(colorize(!noColor, "green", `✓ key ${result.fingerprint} removed (seq ${result.seq})`));
                        console.log(`  active keys: ${result.active}`);
                    }
                    return EXIT.OK;
                }
                if (sub === "list") {
                    const result = drift.keyringList();
                    if (json) {
                        console.log(JSON.stringify({ status: "ok", ...result }));
                    }
                    else if (result.malformed) {
                        console.log(colorize(!noColor, "red", `✗ keyring is malformed: ${result.malformed}`));
                        return EXIT.KEY;
                    }
                    else if (!result.present) {
                        console.log("No keyring in this repository (single-signer trust root only).");
                        console.log("  Initialize one with:  drift keyring init");
                    }
                    else {
                        console.log("Trusted signing keys:");
                        for (const e of result.entries) {
                            const tag = e.status === "active"
                                ? colorize(!noColor, "green", "active")
                                : colorize(!noColor, "red", e.status);
                            console.log(`  ${e.fingerprint}  ${tag}  addedBy ${e.addedBy}  ${e.reason ?? ""}`);
                        }
                        console.log("Audit log:");
                        for (const a of result.audit) {
                            console.log(`  #${a.seq} ${a.action} ${a.fingerprint} by ${a.by} (${a.reason ?? ""})`);
                        }
                    }
                    return EXIT.OK;
                }
                return usageError("usage: drift keyring <init|add|revoke|remove|list>");
            }
            case "version": {
                console.log(`drift ${VERSION}`);
                return EXIT.OK;
            }
            default:
                if (json) {
                    console.log(JSON.stringify({
                        status: "error",
                        type: "error",
                        message: `unknown command: ${command}`,
                        exitCode: EXIT.ERROR,
                    }));
                }
                else {
                    console.log(colorize(!noColor, "red", `unknown command: ${command}`));
                    console.log(USAGE);
                }
                return EXIT.ERROR;
        }
    }
    catch (err) {
        return fail(err);
    }
}
/** Return a copy of `obj` without the given key. */
function omitKey(obj, key) {
    const { [key]: _removed, ...rest } = obj;
    return rest;
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