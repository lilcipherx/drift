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
import { Pool } from "pg";
import { backoffMs, boundedError, extractTenantId } from "./queue.js";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_jobs (
  id              BIGSERIAL PRIMARY KEY,
  delivery_id     TEXT NOT NULL UNIQUE,
  event           TEXT NOT NULL,
  raw_body        TEXT NOT NULL,
  signature       TEXT NOT NULL DEFAULT '',
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 8,
  next_attempt_at BIGINT NOT NULL DEFAULT 0,
  lease_until     BIGINT NOT NULL DEFAULT 0,
  lease_owner     TEXT NOT NULL DEFAULT '',
  last_error      TEXT,
  last_result     TEXT,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  tenant_id       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_claim ON webhook_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_created ON webhook_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_tenant ON webhook_jobs(tenant_id, status);
`;
/** In-place upgrade for tables created before `tenant_id` existed (the
 *  `CREATE TABLE IF NOT EXISTS` is a no-op for an existing table). */
const TENANT_UPGRADE = `
ALTER TABLE webhook_jobs ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_tenant ON webhook_jobs(tenant_id, status);
`;
/** Advisory-lock key serializing concurrent schema creation across the fleet. */
const SCHEMA_LOCK_KEY = 0x6472696674; // "drift"
const VALID_STATUS = ["pending", "in_progress", "done", "dead"];
function rowToJob(row) {
    const status = String(row.status ?? "pending");
    return {
        id: Number(row.id),
        deliveryId: String(row.delivery_id ?? ""),
        tenantId: String(row.tenant_id ?? ""),
        event: String(row.event ?? ""),
        rawBody: String(row.raw_body ?? ""),
        signature: String(row.signature ?? ""),
        payload: safeParseJson(String(row.payload_json ?? "{}"), {}),
        status: VALID_STATUS.includes(status) ? status : "pending",
        attempts: Number(row.attempts ?? 0),
        maxAttempts: Number(row.max_attempts ?? 8),
        nextAttemptAt: Number(row.next_attempt_at ?? 0),
        leaseUntil: Number(row.lease_until ?? 0),
        leaseOwner: String(row.lease_owner ?? ""),
        lastError: row.last_error == null ? null : String(row.last_error),
        lastResult: row.last_result == null ? null : String(row.last_result),
        createdAt: Number(row.created_at ?? 0),
        updatedAt: Number(row.updated_at ?? 0),
    };
}
function safeParseJson(text, fallback) {
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
function clampPositiveInt(n, fallback) {
    if (n === undefined || !Number.isFinite(n) || n < 1)
        return fallback;
    return Math.floor(n);
}
function clampNonNegInt(n, fallback) {
    if (n === undefined || !Number.isFinite(n) || n < 0)
        return fallback;
    return Math.floor(n);
}
export class PostgresQueue {
    pool;
    defaultMaxAttempts;
    closed = false;
    constructor(opts) {
        this.pool = new Pool({
            connectionString: opts.url,
            max: clampPositiveInt(opts.max, 10),
            // Fail fast rather than queueing queries forever when the DB is down.
            connectionTimeoutMillis: 5_000,
            statement_timeout: 30_000,
        });
        this.defaultMaxAttempts = clampPositiveInt(opts.maxAttempts, 8);
        // Schema migration runs lazily on first use via the pool (the constructor
        // is synchronous; connecting eagerly would force an async boot path).
    }
    /**
     * Ensure the schema exists (idempotent; safe to call from every replica).
     *
     * Cold path (table missing): CREATE TABLE IF NOT EXISTS is NOT safe under
     * concurrency — two sessions creating the same table at once collide on the
     * pg_type catalog index (`duplicate key value violates unique constraint
     * "pg_type_typname_nsp_index"`), which is exactly what happens on first boot
     * when every replica's worker + enqueue path races to initialize. A
     * session-scoped advisory lock serializes creation fleet-wide; the lock is
     * released before any queue I/O, so the hot path stays lock-free.
     */
    async ensureSchema(client) {
        const exists = await client.query(`SELECT EXISTS (
         SELECT 1 FROM pg_catalog.pg_tables
         WHERE schemaname = 'public' AND tablename = 'webhook_jobs'
       ) AS exists`);
        if (exists.rows[0]?.exists) {
            // Existing table from before tenant_id existed: upgrade in place.
            await client.query(TENANT_UPGRADE);
            return;
        }
        await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK_KEY]);
        try {
            await client.query(SCHEMA);
        }
        finally {
            await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK_KEY]);
        }
    }
    async enqueue(deliveryId, event, rawBody, payload, signature) {
        if (!deliveryId || deliveryId.length > 200) {
            throw new Error("delivery id is required and must be <= 200 chars");
        }
        const now = Date.now();
        const client = await this.pool.connect();
        try {
            await this.ensureSchema(client);
            const res = await client.query(`INSERT INTO webhook_jobs
           (delivery_id, event, raw_body, signature, payload_json, status, max_attempts,
            next_attempt_at, lease_until, created_at, updated_at, tenant_id)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6, 0, 0, $7, $7, $8)
         ON CONFLICT (delivery_id) DO NOTHING`, [deliveryId, event, rawBody, signature ?? "", JSON.stringify(payload), this.defaultMaxAttempts, now, extractTenantId(payload)]);
            if ((res.rowCount ?? 0) > 0)
                return { accepted: true, duplicate: false, alreadyProcessed: false };
            const existing = await client.query("SELECT status FROM webhook_jobs WHERE delivery_id = $1", [deliveryId]);
            return {
                accepted: false,
                duplicate: true,
                alreadyProcessed: existing.rows[0]?.status === "done",
            };
        }
        finally {
            client.release();
        }
    }
    async claim(batchSize, leaseMs, workerId) {
        const n = clampPositiveInt(batchSize, 1);
        const lease = clampNonNegInt(leaseMs, 30_000);
        const now = Date.now();
        const client = await this.pool.connect();
        try {
            await this.ensureSchema(client);
            await client.query("BEGIN");
            try {
                const claimed = await client.query(`SELECT id FROM webhook_jobs
           WHERE (status = 'pending' AND next_attempt_at <= $1)
              OR (status = 'in_progress' AND lease_until < $1)
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT $2
           FOR UPDATE SKIP LOCKED`, [now, n]);
                for (const row of claimed.rows) {
                    await client.query(`UPDATE webhook_jobs
             SET status = 'in_progress', lease_until = $1, lease_owner = $2, updated_at = $3
             WHERE id = $4`, [now + lease, workerId, now, Number(row.id)]);
                }
                await client.query("COMMIT");
                if (claimed.rows.length === 0)
                    return [];
                const jobs = await client.query(`SELECT * FROM webhook_jobs WHERE id = ANY($1::bigint[]) ORDER BY id ASC`, [claimed.rows.map((r) => Number(r.id))]);
                return jobs.rows.map((r) => rowToJob(r));
            }
            catch (err) {
                await client.query("ROLLBACK");
                throw err;
            }
        }
        finally {
            client.release();
        }
    }
    async ack(id, result) {
        const client = await this.pool.connect();
        try {
            await client.query(`UPDATE webhook_jobs
         SET status = 'done', lease_until = 0, lease_owner = '', last_error = NULL,
             last_result = $1, updated_at = $2
         WHERE id = $3 AND status = 'in_progress'`, [result ? boundedError(result) : null, Date.now(), id]);
        }
        finally {
            client.release();
        }
    }
    async nack(id, error, backoffOverrideMs) {
        const client = await this.pool.connect();
        try {
            const now = Date.now();
            const row = await client.query("SELECT attempts, max_attempts FROM webhook_jobs WHERE id = $1", [id]);
            const current = row.rows[0];
            if (!current)
                return "dead";
            const attempts = Number(current.attempts) + 1;
            const maxAttempts = Number(current.max_attempts) || this.defaultMaxAttempts;
            if (attempts >= maxAttempts) {
                await client.query(`UPDATE webhook_jobs
           SET status = 'dead', attempts = $1, lease_until = 0, lease_owner = '',
               last_error = $2, next_attempt_at = $3, updated_at = $3
           WHERE id = $4`, [attempts, boundedError(error), now, id]);
                return "dead";
            }
            const delay = Number.isFinite(backoffOverrideMs) && (backoffOverrideMs ?? 0) >= 0
                ? backoffOverrideMs
                : backoffMs(attempts);
            await client.query(`UPDATE webhook_jobs
         SET status = 'pending', attempts = $1, lease_until = 0, lease_owner = '',
             last_error = $2, next_attempt_at = $3, updated_at = $3
         WHERE id = $4`, [attempts, boundedError(error), now + Math.max(0, Math.floor(delay)), id]);
            return "retrying";
        }
        finally {
            client.release();
        }
    }
    async deadLetter(id, error) {
        const client = await this.pool.connect();
        try {
            await client.query(`UPDATE webhook_jobs
         SET status = 'dead', lease_until = 0, lease_owner = '', last_error = $1, updated_at = $2
         WHERE id = $3`, [boundedError(error), Date.now(), id]);
        }
        finally {
            client.release();
        }
    }
    async depth() {
        const client = await this.pool.connect();
        try {
            const row = await client.query("SELECT COUNT(*) AS n FROM webhook_jobs WHERE status IN ('pending','in_progress')");
            return Number(row.rows[0]?.n ?? 0);
        }
        finally {
            client.release();
        }
    }
    async stats() {
        const client = await this.pool.connect();
        try {
            const rows = await client.query("SELECT status, COUNT(*) AS n FROM webhook_jobs GROUP BY status");
            const counts = { pending: 0, in_progress: 0, done: 0, dead: 0 };
            for (const r of rows.rows)
                if (r.status in counts)
                    counts[r.status] = Number(r.n);
            const total = Object.values(counts).reduce((a, b) => a + b, 0);
            return {
                pending: counts.pending ?? 0,
                inProgress: counts.in_progress ?? 0,
                done: counts.done ?? 0,
                dead: counts.dead ?? 0,
                total,
            };
        }
        finally {
            client.release();
        }
    }
    async purgeDone(retainDoneForMs) {
        const cutoff = Date.now() - clampNonNegInt(retainDoneForMs, 7 * 24 * 3600 * 1000);
        const client = await this.pool.connect();
        try {
            const res = await client.query("DELETE FROM webhook_jobs WHERE status = 'done' AND updated_at < $1", [cutoff]);
            return Number(res.rowCount ?? 0);
        }
        finally {
            client.release();
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        void this.pool.end().catch(() => undefined);
    }
}
//# sourceMappingURL=queue-pg.js.map