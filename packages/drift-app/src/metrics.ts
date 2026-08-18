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
  deliveries: { accepted: number; deduplicated: number };
  jobs: { acked: number; retried: number; permanent: number; deadLettered: number; nackFailed: number };
  worker: { busy: number; idle: number };
  rateLimit: { lastRemaining: number; samples: number };
  queueDepth: { last: number; max: number; samples: number };
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

/** Fixed logarithmic buckets (0.5 ms … ~64 s). */
const BUCKET_LIMITS = [
  0.5, 1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1_000, 2_000, 4_000, 8_000, 16_000,
  32_000, 64_000,
];

function makeHistogram() {
  const counts = new Array<number>(BUCKET_LIMITS.length).fill(0);
  let count = 0;
  let sum = 0;
  let max = 0;
  return {
    add(ms: number) {
      count++;
      sum += ms;
      if (ms > max) max = ms;
      const idx = BUCKET_LIMITS.findIndex((b) => ms <= b);
      counts[idx === -1 ? BUCKET_LIMITS.length - 1 : idx]! += 1;
    },
    summary(): LatencySummary {
      if (count === 0) {
        return { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
      }
      const pct = (p: number) => {
        const target = Math.max(1, Math.ceil((count * p) / 100));
        let acc = 0;
        for (let i = 0; i < BUCKET_LIMITS.length; i++) {
          acc += counts[i] ?? 0;
          if (acc >= target) return BUCKET_LIMITS[i] ?? 0;
        }
        return max;
      };
      return { count, p50: pct(50), p95: pct(95), p99: pct(99), max, mean: sum / count };
    },
  };
}

export function createMetrics(): Metrics {
  const auditMs = makeHistogram();
  const intakeMs = makeHistogram();
  let accepted = 0;
  let deduplicated = 0;
  let acked = 0;
  let retried = 0;
  let permanent = 0;
  let deadLettered = 0;
  let nackFailed = 0;
  let busy = 0;
  let idle = 0;
  let lastRemaining = -1;
  let rateSamples = 0;
  let lastDepth = 0;
  let maxDepth = 0;
  let depthSamples = 0;

  return {
    deliveryReceived: () => {
      accepted++;
    },
    deliveryDeduplicated: () => {
      deduplicated++;
    },
    observeAudit: (ms) => auditMs.add(ms),
    observeIntake: (ms) => intakeMs.add(ms),
    jobAcked: () => {
      acked++;
    },
    jobRetried: () => {
      retried++;
    },
    jobPermanent: () => {
      permanent++;
    },
    jobDeadLettered: () => {
      deadLettered++;
    },
    jobNackFailed: () => {
      nackFailed++;
    },
    observeRateLimit: (remaining) => {
      lastRemaining = remaining;
      rateSamples++;
    },
    observeQueueDepth: (depth) => {
      lastDepth = depth;
      maxDepth = Math.max(maxDepth, depth);
      depthSamples++;
    },
    workerBusy: (n) => {
      busy += n;
    },
    workerIdle: (n) => {
      idle += n;
    },
    snapshot: () => ({
      deliveries: { accepted, deduplicated },
      jobs: { acked, retried, permanent, deadLettered, nackFailed },
      worker: { busy, idle },
      rateLimit: { lastRemaining, samples: rateSamples },
      queueDepth: { last: lastDepth, max: maxDepth, samples: depthSamples },
      auditMs: auditMs.summary(),
      intakeMs: intakeMs.summary(),
    }),
    reset: () => {
      // Histograms are immutable snapshots — recreate via a fresh instance.
      // This no-op keeps the interface stable; tests create new instances.
    },
  };
}

export const nullMetrics: Metrics = {
  deliveryReceived: () => {},
  deliveryDeduplicated: () => {},
  observeAudit: () => {},
  observeIntake: () => {},
  jobAcked: () => {},
  jobRetried: () => {},
  jobPermanent: () => {},
  jobDeadLettered: () => {},
  jobNackFailed: () => {},
  observeRateLimit: () => {},
  observeQueueDepth: () => {},
  workerBusy: () => {},
  workerIdle: () => {},
  snapshot: () => ({
    deliveries: { accepted: 0, deduplicated: 0 },
    jobs: { acked: 0, retried: 0, permanent: 0, deadLettered: 0, nackFailed: 0 },
    worker: { busy: 0, idle: 0 },
    rateLimit: { lastRemaining: -1, samples: 0 },
    queueDepth: { last: 0, max: 0, samples: 0 },
    auditMs: { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 },
    intakeMs: { count: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 },
  }),
  reset: () => {},
};
