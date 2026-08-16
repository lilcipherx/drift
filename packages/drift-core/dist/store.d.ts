/**
 * Intent DAG storage (PRD §13.2, ADR-001). SQLite in WAL mode, ACID, using
 * Node's built-in `node:sqlite` — zero native dependencies.
 */
import type { ASTDelta, MutationType } from "@drift/ast";
/**
 * Embedded copy of migrations/001_init.sql so @drift/core works standalone
 * (the SQL file in ./migrations is kept as the reviewed source of truth).
 */
declare const MIGRATION_001 = "\nCREATE TABLE IF NOT EXISTS drift_meta (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS intents (\n  id          TEXT PRIMARY KEY,\n  parent_id   TEXT,\n  git_sha     TEXT NOT NULL UNIQUE,\n  author_type INTEGER NOT NULL,\n  author_id   TEXT NOT NULL,\n  model       TEXT,\n  prompt      TEXT NOT NULL,\n  timestamp   INTEGER NOT NULL,\n  object_path TEXT NOT NULL,\n  FOREIGN KEY (parent_id) REFERENCES intents(id)\n);\n\nCREATE INDEX IF NOT EXISTS idx_intents_git_sha ON intents(git_sha);\nCREATE INDEX IF NOT EXISTS idx_intents_timestamp ON intents(timestamp);\n\nCREATE TABLE IF NOT EXISTS intent_files (\n  intent_id     TEXT NOT NULL,\n  file_path     TEXT NOT NULL,\n  mutation_type INTEGER NOT NULL,\n  node_ids      TEXT NOT NULL DEFAULT '[]',\n  summary       TEXT,\n  PRIMARY KEY (intent_id, file_path),\n  FOREIGN KEY (intent_id) REFERENCES intents(id) ON DELETE CASCADE\n);\n\nCREATE INDEX IF NOT EXISTS idx_intent_files_path ON intent_files(file_path);\n";
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
}
export declare class IntentStore {
    private readonly dbPath;
    private db;
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
}
export { MIGRATION_001 };
export { join as joinPath } from "node:path";
//# sourceMappingURL=store.d.ts.map