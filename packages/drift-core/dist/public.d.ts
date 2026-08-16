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
 *
 * Manifest schemas:
 *   V1 (schemaVersion 1) — legacy. Contains an embedded `commit` SHA that was
 *     part of its signed payload. Read and verified as-is; the `commit` field
 *     is treated as untrusted legacy metadata by consumers.
 *   V2 (schemaVersion 2) — current. Deliberately does NOT embed the containing
 *     Git commit SHA (that would be a self-referential cycle: adding the SHA
 *     changes the tree, which changes the SHA). The intent → commit
 *     association is derived from `Drift-Intent:` git trailers. Adds
 *     `signingKeyId` (fingerprint of the signing public key).
 */
/** Maximum length of a public summary (explicit `--summary` or fallback). */
export declare const PUBLIC_SUMMARY_MAX = 200;
/** Maximum number of files recorded in a public manifest. */
export declare const PUBLIC_FILES_MAX = 50;
/** Max raw JSON size of one manifest (resource limit). */
export declare const MANIFEST_MAX_BYTES: number;
/** Max accepted `summary` length after sanitization. */
export declare const MANIFEST_SUMMARY_MAX = 2000;
/** Max accepted `files` entries (engine writes at most PUBLIC_FILES_MAX). */
export declare const MANIFEST_FILES_MAX = 50;
/** Max path length per file entry. */
export declare const MANIFEST_FILE_PATH_MAX = 1024;
/** Max per-file summary length. */
export declare const MANIFEST_FILE_SUMMARY_MAX = 500;
/** Max length of bounded metadata strings (agent identifier, model). */
export declare const MANIFEST_META_MAX = 200;
/** Max length of the recorded `verification` command string. */
export declare const MANIFEST_VERIFY_MAX = 1000;
/** Max length of a base64 signature. */
export declare const MANIFEST_SIGNATURE_MAX = 4096;
/** Max number of `symbols` entries when present. */
export declare const MANIFEST_SYMBOLS_MAX = 200;
/** Max length of one symbol string. */
export declare const MANIFEST_SYMBOL_MAX = 300;
/** Upper bound for `timestamp` (Date.MAX_VALUE) — rejects absurd values. */
export declare const MANIFEST_TIMESTAMP_MAX = 8640000000000000;
/** Max nesting depth walked by the validator (bounded recursion). */
export declare const MANIFEST_MAX_DEPTH = 24;
/** Drift intent id format (mirrors the git-trailer regex everywhere). */
export declare const INTENT_ID_RE: RegExp;
export interface ManifestValidationError {
    /** Dot-path of the offending field (e.g. `files[3].path`). */
    field: string;
    message: string;
}
export type ManifestParseResult = {
    ok: true;
    value: PublicIntentView;
} | {
    ok: false;
    errors: ManifestValidationError[];
};
/**
 * Strict, versioned public-manifest parser. Returns the validated manifest or
 * a bounded list of actionable validation errors. Never throws on hostile
 * input: the raw JSON byte size is capped, every field is type-checked with
 * resource limits, ids must match the filename/request, and V2 requires a
 * syntactically valid `signingKeyId`. Cryptographic checks (signature,
 * `signingKeyId` fingerprint match) are performed by the callers that know
 * the trust root.
 */
export declare function parsePublicIntentManifest(json: unknown, opts?: {
    expectedId?: string;
    sourceName?: string;
}): ManifestParseResult;
/** Read + strictly parse one manifest file; null on parse failure. */
export declare function readManifestFile(path: string): ManifestParseResult;
export declare function basename(p: string, suffix?: string): string;
export interface PublicIntentFile {
    path: string;
    mutationType: string;
    summary?: string;
}
export interface PublicAgent {
    type: "HUMAN" | "AGENT";
    identifier: string;
}
/** Fields common to every manifest schema version. */
export interface PublicIntentManifestBase {
    id: string;
    summary: string;
    model?: string;
    agent?: PublicAgent;
    verification?: string;
    files?: PublicIntentFile[];
    /** Epoch-ms creation time (kept across V1/V2 for consumers). */
    timestamp: number;
}
/**
 * Legacy manifest (ADR-009 initial release). The `commit` field is legacy
 * metadata: it was part of the signed payload of V1 manifests only. Consumers
 * prefer the Git-trailer-derived association over this field.
 */
export interface PublicIntentManifestV1 extends PublicIntentManifestBase {
    schemaVersion: 1;
    commit: string;
    signature: string;
}
/**
 * The canonical public record for one intent (current). Everything except
 * `signature` is covered by the Ed25519 signature, verifiable with
 * `.drift/public/key.pem`.
 *
 * Deliberately does NOT contain the SHA of the Git commit that contains it:
 * that would be a self-referential cycle (adding the SHA changes the tree,
 * which changes the SHA). The intent → commit association is derived from the
 * `Drift-Intent:` trailer in the commit message instead (engine
 * `intentCommitIndex`). `signingKeyId` is a fingerprint of the signing public
 * key so consumers can tell which trust root signed a manifest.
 */
export interface PublicIntentManifestV2 extends PublicIntentManifestBase {
    schemaVersion: 2;
    signingKeyId: string;
    signature: string;
}
export type PublicIntentView = PublicIntentManifestV1 | PublicIntentManifestV2;
/** A V2 view with `signature` stripped (the signed payload). */
export type UnsignedPublicIntentView = Omit<PublicIntentManifestV2, "signature">;
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
 * commit, clone, and render. Used when the user supplies no explicit summary
 * or when a public manifest is missing.
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
    /**
     * The committed Ed25519 public key, or null when absent. Line endings are
     * normalized to LF: on Windows `core.autocrlf` gives tracked PEM files CRLF
     * in the working tree, which would otherwise break string comparisons
     * between the derived public key and the committed trust root.
     */
    publicKey(): string | null;
    /** Write the public key file (idempotent). */
    writePublicKey(pem: string): void;
    /** Sign a public view with the repo key and persist it (V2 schema). */
    write(view: UnsignedPublicIntentView, privateKeyPem: string): PublicIntentView;
    getById(id: string): PublicIntentView | null;
    /**
     * Validation errors for `id`'s manifest, or null when the file is missing
     * or clean. Lets consumers distinguish "malformed" from "missing" (a
     * malformed manifest must never silently fall back to the private record
     * or be reported as valid).
     */
    getDiagnostics(id: string): ManifestValidationError[] | null;
    /** Parse one manifest strictly (id must match its filename). */
    private parseFor;
    /**
     * Every VALID manifest, newest first (timestamp desc). Malformed manifests
     * are excluded from rendering but surfaced through `listWithErrors` so
     * status/log/export can report them as an actionable diagnostic instead of
     * crashing or silently treating them as valid.
     */
    list(): PublicIntentView[];
    /**
     * All manifests with per-file validation errors, newest first. Never
     * throws on hostile files; oversized/unparseable files are reported as
     * diagnostics rather than loaded.
     */
    listWithErrors(): {
        views: PublicIntentView[];
        errors: {
            id: string;
            errors: ManifestValidationError[];
        }[];
    };
    /**
     * Legacy V1-only association: find a V1 manifest whose embedded `commit`
     * field matches. V2 manifests never embed a commit SHA — their association
     * is resolved from `Drift-Intent:` git trailers (engine `intentCommitIndex`),
     * never from this field, so an attacker cannot fabricate an association by
     * editing a manifest.
     */
    findByCommit(commitSha: string): PublicIntentView | null;
    /** Verify the manifest signature against the committed public key. */
    verifySignature(view: PublicIntentView): boolean;
}
/**
 * Canonical short fingerprint of an Ed25519 public key (first 16 hex chars
 * of the SHA-256 of its SPKI DER subject-public-key bytes). Hashing the DER
 * bytes — NOT the textual PEM — means LF/CRLF line endings and harmless
 * surrounding whitespace can never produce a different key identity, and two
 * PEM encodings of the same key always agree. Used as `signingKeyId` in V2
 * manifests and by `drift status` / key-state output — never the private key
 * material. A malformed PEM falls back to a stable hash of the text so the
 * identifier is still deterministic (consumers treat such a key as
 * unverifiable, never trusted).
 */
export declare function signingKeyIdFor(publicKeyPem: string): string;
//# sourceMappingURL=public.d.ts.map