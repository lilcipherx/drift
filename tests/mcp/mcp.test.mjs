/**
 * MCP server e2e: spawn the server over stdio and drive it with
 * JSON-RPC 2.0 (initialize → initialized → tools/list → tools/call),
 * running the full realize → blame flow through the agent-facing skill.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const MCP = resolve(process.cwd(), "packages", "drift-mcp", "dist", "index.js");

function git(repo, args) {
  const res = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function setupRepo() {
  const repo = mkdtempSync(join(tmpdir(), "drift-mcp-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "MCP Test"]);
  git(repo, ["config", "user.email", "mcp@example.com"]);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "util.ts"), "export const n = 1;\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  // init drift via the CLI (the server delegates to it)
  spawnSync(process.execPath, [resolve(process.cwd(), "packages", "drift-cli", "dist", "cli.js"), "init"], {
    cwd: repo,
    encoding: "utf8",
  });
  return repo;
}

function createClient(repo) {
  const child = spawn(process.execPath, [MCP], {
    cwd: repo,
    env: { ...process.env, DRIFT_REPO: repo },
    stdio: ["pipe", "pipe", "inherit"],
  });
  let buffer = "";
  let seq = 0;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.id !== null) {
        const waiter = pending.get(msg.id);
        if (waiter) {
          pending.delete(msg.id);
          waiter(msg);
        }
      }
    }
  });

  return {
    child,
    request(method, params) {
      const id = ++seq;
      return new Promise((resolveP, rejectP) => {
        pending.set(id, (msg) => {
          if (msg.error) rejectP(new Error(JSON.stringify(msg.error)));
          else resolveP(msg.result);
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      });
    },
    notify(method, params) {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    },
    close() {
      child.kill();
    },
  };
}

const repo = setupRepo();
const client = createClient(repo);

after(() => {
  client.close();
});

test("initialize handshake", async () => {
  const result = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0" },
  });
  assert.equal(result.serverInfo.name, "drift");
  assert.ok(result.capabilities.tools);
  client.notify("notifications/initialized", {});
});

test("tools/list exposes all six drift tools", async () => {
  const result = await client.request("tools/list", {});
  const names = result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "drift_blame",
    "drift_context",
    "drift_log",
    "drift_realize",
    "drift_replay",
    "drift_verify",
  ]);
});

test("drift_realize commits with intent", async () => {
  writeFileSync(join(repo, "src", "util.ts"), "export const n = 1;\nexport const answer = () => 42;\n");
  const result = await client.request("tools/call", {
    name: "drift_realize",
    arguments: { prompt: "Add answer constant via MCP", model: "deepseek-v4" },
  });
  const text = result.content[0].text;
  const data = JSON.parse(text);
  assert.equal(data.status, "ok");
  assert.match(data.intentId, /^did_/);
});

test("drift_realize rejects syntax errors", async () => {
  writeFileSync(join(repo, "src", "util.ts"), "export const broken = ;\n");
  const result = await client.request("tools/call", {
    name: "drift_realize",
    arguments: { prompt: "break it" },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "error");
  assert.equal(data.type, "syntax");
  // restore a valid working tree for subsequent tests
  writeFileSync(join(repo, "src", "util.ts"), "export const n = 1;\nexport const answer = () => 42;\n");
});

test("drift_realize with empty prompt returns a JSON error", async () => {
  const result = await client.request("tools/call", {
    name: "drift_realize",
    arguments: { prompt: "" },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "error");
  assert.ok(data.details.includes("prompt"));
});

test("drift_verify with unknown intent returns a JSON error", async () => {
  const result = await client.request("tools/call", {
    name: "drift_verify",
    arguments: { intentId: "did_ffffffffffffffffffffffffffffffff" },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "error");
});

test("drift_blame returns originating prompt", async () => {
  const result = await client.request("tools/call", {
    name: "drift_blame",
    arguments: { file: "src/util.ts", functionName: "answer" },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "ok");
  assert.equal(data.intent.prompt, "Add answer constant via MCP");
});

test("drift_log lists intents", async () => {
  const result = await client.request("tools/call", {
    name: "drift_log",
    arguments: { limit: 10 },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "ok");
  assert.ok(data.intents.length >= 1);
});

test("drift_context hydrates reasoning for a file", async () => {
  const result = await client.request("tools/call", {
    name: "drift_context",
    arguments: { file: "src/util.ts", limit: 3 },
  });
  const data = JSON.parse(result.content[0].text);
  assert.equal(data.status, "ok");
  assert.ok(data.intents.length >= 1);
});

test("drift_verify runs recorded verification", async () => {
  // record an intent with a verification command
  writeFileSync(join(repo, "src", "util.ts"), "export const n = 1;\nexport const answer = 42;\nexport const q = 7;\n");
  const realize = await client.request("tools/call", {
    name: "drift_realize",
    arguments: { prompt: "add q", verifyCmd: 'node -e "process.exit(0)"' },
  });
  const realizeData = JSON.parse(realize.content[0].text);
  const verify = await client.request("tools/call", {
    name: "drift_verify",
    arguments: { intentId: realizeData.intentId },
  });
  const verifyData = JSON.parse(verify.content[0].text);
  assert.equal(verifyData.status, "ok");
  assert.equal(verifyData.verifyStatus, "pass");
});
