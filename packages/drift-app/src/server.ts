/**
 * HTTP webhook server (PRD §16.3): receives GitHub deliveries on POST
 * /webhook, verifies the HMAC signature over the RAW body, checks
 * delivery-ID idempotency, parses JSON, and EITHER enqueues the delivery for
 * the durable worker (production mode, `queue` option) OR processes it
 * inline (legacy/dev single-process mode when no queue is passed).
 *
 * The long GitHub API audit NEVER runs in the webhook request thread when a
 * queue is configured: the request path is bounded body → HMAC → idempotency
 * → JSON parse → enqueue → fast 2xx response.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { handleWebhook, verifyWebhookSignature, type WebhookDeps, type WebhookEvent } from "./handler.js";
import type { QueueAdapter } from "./queue.js";
import type { Logger } from "./logger.js";
import { nullLogger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import { nullMetrics } from "./metrics.js";

export interface ServerOptions extends WebhookDeps {
  port: number;
  host?: string;
  log?: (line: string) => void;
  /** Structured logger (default: console line logger). */
  logger?: Logger;
  /** Operational metrics (default: no-op). */
  metrics?: Metrics;
  /** Durable queue adapter. When present, POST /webhook enqueues and answers
   *  202 immediately; the worker (see worker.ts) audits asynchronously.
   *  When absent, the legacy inline path processes synchronously (tests, dev). */
  queue?: QueueAdapter;
  /** Max accepted webhook body size in bytes (default 8 MB). */
  maxBodyBytes?: number;
  /** Grace for in-flight requests on close() before force-close (ms). */
  closeGraceMs?: number;
}

/**
 * Fail-closed startup: a production webhook endpoint MUST authenticate
 * deliveries. `DRIFT_APP_INSECURE_DEV_MODE` (exactly "true") is the only
 * way to run without a secret and it must be explicit and loud.
 */
export function assertWebhookAuthConfigured(
  webhookSecret: string | undefined,
  insecureDevMode: string | undefined,
): { webhookSecret: string | undefined; insecureDevMode: boolean } {
  if (webhookSecret) return { webhookSecret, insecureDevMode: false };
  if (insecureDevMode === "true") {
    console.error(
      "[drift-app] ⚠ DRIFT_APP_INSECURE_DEV_MODE=true — webhook signatures are NOT verified. Local development only; never use in production.",
    );
    return { webhookSecret: undefined, insecureDevMode: true };
  }
  throw new Error(
    "GITHUB_WEBHOOK_SECRET is required: a public webhook endpoint without HMAC verification lets anyone forge pull_request events. For local development only, set DRIFT_APP_INSECURE_DEV_MODE=true explicitly.",
  );
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
  const logger = opts.logger ?? nullLogger;
  const metrics = opts.metrics ?? nullMetrics;
  const queue = opts.queue;
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
    // --- Liveness: the process is up and the HTTP listener accepts. --------
    if (req.method === "GET" && req.url === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    // --- Readiness: the queue is reachable and the data dir is writable. ---
    // Only meaningful in queue mode; inline mode reports ready when alive.
    if (req.method === "GET" && req.url === "/ready") {
      if (!queue) {
        sendJson(res, 200, { status: "ready", mode: "inline" });
        return;
      }
      try {
        const depth = await queue.depth();
        sendJson(res, 200, { status: "ready", mode: "queued", queueDepth: depth });
      } catch (err) {
        logger.error({
          op: "readiness",
          result: "not-ready",
          errorCode: "queue-unavailable",
          msg: err instanceof Error ? err.message : String(err),
        });
        sendJson(res, 503, { status: "not-ready", error: "queue unavailable" });
      }
      return;
    }
    if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/webhook") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const started = Date.now();
      const rawBody = await readBody(req, opts.maxBodyBytes ?? MAX_BODY_BYTES);
      const signature = req.headers["x-hub-signature-256"] as string | undefined;
      const deliveryId = (req.headers["x-github-delivery"] as string | undefined) ?? "";

      // --- Authenticate BEFORE parsing any JSON -----------------------------
      // Production requires a webhook secret and a valid X-Hub-Signature-256
      // over the RAW body. Untrusted JSON is never parsed before the HMAC
      // check passes. Fail closed: missing secret → 403, missing/invalid
      // signature → 401 (never 200). Only an explicit
      // DRIFT_APP_INSECURE_DEV_MODE=true allows unsigned requests.
      const secret = opts.webhookSecret;
      if (!secret) {
        if (opts.insecureDevMode !== true) {
          logger.error({
            deliveryId,
            op: "webhook.receive",
            result: "rejected",
            errorCode: "missing-secret",
            msg: "webhook rejected: no webhook secret configured",
          });
          sendJson(res, 403, {
            error: "webhook secret missing — production requires authenticated webhooks (local development: set DRIFT_APP_INSECURE_DEV_MODE=true explicitly)",
          });
          return;
        }
        console.error(
          "[drift-app] ⚠ DRIFT_APP_INSECURE_DEV_MODE=true — webhook signatures are NOT verified. Local development only; never enable this in production.",
        );
      } else if (!verifyWebhookSignature(rawBody, signature, secret)) {
        logger.warn({
          deliveryId,
          op: "webhook.receive",
          result: "rejected",
          errorCode: "bad-signature",
          msg: "webhook rejected: invalid or missing signature",
        });
        sendJson(res, 401, { error: "invalid or missing webhook signature" });
        return;
      }

      let payload: Record<string, unknown>;
      try {
        payload = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        sendJson(res, 400, { error: "malformed JSON body" });
        return;
      }

      // --- Delivery-ID idempotency + durable enqueue ------------------------
      // Queue mode: the audit runs on the worker, never in this thread. The
      // response is a fast 202 regardless of how long the audit takes.
      if (queue) {
        metrics.observeIntake(Date.now() - started);
        if (!deliveryId) {
          logger.warn({
            op: "webhook.receive",
            result: "rejected",
            errorCode: "missing-delivery-id",
            msg: "webhook rejected: X-GitHub-Delivery header missing — cannot enforce idempotency",
          });
          sendJson(res, 400, { error: "missing X-GitHub-Delivery header — required for idempotent processing" });
          return;
        }
        let enqueued;
        try {
          enqueued = await queue.enqueue(deliveryId, req.headers["x-github-event"] as string ?? "", rawBody, payload, signature);
        } catch (err) {
          logger.error({
            deliveryId,
            op: "webhook.enqueue",
            result: "failed",
            errorCode: "enqueue-failed",
            msg: err instanceof Error ? err.message : String(err),
          });
          sendJson(res, 500, { error: "internal error" });
          return;
        }
        if (enqueued.accepted) {
          metrics.deliveryReceived(deliveryId);
          const queueDepth = await queue.depth().catch(() => -1);
          logger.info({
            deliveryId,
            op: "webhook.receive",
            durationMs: Date.now() - started,
            result: "accepted",
            queueDepth,
            msg: "delivery enqueued",
          });
          sendJson(res, 202, { accepted: true, deliveryId, duplicate: false });
        } else {
          metrics.deliveryDeduplicated();
          logger.info({
            deliveryId,
            op: "webhook.receive",
            durationMs: Date.now() - started,
            result: "deduplicated",
            msg: enqueued.alreadyProcessed ? "duplicate delivery — already processed" : "duplicate delivery — already queued",
          });
          sendJson(res, 202, { accepted: false, deliveryId, duplicate: true, alreadyProcessed: enqueued.alreadyProcessed });
        }
        return;
      }

      // --- Legacy inline mode (tests, local dev without a queue) -------------
      const event: WebhookEvent = {
        event: req.headers["x-github-event"] as string ?? "",
        signature,
        payload,
        rawBody,
      };
      const result = await handleWebhook(event, opts);
      metrics.observeAudit(Date.now() - started);
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
