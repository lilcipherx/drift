/**
 * Intent DAG storage (PRD §13.2, ADR-001). SQLite in WAL mode, ACID, using
 * Node's built-in `node:sqlite` — zero native dependencies.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ASTDelta, MutationType } from "@drift/ast";

/**
 * Embedded copy of migrations/001_init.sql so @drift/core works standalone
 * (the SQL file in ./migrations is kept as the reviewed source of truth).
 */
const MIGRATION_001 = `
CREATE TABLE IF NOT EXISTS drift_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS intents (
  id          TEXT PRIMARY KEY,
  parent_id   TEXT,
  git_sha     TEXT NOT NULL UNIQUE,
  author_type INTEGER NOT NULL,
  author_id   TEXT NOT NULL,
  model       TEXT,
  prompt      TEXT NOT NULL,
  timestamp   INTEGER NOT NULL,
  object_path TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES intents(id)
);

CREATE INDEX IF NOT EXISTS idx_intents_git_sha ON intents(git_sha);
CREATE INDEX IF NOT EXISTS idx_intents_timestamp ON intents(timestamp);

CREATE TABLE IF NOT EXISTS intent_files (
  intent_id     TEXT NOT NULL,
  file_path     TEXT NOT NULL,
  mutation_type INTEGER NOT NULL,
  node_ids      TEXT NOT NULL DEFAULT '[]',
  summary       TEXT,
  PRIMARY KEY (intent_id, file_path),
  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intent_files_path ON intent_files(file_path);
`;

const MUTATION_TO_INT: Record<MutationType, number> = {
  ADDED: 0,
  MODIFIED: 1,
  DELETED: 2,
  MOVED: 3,
  RENAMED: 4,
};

const INT_TO_MUTATION: MutationType[] = [
  "ADDED",
  "MODIFIED",
  "DELETED",
  "MOVED",
  "RENAMED",
];

export interface IntentRecord {
  id: string;
  parentId: string | null;
  gitCommitSha: string;
  author: { type: "HUMAN" | "AGENT"; identifier: string; model?: string };
  prompt: string;
  astDelta: ASTDelta[];
  agentState?: string;
  verifyCmd?: string;
  timestamp: number;
  objectPath: string;
  signature: string;
}

export interface IntentRow {
  id: string;
  parent_id: string | null;
  git_sha: string;
  author_type: number;
  author_id: string;
  model: string | null;
  prompt: string;
  timestamp: number;
  object_path: string;
}

export interface IntentFileRow {
  intent_id: string;
  file_path: string;
  mutation_type: number;
  node_ids: string;
  summary: string | null;
}

export interface LogFilters {
  author?: string;
  model?: string;
  file?: string;
  limit?: number;
}

export interface LogEntry {
  id: string;
  gitSha: string;
  authorType: "HUMAN" | "AGENT";
  authorId: string;
  model: string | null;
  prompt: string;
  timestamp: number;
  files: { path: string; mutationType: MutationType; summary: string | null }[];
}

interface LogRow {
  id: string;
  git_sha: string;
  author_type: number;
  author_id: string;
  model: string | null;
  prompt: string;
  timestamp: number;
  files_json: string;
}

export class IntentStore {
  private db: DatabaseSync;

  private constructor(private readonly dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(MIGRATION_001);
  }

  static open(dbPath: string): IntentStore {
    return new IntentStore(dbPath);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ---- meta ---------------------------------------------------------------
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM drift_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO drift_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  getHead(): string | null {
    return this.getMeta("head_id");
  }

  setHead(id: string): void {
    this.setMeta("head_id", id);
  }

  // ---- intents ------------------------------------------------------------
  insertIntent(intent: IntentRecord): void {
    const { id, parentId, gitCommitSha, author, prompt, timestamp, objectPath, signature } = intent;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO intents
             (id, parent_id, git_sha, author_type, author_id, model, prompt, timestamp, object_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          parentId,
          gitCommitSha,
          author.type === "AGENT" ? 1 : 0,
          author.identifier,
          author.model ?? null,
          prompt,
          timestamp,
          objectPath,
        );
      for (const delta of intent.astDelta) {
        this.db
          .prepare(
            `INSERT OR REPLACE INTO intent_files
               (intent_id, file_path, mutation_type, node_ids, summary)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            delta.filePath,
            MUTATION_TO_INT[delta.type],
            JSON.stringify(delta.nodeIds),
            delta.summary,
          );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  findByGitSha(gitSha: string): IntentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM intents WHERE git_sha = ?")
      .get(gitSha) as IntentRow | undefined;
    return row ? this.rowToIntent(row) : null;
  }

  getById(id: string): IntentRecord | null {
    const row = this.db
      .prepare("SELECT * FROM intents WHERE id = ?")
      .get(id) as IntentRow | undefined;
    return row ? this.rowToIntent(row) : null;
  }

  private rowToIntent(row: IntentRow): IntentRecord {
    const files = this.db
      .prepare(
        "SELECT file_path, mutation_type, node_ids, summary FROM intent_files WHERE intent_id = ? ORDER BY rowid",
      )
      .all(row.id) as unknown as IntentFileRow[];
    const obj = this.readObjectRecord(row.object_path) ?? {};
    return {
      id: row.id,
      parentId: row.parent_id,
      gitCommitSha: row.git_sha,
      author: {
        type: row.author_type === 1 ? "AGENT" : "HUMAN",
        identifier: row.author_id,
        model: row.model ?? undefined,
      },
      prompt: row.prompt,
      astDelta: files.map((f) => ({
        filePath: f.file_path,
        type: INT_TO_MUTATION[f.mutation_type] ?? "MODIFIED",
        nodeIds: safeParseJson<string[]>(f.node_ids, []),
        summary: f.summary ?? "",
      })),
      agentState: (obj.agentState as string | undefined) ?? undefined,
      verifyCmd: (obj.verifyCmd as string | undefined) ?? undefined,
      timestamp: row.timestamp,
      objectPath: row.object_path,
      signature: (obj.signature as string | undefined) ?? "",
    };
  }

  /**
   * Parse the intent's object file (source of truth for signature data).
   * object_path is stored relative to the repo root (ADR-007) so metadata
   * stays portable when committed and cloned.
   */
  readObjectRecord(objectPath: string): Record<string, unknown> | null {
    const repoRoot = dirname(dirname(this.dbPath));
    const abs = resolve(repoRoot, objectPath);
    if (!existsSync(abs)) return null;
    try {
      return JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  listIntents(filters: LogFilters = {}): LogEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filters.author) {
      where.push("i.author_id = ?");
      params.push(filters.author);
    }
    if (filters.model) {
      where.push("i.model = ?");
      params.push(filters.model);
    }
    if (filters.file) {
      // exact match, or prefix match (e.g. `--file src/auth` matches src/auth.ts)
      where.push(
        "EXISTS (SELECT 1 FROM intent_files f WHERE f.intent_id = i.id AND (f.file_path = ? OR f.file_path LIKE ? || '%'))",
      );
      params.push(filters.file, filters.file);
    }
    const sql = `
      SELECT i.id, i.git_sha, i.author_type, i.author_id, i.model, i.prompt, i.timestamp,
             (SELECT json_group_array(json_object(
                'path', f.file_path, 'mutationType', f.mutation_type, 'summary', f.summary
             )) FROM intent_files f WHERE f.intent_id = i.id) AS files_json
      FROM intents i
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY i.timestamp DESC
      ${filters.limit !== undefined ? "LIMIT " + safeLimit(filters.limit, 100) : ""}
    `;
    const rows = this.db.prepare(sql).all(...params) as unknown as LogRow[];
    return rows.map((r) => this.rowToLogEntry(r));
  }

  private rowToLogEntry(r: LogRow): LogEntry {
    const files = safeParseJson<
      { path: string; mutationType: number; summary: string | null }[]
    >(r.files_json, []);
    return {
      id: r.id,
      gitSha: r.git_sha,
      authorType: r.author_type === 1 ? "AGENT" : "HUMAN",
      authorId: r.author_id,
      model: r.model,
      prompt: r.prompt,
      timestamp: r.timestamp,
      files: files.map((f) => ({
        path: f.path,
        mutationType: INT_TO_MUTATION[f.mutationType] ?? "MODIFIED",
        summary: f.summary,
      })),
    };
  }

  /** Last N intents touching a file (PRD §7.5 `drift context`). */
  contextForFile(filePath: string, limit = 5): LogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.git_sha, i.author_type, i.author_id, i.model, i.prompt, i.timestamp,
                (SELECT json_group_array(json_object(
                   'path', f.file_path, 'mutationType', f.mutation_type, 'summary', f.summary
                )) FROM intent_files f WHERE f.intent_id = i.id) AS files_json
         FROM intent_files ifx
         JOIN intents i ON i.id = ifx.intent_id
         WHERE ifx.file_path = ?
         ORDER BY i.timestamp DESC
         LIMIT ?`,
      )
      .all(filePath, safeLimit(limit, 5)) as unknown as LogRow[];
    return rows.map((r) => this.rowToLogEntry(r));
  }

  /** PRAGMA integrity_check — 'ok' on success. */
  integrityCheck(): string {
    const row = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    return row?.integrity_check ?? "unknown";
  }

  allRows(): IntentRow[] {
    return this.db.prepare("SELECT * FROM intents").all() as unknown as IntentRow[];
  }

  deleteById(id: string): void {
    this.db.prepare("DELETE FROM intents WHERE id = ?").run(id);
  }
}

function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Clamp a user-supplied limit to a safe, finite positive integer.
 * Non-finite input (Infinity / NaN from a `--limit` flag or SDK call) falls
 * back instead of being interpolated into SQL (which would raise
 * "no such column: Infinity").
 */
function safeLimit(n: number | undefined, fallback: number): number {
  if (n === undefined) return fallback;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.floor(n));
}

export { MIGRATION_001 };
export { join as joinPath } from "node:path";
