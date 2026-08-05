/**
 * HTTP webhook server (PRD §16.3 "drift-app dev"): receives GitHub deliveries
 * on POST /webhook, verifies the HMAC signature, and delegates to the handler.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { handleWebhook, type WebhookDeps, type WebhookEvent } from "./handler.js";

export interface ServerOptions extends WebhookDeps {
  port: number;
  host?: string;
  log?: (line: string) => void;
  /** Max accepted webhook body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
}

const MAX_BODY_BYTES = 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function createWebhookServer(opts: ServerOptions) {
  const log = opts.log ?? (() => {});
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/webhook") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const rawBody = await readBody(req, opts.maxBodyBytes ?? MAX_BODY_BYTES);
      const event: WebhookEvent = {
        event: req.headers["x-github-event"] as string ?? "",
        signature: req.headers["x-hub-signature-256"] as string | undefined,
        payload: rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
        rawBody,
      };
      const result = await handleWebhook(event, opts);
      log(`[webhook] ${result.action} (${result.intentsFound} intents)${result.error ? ` — ${result.error}` : ""}`);
      // Client-side errors (bad signature, malformed payload) are not
      // retryable — ack with 200 so GitHub stops redelivering. Only transient
      // failures (GitHub API/network) get 500 and trigger GitHub's retries.
      const status = result.action === "error" && result.retryable ? 500 : 200;
      sendJson(res, status, result);
    } catch (err) {
      log(`[webhook] fatal: ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { error: "internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  return {
    server,
    port: actualPort,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
