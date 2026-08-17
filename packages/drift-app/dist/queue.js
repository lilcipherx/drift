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
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomInt } from "node:crypto";
/**
 * Exponential backoff with FULL jitter (AWS-style): a random value in
 * [0, base * 2^attempts], capped at `maxMs`. Attempts is the number of
 * FAILURES so far (0 → [0, base); 1 → [0, base*2); ...).
 */
export function backoffMs(attempts, baseMs = 1_000, maxMs = 60_000) {
    if (!Number.isFinite(attempts) || attempts < 0)
        return baseMs;
    const cap = Math.min(baseMs * 2 ** Math.min(attempts, 16), maxMs);
    if (cap <= 0)
        return 0;
    return randomInt(0, Math.floor(cap) + 1);
}
const SCHEMA = `
CREATE TABLE IF NOT EXISTS webhook_jobs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id   TEXT NOT NULL UNIQUE,
  event         TEXT NOT NULL,
  raw_body      TEXT NOT NULL,
  signature     TEXT NOT NULL DEFAULT '',
  payload_json  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 8,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until   INTEGER NOT NULL DEFAULT 0,
  lease_owner   TEXT NOT NULL DEFAULT '',
  last_error    TEXT,
  last_result   TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_claim ON webhook_jobs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_jobs_created ON webhook_jobs(created_at);
`;
const VALID_STATUS = ["pending", "in_progress", "done", "dead"];
function rowToJob(row) {
    const status = String(row.status ?? "pending");
    return {
        id: Number(row.id),
        deliveryId: String(row.delivery_id ?? ""),
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
/** Cap on one error string persisted (bounds storage; never stores secrets —
 *  callers must already sanitize before calling nack/deadLetter). */
const MAX_ERROR_LEN = 500;
export function boundedError(message) {
    const s = String(message ?? "unknown error");
    return s.length <= MAX_ERROR_LEN ? s : `${s.slice(0, MAX_ERROR_LEN - 1)}…`;
}
export class SqliteQueue {
    db;
    defaultMaxAttempts;
    constructor(opts) {
        const dir = dirname(opts.path);
        if (dir && dir !== "." && !existsSync(dir))
            mkdirSync(dir, { recursive: true });
        this.db = new DatabaseSync(opts.path);
        this.db.exec("PRAGMA journal_mode = WAL;");
        this.db.exec("PRAGMA busy_timeout = 5000;");
        this.db.exec("PRAGMA synchronous = NORMAL;");
        this.db.exec(SCHEMA);
        // Migration for DBs created before the `signature` column existed: the
        // worker must re-verify the HMAC, so a pre-migration job without a stored
        // signature is treated as unauthenticated (fail closed) by the worker.
        const cols = this.db.prepare("PRAGMA table_info(webhook_jobs)").all();
        if (!cols.some((c) => c.name === "signature")) {
            this.db.exec("ALTER TABLE webhook_jobs ADD COLUMN signature TEXT NOT NULL DEFAULT ''");
        }
        this.defaultMaxAttempts = clampPositiveInt(opts.maxAttempts, 8);
    }
    async enqueue(deliveryId, event, rawBody, payload, signature) {
        if (!deliveryId || deliveryId.length > 200) {
            throw new Error("delivery id is required and must be <= 200 chars");
        }
        const now = Date.now();
        // Idempotency: the UNIQUE(delivery_id) constraint + INSERT OR IGNORE makes
        // concurrent duplicate deliveries (GitHub redelivery, retries, multi-replica
        // fan-out) collapse into one durable job.
        const info = this.db
            .prepare(`INSERT OR IGNORE INTO webhook_jobs
           (delivery_id, event, raw_body, signature, payload_json, status, max_attempts,
            next_attempt_at, lease_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?)`)
            .run(deliveryId, event, rawBody, signature ?? "", JSON.stringify(payload), this.defaultMaxAttempts, now, now);
        if (info.changes > 0)
            return { accepted: true, duplicate: false, alreadyProcessed: false };
        const existing = this.db.prepare("SELECT status FROM webhook_jobs WHERE delivery_id = ?").get(deliveryId);
        return {
            accepted: false,
            duplicate: true,
            alreadyProcessed: existing?.status === "done",
        };
    }
    async claim(batchSize, leaseMs, workerId) {
        const n = clampPositiveInt(batchSize, 1);
        const lease = clampNonNegInt(leaseMs, 30_000);
        const now = Date.now();
        const ids = [];
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const rows = this.db
                .prepare(`SELECT id FROM webhook_jobs
           WHERE (status = 'pending' AND next_attempt_at <= ?)
              OR (status = 'in_progress' AND lease_until < ?)
           ORDER BY next_attempt_at ASC, id ASC
           LIMIT ?`)
                .all(now, now, n);
            for (const row of rows) {
                this.db
                    .prepare(`UPDATE webhook_jobs
             SET status = 'in_progress', lease_until = ?, lease_owner = ?, updated_at = ?
             WHERE id = ?`)
                    .run(now + lease, workerId, now, row.id);
                ids.push(row.id);
            }
            this.db.exec("COMMIT");
        }
        catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(",");
        const jobs = this.db
            .prepare(`SELECT * FROM webhook_jobs WHERE id IN (${placeholders}) ORDER BY id ASC`)
            .all(...ids);
        return jobs.map(rowToJob);
    }
    async ack(id, result) {
        const now = Date.now();
        this.db
            .prepare(`UPDATE webhook_jobs
         SET status = 'done', lease_until = 0, lease_owner = '', last_error = NULL,
             last_result = ?, updated_at = ?
         WHERE id = ? AND status = 'in_progress'`)
            .run(result ? boundedError(result) : null, now, id);
    }
    async nack(id, error, backoffOverrideMs) {
        const now = Date.now();
        const row = this.db.prepare("SELECT attempts, max_attempts FROM webhook_jobs WHERE id = ?").get(id);
        if (!row)
            return "dead";
        const attempts = Number(row.attempts) + 1;
        const maxAttempts = Number(row.max_attempts) || this.defaultMaxAttempts;
        if (attempts >= maxAttempts) {
            this.db
                .prepare(`UPDATE webhook_jobs
           SET status = 'dead', attempts = ?, lease_until = 0, lease_owner = '',
               last_error = ?, next_attempt_at = ?, updated_at = ?
           WHERE id = ?`)
                .run(attempts, boundedError(error), now, now, id);
            return "dead";
        }
        const delay = Number.isFinite(backoffOverrideMs) && (backoffOverrideMs ?? 0) >= 0
            ? backoffOverrideMs
            : backoffMs(attempts);
        this.db
            .prepare(`UPDATE webhook_jobs
         SET status = 'pending', attempts = ?, lease_until = 0, lease_owner = '',
             last_error = ?, next_attempt_at = ?, updated_at = ?
         WHERE id = ?`)
            .run(attempts, boundedError(error), now + Math.max(0, Math.floor(delay)), now, id);
        return "retrying";
    }
    async deadLetter(id, error) {
        const now = Date.now();
        this.db
            .prepare(`UPDATE webhook_jobs
         SET status = 'dead', lease_until = 0, lease_owner = '', last_error = ?, updated_at = ?
         WHERE id = ?`)
            .run(boundedError(error), now, id);
    }
    async depth() {
        const row = this.db
            .prepare("SELECT COUNT(*) AS n FROM webhook_jobs WHERE status IN ('pending','in_progress')")
            .get();
        return Number(row?.n ?? 0);
    }
    async stats() {
        const rows = this.db
            .prepare("SELECT status, COUNT(*) AS n FROM webhook_jobs GROUP BY status")
            .all();
        const counts = { pending: 0, in_progress: 0, done: 0, dead: 0 };
        for (const r of rows)
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
    async purgeDone(retainDoneForMs) {
        const cutoff = Date.now() - clampNonNegInt(retainDoneForMs, 7 * 24 * 3600 * 1000);
        const info = this.db
            .prepare("DELETE FROM webhook_jobs WHERE status = 'done' AND updated_at < ?")
            .run(cutoff);
        return Number(info.changes ?? 0);
    }
    close() {
        try {
            this.db.close();
        }
        catch {
            /* already closed */
        }
    }
}
export class MemoryQueue {
    jobs = new Map();
    byDelivery = new Map();
    nextId = 1;
    defaultMaxAttempts;
    constructor(opts = {}) {
        this.defaultMaxAttempts = clampPositiveInt(opts.maxAttempts, 8);
    }
    async enqueue(deliveryId, event, rawBody, payload, signature) {
        if (!deliveryId || deliveryId.length > 200) {
            throw new Error("delivery id is required and must be <= 200 chars");
        }
        const existingId = this.byDelivery.get(deliveryId);
        if (existingId !== undefined) {
            const job = this.jobs.get(existingId);
            return {
                accepted: false,
                duplicate: true,
                alreadyProcessed: job?.status === "done",
            };
        }
        const now = Date.now();
        const id = this.nextId++;
        const job = {
            id,
            deliveryId,
            event,
            rawBody,
            signature: signature ?? "",
            payload,
            status: "pending",
            attempts: 0,
            maxAttempts: this.defaultMaxAttempts,
            nextAttemptAt: 0,
            leaseUntil: 0,
            leaseOwner: "",
            lastError: null,
            lastResult: null,
            createdAt: now,
            updatedAt: now,
        };
        this.jobs.set(id, job);
        this.byDelivery.set(deliveryId, id);
        return { accepted: true, duplicate: false, alreadyProcessed: false };
    }
    async claim(batchSize, leaseMs, workerId) {
        const n = clampPositiveInt(batchSize, 1);
        const lease = clampNonNegInt(leaseMs, 30_000);
        const now = Date.now();
        const due = [...this.jobs.values()]
            .filter((j) => (j.status === "pending" && j.nextAttemptAt <= now) ||
            (j.status === "in_progress" && j.leaseUntil < now))
            .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.id - b.id)
            .slice(0, n);
        for (const job of due) {
            job.status = "in_progress";
            job.leaseUntil = now + lease;
            job.leaseOwner = workerId;
            job.updatedAt = now;
        }
        return due.map((j) => ({ ...j, payload: j.payload }));
    }
    async ack(id, result) {
        const job = this.jobs.get(id);
        if (!job || job.status !== "in_progress")
            return;
        job.status = "done";
        job.leaseUntil = 0;
        job.leaseOwner = "";
        job.lastError = null;
        job.lastResult = result ? boundedError(result) : null;
        job.updatedAt = Date.now();
    }
    async nack(id, error, backoffOverrideMs) {
        const job = this.jobs.get(id);
        if (!job)
            return "dead";
        const attempts = job.attempts + 1;
        job.attempts = attempts;
        job.lastError = boundedError(error);
        job.updatedAt = Date.now();
        if (attempts >= job.maxAttempts) {
            job.status = "dead";
            job.leaseUntil = 0;
            job.leaseOwner = "";
            return "dead";
        }
        const delay = Number.isFinite(backoffOverrideMs) && (backoffOverrideMs ?? 0) >= 0
            ? backoffOverrideMs
            : backoffMs(attempts);
        job.status = "pending";
        job.nextAttemptAt = Date.now() + Math.max(0, Math.floor(delay));
        job.leaseUntil = 0;
        job.leaseOwner = "";
        return "retrying";
    }
    async deadLetter(id, error) {
        const job = this.jobs.get(id);
        if (!job)
            return;
        job.status = "dead";
        job.lastError = boundedError(error);
        job.updatedAt = Date.now();
    }
    async depth() {
        let n = 0;
        for (const j of this.jobs.values()) {
            if (j.status === "pending" || j.status === "in_progress")
                n++;
        }
        return n;
    }
    async stats() {
        const counts = { pending: 0, in_progress: 0, done: 0, dead: 0 };
        for (const j of this.jobs.values()) {
            if (j.status in counts)
                counts[j.status]++;
        }
        const total = this.jobs.size;
        return {
            pending: counts.pending,
            inProgress: counts.in_progress,
            done: counts.done,
            dead: counts.dead,
            total,
        };
    }
    async purgeDone(retainDoneForMs) {
        const cutoff = Date.now() - clampNonNegInt(retainDoneForMs, 7 * 24 * 3600 * 1000);
        let purged = 0;
        for (const [id, job] of [...this.jobs.entries()]) {
            if (job.status === "done" && job.updatedAt < cutoff) {
                this.jobs.delete(id);
                this.byDelivery.delete(job.deliveryId);
                purged++;
            }
        }
        return purged;
    }
    close() {
        this.jobs.clear();
        this.byDelivery.clear();
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
//# sourceMappingURL=queue.js.map