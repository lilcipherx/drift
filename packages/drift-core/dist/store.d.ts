/**
 * Intent DAG storage (PRD §13.2, ADR-001). SQLite in WAL mode, ACID, using
 * Node's built-in `node:sqlite` — zero native dependencies.
 */
import type { ASTDelta, MutationType } from "@drift/ast";
/**
 * Embedded copy of migrations/001_init.sql so @drift/core works standalone
 * (the SQL file in ./migrations is kept as the reviewed source of truth).
 */
declare const MIGRATION_001 = "\nCREATE TABLE IF NOT EXISTS drift_meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS intents (\n  id          TEXT PRIMARY KEY,\n  parent_id   TEXT,\n  git_sha     TEXT NOT NULL UNIQUE,\n  author_type INTEGER NOT NULL,\n  author_id   TEXT NOT NULL,\n  model       TEXT,\n  prompt      TEXT NOT NULL,\n  timestamp   INTEGER NOT NULL,\n  object_path TEXT NOT NULL,\n  FOREIGN KEY (parent_id) REFERENCES intents(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_intents_git_sha ON intents(git_sha);\nCREATE INDEX IF NOT EXISTS idx_intents_timestamp ON intents(timestamp);\n\nCREATE TABLE IF NOT EXISTS intent_files (\n  intent_id     TEXT NOT NULL,\n  file_path     TEXT NOT NULL,\n  mutation_type INTEGER NOT NULL,\n  node_ids      TEXT NOT NULL DEFAULT '[]',\n  summary       TEXT,\n  PRIMARY KEY (intent_id, file_path),\n  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_intent_files_path ON intent_files(file_path);\n\n-- Stat-validated performance index over the committed public manifests\n-- (PRD \u00A77 / docs/PERFORMANCE_REPORT.md). NEVER a trust source: it stores only\n-- selection/ordering metadata (existence, mtime/size/ctime, manifest\n-- timestamp, author/model, file paths) so bounded commands like\n-- drift log --limit N and drift context can avoid walking and parsing\n-- every manifest on every run. Every trust decision still re-reads the actual\n-- manifest file; status/doctor re-verify the full tree from files. Rows are\n-- invalidated by stat mismatch (mtime+size+ctime), the same class of\n-- freshness discipline git's own index uses.\nCREATE TABLE IF NOT EXISTS public_manifest_index (\n  id           TEXT PRIMARY KEY,\n  mtime_ms     INTEGER NOT NULL,\n  size         INTEGER NOT NULL,\n  ctime_ms     INTEGER NOT NULL,\n  timestamp_ms INTEGER NOT NULL,\n  valid        INTEGER NOT NULL,\n  author_id    TEXT,\n  model        TEXT\n);\n\nCREATE INDEX IF NOT EXISTS idx_pmi_timestamp ON public_manifest_index(timestamp_ms);\n\nCREATE TABLE IF NOT EXISTS public_manifest_files (\n  manifest_id TEXT NOT NULL,\n  file_path   TEXT NOT NULL,\n  PRIMARY KEY (manifest_id, file_path)\n);\n\nCREATE INDEX IF NOT EXISTS idx_pmf_path ON public_manifest_files(file_path);\n";
/** Bump when the public-manifest index schema or derivation changes. */
export declare const PUBLIC_MANIFEST_INDEX_VERSION = "1";
export interface PublicManifestStat {
    mtimeMs: number;
    size: number;
    ctimeMs: number;
}
export interface IntentRecord {
    id: string;
    parentId: string | null;
    gitCommitSha: string;
    author: {
        type: "HUMAN" | "AGENT";
        identifier: string;
        model?: string;
    };
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
export type IntentCommitAssociation = {
    state: "unique";
    commit: string;
} | {
    state: "missing";
} | {
    state: "duplicate-in-commit";
    commit: string;
    occurrences: number;
} | {
    state: "replayed";
    originalCommit: string;
    laterCommits: string[];
} | {
    state: "ambiguous";
    commits: string[];
};
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
    files: {
        path: string;
        mutationType: MutationType;
        summary: string | null;
    }[];
    /** Structured trailer-derived association (unique/missing/ambiguous/replayed/duplicate). */
    association?: IntentCommitAssociation;
}
export declare class IntentStore {
    private readonly dbPath;
    private db;
    private inBatch;
    private constructor();
    static open(dbPath: string): IntentStore;
    close(): void;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    getHead(): string | null;
    setHead(id: string): void;
    insertIntent(intent: IntentRecord): void;
    findByGitSha(gitSha: string): IntentRecord | null;
    getById(id: string): IntentRecord | null;
    private rowToIntent;
    /**
     * Parse the intent's object file (source of truth for signature data).
     * object_path is stored relative to the repo root (ADR-007) so metadata
     * stays portable when committed and cloned.
     */
    readObjectRecord(objectPath: string): Record<string, unknown> | null;
    listIntents(filters?: LogFilters): LogEntry[];
    private rowToLogEntry;
    /** Last N intents touching a file (PRD §7.5 `drift context`). */
    contextForFile(filePath: string, limit?: number): LogEntry[];
    /** PRAGMA integrity_check — 'ok' on success. */
    integrityCheck(): string;
    allRows(): IntentRow[];
    deleteById(id: string): void;
    /** True when the cached stat matches the file's current stat (fresh). */
    publicManifestRowMatches(id: string, st: PublicManifestStat): boolean;
    /**
     * Wrap a batch of `upsertPublicManifest` calls in ONE transaction (cold
     * index build). Outside a batch each upsert commits independently so a
     * crash never leaves a half-written row.
     */
    publicManifestIndexBatch<T>(fn: () => T): T;
    /** Upsert one manifest row + its file-path rows. Caller re-parses first. */
    upsertPublicManifest(id: string, st: PublicManifestStat, timestampMs: number, valid: boolean, authorId: string | null, model: string | null, files: string[]): void;
    /** Drop rows whose manifest file no longer exists in the working tree. */
    dropPublicManifestMissing(seen: Set<string>): void;
    dropAllPublicManifestIndex(): void;
    /** Total indexed manifest rows (benchmark/observability). */
    publicManifestIndexRows(): number;
    /** Valid (selectable) indexed manifest rows (benchmark/observability). */
    publicManifestIndexValidRows(): number;
    /** Ids of indexed-but-invalid manifests (fast diagnostics path). */
    publicManifestIndexInvalidIds(): string[];
    /**
     * Bounded top-N manifest ids (timestamp desc, id asc tiebreak), optionally
     * filtered by file (prefix for `log --file`, exact for `context`) and by
     * author/model. Only VALID manifests are selectable — malformed manifests
     * are surfaced by status/doctor (which always re-read every file), never
     * silently rendered by log/context.
     */
    topPublicManifestIds(limit: number, opts?: {
        file?: string;
        fileExact?: boolean;
        author?: string;
        model?: string;
    }): string[];
}
export { MIGRATION_001 };
export { join as joinPath } from "node:path";
//# sourceMappingURL=store.d.ts.map