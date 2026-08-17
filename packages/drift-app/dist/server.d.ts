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
import { type IncomingMessage, type ServerResponse } from "node:http";
import { type WebhookDeps } from "./handler.js";
import type { QueueAdapter } from "./queue.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
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
export declare function assertWebhookAuthConfigured(webhookSecret: string | undefined, insecureDevMode: string | undefined): {
    webhookSecret: string | undefined;
    insecureDevMode: boolean;
};
export declare function createWebhookServer(opts: ServerOptions): Promise<{
    server: import("http").Server<typeof IncomingMessage, typeof ServerResponse>;
    port: number;
    close: () => Promise<void>;
}>;
//# sourceMappingURL=server.d.ts.map