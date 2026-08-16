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
    /**
     * pass/fail/timeout — the command executed (only with explicit `--run`).
     * no-command        — no verification command recorded.
     * not-executed      — a command is recorded but was NOT run (default).
     * refused           — `--run` given but trust requirements unmet.
     */
    status: "pass" | "fail" | "timeout" | "no-command" | "not-executed" | "refused";
    /** Signature/trust state of the intent (valid | invalid | unsigned | unverifiable | untrusted-key). */
    signature: SignatureState;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    /** Human-readable explanation (also safe to render). */
    message: string;
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
    /** Signer state after init: ready | read-only | missing | mismatch. */
    signerState: SignerState;
    /** sha256 fingerprint (16 hex chars) of the public key, or null. */
    publicKeyFingerprint: string | null;
}
/**
 * Signing-key availability of this checkout (ADR-009 key model):
 *   ready    — private key present and matches the committed trust root.
 *   read-only— committed public key present, private key absent (fresh clone).
 *   missing  — neither key present.
 *   mismatch — private key present but does NOT match the trust root.
 */
export type SignerState = "ready" | "read-only" | "missing" | "mismatch";
/**
 * Cryptographic trust state of an intent's signature:
 *   valid        — verifies against the trusted repository public key.
 *   invalid      — a signature exists but does not verify against the key.
 *   unsigned     — no signature recorded.
 *   unverifiable — no verification material available (e.g. no committed key).
 *   untrusted-key— verifies only against a key that is NOT the trust root
 *                  (PR contexts: a replacement key from the same PR).
 */
export type SignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "untrusted-key";
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
    /** Signer state: ready | read-only | missing | mismatch. */
    signerState?: SignerState;
    /** sha256 fingerprint (16 hex) of the trust-root public key, or null. */
    publicKeyFingerprint?: string | null;
    /** Whether a private signing key is present in this checkout. */
    privateKeyAvailable?: boolean;
    /** Whether new signed intents can be created here. */
    signingAllowed?: boolean;
    /** Whether committed public provenance exists (.drift/public/). */
    publicProvenance?: boolean;
    /** Whether verification material (committed public key) is available. */
    verificationMaterial?: boolean;
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
    private signerState;
    private redactionPatterns;
    private readonly publicOnly;
    /**
     * @param opts.forceStore open the private store even when drift.db is
     *   absent (used by `init`, which creates it).
     */
    private constructor();
    /**
     * Resolve the signer state from the private key (if present) and the
     * committed public trust root. Never throws for a missing or mismatched
     * private key — read commands must keep working; only signing is refused.
     *
     * State A: neither key            → missing (init generates a pair).
     * State B: both, matching         → ready.
     * State C: public only            → read-only (fresh clone).
     * State D: private only           → derive public, ready.
     * State E: both, not matching     → mismatch (signing refused).
     */
    private deriveKeyState;
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
    /**
     * Import the repository private signing key (ADR-009 key model, State C →
     * ready). Validates the key, derives its public key, requires it to match
     * the committed trust root, copies it atomically with restrictive
     * permissions, and never prints key material or stages it in git.
     */
    keyImport(privateKeyFilePath: string): {
        signerState: SignerState;
        publicKeyFingerprint: string | null;
    };
    /**
     * Refuse to create NEW signed provenance unless the local private key
     * matches the committed trust root (States A/B/D). Read-only clones (C) and
     * mismatches (E) get an actionable message and exit E_KEY.
     */
    private assertSignerReady;
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
    /**
     * Stage ONLY approved public Drift paths for the realize commit: the
     * ADR-009 gitignore (so `git add .` can never stage private data), the
     * public key (first introduction), and the new manifest. Config is staged
     * only when already tracked (respects a user who deliberately untracked it).
     * Returns the repo-relative paths that were staged.
     */
    private stagePublicFiles;
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
    /**
     * Canonical intent → commit association, derived ONLY from `Drift-Intent:`
     * git trailers (never from an unverified manifest field). `byId` maps each
     * intent id to the FIRST commit that references it (newest-first log order,
     * i.e. the introducing commit). `byCommit` maps each commit to all ids its
     * message references. Used by log, context, blame, status, export and the
     * fresh-clone paths so every consumer shares one resolver.
     */
    private intentCommitIndex;
    /**
     * Public manifests referenced by a commit's `Drift-Intent:` trailers. Falls
     * back to the V1 embedded `commit` field only when no trailer-derived match
     * exists (legacy manifests written before trailers became canonical).
     */
    private findManifestsForCommit;
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
    /**
     * Verification is INFORMATION by default: `drift verify <id>` validates the
     * manifest schema, reports the signature/trust state and shows the recorded
     * command WITHOUT executing it. A repository-provided verification string is
     * code — it may only run with an explicit `--run`, and only when the
     * manifest is validly signed by the trusted repository key (or when the
     * user explicitly forces execution with --allow-untrusted-command).
     */
    verify(intentId: string, opts?: {
        run?: boolean;
        allowUntrustedCommand?: boolean;
        timeoutMs?: number;
    }): VerifyResult;
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
    /**
     * Default export is PUBLIC-ONLY (ADR-009): committed manifests + trailer-
     * derived commit association, never a prompt. Private prompts are exported
     * only with `{ includePrivatePrompt: true }` (CLI: --include-private-prompt),
     * which marks the output `containsPrivatePrompts: true` and requires the
     * local store.
     */
    exportJson(opts?: {
        includePrivatePrompt?: boolean;
    }): string;
    verifyIntentSignature(intentId: string): {
        ok: boolean;
        detail: string;
        state: SignatureState;
    };
    /**
     * Shared signature/trust-state resolver used by verify, verify-intent and
     * blame. The committed public manifest is verified against the COMMITTED
     * public key — a newly generated local key (e.g. after `drift init` in a
     * clone) is never used to judge an old record, so the states distinguish
     * valid / invalid / unsigned / unverifiable / untrusted-key honestly.
     */
    private signatureState;
}
/**
 * Ensure `.drift/.gitignore` contains the ADR-009 rules. Idempotent and
 * non-destructive: existing lines are kept, missing rules are appended as a
 * block (the negation order within the block is preserved).
 */
export declare function ensureDriftGitignore(driftDir: string): void;
//# sourceMappingURL=engine.d.ts.map