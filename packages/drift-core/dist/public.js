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
import { createHash, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, signPayload, verifyPayload } from "./crypto.js";
/** Maximum length of a public summary (explicit `--summary` or fallback). */
export const PUBLIC_SUMMARY_MAX = 200;
/** Maximum number of files recorded in a public manifest. */
export const PUBLIC_FILES_MAX = 50;
// ---------------------------------------------------------------------------
// Strict manifest validation (trust-boundary parsing). A public manifest is
// attacker-controlled input the moment it is committed by anyone — consumers
// (log/status/export/verify/blame/Action/App/MCP) must never crash on it and
// must never render it as valid. `parsePublicIntentManifest` is the single
// strict parser; permissive type guards are not used for trusted rendering.
// ---------------------------------------------------------------------------
/** Max raw JSON size of one manifest (resource limit). */
export const MANIFEST_MAX_BYTES = 256 * 1024;
/** Max accepted `summary` length after sanitization. */
export const MANIFEST_SUMMARY_MAX = 2000;
/** Max accepted `files` entries (engine writes at most PUBLIC_FILES_MAX). */
export const MANIFEST_FILES_MAX = PUBLIC_FILES_MAX;
/** Max path length per file entry. */
export const MANIFEST_FILE_PATH_MAX = 1024;
/** Max per-file summary length. */
export const MANIFEST_FILE_SUMMARY_MAX = 500;
/** Max length of bounded metadata strings (agent identifier, model). */
export const MANIFEST_META_MAX = 200;
/** Max length of the recorded `verification` command string. */
export const MANIFEST_VERIFY_MAX = 1000;
/** Max length of a base64 signature. */
export const MANIFEST_SIGNATURE_MAX = 4096;
/** Upper bound for `timestamp` (Date.MAX_VALUE) — rejects absurd values. */
export const MANIFEST_TIMESTAMP_MAX = 8_640_000_000_000_000;
/** Max nesting depth walked by the validator (bounded recursion). */
export const MANIFEST_MAX_DEPTH = 24;
/** Drift intent id format (mirrors the git-trailer regex everywhere). */
export const INTENT_ID_RE = /^did_[0-9a-f]{32}$/;
function isRecord(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
const MUTATION_ENUM = new Set(["ADDED", "MODIFIED", "DELETED"]);
function hasControlChar(s) {
    return /[\x00-\x1f\x7f]/.test(s.replace(/\t/g, "").replace(/\n/g, "").replace(/\r/g, ""));
}
function push(errors, field, message) {
    if (errors.length < 50)
        errors.push({ field, message }); // bound diagnostics
}
function checkString(errors, value, field, opts = {}) {
    if (value === undefined || value === null) {
        if (opts.required)
            push(errors, field, "missing required string");
        return null;
    }
    if (typeof value !== "string") {
        push(errors, field, "expected a string");
        return null;
    }
    if (value.length > (opts.max ?? 1024)) {
        push(errors, field, `exceeds maximum length ${opts.max ?? 1024}`);
        return null;
    }
    if (value.includes("\0")) {
        push(errors, field, "contains NUL bytes");
        return null;
    }
    if (opts.noControl && hasControlChar(value)) {
        push(errors, field, "contains control characters");
        return null;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
        push(errors, field, opts.patternMsg ?? "does not match the required format");
        return null;
    }
    return value;
}
function checkNonNegInt(errors, value, field, opts = {}) {
    if (value === undefined || value === null) {
        if (opts.required)
            push(errors, field, "missing required integer");
        return null;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        push(errors, field, "expected a non-negative integer");
        return null;
    }
    if (opts.max !== undefined && value > opts.max) {
        push(errors, field, `exceeds maximum value ${opts.max}`);
        return null;
    }
    return value;
}
function validateFiles(errors, value, depth) {
    if (value === undefined)
        return true;
    if (!Array.isArray(value)) {
        push(errors, "files", "expected an array");
        return false;
    }
    if (value.length > MANIFEST_FILES_MAX) {
        push(errors, "files", `exceeds maximum ${MANIFEST_FILES_MAX} entries`);
        return false;
    }
    if (depth > MANIFEST_MAX_DEPTH) {
        push(errors, "files", "nesting too deep");
        return false;
    }
    let ok = true;
    value.forEach((f, i) => {
        if (!isRecord(f)) {
            push(errors, `files[${i}]`, "expected an object");
            ok = false;
            return;
        }
        for (const key of Object.keys(f)) {
            if (key !== "path" && key !== "mutationType" && key !== "summary") {
                push(errors, `files[${i}].${key}`, "unknown field");
                ok = false;
            }
        }
        const path = checkString(errors, f.path, `files[${i}].path`, {
            required: true,
            max: MANIFEST_FILE_PATH_MAX,
            noControl: true,
        });
        if (path !== null && path.length === 0) {
            push(errors, `files[${i}].path`, "must not be empty");
            ok = false;
        }
        const mutation = checkString(errors, f.mutationType, `files[${i}].mutationType`, {
            required: true,
            max: 16,
        });
        if (mutation !== null && !MUTATION_ENUM.has(mutation)) {
            push(errors, `files[${i}].mutationType`, `unsupported mutation type "${mutation}"`);
            ok = false;
        }
        const summary = checkString(errors, f.summary, `files[${i}].summary`, {
            max: MANIFEST_FILE_SUMMARY_MAX,
            noControl: true,
        });
        void summary;
    });
    return ok;
}
/**
 * Strict, versioned public-manifest parser. Returns the validated manifest or
 * a bounded list of actionable validation errors. Never throws on hostile
 * input: the raw JSON byte size is capped, every field is type-checked with
 * resource limits, ids must match the filename/request, and V2 requires a
 * syntactically valid `signingKeyId`. Cryptographic checks (signature,
 * `signingKeyId` fingerprint match) are performed by the callers that know
 * the trust root.
 */
export function parsePublicIntentManifest(json, opts = {}) {
    const errors = [];
    const fail = () => ({
        ok: false,
        errors: errors.length > 0 ? errors : [{ field: "$schema", message: "not an object" }],
    });
    if (!isRecord(json))
        return fail();
    const schemaVersion = checkNonNegInt(errors, json.schemaVersion, "schemaVersion", { required: true });
    if (schemaVersion !== 1 && schemaVersion !== 2) {
        push(errors, "schemaVersion", `unsupported schema version ${String(json.schemaVersion)}`);
        return fail();
    }
    // Strict unknown-field policy (ADR-009): every semantically accepted field
    // of a supported schema is enumerated here. Unknown fields are REJECTED
    // outright — they cannot silently join the signed payload via canonical
    // JSON, and a post-signing insertion would break the signature anyway. If a
    // future version needs extension points it must define an explicit,
    // versioned `extensions` object whose contents participate in the signed
    // payload.
    const V1_FIELDS = new Set([
        "schemaVersion",
        "id",
        "summary",
        "timestamp",
        "signature",
        "agent",
        "model",
        "verification",
        "files",
        "commit",
    ]);
    const V2_FIELDS = new Set([
        "schemaVersion",
        "id",
        "summary",
        "timestamp",
        "signature",
        "agent",
        "model",
        "verification",
        "files",
        "signingKeyId",
    ]);
    const allowed = schemaVersion === 2 ? V2_FIELDS : V1_FIELDS;
    for (const key of Object.keys(json)) {
        if (!allowed.has(key))
            push(errors, key, `unknown field (schema v${schemaVersion})`);
    }
    const id = checkString(errors, json.id, "id", {
        required: true,
        max: 64,
        pattern: INTENT_ID_RE,
        patternMsg: "invalid Drift intent id (expected did_<32 hex chars>)",
    });
    if (id !== null && opts.expectedId !== undefined && id !== opts.expectedId) {
        push(errors, "id", `does not match ${opts.sourceName ?? "the requested intent"} (expected ${opts.expectedId})`);
        return fail();
    }
    // A public manifest must carry a NON-EMPTY summary: an empty string is
    // ambiguous (it blurs "missing" and "intentional") and would render as a
    // blank PR comment / check-run line. `none` prompt mode still writes the
    // generic non-prompt fallback (engine `genericPublicSummary`), so a real
    // manifest is never empty here.
    const summary = checkString(errors, json.summary, "summary", {
        required: true,
        max: MANIFEST_SUMMARY_MAX,
        noControl: true,
    });
    if (summary !== null && summary.trim().length === 0) {
        push(errors, "summary", "must not be empty or whitespace-only");
    }
    const timestamp = checkNonNegInt(errors, json.timestamp, "timestamp", {
        required: true,
        max: MANIFEST_TIMESTAMP_MAX,
    });
    const signature = checkString(errors, json.signature, "signature", {
        max: MANIFEST_SIGNATURE_MAX,
    });
    if (signature !== null && signature.length > 0) {
        // Bounded base64 encoding check — a non-base64 signature can never be
        // cryptographically valid and should be reported as malformed, not
        // silently verified against garbage.
        try {
            const decoded = Buffer.from(signature, "base64").toString("base64").replace(/=+$/, "");
            const normalized = signature.replace(/=+$/, "");
            if (decoded !== normalized)
                push(errors, "signature", "not valid base64");
        }
        catch {
            push(errors, "signature", "not valid base64");
        }
    }
    if (json.agent !== undefined) {
        if (!isRecord(json.agent)) {
            push(errors, "agent", "expected an object");
        }
        else {
            for (const key of Object.keys(json.agent)) {
                if (key !== "type" && key !== "identifier") {
                    push(errors, `agent.${key}`, "unknown field");
                }
            }
            const type = checkString(errors, json.agent.type, "agent.type", { required: true, max: 20 });
            if (type !== null && schemaVersion === 2 && type !== "HUMAN" && type !== "AGENT") {
                push(errors, "agent.type", `unsupported agent type "${type}"`);
            }
            checkString(errors, json.agent.identifier, "agent.identifier", {
                required: true,
                max: MANIFEST_META_MAX,
                noControl: true,
            });
        }
    }
    if (json.model !== undefined) {
        checkString(errors, json.model, "model", { max: MANIFEST_META_MAX, noControl: true });
    }
    if (json.verification !== undefined) {
        checkString(errors, json.verification, "verification", {
            max: MANIFEST_VERIFY_MAX,
            noControl: true,
        });
    }
    validateFiles(errors, json.files, 0);
    if (schemaVersion === 1) {
        checkString(errors, json.commit, "commit", { max: 64 });
    }
    if (schemaVersion === 2) {
        checkString(errors, json.signingKeyId, "signingKeyId", {
            required: true,
            max: 32,
            pattern: /^[0-9a-f]{16}$/,
            patternMsg: "must be a 16-hex-char key fingerprint",
        });
    }
    if (errors.length > 0)
        return fail();
    const base = {
        id: id,
        summary: summary,
        timestamp: timestamp,
    };
    if (json.model !== undefined)
        base.model = json.model;
    if (isRecord(json.agent)) {
        base.agent = {
            type: json.agent.type,
            identifier: json.agent.identifier,
        };
    }
    if (json.verification !== undefined)
        base.verification = json.verification;
    if (Array.isArray(json.files)) {
        base.files = json.files.map((f) => ({
            path: f.path,
            mutationType: f.mutationType,
            ...(typeof f.summary === "string" ? { summary: f.summary } : {}),
        }));
    }
    if (schemaVersion === 1) {
        return { ok: true, value: { ...base, schemaVersion: 1, commit: json.commit, signature: signature ?? "" } };
    }
    return { ok: true, value: { ...base, schemaVersion: 2, signingKeyId: json.signingKeyId, signature: signature ?? "" } };
}
/** Read + strictly parse one manifest file; null on parse failure. */
export function readManifestFile(path) {
    if (!existsSync(path))
        return { ok: false, errors: [{ field: "$file", message: "manifest file not found" }] };
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return { ok: false, errors: [{ field: "$file", message: "manifest file unreadable" }] };
    }
    if (Buffer.byteLength(raw, "utf8") > MANIFEST_MAX_BYTES) {
        return { ok: false, errors: [{ field: "$file", message: `manifest exceeds maximum size ${MANIFEST_MAX_BYTES} bytes` }] };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, errors: [{ field: "$file", message: "manifest is not valid JSON" }] };
    }
    return parsePublicIntentManifest(parsed, {
        expectedId: path.endsWith(".json") ? basename(path, ".json") : undefined,
        sourceName: "the manifest filename",
    });
}
export function basename(p, suffix = "") {
    const parts = p.split(/[\\/]/);
    const last = parts[parts.length - 1] ?? "";
    return suffix ? last.slice(0, last.length - suffix.length) : last;
}
/**
 * Strip content that must never reach a public surface (PR comments, step
 * summaries, committed manifests, default JSON): control characters, ANSI
 * escape sequences, HTML-comment delimiters and mention-spam tokens.
 */
export function sanitizePublicText(text) {
    let out = String(text ?? "");
    // ANSI escape sequences (colors/cursor control): ESC [ params m / ESC ] ... BEL
    out = out.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
    // Control characters (including C0) and DEL — keep \n and \t for layout.
    out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    // Neutralize HTML comments so intent metadata cannot inject markers or
    // hide the rest of a rendered comment (GFM supports HTML comments).
    out = out.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--/g, "").replace(/-->/g, "");
    // Neutralize mention/notification spam (@everyone / @here / @all).
    out = out.replace(/@(everyone|here|all)\b/gi, "@\u200b$1");
    return out;
}
/**
 * Sanitize + length-limit a USER-SUPPLIED public summary (ADR-009). The caller
 * redacts secrets first; this never touches the raw prompt. A one-line prompt
 * is deliberately NOT used as a summary: the full first line of a one-line
 * prompt would otherwise be copied verbatim into git history.
 */
export function buildPublicSummary(text) {
    const cleaned = sanitizePublicText(text).trim();
    return cleaned.length <= PUBLIC_SUMMARY_MAX
        ? cleaned
        : `${cleaned.slice(0, PUBLIC_SUMMARY_MAX - 1)}…`;
}
/**
 * Generic fallback summary derived ONLY from non-prompt metadata (intent id,
 * affected file count) — never from prompt text, so it is always safe to
 * commit, clone, and render. Used when the user supplies no explicit summary
 * or when a public manifest is missing.
 */
export function genericPublicSummary(id, opts = {}) {
    const base = `Drift intent ${id}`;
    const n = opts.fileCount ?? 0;
    return n > 0 ? `${base} (${n} file${n === 1 ? "" : "s"})` : base;
}
export const PUBLIC_KEY_PATH = join("public", "key.pem");
export const PUBLIC_INTENTS_DIR = join("public", "intents");
/**
 * Strictly parse one manifest file for `id`. Returns the validated manifest
 * or null. Malformed manifests are NOT silently dropped: callers can ask for
 * the diagnostic with `getDiagnostics` so a malformed file is reported (e.g.
 * `drift verify` / `drift status`) instead of being confused with "missing".
 */
function parseManifestFileFor(id, path) {
    const result = readManifestFile(path);
    if (!result.ok)
        return result;
    if (result.value.id !== id) {
        return {
            ok: false,
            errors: [{ field: "id", message: `manifest id does not match its filename (expected ${id})` }],
        };
    }
    return result;
}
/**
 * Read/write access to `.drift/public/`. Reading never requires the private
 * database, so a fresh clone can still list intents, blame lines and verify
 * signatures (ADR-009 "Fresh-clone behavior").
 */
export class PublicStore {
    driftDir;
    constructor(driftDir) {
        this.driftDir = driftDir;
    }
    /** Absolute path of a manifest for `id`. */
    manifestPath(id) {
        return join(this.driftDir, PUBLIC_INTENTS_DIR, `${id}.json`);
    }
    /** Absolute path of the committed public key. */
    get keyPath() {
        return join(this.driftDir, PUBLIC_KEY_PATH);
    }
    /** Whether the public provenance tree exists (key or any manifest). */
    exists() {
        return existsSync(this.keyPath) || this.list().length > 0;
    }
    /**
     * The committed Ed25519 public key, or null when absent. Line endings are
     * normalized to LF: on Windows `core.autocrlf` gives tracked PEM files CRLF
     * in the working tree, which would otherwise break string comparisons
     * between the derived public key and the committed trust root.
     */
    publicKey() {
        if (!existsSync(this.keyPath))
            return null;
        try {
            const pem = readFileSync(this.keyPath, "utf8").replace(/\r\n/g, "\n").trim();
            return pem || null;
        }
        catch {
            return null;
        }
    }
    /** Write the public key file (idempotent). */
    writePublicKey(pem) {
        mkdirSync(dirname(this.keyPath), { recursive: true });
        writeFileSync(this.keyPath, `${pem.replace(/\r\n/g, "\n").trim()}\n`, { mode: 0o644 });
    }
    /** Sign a public view with the repo key and persist it (V2 schema). */
    write(view, privateKeyPem) {
        const signature = signPayload(canonicalJson(view), privateKeyPem);
        const signed = { ...view, signature };
        mkdirSync(dirname(this.manifestPath(view.id)), { recursive: true });
        writeFileSync(this.manifestPath(view.id), `${JSON.stringify(signed, null, 2)}\n`);
        return signed;
    }
    getById(id) {
        const result = this.parseFor(id);
        return result.ok ? result.value : null;
    }
    /**
     * Validation errors for `id`'s manifest, or null when the file is missing
     * or clean. Lets consumers distinguish "malformed" from "missing" (a
     * malformed manifest must never silently fall back to the private record
     * or be reported as valid).
     */
    getDiagnostics(id) {
        // A missing manifest is NOT "malformed" — callers must keep treating it
        // as absent (e.g. `drift verify` reports intent-not-found). Only an
        // existing-but-invalid file yields diagnostics.
        if (!existsSync(this.manifestPath(id)))
            return null;
        const result = this.parseFor(id);
        return result.ok ? null : result.errors;
    }
    /** Parse one manifest strictly (id must match its filename). */
    parseFor(id) {
        const path = this.manifestPath(id);
        if (!existsSync(path))
            return { ok: false, errors: [{ field: "$file", message: "manifest file not found" }] };
        return parseManifestFileFor(id, path);
    }
    /**
     * Every VALID manifest, newest first (timestamp desc). Malformed manifests
     * are excluded from rendering but surfaced through `listWithErrors` so
     * status/log/export can report them as an actionable diagnostic instead of
     * crashing or silently treating them as valid.
     */
    list() {
        return this.listWithErrors().views;
    }
    /**
     * All manifests with per-file validation errors, newest first. Never
     * throws on hostile files; oversized/unparseable files are reported as
     * diagnostics rather than loaded.
     */
    listWithErrors() {
        const dir = join(this.driftDir, PUBLIC_INTENTS_DIR);
        const views = [];
        const errors = [];
        if (!existsSync(dir))
            return { views, errors };
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json"))
                continue;
            const id = name.slice(0, -".json".length);
            if (!INTENT_ID_RE.test(id)) {
                errors.push({ id, errors: [{ field: "id", message: "filename is not a valid Drift intent id" }] });
                continue;
            }
            const result = this.parseFor(id);
            if (result.ok)
                views.push(result.value);
            else
                errors.push({ id, errors: result.errors });
        }
        views.sort((a, b) => b.timestamp - a.timestamp);
        errors.sort((a, b) => a.id.localeCompare(b.id));
        return { views, errors };
    }
    /**
     * Legacy V1-only association: find a V1 manifest whose embedded `commit`
     * field matches. V2 manifests never embed a commit SHA — their association
     * is resolved from `Drift-Intent:` git trailers (engine `intentCommitIndex`),
     * never from this field, so an attacker cannot fabricate an association by
     * editing a manifest.
     */
    findByCommit(commitSha) {
        if (!/^[0-9a-f]{40}$/.test(commitSha))
            return null;
        return this.list().find((v) => v.schemaVersion === 1 && v.commit === commitSha) ?? null;
    }
    /** Verify the manifest signature against the committed public key. */
    verifySignature(view) {
        const pub = this.publicKey();
        if (!pub)
            return false;
        const { signature, ...unsigned } = view;
        return verifyPayload(canonicalJson(unsigned), pub, signature);
    }
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
export function signingKeyIdFor(publicKeyPem) {
    try {
        const key = createPublicKey(String(publicKeyPem ?? "").trim());
        const der = key.export({ type: "spki", format: "der" });
        return createHash("sha256").update(der).digest("hex").slice(0, 16);
    }
    catch {
        return createHash("sha256")
            .update(String(publicKeyPem ?? "").trim(), "utf8")
            .digest("hex")
            .slice(0, 16);
    }
}
//# sourceMappingURL=public.js.map