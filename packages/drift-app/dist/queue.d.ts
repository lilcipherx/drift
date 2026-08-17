/**
 * Durable webhook queue (production App architecture, PRD §16 / CAPACITY_MODEL).
 *
 * The webhook request path MUST be: bounded raw body → HMAC verification →
 * delivery-ID idempotency check → JSON parse → enqueue durable work → fast
 * HTTP response. The long GitHub API audit never runs in the request thread —
 * a worker claims jobs, retries transient failures with exponential backoff
 * and jitter, and dead-letters jobs that exhaust their attempts.
 *
 * Queue adapters:
 *   - `SqliteQueue`  — production default. One SQLite file (node:sqlite, zero
 *     native deps, WAL mode) shared by N stateless HTTP replicas and M
 *     workers. Idempotency is enforced by a UNIQUE(delivery_id) constraint;
 *     atomic lease/visibility semantics come from BEGIN IMMEDIATE transactions.
 *   - `MemoryQueue`  — local development / tests. Same interface and semantics
 *     (dedupe + leases), but not durable across process restarts.
 *
 * Nothing in this module ever stores prompts, tokens, webhook secrets or
 * private key material: only the bounded raw webhook body and parsed event
 * envelope are persisted.
 */
/** Job lifecycle states. */
export type JobStatus = "pending" | "in_progress" | "done" | "dead";
export interface QueueJob {
    /** Internal autoincrement id (unstable across restores). */
    id: number;
    /** GitHub webhook delivery GUID — the idempotency key. */
    deliveryId: string;
    /** X-GitHub-Event value (e.g. "pull_request"). */
    event: string;
    /** Bounded raw body (the server already enforced the size cap). */
    rawBody: string;
    /** Parsed JSON payload (bounded by the raw-body cap). */
    payload: unknown;
    status: JobStatus;
    /** Number of failed processing attempts so far. */
    attempts: number;
    /** Hard cap on processing attempts before dead-lettering. */
    maxAttempts: number;
    /** Epoch-ms before which the job may be claimed again. */
    nextAttemptAt: number;
    /** Epoch-ms until which a claimed job's lease is valid. */
    leaseUntil: number;
    /** Worker id holding the lease ("" when unclaimed). */
    leaseOwner: string;
    /** Last error message (bounded, no secrets — set by nack/deadLetter). */
    lastError: string | null;
    /** Human-readable result of the final attempt, when done (bounded). */
    lastResult: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface EnqueueResult {
    /** True when this delivery was newly enqueued. */
    accepted: boolean;
    /** True when a job for this delivery id already exists (duplicate delivery). */
    duplicate: boolean;
    /** True when the duplicate was already processed successfully. */
    alreadyProcessed: boolean;
}
export interface QueueStats {
    pending: number;
    inProgress: number;
    done: number;
    dead: number;
    total: number;
}
export interface QueueAdapter {
    /** Idempotent enqueue keyed on the GitHub delivery id. */
    enqueue(deliveryId: string, event: string, rawBody: string, payload: unknown): EnqueueResult;
    /** Claim up to `batchSize` due jobs (pending past next_attempt_at, or
     *  in_progress jobs whose lease expired) for `leaseMs`. */
    claim(batchSize: number, leaseMs: number, workerId: string): QueueJob[];
    /** Acknowledge a job as processed successfully (keeps the delivery-id
     *  record so redeliveries are deduplicated). */
    ack(id: number, result?: string): void;
    /** Mark a job for retry: attempts+1, exponential backoff with jitter; the
     *  job is dead-lettered when attempts reach maxAttempts. */
    nack(id: number, error: string, backoffOverrideMs?: number): "retrying" | "dead";
    /** Explicitly dead-letter a job (non-retryable failure). */
    deadLetter(id: number, error: string): void;
    /** Number of pending + in_progress jobs. */
    depth(): number;
    stats(): QueueStats;
    /** Purge `done` jobs older than `retainDoneForMs` (bounds storage growth). */
    purgeDone(retainDoneForMs: number): number;
    /** Release resources. */
    close(): void;
}
/**
 * Exponential backoff with FULL jitter (AWS-style): a random value in
 * [0, base * 2^attempts], capped at `maxMs`. Attempts is the number of
 * FAILURES so far (0 → [0, base); 1 → [0, base*2); ...).
 */
export declare function backoffMs(attempts: number, baseMs?: number, maxMs?: number): number;
export declare function boundedError(message: string): string;
export interface SqliteQueueOptions {
    /** Path of the queue database file. */
    path: string;
    /** Default per-job processing-attempt cap before dead-lettering. */
    maxAttempts?: number;
}
export declare class SqliteQueue implements QueueAdapter {
    private db;
    private readonly defaultMaxAttempts;
    constructor(opts: SqliteQueueOptions);
    enqueue(deliveryId: string, event: string, rawBody: string, payload: unknown): EnqueueResult;
    claim(batchSize: number, leaseMs: number, workerId: string): QueueJob[];
    ack(id: number, result?: string): void;
    nack(id: number, error: string, backoffOverrideMs?: number): "retrying" | "dead";
    deadLetter(id: number, error: string): void;
    depth(): number;
    stats(): QueueStats;
    purgeDone(retainDoneForMs: number): number;
    close(): void;
}
export interface MemoryQueueOptions {
    maxAttempts?: number;
}
export declare class MemoryQueue implements QueueAdapter {
    private jobs;
    private byDelivery;
    private nextId;
    private readonly defaultMaxAttempts;
    constructor(opts?: MemoryQueueOptions);
    enqueue(deliveryId: string, event: string, rawBody: string, payload: unknown): EnqueueResult;
    claim(batchSize: number, leaseMs: number, workerId: string): QueueJob[];
    ack(id: number, result?: string): void;
    nack(id: number, error: string, backoffOverrideMs?: number): "retrying" | "dead";
    deadLetter(id: number, error: string): void;
    depth(): number;
    stats(): QueueStats;
    purgeDone(retainDoneForMs: number): number;
    close(): void;
}
//# sourceMappingURL=queue.d.ts.map