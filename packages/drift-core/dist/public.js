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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalJson, signPayload, verifyPayload } from "./crypto.js";
/** Maximum length of a public summary (explicit `--summary` or fallback). */
export const PUBLIC_SUMMARY_MAX = 200;
/** Maximum number of files recorded in a public manifest. */
export const PUBLIC_FILES_MAX = 50;
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
 * commit, clone, and render. Used when the user supplies no explicit summary.
 */
export function genericPublicSummary(id, opts = {}) {
    const base = `Drift intent ${id}`;
    const n = opts.fileCount ?? 0;
    return n > 0 ? `${base} (${n} file${n === 1 ? "" : "s"})` : base;
}
export const PUBLIC_KEY_PATH = join("public", "key.pem");
export const PUBLIC_INTENTS_DIR = join("public", "intents");
function isPublicIntentView(value) {
    if (typeof value !== "object" || value === null)
        return false;
    const v = value;
    return (v.schemaVersion === 1 &&
        typeof v.id === "string" &&
        typeof v.summary === "string" &&
        typeof v.commit === "string" &&
        typeof v.signature === "string");
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
    /** The committed Ed25519 public key, or null when absent. */
    publicKey() {
        if (!existsSync(this.keyPath))
            return null;
        try {
            const pem = readFileSync(this.keyPath, "utf8").trim();
            return pem || null;
        }
        catch {
            return null;
        }
    }
    /** Write the public key file (idempotent). */
    writePublicKey(pem) {
        mkdirSync(dirname(this.keyPath), { recursive: true });
        writeFileSync(this.keyPath, `${pem.trim()}\n`, { mode: 0o644 });
    }
    /** Sign a public view with the repo key and persist it. */
    write(view, privateKeyPem) {
        const signature = signPayload(canonicalJson(view), privateKeyPem);
        const signed = { ...view, signature };
        mkdirSync(dirname(this.manifestPath(view.id)), { recursive: true });
        writeFileSync(this.manifestPath(view.id), `${JSON.stringify(signed, null, 2)}\n`);
        return signed;
    }
    getById(id) {
        const path = this.manifestPath(id);
        if (!existsSync(path))
            return null;
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            return isPublicIntentView(parsed) ? parsed : null;
        }
        catch {
            return null;
        }
    }
    /** Every manifest, newest first (commit timestamp desc). */
    list() {
        const dir = join(this.driftDir, PUBLIC_INTENTS_DIR);
        if (!existsSync(dir))
            return [];
        const views = [];
        for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json"))
                continue;
            const view = this.getById(name.slice(0, -".json".length));
            if (view)
                views.push(view);
        }
        return views.sort((a, b) => b.timestamp - a.timestamp);
    }
    findByCommit(commitSha) {
        if (!/^[0-9a-f]{40}$/.test(commitSha))
            return null;
        return this.list().find((v) => v.commit === commitSha) ?? null;
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
//# sourceMappingURL=public.js.map