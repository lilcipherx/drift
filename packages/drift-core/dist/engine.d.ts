/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */
import { type ASTDelta } from "@drift/ast";
import { type DriftConfig, type PromptMode } from "./config.js";
import { type IntentRecord, type LogEntry } from "./store.js";
export interface RealizeOptions {
    prompt: string;
    /**
     * Explicit PUBLIC summary (ADR-009). Redacted, sanitized, length-limited
     * before it can reach git history, manifests, PR comments or default JSON.
     * When omitted, a generic non-prompt fallback is used instead of copying
     * prompt text. Never derives from `prompt`.
     */
    summary?: string;
    files?: string[];
    model?: string;
    author?: string;
    authorType?: "HUMAN" | "AGENT";
    agentState?: string;
    verifyCmd?: string;
    noAst?: boolean;
}
export interface RealizeResult {
    gitSha: string;
    intentId: string;
    astDelta: ASTDelta[];
    redactions: number;
}
export interface BlameResult {
    file: string;
    line: number;
    functionName?: string;
    gitSha: string;
    committed: boolean;
    intent: (IntentRecord & {
        signatureValid: boolean;
        summary: string;
    }) | null;
    baseline: boolean;
}
export interface VerifyResult {
    intentId: string;
    verifyCmd: string | null;
    status: "pass" | "fail" | "no-command";
    exitCode: number | null;
    stdout: string;
    stderr: string;
}
export interface ReplayResult {
    intentId: string;
    gitSha: string;
    agentState: string | null;
    checkedOut: boolean;
}
export interface DoctorCheck {
    name: string;
    ok: boolean;
    detail: string;
}
export interface DoctorResult {
    checks: DoctorCheck[];
    orphanIds: string[];
    fixed: string[];
}
export interface InitResult {
    repoRoot: string;
    driftDir: string;
    publicKeyPem: string;
}
export interface DriftStatus {
    initialized: boolean;
    repoRoot: string | null;
    /** Why status is not fully initialized. */
    reason?: "no-git" | "not-initialized";
    /** Merged intent count (committed public + local-only legacy). */
    intents?: number;
    /** Committed public provenance count (canonical, survives clones). */
    publicIntents?: number;
    /** Local-only private store records (0 in a fresh clone before init). */
    localIntents?: number;
    head?: string | null;
    encryption?: boolean;
    promptMode?: PromptMode;
    gitBranch?: string | null;
    gitHead?: string | null;
    gitDirty?: boolean;
    lastIntent?: {
        id: string;
        timestamp: number;
        summary: string;
    } | null;
}
export declare class Drift {
    readonly repoRoot: string;
    readonly driftDir: string;
    readonly config: DriftConfig;
    /**
     * Private SQLite intent store. `null` in public-only mode (fresh clone,
     * ADR-009): read commands then serve from the committed public manifests.
     */
    private store;
    private publicStore;
    private privateKeyPem;
    private publicKeyPem;
    private redactionPatterns;
    private readonly publicOnly;
    /**
     * @param opts.forceStore open the private store even when drift.db is
     *   absent (used by `init`, which creates it).
     */
    private constructor();
    /** DRIFT_MASTER_KEY → 32-byte AES key, or null when not set (PRD §17.2). */
    private getMasterKey;
    /** Throw E_KEY (exit 4) when encryption is enabled but the key is missing. */
    private masterKeyOrThrow;
    /**
     * Decrypt a stored value when it is an encrypted payload (AAD-bound to the
     * intent id). Legacy plaintext passes through untouched. Without a key:
     * readable fields degrade to a placeholder; `replay`/`verify` fail hard
     * with E_KEY instead.
     */
    private decryptText;
    static fromCwd(cwd: string): Drift;
    static init(cwd: string, opts?: {
        author?: string;
    }): InitResult;
    private loadKeys;
    close(): void;
    /** The private store, or a clear error naming the command that needs it. */
    private requireStore;
    get publicKey(): string;
    /**
     * First-run friendly status: always succeeds as a read, reports whether the
     * repo is initialized and what the next step is. Never throws for missing
     * init (a corrupted store still surfaces as exit 5).
     */
    static status(cwd: string): DriftStatus;
    realize(opts: RealizeOptions): RealizeResult;
    log(filters?: {
        author?: string;
        model?: string;
        file?: string;
        limit?: number;
    }): LogEntry[];
    /**
     * Canonical provenance is the committed public manifest (ADR-009) — that is
     * what survives a fresh clone and what the Action/App consume. The private
     * store only enriches those entries with the local prompt; store-only
     * (legacy pre-ADR-009) intents are kept so old repos keep working.
     */
    private mergeIntents;
    /**
     * Safe public summary for an intent: committed manifest first; for legacy
     * pre-ADR-009 records without a manifest, a generic non-prompt fallback
     * (never prompt text — public summaries cannot be reconstructed safely).
     */
    summaryFor(id: string, _localPrompt: string): string;
    blame(filePath: string, opts?: {
        line?: number;
        functionName?: string;
    }): BlameResult;
    context(filePath: string, limit?: number): LogEntry[];
    verify(intentId: string): VerifyResult;
    replay(intentId: string, opts?: {
        checkout?: boolean;
    }): ReplayResult;
    doctor(opts?: {
        fix?: boolean;
    }): DoctorResult;
    /** Private Drift paths that git does NOT ignore. */
    private untrackPrivateDriftFiles;
    /** Tracked files under .drift that are NOT in the public allow-list. */
    private trackedPrivateDriftFiles;
    /** Tracked .drift JSON files whose content carries a `prompt` field. */
    private trackedPromptBearingObjects;
    exportJson(): string;
    verifyIntentSignature(intentId: string): {
        ok: boolean;
        detail: string;
    };
}
/**
 * Ensure `.drift/.gitignore` contains the ADR-009 rules. Idempotent and
 * non-destructive: existing lines are kept, missing rules are appended as a
 * block (the negation order within the block is preserved).
 */
export declare function ensureDriftGitignore(driftDir: string): void;
//# sourceMappingURL=engine.d.ts.map