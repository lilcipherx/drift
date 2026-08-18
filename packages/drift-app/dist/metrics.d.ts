/**
 * Lightweight operational metrics for the Drift App and workers.
 *
 * Counters and latency histograms (p50/p95/p99) that feed health/readiness,
 * logs, and the docs/PERFORMANCE_REPORT.md evidence. In-memory by design —
 * a production deployment aggregates these via the log/export hook (see
 * docs/OBSERVABILITY.md). No prompts or secrets are ever recorded.
 */
export interface Metrics {
    /** A webhook delivery was accepted (or deduplicated) at intake. */
    deliveryReceived(deliveryId: string): void;
    deliveryDeduplicated(): void;
    /** The worker finished an audit; record its duration. */
    observeAudit(durationMs: number): void;
    /** Webhook intake latency (HMAC → enqueue). */
    observeIntake(durationMs: number): void;
    jobAcked(): void;
    jobRetried(): void;
    jobPermanent(): void;
    jobDeadLettered(): void;
    jobNackFailed(): void;
    /** GitHub API rate-limit remaining for an installation. */
    observeRateLimit(remaining: number): void;
    /** Queue depth sampled by the worker. */
    observeQueueDepth(depth: number): void;
    workerBusy(n: number): void;
    workerIdle(n: number): void;
    /** Snapshot of all counters and histograms (for /metrics or logs). */
    snapshot(): MetricsSnapshot;
    reset(): void;
}
export interface MetricsSnapshot {
    deliveries: {
        accepted: number;
        deduplicated: number;
    };
    jobs: {
        acked: number;
        retried: number;
        permanent: number;
        deadLettered: number;
        nackFailed: number;
    };
    worker: {
        busy: number;
        idle: number;
    };
    rateLimit: {
        lastRemaining: number;
        samples: number;
    };
    queueDepth: {
        last: number;
        max: number;
        samples: number;
    };
    auditMs: LatencySummary;
    intakeMs: LatencySummary;
}
export interface LatencySummary {
    count: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
    mean: number;
}
export declare function createMetrics(): Metrics;
export declare const nullMetrics: Metrics;
//# sourceMappingURL=metrics.d.ts.map