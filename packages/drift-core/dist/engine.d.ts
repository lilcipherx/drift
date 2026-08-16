/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */
import { type ASTDelta } from "@drift/ast";
import { type DriftConfig, type PromptMode } from "./config.js";
import { type IntentRecord, type LogEntry } from "./store.js";
export interface RealizeOptions {
    prompt: string;
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
    intents?: number;
    head?: string | null;
    encryption?: boolean;
    promptMode?: PromptMode;
    gitBranch?: string | null;
    gitHead?: string | null;
    gitDirty?: boolean;
    lastIntent?: {
        id: string;
        timestamp: number;
        prompt: string;
    } | null;
}
export declare class Drift {
    readonly repoRoot: string;
    readonly driftDir: string;
    readonly config: DriftConfig;
    private store;
    private privateKeyPem;
    private publicKeyPem;
    private redactionPatterns;
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
    exportJson(): string;
    verifyIntentSignature(intentId: string): {
        ok: boolean;
        detail: string;
    };
}
//# sourceMappingURL=engine.d.ts.map