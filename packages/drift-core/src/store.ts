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

-- Stat-validated performance index over the committed public manifests
-- (PRD §7 / docs/PERFORMANCE_REPORT.md). NEVER a trust source: it stores only
-- selection/ordering metadata (existence, mtime/size/ctime, manifest
-- timestamp, author/model, file paths) so bounded commands like
-- drift log --limit N and drift context can avoid walking and parsing
-- every manifest on every run. Every trust decision still re-reads the actual
-- manifest file; status/doctor re-verify the full tree from files. Rows are
-- invalidated by stat mismatch (mtime+size+ctime), the same class of
-- freshness discipline git's own index uses.
CREATE TABLE IF NOT EXISTS public_manifest_index (
  id           TEXT PRIMARY KEY,
  mtime_ms     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  ctime_ms     INTEGER NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  valid        INTEGER NOT NULL,
  author_id    TEXT,
  model        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pmi_timestamp ON public_manifest_index(timestamp_ms);

CREATE TABLE IF NOT EXISTS public_manifest_files (
  manifest_id TEXT NOT NULL,
  file_path   TEXT NOT NULL,
  PRIMARY KEY (manifest_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_pmf_path ON public_manifest_files(file_path);
`;

/** Bump when the public-manifest index schema or derivation changes. */
export const PUBLIC_MANIFEST_INDEX_VERSION = "1";

export interface PublicManifestStat {
  mtimeMs: number;
  size: number;
  ctimeMs: number;
}

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

/**
 * Deterministic intent → commit association, derived ONLY from
 * `Drift-Intent:` git trailers (never from an unverified manifest field):
 *
 *   unique    — referenced by exactly one commit.
 *   missing   — referenced by no commit.
 *   ambiguous — referenced by multiple commits and no committed public
 *               manifest establishes an introduction (orphan provenance).
 *   replayed  — referenced by multiple commits AND a committed public
 *               manifest exists: the oldest reference is the introduction,
 *               later references are replays.
 *   duplicate — the same id appears more than once in a single commit's
 *               trailer block (malformed/duplicate metadata).
 */
export type IntentCommitAssociation =
  | { state: "unique"; commit: string }
  | { state: "missing" }
  | { state: "duplicate-in-commit"; commit: string; occurrences: number }
  | { state: "replayed"; originalCommit: string; laterCommits: string[] }
  | { state: "ambiguous"; commits: string[] };

export interface LogEntry {
  id: string;
  gitSha: string;
  authorType: "HUMAN" | "AGENT";
  authorId: string;
  model: string | null;
  /** Full (redacted) prompt. Private: only surfaced with an explicit opt-in flag. */
  prompt: string;
  /** Safe public summary (ADR-009) — safe to commit, clone, and render. */
  summary?: string;
  timestamp: number;
  files: { path: string; mutationType: MutationType; summary: string | null }[];
  /** Structured trailer-derived association (unique/missing/ambiguous/replayed/duplicate). */
  association?: IntentCommitAssociation;
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
  private inBatch = 0;

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
    // `intents.parent_id` has no ON DELETE clause, so deleting an intent that
    // has dependants fails with a FOREIGN KEY error (e.g. `doctor --fix` on
    // an orphan that is a parent). Reparent the children to the removed
    // intent's parent first, keeping the DAG valid.
    this.db.exec("BEGIN");
    try {
      const row = this.db.prepare("SELECT parent_id FROM intents WHERE id = ?").get(id) as
        | { parent_id: string | null }
        | undefined;
      const parent = row?.parent_id ?? null;
      this.db.prepare("UPDATE intents SET parent_id = ? WHERE parent_id = ?").run(parent, id);
      this.db.prepare("DELETE FROM intents WHERE id = ?").run(id);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ------------------------------------------------- public-manifest index
  // Selection/ordering cache over `.drift/public/intents/*.json`. NEVER a
  // trust source — see the table comment and docs/PERFORMANCE_REPORT.md.

  /** True when the cached stat matches the file's current stat (fresh). */
  publicManifestRowMatches(id: string, st: PublicManifestStat): boolean {
    const row = this.db
      .prepare(
        "SELECT mtime_ms, size, ctime_ms FROM public_manifest_index WHERE id = ?",
      )
      .get(id) as { mtime_ms: number; size: number; ctime_ms: number } | undefined;
    return (
      row !== undefined &&
      row.mtime_ms === Math.trunc(st.mtimeMs) &&
      row.size === st.size &&
      row.ctime_ms === Math.trunc(st.ctimeMs)
    );
  }

  /**
   * Wrap a batch of `upsertPublicManifest` calls in ONE transaction (cold
   * index build). Outside a batch each upsert commits independently so a
   * crash never leaves a half-written row.
   */
  publicManifestIndexBatch<T>(fn: () => T): T {
    this.inBatch++;
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.inBatch--;
    }
  }

  /** Upsert one manifest row + its file-path rows. Caller re-parses first. */
  upsertPublicManifest(
    id: string,
    st: PublicManifestStat,
    timestampMs: number,
    valid: boolean,
    authorId: string | null,
    model: string | null,
    files: string[],
  ): void {
    const outer = this.inBatch === 0;
    if (outer) this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO public_manifest_index
             (id, mtime_ms, size, ctime_ms, timestamp_ms, valid, author_id, model)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             mtime_ms = excluded.mtime_ms,
             size = excluded.size,
             ctime_ms = excluded.ctime_ms,
             timestamp_ms = excluded.timestamp_ms,
             valid = excluded.valid,
             author_id = excluded.author_id,
             model = excluded.model`,
        )
        .run(
          id,
          Math.trunc(st.mtimeMs),
          st.size,
          Math.trunc(st.ctimeMs),
          timestampMs,
          valid ? 1 : 0,
          authorId,
          model,
        );
      this.db.prepare("DELETE FROM public_manifest_files WHERE manifest_id = ?").run(id);
      for (const path of files) {
        this.db.prepare("INSERT OR IGNORE INTO public_manifest_files (manifest_id, file_path) VALUES (?, ?)").run(id, path);
      }
      if (outer) this.db.exec("COMMIT");
    } catch (err) {
      if (outer) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Drop rows whose manifest file no longer exists in the working tree. */
  dropPublicManifestMissing(seen: Set<string>): void {
    const all = this.db
      .prepare("SELECT id FROM public_manifest_index")
      .all() as unknown as { id: string }[];
    const toDelete = all.filter((r) => !seen.has(r.id)).map((r) => r.id);
    if (toDelete.length === 0) return;
    const chunk = 400;
    for (let i = 0; i < toDelete.length; i += chunk) {
      const slice = toDelete.slice(i, i + chunk);
      const marks = slice.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM public_manifest_index WHERE id IN (${marks})`).run(...slice);
      this.db
        .prepare(`DELETE FROM public_manifest_files WHERE manifest_id IN (${marks})`)
        .run(...slice);
    }
  }

  dropAllPublicManifestIndex(): void {
    this.db.prepare("DELETE FROM public_manifest_files").run();
    this.db.prepare("DELETE FROM public_manifest_index").run();
  }

  /** Total indexed manifest rows (benchmark/observability). */
  publicManifestIndexRows(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS c FROM public_manifest_index").get() as { c: number };
    return row.c;
  }

  /** Valid (selectable) indexed manifest rows (benchmark/observability). */
  publicManifestIndexValidRows(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM public_manifest_index WHERE valid = 1")
      .get() as { c: number };
    return row.c;
  }

  /** Ids of indexed-but-invalid manifests (fast diagnostics path). */
  publicManifestIndexInvalidIds(): string[] {
    const rows = this.db
      .prepare("SELECT id FROM public_manifest_index WHERE valid = 0 ORDER BY id ASC")
      .all() as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  /**
   * Bounded top-N manifest ids (timestamp desc, id asc tiebreak), optionally
   * filtered by file (prefix for `log --file`, exact for `context`) and by
   * author/model. Only VALID manifests are selectable — malformed manifests
   * are surfaced by status/doctor (which always re-read every file), never
   * silently rendered by log/context.
   */
  topPublicManifestIds(
    limit: number,
    opts: { file?: string; fileExact?: boolean; author?: string; model?: string } = {},
  ): string[] {
    const joins: string[] = [];
    const where: string[] = ["m.valid = 1"];
    const params: (string | number)[] = [];
    if (opts.file !== undefined) {
      joins.push("JOIN public_manifest_files f ON f.manifest_id = m.id");
      if (opts.fileExact) {
        where.push("f.file_path = ?");
        params.push(opts.file);
      } else {
        where.push("f.file_path LIKE ? || '%'");
        params.push(opts.file);
      }
    }
    if (opts.author !== undefined) {
      where.push("m.author_id = ?");
      params.push(opts.author);
    }
    if (opts.model !== undefined) {
      where.push("m.model = ?");
      params.push(opts.model);
    }
    const sql = `
      SELECT DISTINCT m.id
      FROM public_manifest_index m
      ${joins.join("\n")}
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY m.timestamp_ms DESC, m.id ASC
      LIMIT ?
    `;
    const rows = this.db.prepare(sql).all(...params, safeLimit(limit, 100)) as unknown as {
      id: string;
    }[];
    return rows.map((r) => r.id);
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
