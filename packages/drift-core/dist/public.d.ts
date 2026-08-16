/**
 * Public provenance (ADR-009, docs/adrs/009-public-private-provenance.md).
 *
 * `.drift/public/` is the ONLY trackable part of a Drift repository:
 *
 *   .drift/public/key.pem              Ed25519 public key (written by init)
 *   .drift/public/intents/<id>.json    signed PublicIntentView per intent
 *
 * Raw prompts, the SQLite database, the content-addressed objects and the
 * signing key live in private (gitignored) locations. This module never sees
 * them: everything here is safe to commit and safe to render publicly.
 */
/** Maximum length of a public summary (explicit `--summary` or fallback). */
export declare const PUBLIC_SUMMARY_MAX = 200;
/** Maximum number of files recorded in a public manifest. */
export declare const PUBLIC_FILES_MAX = 50;
export interface PublicIntentFile {
    path: string;
    mutationType: string;
    summary?: string;
}
export interface PublicAgent {
    type: "HUMAN" | "AGENT";
    identifier: string;
}
/**
 * The canonical public record for one intent. Everything except `signature`
 * is covered by the Ed25519 signature, verifiable with `.drift/public/key.pem`.
 */
export interface PublicIntentView {
    schemaVersion: 1;
    id: string;
    summary: string;
    model?: string;
    agent?: PublicAgent;
    verification?: string;
    files?: PublicIntentFile[];
    commit: string;
    timestamp: number;
    signature: string;
}
/** A PublicIntentView with `signature` stripped (the signed payload). */
export type UnsignedPublicIntentView = Omit<PublicIntentView, "signature">;
/**
 * Strip content that must never reach a public surface (PR comments, step
 * summaries, committed manifests, default JSON): control characters, ANSI
 * escape sequences, HTML-comment delimiters and mention-spam tokens.
 */
export declare function sanitizePublicText(text: string): string;
/**
 * Sanitize + length-limit a USER-SUPPLIED public summary (ADR-009). The caller
 * redacts secrets first; this never touches the raw prompt. A one-line prompt
 * is deliberately NOT used as a summary: the full first line of a one-line
 * prompt would otherwise be copied verbatim into git history.
 */
export declare function buildPublicSummary(text: string): string;
/**
 * Generic fallback summary derived ONLY from non-prompt metadata (intent id,
 * affected file count) — never from prompt text, so it is always safe to
 * commit, clone, and render. Used when the user supplies no explicit summary.
 */
export declare function genericPublicSummary(id: string, opts?: {
    fileCount?: number;
}): string;
export declare const PUBLIC_KEY_PATH: string;
export declare const PUBLIC_INTENTS_DIR: string;
/**
 * Read/write access to `.drift/public/`. Reading never requires the private
 * database, so a fresh clone can still list intents, blame lines and verify
 * signatures (ADR-009 "Fresh-clone behavior").
 */
export declare class PublicStore {
    private readonly driftDir;
    constructor(driftDir: string);
    /** Absolute path of a manifest for `id`. */
    manifestPath(id: string): string;
    /** Absolute path of the committed public key. */
    get keyPath(): string;
    /** Whether the public provenance tree exists (key or any manifest). */
    exists(): boolean;
    /** The committed Ed25519 public key, or null when absent. */
    publicKey(): string | null;
    /** Write the public key file (idempotent). */
    writePublicKey(pem: string): void;
    /** Sign a public view with the repo key and persist it. */
    write(view: UnsignedPublicIntentView, privateKeyPem: string): PublicIntentView;
    getById(id: string): PublicIntentView | null;
    /** Every manifest, newest first (commit timestamp desc). */
    list(): PublicIntentView[];
    findByCommit(commitSha: string): PublicIntentView | null;
    /** Verify the manifest signature against the committed public key. */
    verifySignature(view: PublicIntentView): boolean;
}
//# sourceMappingURL=public.d.ts.map