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
import { backoffMs } from "./queue.js";
import { handleWebhook } from "./handler.js";
import { nullLogger } from "./logger.js";
import { nullMetrics } from "./metrics.js";
/**
 * Process one queued webhook delivery: re-verify the HMAC over the stored
 * raw body, run the full audit, and classify the outcome for the retry policy.
 *
 *   - success actions / non-retryable handler errors  → terminal
 *   - transient handler errors (network, 5xx, 429)    → retry
 */
export async function processDelivery(deps, job, log = nullLogger) {
    const started = Date.now();
    // Re-verify the HMAC over the stored raw body BEFORE auditing: the job
    // persists the signature the intake server already verified, so a forged
    // or tampered queued delivery is rejected exactly like a forged webhook.
    const event = {
        event: job.event,
        payload: (job.payload ?? {}),
        rawBody: job.rawBody,
        signature: job.signature || undefined,
    };
    try {
        const result = await handleWebhook(event, deps);
        const durationMs = Date.now() - started;
        if (result.action === "error") {
            if (result.retryable) {
                log.warn({
                    deliveryId: job.deliveryId,
                    op: "job.process",
                    durationMs,
                    result: "retrying",
                    retryCount: job.attempts,
                    errorCode: "transient",
                    msg: "transient failure — job will be retried",
                });
                return {
                    terminal: false,
                    ok: false,
                    result,
                    error: result.error,
                    errorCode: "transient",
                    durationMs,
                    retryAfterMs: result.retryAfterMs,
                };
            }
            log.error({
                deliveryId: job.deliveryId,
                op: "job.process",
                durationMs,
                result: "permanent",
                retryCount: job.attempts,
                errorCode: "permanent",
                msg: "permanent failure — job acknowledged without retry",
            });
            return { terminal: true, ok: false, result, error: result.error, errorCode: "permanent", durationMs };
        }
        log.info({
            deliveryId: job.deliveryId,
            op: "job.process",
            durationMs,
            result: result.action,
            retryCount: job.attempts,
            msg: "delivery processed",
        });
        return { terminal: true, ok: true, result, durationMs };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - started;
        // An unexpected throw is always treated as transient: retry with backoff
        // rather than losing the delivery (the dead-letter path bounds the damage).
        log.warn({
            deliveryId: job.deliveryId,
            op: "job.process",
            durationMs,
            result: "retrying",
            retryCount: job.attempts,
            errorCode: "thrown",
            msg: "unexpected error — job will be retried",
        });
        return { terminal: false, ok: false, error: message, errorCode: "thrown", durationMs };
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class Worker {
    queue;
    processJob;
    concurrency;
    pollIntervalMs;
    leaseMs;
    baseBackoffMs;
    maxBackoffMs;
    stopGraceMs;
    log;
    metrics;
    workerId;
    stopped = false;
    stopPromise = null;
    slots = [];
    inFlight = 0;
    constructor(opts) {
        this.queue = opts.queue;
        if (opts.process) {
            this.processJob = opts.process;
        }
        else if (opts.deps) {
            const deps = opts.deps;
            const log = opts.log ?? nullLogger;
            this.processJob = (job) => processDelivery(deps, job, log);
        }
        else {
            throw new Error("Worker requires either `process` or `deps`");
        }
        this.concurrency = clampInt(opts.concurrency, 4, 1, 64);
        this.pollIntervalMs = clampInt(opts.pollIntervalMs, 500, 10, 60_000);
        this.leaseMs = clampInt(opts.leaseMs, 300_000, 1_000, 3_600_000);
        this.baseBackoffMs = clampInt(opts.baseBackoffMs, 1_000, 0, 3_600_000);
        this.maxBackoffMs = clampInt(opts.maxBackoffMs, 60_000, 0, 3_600_000);
        this.stopGraceMs = clampInt(opts.stopGraceMs, 30_000, 0, 3_600_000);
        this.log = opts.log ?? nullLogger;
        this.metrics = opts.metrics ?? nullMetrics;
        this.workerId = `worker-${process.pid}-${randomId()}`;
    }
    /** Start the worker slot pool. Idempotent. */
    start() {
        if (this.slots.length > 0)
            return;
        this.log.info({ op: "worker.start", msg: `starting ${this.concurrency} worker slots` });
        for (let i = 0; i < this.concurrency; i++) {
            this.slots.push(this.runSlot());
        }
    }
    async runSlot() {
        while (!this.stopped) {
            let job;
            try {
                const batch = this.queue.claim(1, this.leaseMs, this.workerId);
                job = batch[0];
            }
            catch (err) {
                this.log.error({
                    op: "worker.claim",
                    errorCode: "claim-failed",
                    msg: err instanceof Error ? err.message : String(err),
                });
                await sleep(this.pollIntervalMs);
                continue;
            }
            if (!job) {
                this.metrics.workerIdle(1);
                await sleep(this.pollIntervalMs);
                continue;
            }
            this.inFlight++;
            const started = Date.now();
            this.metrics.workerBusy(1);
            try {
                const outcome = await this.processJob(job);
                const durationMs = Date.now() - started;
                this.metrics.observeAudit(durationMs);
                if (outcome.terminal) {
                    if (outcome.ok) {
                        this.queue.ack(job.id, outcome.result?.action ?? "ok");
                        this.metrics.jobAcked();
                    }
                    else {
                        // Permanent failure: acknowledge (never retried) and record the
                        // reason on the job so operators can inspect dead/terminal jobs.
                        this.queue.ack(job.id, `permanent: ${outcome.errorCode ?? "permanent"}`);
                        this.metrics.jobPermanent();
                    }
                }
                else {
                    // Rate-limit retries must respect the server's Retry-After: back off
                    // at least that long (bounded by the configured cap so a hostile or
                    // stale Retry-After can never stall the queue forever).
                    const delay = Math.min(Math.max(backoffMs(job.attempts, this.baseBackoffMs, this.maxBackoffMs), outcome.retryAfterMs ?? 0), this.maxBackoffMs);
                    const state = this.queue.nack(job.id, outcome.error ?? "transient failure", delay);
                    if (state === "dead") {
                        this.metrics.jobDeadLettered();
                        this.log.error({
                            deliveryId: job.deliveryId,
                            op: "worker.nack",
                            durationMs,
                            result: "dead",
                            retryCount: job.attempts,
                            errorCode: "max-attempts",
                            msg: "job dead-lettered after exhausting attempts",
                        });
                    }
                    else {
                        this.metrics.jobRetried();
                    }
                }
            }
            catch (err) {
                // Queue operations themselves failed (e.g. DB error) — do not lose
                // the job: attempt a nack with the lease still held; if even that
                // fails the lease will expire and the job is re-claimed.
                this.metrics.jobNackFailed();
                try {
                    this.queue.nack(job.id, err instanceof Error ? err.message : String(err), 0);
                }
                catch {
                    this.log.error({
                        deliveryId: job.deliveryId,
                        op: "worker.ack",
                        errorCode: "queue-error",
                        msg: "failed to ack/nack job — lease will expire and the job will be re-claimed",
                    });
                }
            }
            finally {
                this.inFlight--;
                this.metrics.workerIdle(1);
            }
        }
    }
    /** Current number of jobs being processed. */
    get busy() {
        return this.inFlight;
    }
    /**
     * Graceful shutdown: stop claiming new jobs, wait up to `stopGraceMs` for
     * in-flight jobs, then return. Idempotent.
     */
    stop() {
        if (!this.stopPromise) {
            this.stopPromise = (async () => {
                this.stopped = true;
                const deadline = Date.now() + this.stopGraceMs;
                while (this.inFlight > 0 && Date.now() < deadline) {
                    await sleep(50);
                }
                await Promise.allSettled(this.slots);
                this.slots = [];
                this.log.info({ op: "worker.stop", msg: "worker stopped" });
            })();
        }
        return this.stopPromise;
    }
}
function clampInt(n, fallback, min, max) {
    if (n === undefined || !Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.floor(n)));
}
function randomId() {
    return Math.random().toString(36).slice(2, 10);
}
//# sourceMappingURL=worker.js.map