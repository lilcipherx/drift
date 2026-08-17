/**
 * Durable worker for the Drift GitHub App.
 *
 * Claims jobs from the queue, runs the pull_request audit OUTSIDE the webhook
 * request thread, acknowledges on success, retries transient failures with
 * exponential backoff + jitter, and dead-letters jobs that exhaust their
 * attempts or fail permanently. Bounded concurrency, worker leases with
 * visibility timeout (a crashed worker's job is re-claimed after the lease
 * expires), and graceful shutdown that stops claiming and finishes in-flight
 * jobs.
 *
 * Privacy: job processing re-uses the existing `handleWebhook` pipeline which
 * never reads or renders prompts/private data. Logs carry only the structured
 * fields from logger.ts.
 */
import type { QueueAdapter, QueueJob } from "./queue.js";
import { type WebhookDeps, type WebhookResult } from "./handler.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
export interface DeliveryOutcome {
    /** True when the job must NOT be retried (success or permanent failure). */
    terminal: boolean;
    ok: boolean;
    result?: WebhookResult;
    error?: string;
    errorCode?: string;
    durationMs: number;
    /** Client-provided retry hint (GitHub Retry-After for rate limits, ms). */
    retryAfterMs?: number;
}
/**
 * Process one queued webhook delivery: re-verify the HMAC over the stored
 * raw body, run the full audit, and classify the outcome for the retry policy.
 *
 *   - success actions / non-retryable handler errors  → terminal
 *   - transient handler errors (network, 5xx, 429)    → retry
 */
export declare function processDelivery(deps: WebhookDeps, job: QueueJob, log?: Logger): Promise<DeliveryOutcome>;
export interface WorkerOptions {
    queue: QueueAdapter;
    /** Process one job → outcome (defaults to processDelivery with `deps`). */
    process?: (job: QueueJob) => Promise<DeliveryOutcome>;
    /** Webhook handler dependencies (used by the default process). */
    deps?: WebhookDeps;
    /** Max jobs processed concurrently (bounded concurrency). */
    concurrency?: number;
    /** Poll interval when the queue is empty (ms). */
    pollIntervalMs?: number;
    /** Worker lease / visibility timeout (ms) — a job is re-claimed by another
     *  worker if this expires while in_progress (crash recovery). */
    leaseMs?: number;
    /** Retry backoff base (ms). */
    baseBackoffMs?: number;
    /** Retry backoff cap (ms). */
    maxBackoffMs?: number;
    /** Grace period for in-flight jobs on stop() (ms). */
    stopGraceMs?: number;
    log?: Logger;
    metrics?: Metrics;
}
export declare class Worker {
    private readonly queue;
    private readonly processJob;
    private readonly concurrency;
    private readonly pollIntervalMs;
    private readonly leaseMs;
    private readonly baseBackoffMs;
    private readonly maxBackoffMs;
    private readonly stopGraceMs;
    private readonly log;
    private readonly metrics;
    private readonly workerId;
    private stopped;
    private stopPromise;
    private slots;
    private inFlight;
    constructor(opts: WorkerOptions);
    /** Start the worker slot pool. Idempotent. */
    start(): void;
    private runSlot;
    /** Current number of jobs being processed. */
    get busy(): number;
    /**
     * Graceful shutdown: stop claiming new jobs, wait up to `stopGraceMs` for
     * in-flight jobs, then return. Idempotent.
     */
    stop(): Promise<void>;
}
//# sourceMappingURL=worker.d.ts.map