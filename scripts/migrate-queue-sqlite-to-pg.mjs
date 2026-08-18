#!/usr/bin/env node
/**
 * Migrate the App's durable webhook queue from SQLite to Postgres
 * (docs/OPERATIONS_RUNBOOK.md §5). Both adapters share the same schema and
 * semantics, so the migration is a straight row copy:
 *
 *   - source: `webhook_jobs` in the SQLite queue.db (node:sqlite, no native
 *     deps);
 *   - target: `webhook_jobs` in Postgres (created automatically by the
 *     adapter on first use);
 *   - idempotent: `ON CONFLICT (delivery_id) DO NOTHING` — safe to re-run
 *     after an interrupted migration;
 *   - verifies: per-status counts must match between source and target.
 *
 * Run with the queue DRAINED OR STOPPED (no active worker claiming jobs) so
 * the snapshot is consistent. After the migration, switch the deployment to
 * `DRIFT_APP_QUEUE=postgres` + `DRIFT_QUEUE_URL`.
 *
 * Usage:
 *   node scripts/migrate-queue-sqlite-to-pg.mjs \
 *     --sqlite /path/to/queue.db --pg postgres://user:pass@host/db [--dry-run]
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { Pool } from "pg";

const args = process.argv.slice(2);
const pick = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};
const sqlitePath = pick("--sqlite") ?? process.env.DRIFT_APP_QUEUE_PATH;
const pgUrl = pick("--pg") ?? process.env.DRIFT_QUEUE_URL ?? process.env.DRIFT_TEST_PG_URL;
const dryRun = args.includes("--dry-run");

if (!sqlitePath || !pgUrl) {
  console.error("usage: node scripts/migrate-queue-sqlite-to-pg.mjs --sqlite <queue.db> --pg <postgres-url> [--dry-run]");
  process.exit(2);
}
if (!existsSync(sqlitePath)) {
  console.error(`source queue.db not found: ${sqlitePath}`);
  process.exit(2);
}

const COLS = [
  "delivery_id",
  "event",
  "raw_body",
  "signature",
  "payload_json",
  "status",
  "attempts",
  "max_attempts",
  "next_attempt_at",
  "lease_until",
  "lease_owner",
  "last_error",
  "last_result",
  "created_at",
  "updated_at",
  "tenant_id",
];

async function main() {
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const rows = src.prepare(`SELECT ${COLS.join(", ")} FROM webhook_jobs`).all();
  src.close();
  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  console.log(`[migrate] source ${rows.length} jobs: ${JSON.stringify(byStatus)}`);

  if (dryRun) {
    console.log("[migrate] dry-run: no writes performed.");
    process.exit(0);
  }

  const pool = new Pool({ connectionString: pgUrl, max: 5 });
  let client;
  try {
    client = await pool.connect();
    // Ensure the target schema exists (same DDL as the PostgresQueue adapter).
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_jobs (
        id BIGSERIAL PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE,
        event TEXT NOT NULL,
        raw_body TEXT NOT NULL,
        signature TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 8,
        next_attempt_at BIGINT NOT NULL DEFAULT 0,
        lease_until BIGINT NOT NULL DEFAULT 0,
        lease_owner TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        last_result TEXT,
        created_at BIGINT NOT NULL,
        updated_at BIGINT NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_jobs_claim ON webhook_jobs(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_jobs_created ON webhook_jobs(created_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_jobs_tenant ON webhook_jobs(tenant_id, status);
    `);

    let copied = 0;
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO webhook_jobs
           (${COLS.join(", ")})
         VALUES (${COLS.map((_, i) => `$${i + 1}`).join(", ")})
         ON CONFLICT (delivery_id) DO NOTHING`,
        COLS.map((c) => (r[c] === null ? null : r[c])),
      );
      copied += Number(res.rowCount ?? 0);
    }

    const tgt = await client.query("SELECT status, COUNT(*) AS n FROM webhook_jobs GROUP BY status");
    const tgtByStatus = {};
    for (const t of tgt.rows) tgtByStatus[t.status] = Number(t.n);
    const tgtTotal = Object.values(tgtByStatus).reduce((a, b) => a + b, 0);

    const ok = tgtTotal === rows.length && Object.keys(byStatus).every((s) => (tgtByStatus[s] ?? 0) === byStatus[s]);
    console.log(`[migrate] copied ${copied} (${rows.length - copied} already present) → target ${tgtTotal} jobs: ${JSON.stringify(tgtByStatus)}`);
    if (!ok) {
      console.error("[migrate] FAIL: target counts do not match source counts");
      process.exit(1);
    }
    console.log("[migrate] OK — counts match. Switch the deployment to DRIFT_APP_QUEUE=postgres + DRIFT_QUEUE_URL.");
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`[migrate] fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
