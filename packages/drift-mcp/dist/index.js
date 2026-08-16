#!/usr/bin/env node
/**
 * Drift MCP server (PRD §3.1, §14.2) — the agent-facing skill surface.
 *
 * Exposes capabilities agents did not have before:
 *   drift_realize  commit changes with intent, rejecting broken syntax
 *   drift_context  hydrate reasoning for a file
 *   drift_replay   restore a prior cognitive state
 *   drift_blame    ask "why does this function exist?"
 *   drift_verify   re-run an intent's verification command
 *   drift_log      inspect intent history
 *
 * Contract (PRD §11): this server never touches git or SQLite directly —
 * every tool delegates to the `drift` CLI as a child process.
 *
 * Configure the repo with the `DRIFT_REPO` env var (defaults to the server's
 * working directory).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const SERVER_NAME = "drift";
// --- locate the CLI ---------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const requireFromHere = createRequire(import.meta.url);
const CLI_CANDIDATES = [
    join(HERE, "..", "..", "drift-cli", "dist", "cli.js"),
    join(HERE, "..", "drift-cli", "dist", "cli.js"),
];
function findCli() {
    // 1. Monorepo layout: sibling package in the same checkout.
    for (const candidate of CLI_CANDIDATES) {
        if (existsSync(candidate))
            return candidate;
    }
    // 2. Installed @drift/cli (npm / npx): resolve from this package's own
    //    dependency tree, wherever npm hoisted it.
    try {
        const installed = requireFromHere.resolve("@drift/cli/dist/cli.js");
        if (existsSync(installed))
            return installed;
    }
    catch {
        // fall through
    }
    // 3. A separately-installed @drift/cli next to the consumer project.
    const cwdResolved = resolve(process.cwd(), "node_modules", "@drift", "cli", "dist", "cli.js");
    if (existsSync(cwdResolved))
        return cwdResolved;
    throw new Error("Drift CLI not found. Build the workspace (npm run build) or install @drift/cli.");
}
let VERSION = "0.0.0";
try {
    // dist/index.js → ../package.json (works in the monorepo and in the
    // installed @drift/mcp under node_modules)
    VERSION = requireFromHere("../package.json").version ?? VERSION;
}
catch {
    // packaged without package.json — fall back
}
const CLI = findCli();
const repoDir = process.env.DRIFT_REPO || process.cwd();
function runCli(args) {
    const res = spawnSync(process.execPath, [CLI, ...args, "--json"], {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
    });
    const raw = {
        stdout: (res.stdout ?? "").toString(),
        stderr: (res.stderr ?? "").toString(),
        status: res.status ?? -1,
    };
    let data = null;
    let error = null;
    const merged = raw.stdout.trim() || raw.stderr.trim();
    try {
        const parsed = JSON.parse(merged || "{}");
        if (parsed.status === "ok") {
            data = parsed;
        }
        else {
            error = {
                type: parsed?.type ?? "error",
                message: parsed?.message || raw.stderr.trim() || "drift command failed",
                exitCode: parsed?.exitCode ?? raw.status,
            };
        }
    }
    catch {
        error = {
            type: "error",
            message: raw.stderr.trim() || raw.stdout.trim() || "drift command failed",
            exitCode: raw.status,
        };
    }
    return { ok: data !== null, data, error, raw };
}
function text(content) {
    return {
        content: [{ type: "text", text: JSON.stringify(content, null, 2) }],
    };
}
const server = new McpServer({ name: SERVER_NAME, version: VERSION });
server.registerTool("drift_realize", {
    title: "Drift Realize",
    description: "Commit changes with semantic intent tracking. Use instead of `git commit`. Rejects broken syntax before commit (never pollutes history). Prompts are redacted for secrets.",
    inputSchema: {
        prompt: z.string().describe("What you changed and why (the intent)"),
        files: z.array(z.string()).optional().describe("Optional file paths to include (default: all changes)"),
        model: z.string().optional().describe("Model identifier, e.g. claude-3-5-sonnet"),
        agentState: z.string().optional().describe("base64 JSON cognitive state to checkpoint for replay"),
        verifyCmd: z.string().optional().describe("Verification command recorded with the intent"),
    },
}, async (args) => {
    const cliArgs = ["realize", "-p", String(args.prompt ?? ""), "--agent"];
    if (Array.isArray(args.files))
        cliArgs.push(...args.files.map(String));
    if (args.model)
        cliArgs.push("--model", String(args.model));
    if (args.agentState)
        cliArgs.push("--state", String(args.agentState));
    if (args.verifyCmd)
        cliArgs.push("--verify-cmd", String(args.verifyCmd));
    const out = runCli(cliArgs);
    if (!out.ok) {
        return text({
            status: "error",
            type: out.error?.type ?? "syntax",
            details: out.error?.message,
            exitCode: out.error?.exitCode,
        });
    }
    return text(out.data);
});
server.registerTool("drift_context", {
    title: "Drift Context",
    description: "Return the last N intents for a file to hydrate reasoning before editing. Use to ground yourself in prior intent.",
    inputSchema: {
        file: z.string(),
        limit: z.number().int().positive().optional(),
    },
}, async (args) => {
    const cliArgs = ["context", String(args.file)];
    if (args.limit)
        cliArgs.push("--limit", String(args.limit));
    const out = runCli(cliArgs);
    if (!out.ok)
        return text({ status: "error", details: out.error?.message });
    return text(out.data);
});
server.registerTool("drift_replay", {
    title: "Drift Replay",
    description: "Restore a prior agent cognitive state. Optionally checks out the intent's commit first. Use to resume a crashed or interrupted task.",
    inputSchema: {
        intentId: z.string(),
        checkout: z.boolean().optional(),
    },
}, async (args) => {
    const cliArgs = ["replay", String(args.intentId)];
    if (args.checkout)
        cliArgs.push("--checkout");
    const out = runCli(cliArgs);
    if (!out.ok)
        return text({ status: "error", details: out.error?.message });
    return text(out.data);
});
server.registerTool("drift_blame", {
    title: "Drift Blame",
    description: 'Ask "why does this function exist?" — returns the safe public summary, model and intent for a line or function (never the private prompt).',
    inputSchema: {
        file: z.string(),
        line: z.number().int().positive().optional().describe("1-based line number"),
        functionName: z.string().optional().describe("Function name to blame"),
    },
}, async (args) => {
    const cliArgs = ["blame", String(args.file)];
    if (args.functionName)
        cliArgs.push("--function", String(args.functionName));
    else if (args.line)
        cliArgs.push("--line", String(args.line));
    const out = runCli(cliArgs);
    if (!out.ok)
        return text({ status: "error", details: out.error?.message });
    return text(out.data);
});
server.registerTool("drift_verify", {
    title: "Drift Verify",
    description: "Re-run the verification command recorded in an intent and report pass/fail.",
    inputSchema: {
        intentId: z.string(),
    },
}, async (args) => {
    const out = runCli(["verify", String(args.intentId)]);
    if (!out.ok)
        return text({ status: "error", details: out.error?.message });
    return text(out.data);
});
server.registerTool("drift_log", {
    title: "Drift Log",
    description: "List recorded intents (ID, author, model, public summary, files) with optional filters. The full private prompt is never returned.",
    inputSchema: {
        author: z.string().optional(),
        model: z.string().optional(),
        file: z.string().optional(),
        limit: z.number().int().positive().optional(),
    },
}, async (args) => {
    const cliArgs = ["log"];
    if (args.author)
        cliArgs.push("--author", String(args.author));
    if (args.model)
        cliArgs.push("--model", String(args.model));
    if (args.file)
        cliArgs.push("--file", String(args.file));
    if (args.limit)
        cliArgs.push("--limit", String(args.limit));
    const out = runCli(cliArgs);
    if (!out.ok)
        return text({ status: "error", details: out.error?.message });
    return text(out.data);
});
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map