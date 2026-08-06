/**
 * HTTP webhook server (PRD §16.3 "drift-app dev"): receives GitHub deliveries
 * on POST /webhook, verifies the HMAC signature, and delegates to the handler.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { handleWebhook, type WebhookDeps, type WebhookEvent } from "./handler.js";

export interface ServerOptions extends WebhookDeps {
  port: number;
  host?: string;
  log?: (line: string) => void;
  /** Max accepted webhook body size in bytes (default 1 MB). */
  maxBodyBytes?: number;
  /** Grace for in-flight requests on close() before force-close (ms). */
  closeGraceMs?: number;
}

// GitHub webhook payloads can reach several MB on busy PRs — keep a bounded
// but realistic cap (8 MB) instead of rejecting legitimate large deliveries.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("aborted", onAborted);
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        cleanup();
        // Stop buffering but keep draining the rest of the body so the
        // server can answer with 413 and close cleanly instead of resetting
        // the connection mid-send (which surfaces as a socket error).
        req.removeAllListeners("data");
        req.resume();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const onError = (e: Error) => {
      cleanup();
      reject(e);
    };
    const onAborted = () => {
      cleanup();
      reject(new Error("request aborted"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("aborted", onAborted);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  // The request may already have been terminated (timeout, oversized body,
  // aborted client) — writing again would throw ERR_HTTP_HEADERS_SENT or
  // ERR_STREAM_DESTROYED (client disconnect destroys the response stream).
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function createWebhookServer(opts: ServerOptions) {
  const log = opts.log ?? (() => {});
  const server = createServer(async (req, res) => {
    // Bound slow/abandoned connections so idle sockets never hold the server.
    req.setTimeout(30_000, () => {
      // The response may already be gone (client disconnected) — writing
      // would throw and crash the process from the timer callback.
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      res.writeHead(408, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "request timeout" }));
      req.destroy();
    });
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
      const message = err instanceof Error ? err.message : String(err);
      // Oversized payloads are a client error — ack with 413 so GitHub stops
      // redelivering (5xx would trigger endless retries).
      if (message.includes("body too large")) {
        sendJson(res, 413, { error: "request body too large" });
        return;
      }
      log(`[webhook] fatal: ${message}`);
      sendJson(res, 500, { error: "internal error" });
    }
  });

  // Own the connection registry: closeIdleConnections() only releases sockets
  // that completed a request — a client that connected but never sent one (or
  // sent a partial one) is treated as active and would block shutdown forever.
  const connections = new Set<Socket>();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolve());
  });

  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : opts.port;

  /** Release every connection that is not mid-request. Idempotent: safe to
   *  re-run while closing, which is exactly what the sweep below does. */
  const releaseIdle = () => {
    server.closeIdleConnections();
    for (const socket of connections) {
      // `_httpMessage` is bound by ServerResponse.assignSocket as soon as
      // request HEADERS are parsed — before the body is read or the handler
      // runs — and nulled after the response finishes. So a mid-body /
      // mid-handler webhook POST is spared; only request-less or
      // already-finished sockets are destroyed.
      if ((socket as unknown as { _httpMessage?: unknown })._httpMessage) continue;
      socket.destroy();
    }
  };

  const graceMs =
    Number.isFinite(opts.closeGraceMs) && (opts.closeGraceMs ?? 0) >= 0
      ? (opts.closeGraceMs as number)
      : 5_000;
  let closePromise: Promise<void> | null = null;

  return {
    server,
    port: actualPort,
    // Idempotent: repeated calls (e.g. SIGINT+SIGTERM) share one promise.
    close: () => {
      if (!closePromise) {
        closePromise = new Promise<void>((resolve) => {
          // Bare server.close() waits for EVERY open connection — an idle
          // keep-alive or request-less client would block graceful shutdown
          // forever. Release every connection with no parsed request now, and
          // keep sweeping while closing: a socket spared because it had an
          // in-flight request becomes idle the moment its response finishes,
          // and must be released then — not after the whole grace period.
          // (The sweep/force are declared below and referenced by this
          // deferred callback, which Node never invokes synchronously.)
          server.close(() => {
            clearInterval(sweep);
            clearTimeout(force);
            resolve();
          });
          releaseIdle();
          const sweep = setInterval(releaseIdle, 100);
          sweep.unref();
          // Ultimate bound: a request that never finishes must not block
          // shutdown forever.
          const force = setTimeout(() => {
            server.closeAllConnections();
          }, graceMs);
          force.unref();
        });
      }
      return closePromise;
    },
  };
}
