#!/usr/bin/env node
/**
 * Drift GitHub App (PRD §16).
 *
 *   drift-app start                run the webhook server (env: PORT, GITHUB_APP_ID,
 *                                  GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, DRIFT_MASTER_KEY)
 *   drift-app dev <payload.json>   process one webhook payload with the live GitHub API
 *                                  (--dry-run prints the comment without posting)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { GitHubAppClient } from "./github.js";
import { handleWebhook, type WebhookEvent } from "./handler.js";
import { createWebhookServer } from "./server.js";

const USAGE = `Drift GitHub App

Usage:
  drift-app start                Run the webhook server on PORT (default 3000)
                                 Env: GITHUB_APP_ID, GITHUB_PRIVATE_KEY (path or PEM),
                                      GITHUB_WEBHOOK_SECRET, DRIFT_MASTER_KEY (optional),
                                      GITHUB_API_BASE_URL (optional, e.g. local mock),
                                      PORT
  drift-app dev <payload.json>   Process one webhook payload against the GitHub API
                                 (--dry-run: build the summary without posting)
`;

function loadPrivateKey(): string {
  const raw = process.env.GITHUB_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("GITHUB_PRIVATE_KEY is not set");
  // PEM content vs path
  return raw.includes("BEGIN") ? raw : readFileSync(resolve(raw), "utf8");
}

function loadPayload(path: string): { raw: string; json: Record<string, unknown> } {
  if (!existsSync(path)) throw new Error(`payload not found: ${path}`);
  const raw = readFileSync(path, "utf8");
  return { raw, json: JSON.parse(raw) as Record<string, unknown> };
}

async function runDev(payloadPath: string, dryRun: boolean): Promise<void> {
  const { raw, json } = loadPayload(payloadPath);
  const github = new GitHubAppClient({
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKeyPem: loadPrivateKey(),
    ...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
  });
  const event: WebhookEvent = {
    event: "pull_request",
    payload: json,
    rawBody: raw,
  };
  const result = await handleWebhook(event, {
    github,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    readOnly: dryRun,
  });
  if (dryRun && result.commentBody) {
    console.log(result.commentBody);
  }
  console.log(`[dev] action=${result.action} intents=${result.intentsFound}${result.error ? ` error=${result.error}` : ""}`);
  // error action (bad signature, malformed payload, permanent API error)
  // means the dev run failed — surface it in the exit code for scripts/CI.
  if (result.action === "error") process.exitCode = 1;
}

async function runStart(): Promise<void> {
  // A public webhook endpoint with HMAC verification disabled lets anyone
  // forge pull_request events — require the secret in server mode (dev mode
  // stays permissive because it processes a local file).
  if (!process.env.GITHUB_WEBHOOK_SECRET) {
    throw new Error("GITHUB_WEBHOOK_SECRET is required for drift-app start");
  }
  const github = new GitHubAppClient({
    appId: process.env.GITHUB_APP_ID ?? "",
    privateKeyPem: loadPrivateKey(),
    ...(process.env.GITHUB_API_BASE_URL ? { baseUrl: process.env.GITHUB_API_BASE_URL } : {}),
  });
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT: ${process.env.PORT ?? ""}`);
  }
  const { close, port: actualPort } = await createWebhookServer({
    github,
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET,
    port,
    log: (line) => console.log(line),
  });
  console.log(`drift-app listening on http://127.0.0.1:${actualPort}/webhook`);
  console.log("  point your GitHub App webhook URL here (or use scripts/webhook-proxy.sh with smee.io)");
  const shutdown = async () => {
    await close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // keep the server alive
  await new Promise<void>(() => {});
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  if (command === "start") {
    await runStart();
  } else if (command === "dev") {
    const payloadPath = args.slice(1).find((a) => !a.startsWith("-"));
    if (!payloadPath) throw new Error("drift-app dev requires a payload file");
    await runDev(payloadPath, args.includes("--dry-run"));
  } else {
    console.log(USAGE);
    process.exitCode = command === "help" ? 0 : 1;
  }
}

main().catch((err) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
