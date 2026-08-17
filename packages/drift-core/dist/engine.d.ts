/**
 * The Drift engine: orchestrates every command. Used by the CLI and wrapped
 * by the SDK. The MCP server delegates here through the CLI (PRD §11 contract).
 */
import { type ASTDelta } from "@drift/ast";
import { type DriftConfig, type PromptMode } from "./config.js";
import { type IntentCommitAssociation, type IntentRecord, type LogEntry } from "./store.js";
import { type ManifestValidationError } from "./public.js";
/**
 * Environment allowlist for `drift verify --run`. Repository-provided
 * verification commands are UNTRUSTED code: by default the child process gets
 * only the non-secret variables needed for ordinary PATH-based tooling on
 * Linux/macOS/Windows (git, npm, node, shell). Secret-bearing variables
 * (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, NODE_AUTH_TOKEN, DRIFT_MASTER_KEY,
 * AWS_*, AZURE_*, GOOGLE_*, GCP_*, SSH_AUTH_SOCK, DATABASE_URL, anything
 * named *_TOKEN / *_SECRET / *PRIVATE_KEY*) are deliberately absent. Full
 * inheritance requires an explicit `--inherit-env` opt-in.
 */
export declare const VERIFY_ENV_ALLOWLIST: readonly ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS", "OS", "LANG", "LC_ALL", "LC_CTYPE", "CI", "GITHUB_ACTIONS", "SHELL", "TERM", "TERM_PROGRAM", "USER", "LOGNAME", "HOSTNAME", "PWD"];
/** Build the sanitized child environment from a parent env (default: process). */
export declare function sanitizedVerifyEnv(parent?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
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
    /**
     * Structured commit→intent association for the blamed commit:
     *   unique    — exactly one manifest candidate after file filtering.
     *   ambiguous — more than one candidate touches the blamed file (no
     *               arbitrary first intent is presented).
     *   missing   — no manifest candidate touches the blamed file (baseline /
     *               legacy local-only intent).
     */
    association?: {
        state: "unique" | "ambiguous" | "missing";
        commit?: string;
        candidates?: string[];
    };
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
export type SignerState = "ready" | "read-only" | "missing" | "mismatch" | "malformed";
/**
 * Cryptographic trust state of an intent's signature:
 *   valid        — verifies against the trusted repository public key.
 *   invalid      — a signature exists but does not verify against the key.
 *   unsigned     — no signature recorded.
 *   unverifiable — no verification material available (e.g. no committed key).
 *   untrusted-key— verifies only against a key that is NOT the trust root
 *                  (PR contexts: a replacement key from the same PR).
 *   malformed    — a public manifest exists but fails strict schema
 *                  validation (never reported as valid, never executed).
 */
export type SignatureState = "valid" | "invalid" | "unsigned" | "unverifiable" | "untrusted-key" | "malformed";
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
    /** Tracked manifests that fail strict schema validation (never rendered as valid). */
    malformedManifests?: {
        id: string;
        errors: ManifestValidationError[];
    }[];
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
    /**
     * Structured intent→commit association counts over every id referenced by a
     * Drift-Intent trailer, plus public manifests with no trailer (missing). A
     * non-zero ambiguous/replayed/duplicate count is a provenance red flag that
     * must be surfaced, never silently mapped to one commit. Counts cover
     * resolved associations only — trailer-only orphans are in
     * `associationDiagnostics.trailerWithoutManifest`, never in `unique`.
     */
    intentAssociations?: {
        unique: number;
        missing: number;
        ambiguous: number;
        replayed: number;
        duplicate: number;
    };
    /**
     * Per-id provenance anomalies, exposed SEPARATELY from valid intents so
     * diagnostics never inflate `publicIntents` / `intents`:
     *   trailerWithoutManifest — a Drift-Intent trailer with no manifest, no
     *                            local record and no malformed file on disk.
     *   orphanManifests         — a valid manifest that no trailer references
     *                            (V1 legacy manifests are the normal case).
     *   ambiguous               — id referenced by >1 reachable commits, no
     *                            manifest to establish the introduction.
     *   replayed                — id referenced by a later commit after its
     *                            original introduction.
     *   duplicateTrailers       — id repeated >1× within a single commit.
     *   malformedManifests      — tracked manifests failing strict validation.
     */
    associationDiagnostics?: {
        trailerWithoutManifest: string[];
        orphanManifests: string[];
        ambiguous: string[];
        replayed: string[];
        duplicateTrailers: string[];
        malformedManifests: {
            id: string;
            errors: ManifestValidationError[];
        }[];
    };
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
     * Stage ONLY approved public Drift paths for the realize commit. The
     * ADR-009 trust boundary is staged on genuine first introduction only:
     *
     *   - `.drift/.gitignore`        — staged when new or unchanged vs HEAD;
     *                                  a user's unexpected working-tree edit is
     *                                  left alone (never silently committed).
     *   - `.drift/public/key.pem`    — staged on first introduction; if the key
     *                                  is ALREADY tracked and its working-tree
     *                                  content differs from HEAD, signing is
     *                                  REFUSED instead of staging a trust-root
     *                                  replacement the user did not approve.
     *   - manifest                    — always staged (written by this operation).
     *   - `.drift/config.toml`       — staged ONLY when byte-identical to the
     *                                  safe public template (first
     *                                  introduction). Never staged merely
     *                                  because it is tracked: that could carry
     *                                  an unstaged user edit into the commit.
     *                                  A config the user already staged rides
     *                                  along in the whole-index commit.
     */
    private stagePublicFiles;
    /**
     * Bounded `log` (PRD §7): never walks or parses every manifest. Selects the
     * top-L candidates from the stat-validated index (or a bounded heap on a
     * fresh clone), re-reads only those manifest files, and resolves trailer
     * associations for the candidate set only — memory O(limit), not O(repo).
     */
    log(filters?: {
        author?: string;
        model?: string;
        file?: string;
        limit?: number;
    }): LogEntry[];
    /**
     * Tracked manifests that fail strict schema validation. Consumers render
     * only valid manifests; this surfaces the rest as an actionable diagnostic
     * (never a crash, never a silent "valid"). Fast path: the stat-validated
     * index knows which files are invalid, so only those files are re-read for
     * the diagnostics (bounded); falls back to a full walk when no index exists
     * (fresh clone) or the index is unavailable. Malformed manifests are always
     * re-verified from the FILE here — the index is never a trust source.
     */
    publicManifestDiagnostics(): {
        id: string;
        errors: ManifestValidationError[];
    }[]; /**
     * Canonical provenance is the committed public manifest (ADR-009) — that is
     * what survives a fresh clone and what the Action/App consume. The private
     * store only enriches those entries with the local prompt; store-only
     * (legacy pre-ADR-009) intents are kept so old repos keep working.
     */
    /**
     * Deterministic intent → commit associations, derived ONLY from
     * `Drift-Intent:` git trailers (never from an unverified manifest field or
     * a "first value wins" map). Scans ALL trailers in chronological order
     * (oldest first) so the introduction is always the oldest reference:
     *
     *   zero references      → missing
     *   one reference        → unique
     *   >1 distinct commits  → replayed when a committed public manifest
     *                          establishes the introduction (oldest reference
     *                          is the original), else ambiguous
     *   duplicate trailer lines inside ONE commit → duplicate metadata
     *
     * `byCommit` (commit → referenced ids, deduplicated) is still exposed for
     * consumers that map a commit to its intents (blame, context).
     *
     * When `onlyIds` is given, refs are collected for those ids only — bounded
     * memory for commands that need associations for a candidate set (log,
     * context). Absent ids are simply not in the returned map, matching the
     * full scan (callers treat absence as `missing`).
     */
    private intentCommitIndex;
    /**
     * Bounded-memory provenance merge shared by `log` and `context` (PRD §7).
     * Selects the top-L candidates from each source — the stat-validated index
     * (or a bounded heap when no private store exists) for public manifests,
     * SQL LIMIT for the private store — then merges exactly like the old full
     * scan (prompt enrichment by id, store-only legacy entries kept) and
     * resolves trailer associations for the candidate set only.
     *
     * Correctness: the union's top-L by timestamp is exactly the merge of each
     * source's top-L (any member of the union's top-L is within its own
     * source's top-L), so results are identical to a full scan while memory
     * stays O(L). Malformed manifests are never selected here (valid=1 / the
     * heap skips them); they are surfaced by status/doctor, which always
     * re-read and re-verify every file.
     */
    private mergeBounded;
    /**
     * Stat-validated refresh of the public-manifest index (PRD §7). Walks the
     * intents directory; files whose (mtime, size, ctime) match the cached row
     * are kept without re-parsing; only new/changed files are strictly
     * re-parsed. The index is selection metadata only — every trust decision
     * re-reads the actual manifest file, so a stale or poisoned index can never
     * alter trust states (status/doctor always re-verify the full tree).
     */
    private refreshPublicManifestIndex;
    /** Structured association for one intent id (unique/missing/duplicate-in-commit/ambiguous/replayed). */
    intentCommitAssociation(id: string): IntentCommitAssociation;
    /**
     * The full deterministic intent→commit association map (MCP / JSON
     * consumers). Keys: every id referenced by a `Drift-Intent:` trailer on a
     * commit reachable from HEAD. Never silently collapses ambiguous, replayed
     * or duplicate-in-commit ids to one commit.
     */
    intentAssociations(): Map<string, IntentCommitAssociation>;
    /** The single authoritative commit for an id when one exists (intro first). */
    private commitFor;
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
        /** Pass the full process environment to the (untrusted) command. */
        inheritEnv?: boolean;
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