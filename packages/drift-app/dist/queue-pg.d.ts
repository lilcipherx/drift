/**
 * Postgres durable queue adapter (production distributed architecture).
 *
 * Same interface and semantics as `SqliteQueue` (see queue.ts), but backed by
 * a shared Postgres database so ANY number of stateless HTTP replicas and
 * workers can claim and process jobs concurrently across processes and hosts:
 *
 *   - Idempotency: UNIQUE(delivery_id) + ON CONFLICT DO NOTHING.
 *   - Atomic claims: `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction
 *     — concurrent claimers never block each other and never double-claim.
 *   - Lease/retry: identical next_attempt_at / lease_until / attempts /
 *     max_attempts semantics as the SQLite adapter (bounded backoff with full
 *     jitter), so a mixed fleet (SQLite during migration, Postgres after) has
 *     one observable contract.
 *   - Dead-lettering: attempts >= max_attempts → status 'dead' (retained for
 *     ops inspection; purgeDone bounds growth of done jobs only).
 *
 * Storage: only the bounded raw webhook body and parsed event envelope are
 * persisted — never prompts, tokens, webhook secrets or private keys. The
 * worker re-verifies the HMAC signature stored on the job (defense in depth).
 *
 * Configuration: pass a postgres:// URL to the constructor. Connections come
 * from a pg Pool (lazy; the first query opens them), so the constructor is
 * synchronous and safe to call during server boot.
 */
import { type EnqueueResult, type QueueAdapter, type QueueJob, type QueueStats } from "./queue.js";
export interface PostgresQueueOptions {
    /** postgres:// URL (or any pg ConnectionConfig-compatible string). */
    url: string;
    /** Default per-job processing-attempt cap before dead-lettering. */
    maxAttempts?: number;
    /** Max connections in the pool (default 10). */
    max?: number;
}
export declare class PostgresQueue implements QueueAdapter {
    private readonly pool;
    private readonly defaultMaxAttempts;
    private closed;
    constructor(opts: PostgresQueueOptions);
    /** Ensure the schema exists (idempotent; safe to call from every replica). */
    private ensureSchema;
    enqueue(deliveryId: string, event: string, rawBody: string, payload: unknown, signature?: string): Promise<EnqueueResult>;
    claim(batchSize: number, leaseMs: number, workerId: string): Promise<QueueJob[]>;
    ack(id: number, result?: string): Promise<void>;
    nack(id: number, error: string, backoffOverrideMs?: number): Promise<"retrying" | "dead">;
    deadLetter(id: number, error: string): Promise<void>;
    depth(): Promise<number>;
    stats(): Promise<QueueStats>;
    purgeDone(retainDoneForMs: number): Promise<number>;
    close(): void;
}
//# sourceMappingURL=queue-pg.d.ts.map