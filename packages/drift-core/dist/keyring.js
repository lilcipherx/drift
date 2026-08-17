/**
 * Multi-signer keyring (production trust model, ADR-009 extension).
 *
 * A single committed public key (`.drift/public/key.pem`) is the ANCHOR and
 * the bootstrap of trust. Repositories that need more than one maintainer to
 * sign intents additionally commit `.drift/public/keyring.json`, an
 * append-only, signed record of every trusted key and every change to the
 * trust set:
 *
 *   - bootstrap — the anchor key (must byte-match `.drift/public/key.pem`),
 *     self-signed by that same key. This is the ONLY way a keyring can begin.
 *   - add       — a NEW Ed25519 public key becomes trusted. Must be signed by
 *     a key that is ACTIVE at the time of the change. The added key can never
 *     sign its own addition (no self-escrow).
 *   - revoke    — an active key stops being trusted immediately (compromise /
 *     lost key). Signed by any active key, including the key being revoked
 *     (a maintainer may revoke their own lost key). The entry stays in the
 *     file so history can be reconstructed.
 *   - remove    — rotation cleanup: an active key is marked `removed` (out
 *     of the trust set) after a grace period. Signed by any OTHER active key
 *     (a key cannot remove itself — use `revoke` for self-removal). The entry
 *     stays in the file so history can be reconstructed.
 *
 * Trust invariants (a keyring is trusted ONLY when ALL hold):
 *   1. Every key entry is a valid Ed25519 PUBLIC key whose fingerprint is the
 *      canonical SPKI-DER SHA-256 (never a textual hash).
 *   2. The first audit entry is `bootstrap` for the anchor key and its
 *      signature verifies against `.drift/public/key.pem` — the anchor comes
 *      from the PEM file, NEVER from the keyring file itself.
 *   3. Audit entries are contiguous (seq 1..N) and each verifies against a
 *      key that was ACTIVE immediately before that entry.
 *   4. Replaying the audit log against an empty state reproduces exactly the
 *      `keys` array (fingerprints, statuses, ordering).
 *
 * Failure mode: a keyring that fails ANY invariant is malformed — the whole
 * trust set is treated as unusable (fail closed), exactly like a malformed
 * `key.pem`. A malformed keyring is a security state, never a cosmetic one.
 *
 * Backward compatibility: when `keyring.json` is absent, the trust set is
 * exactly the anchor key (the pre-keyring single-signer model). Nothing about
 * existing repositories or existing manifests changes.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicKey } from "node:crypto";
import { signPayload, verifyPayload } from "./crypto.js";
/** Derive the SPKI PEM of the public key from a private-key PEM. */
function publicKeyFromPrivate(privateKeyPem) {
    return createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();
}
import { signingKeyIdFor, signingKeyIdForValidKey } from "./public.js";
import { tryParseTrustRoot, TRUST_ROOT_MAX_BYTES } from "./trust-root.js";
/** Committed keyring file name (relative to `.drift/public/`). */
export const KEYRING_PATH = "keyring.json";
/** Strict max size of the committed keyring file. */
export const KEYRING_MAX_BYTES = 256 * 1024;
/** Canonical payload a change signs (deterministic, versioned). */
export function keyringPayload(seq, action, fingerprint, by, at, reason) {
    return `drift-keyring:v1:${seq}:${action}:${fingerprint}:${by}:${at}:${reason ?? ""}`;
}
/** Strictly parse one public-key PEM into a validated fingerprint + PEM. */
export function parseKeyringKey(pem) {
    if (!pem || pem.trim().length === 0)
        return { ok: false, error: "empty key PEM" };
    if (Buffer.byteLength(pem, "utf8") > TRUST_ROOT_MAX_BYTES) {
        return { ok: false, error: "key PEM exceeds the size bound" };
    }
    const parsed = tryParseTrustRoot(pem);
    if (parsed.state !== "valid") {
        return { ok: false, error: `key PEM is not a valid Ed25519 public key (${parsed.state})` };
    }
    const fingerprint = signingKeyIdForValidKey(parsed.publicKey);
    return { ok: true, fingerprint, pem: pem.trim() };
}
/** Fingerprint of a PEM that is guaranteed valid (caller checked first). */
export function keyringFingerprint(pem) {
    return signingKeyIdFor(pem);
}
function isKeyringAction(v) {
    return v === "bootstrap" || v === "add" || v === "revoke" || v === "remove";
}
/**
 * Validate a keyring file against the anchor PEM. Returns the parsed file on
 * success or a fail-closed error message.
 */
export function validateKeyring(raw, anchorPem) {
    const text = String(raw ?? "");
    if (text.trim().length === 0) {
        // An empty keyring file is a malformed security state — never silently
        // fall back to the single-key model.
        return { ok: false, error: "keyring.json exists but is empty" };
    }
    if (Buffer.byteLength(text, "utf8") > KEYRING_MAX_BYTES) {
        return { ok: false, error: `keyring.json exceeds ${KEYRING_MAX_BYTES} bytes` };
    }
    let json;
    try {
        json = JSON.parse(text);
    }
    catch {
        return { ok: false, error: "keyring.json is not valid JSON" };
    }
    if (typeof json !== "object" || json === null)
        return { ok: false, error: "keyring.json is not an object" };
    const file = json;
    if (file.schemaVersion !== 1) {
        return { ok: false, error: `unsupported keyring schemaVersion ${String(file.schemaVersion)}` };
    }
    if (!Array.isArray(file.keys) || !Array.isArray(file.audit)) {
        return { ok: false, error: "keyring.json is missing keys[] or audit[]" };
    }
    // --- keys ---------------------------------------------------------------
    const entries = [];
    const seen = new Set();
    for (const k of file.keys) {
        if (typeof k !== "object" || k === null)
            return { ok: false, error: "keyring.json contains a non-object key entry" };
        const e = k;
        if (typeof e.fingerprint !== "string" || typeof e.pem !== "string") {
            return { ok: false, error: "key entry is missing fingerprint or pem" };
        }
        const parsed = parseKeyringKey(e.pem);
        if (!parsed.ok)
            return { ok: false, error: `key entry ${e.fingerprint}: ${parsed.error}` };
        if (parsed.fingerprint !== e.fingerprint) {
            return { ok: false, error: `key entry fingerprint mismatch: declared ${e.fingerprint}, computed ${parsed.fingerprint}` };
        }
        if (seen.has(e.fingerprint))
            return { ok: false, error: `duplicate key fingerprint ${e.fingerprint}` };
        seen.add(e.fingerprint);
        const status = e.status;
        if (status !== "active" && status !== "revoked" && status !== "removed") {
            return { ok: false, error: `key ${e.fingerprint} has invalid status ${String(status)}` };
        }
        entries.push({
            fingerprint: e.fingerprint,
            pem: parsed.pem,
            status,
            addedBy: typeof e.addedBy === "string" ? e.addedBy : "",
            addedAt: typeof e.addedAt === "number" ? e.addedAt : 0,
            transitionedBy: typeof e.transitionedBy === "string" ? e.transitionedBy : null,
            transitionedAt: typeof e.transitionedAt === "number" ? e.transitionedAt : null,
            reason: typeof e.reason === "string" ? e.reason : null,
        });
    }
    if (entries.length === 0)
        return { ok: false, error: "keyring.json has no keys" };
    // --- audit replay -------------------------------------------------------
    // Replay state: fingerprint → entry. bootstrap/add insert, revoke marks,
    // remove deletes. The final map must exactly match `entries`.
    const replay = new Map();
    let seq = 0;
    for (const a of file.audit) {
        if (typeof a !== "object" || a === null)
            return { ok: false, error: "audit contains a non-object entry" };
        const e = a;
        seq++;
        if (e.seq !== seq) {
            return { ok: false, error: `audit seq out of order: expected ${seq}, got ${String(e.seq)}` };
        }
        if (typeof e.action !== "string" || !isKeyringAction(e.action)) {
            return { ok: false, error: `audit entry ${seq} has invalid action ${String(e.action)}` };
        }
        if (typeof e.fingerprint !== "string" ||
            typeof e.by !== "string" ||
            typeof e.payload !== "string" ||
            typeof e.signature !== "string") {
            return { ok: false, error: `audit entry ${seq} is missing fingerprint/by/payload/signature` };
        }
        const at = typeof e.at === "number" ? e.at : 0;
        const reason = typeof e.reason === "string" ? e.reason : null;
        const canonical = keyringPayload(seq, e.action, e.fingerprint, e.by, at, reason);
        if (e.payload !== canonical) {
            return { ok: false, error: `audit entry ${seq} payload does not match the canonical payload` };
        }
        const action = e.action;
        if (action === "bootstrap") {
            if (seq !== 1)
                return { ok: false, error: "bootstrap entry must be seq 1" };
            if (!anchorPem)
                return { ok: false, error: "keyring exists but no anchor key (.drift/public/key.pem)" };
            const anchor = parseKeyringKey(anchorPem);
            if (!anchor.ok)
                return { ok: false, error: `anchor key invalid: ${anchor.error}` };
            if (e.fingerprint !== anchor.fingerprint || e.by !== anchor.fingerprint) {
                return { ok: false, error: "bootstrap entry does not match the committed anchor key" };
            }
            if (!verifyPayload(canonical, anchorPem, e.signature)) {
                return { ok: false, error: "bootstrap entry signature does not verify against the anchor key" };
            }
            if (replay.has(e.fingerprint))
                return { ok: false, error: `bootstrap adds an already-present key ${e.fingerprint}` };
            replay.set(e.fingerprint, {
                fingerprint: e.fingerprint,
                pem: anchor.pem,
                status: "active",
                addedBy: e.fingerprint,
                addedAt: at,
                transitionedBy: null,
                transitionedAt: null,
                reason: null,
            });
            continue;
        }
        // add / revoke / remove — authorizer must be active BEFORE this entry.
        const authorizer = replay.get(e.by);
        if (!authorizer || authorizer.status !== "active") {
            return { ok: false, error: `audit entry ${seq}: authorizer ${e.by} is not active at this point in the log` };
        }
        if (!verifyPayload(canonical, authorizer.pem, e.signature)) {
            return { ok: false, error: `audit entry ${seq} signature does not verify against ${e.by}` };
        }
        const target = replay.get(e.fingerprint);
        if (action === "add") {
            if (target)
                return { ok: false, error: `add for already-known fingerprint ${e.fingerprint}` };
            // The added key's PEM must come from the keyring's keys[] — the entry
            // itself must parse (checked above) and match the fingerprint.
            const entry = entries.find((x) => x.fingerprint === e.fingerprint);
            if (!entry)
                return { ok: false, error: `added fingerprint ${e.fingerprint} has no key entry` };
            if (entry.addedBy !== e.by) {
                return { ok: false, error: `added key ${e.fingerprint} addedBy does not match the audit authorizer` };
            }
            if (e.by === e.fingerprint)
                return { ok: false, error: "a key cannot add itself" };
            replay.set(e.fingerprint, { ...entry, status: "active", addedAt: at });
        }
        else if (action === "revoke" || action === "remove") {
            if (action === "revoke") {
                // A retired key discovered later to be compromised can be upgraded to
                // revoked; an already-revoked key cannot change again.
                if (!target || (target.status !== "active" && target.status !== "removed")) {
                    return { ok: false, error: `audit entry ${seq}: target ${e.fingerprint} cannot be revoked (status ${target?.status ?? "absent"})` };
                }
                replay.set(e.fingerprint, { ...target, status: "revoked", transitionedBy: e.by, transitionedAt: at, reason });
            }
            else {
                if (!target || target.status !== "active") {
                    return { ok: false, error: `audit entry ${seq}: target ${e.fingerprint} is not active and cannot be removed` };
                }
                replay.set(e.fingerprint, { ...target, status: "removed", transitionedBy: e.by, transitionedAt: at, reason });
            }
        }
    }
    if (seq === 0)
        return { ok: false, error: "keyring.json has an empty audit log" };
    // Final replay must match the keys[] array exactly (order + status).
    const finalEntries = [...replay.values()];
    if (finalEntries.length !== entries.length) {
        return { ok: false, error: "keyring.json keys[] does not match the audit log (length)" };
    }
    for (let i = 0; i < entries.length; i++) {
        const f = finalEntries[i];
        const e = entries[i];
        if (f.fingerprint !== e.fingerprint || f.status !== e.status) {
            return { ok: false, error: `keyring.json keys[] does not match the audit log at index ${i}` };
        }
    }
    return {
        ok: true,
        keyring: { schemaVersion: 1, keys: entries, audit: file.audit },
    };
}
/**
 * Create a brand-new keyring bootstrapped on the anchor key. The anchor must
 * be present and the caller must hold the anchor's private key (the bootstrap
 * entry is self-signed). Fails closed otherwise.
 */
export function createKeyring(anchorPem, privateKeyPem, at = Date.now()) {
    const anchor = parseKeyringKey(anchorPem);
    if (!anchor.ok)
        return { ok: false, error: `anchor key invalid: ${anchor.error}` };
    let derived;
    try {
        derived = publicKeyFromPrivate(privateKeyPem).trim();
    }
    catch {
        return { ok: false, error: "private key is not a readable Ed25519 key" };
    }
    const derivedParsed = parseKeyringKey(derived);
    if (!derivedParsed.ok || derivedParsed.fingerprint !== anchor.fingerprint) {
        return {
            ok: false,
            error: "the private key does not match the anchor key — only the anchor key holder can bootstrap the keyring",
        };
    }
    const seq = 1;
    const payload = keyringPayload(seq, "bootstrap", anchor.fingerprint, anchor.fingerprint, at, null);
    let signature;
    try {
        signature = signPayload(payload, privateKeyPem);
    }
    catch {
        return { ok: false, error: "failed to sign the bootstrap entry" };
    }
    return {
        ok: true,
        keyring: {
            schemaVersion: 1,
            keys: [
                {
                    fingerprint: anchor.fingerprint,
                    pem: anchor.pem,
                    status: "active",
                    addedBy: anchor.fingerprint,
                    addedAt: at,
                    transitionedBy: null,
                    transitionedAt: null,
                    reason: null,
                },
            ],
            audit: [
                {
                    seq,
                    action: "bootstrap",
                    fingerprint: anchor.fingerprint,
                    by: anchor.fingerprint,
                    at,
                    reason: null,
                    payload,
                    signature,
                },
            ],
        },
    };
}
/**
 * Apply a signed change to an existing keyring. The private key must belong
 * to an ACTIVE keyring key (the authorizer). `revoke` allows self-revocation
 * (lost key); `remove` requires a different authorizer (rotation cleanup).
 */
export function applyKeyringChange(keyring, privateKeyPem, action, target, reason, at = Date.now()) {
    // Authorizer fingerprint from the private key.
    let derived;
    try {
        derived = publicKeyFromPrivate(privateKeyPem).trim();
    }
    catch {
        return { ok: false, error: "the private key is not a readable Ed25519 key" };
    }
    const authorizer = parseKeyringKey(derived);
    if (!authorizer.ok)
        return { ok: false, error: "the private key does not derive a valid Ed25519 public key" };
    const by = authorizer.fingerprint;
    const active = keyring.keys.find((k) => k.fingerprint === by && k.status === "active");
    if (!active) {
        const known = keyring.keys.find((k) => k.fingerprint === by);
        if (known) {
            return { ok: false, error: `key ${by} is ${known.status} and cannot authorize keyring changes` };
        }
        return { ok: false, error: `key ${by} is not in the keyring and cannot authorize keyring changes` };
    }
    let fingerprint;
    if (action === "add") {
        if (!target.pem)
            return { ok: false, error: "add requires the new key PEM" };
        const parsed = parseKeyringKey(target.pem);
        if (!parsed.ok)
            return { ok: false, error: `new key invalid: ${parsed.error}` };
        fingerprint = parsed.fingerprint;
        if (keyring.keys.some((k) => k.fingerprint === fingerprint)) {
            return { ok: false, error: `fingerprint ${fingerprint} is already in the keyring` };
        }
        if (fingerprint === by)
            return { ok: false, error: "a key cannot add itself to the keyring" };
    }
    else {
        if (!target.fingerprint)
            return { ok: false, error: `${action} requires a fingerprint` };
        fingerprint = target.fingerprint;
        const known = keyring.keys.find((k) => k.fingerprint === fingerprint);
        if (!known)
            return { ok: false, error: `fingerprint ${fingerprint} is not in the keyring` };
        if (action === "revoke") {
            // A retired key later found compromised can be upgraded to revoked.
            if (known.status !== "active" && known.status !== "removed") {
                return { ok: false, error: `fingerprint ${fingerprint} is already ${known.status} and cannot be revoked again` };
            }
        }
        else {
            if (known.status !== "active") {
                return { ok: false, error: `fingerprint ${fingerprint} is already ${known.status} and cannot be removed` };
            }
            if (fingerprint === by) {
                return {
                    ok: false,
                    error: "a key cannot remove itself — use `revoke` for a lost key, or have another active key remove it",
                };
            }
        }
    }
    const seq = keyring.audit.length + 1;
    const payload = keyringPayload(seq, action, fingerprint, by, at, reason);
    let signature;
    try {
        signature = signPayload(payload, privateKeyPem);
    }
    catch {
        return { ok: false, error: "failed to sign the keyring change" };
    }
    const entry = {
        seq,
        action,
        fingerprint,
        by,
        at,
        reason,
        payload,
        signature,
    };
    const keys = keyring.keys.map((k) => ({ ...k }));
    if (action === "add") {
        keys.push({
            fingerprint,
            pem: target.pem.trim(),
            status: "active",
            addedBy: by,
            addedAt: at,
            transitionedBy: null,
            transitionedAt: null,
            reason: null,
        });
    }
    else if (action === "revoke") {
        const idx = keys.findIndex((k) => k.fingerprint === fingerprint);
        keys[idx] = { ...keys[idx], status: "revoked", transitionedBy: by, transitionedAt: at, reason };
    }
    else {
        const idx = keys.findIndex((k) => k.fingerprint === fingerprint);
        keys[idx] = { ...keys[idx], status: "removed", transitionedBy: by, transitionedAt: at, reason };
    }
    return { ok: true, keyring: { schemaVersion: 1, keys, audit: [...keyring.audit, entry] }, entry };
}
/** Absolute path of the keyring file for a drift dir. */
export function keyringPath(driftDir) {
    return join(driftDir, "public", KEYRING_PATH);
}
/**
 * Load and validate the full trust set for a repository. Never throws on a
 * hostile keyring — a malformed keyring yields `malformed` (fail closed).
 * Backward compatibility: no keyring file → trust set is exactly the anchor.
 */
export function loadTrustSet(driftDir) {
    const anchorPath = join(driftDir, "public", "key.pem");
    const krPath = keyringPath(driftDir);
    let anchorPem = null;
    if (existsSync(anchorPath)) {
        try {
            const raw = readFileSync(anchorPath, "utf8").replace(/\r\n/g, "\n").trim();
            anchorPem = raw || null;
        }
        catch {
            anchorPem = null;
        }
    }
    const keyringPresent = existsSync(krPath);
    if (!keyringPresent) {
        // Legacy single-signer model.
        if (!anchorPem)
            return { anchorPem: null, active: [], keyring: null, malformed: null, keyringPresent: false };
        const parsed = parseKeyringKey(anchorPem);
        if (!parsed.ok) {
            return { anchorPem, active: [], keyring: null, malformed: `anchor key invalid: ${parsed.error}`, keyringPresent: false };
        }
        return {
            anchorPem,
            active: [{ fingerprint: parsed.fingerprint, pem: parsed.pem }],
            keyring: null,
            malformed: null,
            keyringPresent: false,
        };
    }
    let raw;
    try {
        raw = readFileSync(krPath, "utf8");
    }
    catch {
        return { anchorPem, active: [], keyring: null, malformed: "keyring.json exists but is unreadable", keyringPresent: true };
    }
    const result = validateKeyring(raw, anchorPem);
    if (!result.ok) {
        return { anchorPem, active: [], keyring: null, malformed: result.error, keyringPresent: true };
    }
    return {
        anchorPem,
        active: result.keyring.keys
            .filter((k) => k.status === "active")
            .map((k) => ({ fingerprint: k.fingerprint, pem: k.pem })),
        keyring: result.keyring,
        malformed: null,
        keyringPresent: true,
    };
}
/** Write a keyring file atomically (temp + rename, 0644, committed file). */
export function writeKeyringFile(driftDir, keyring) {
    const target = keyringPath(driftDir);
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(keyring, null, 2)}\n`, { mode: 0o644 });
    renameSync(tmp, target);
}
/** Look up a key entry (active or revoked) by fingerprint. */
export function findKeyringEntry(keyring, fingerprint) {
    return keyring.keys.find((k) => k.fingerprint === fingerprint);
}
function auditEntriesEqual(a, b) {
    return (a.seq === b.seq &&
        a.action === b.action &&
        a.fingerprint === b.fingerprint &&
        a.by === b.by &&
        a.at === b.at &&
        a.reason === b.reason &&
        a.payload === b.payload &&
        a.signature === b.signature);
}
/** True when `base.audit` is a strict prefix of `head.audit` (base shorter). */
function isStrictPrefix(base, head) {
    if (base.audit.length >= head.audit.length)
        return false;
    for (let i = 0; i < base.audit.length; i++) {
        if (!auditEntriesEqual(base.audit[i], head.audit[i]))
            return false;
    }
    return true;
}
/** True when two keyrings are byte-identical (after strict parse). */
function keyringsEqual(a, b) {
    if (a.audit.length !== b.audit.length)
        return false;
    for (let i = 0; i < a.audit.length; i++) {
        if (!auditEntriesEqual(a.audit[i], b.audit[i]))
            return false;
    }
    return true;
}
/**
 * Evaluate a base/head keyring change. `raw` values are the raw file contents
 * (or null); anchors are the corresponding `.drift/public/key.pem` contents.
 * Fails closed on malformed input exactly like the trust-root evaluator.
 */
export function evaluateKeyringChange(baseRaw, headRaw, baseAnchor, headAnchor) {
    const baseText = String(baseRaw ?? "");
    const headText = String(headRaw ?? "");
    const basePresent = baseText.trim().length > 0;
    const headPresent = headText.trim().length > 0;
    const baseAnchorText = String(baseAnchor ?? "");
    const headAnchorText = String(headAnchor ?? "");
    const baseAnchorPresent = baseAnchorText.trim().length > 0;
    const headAnchorPresent = headAnchorText.trim().length > 0;
    if (!basePresent && !headPresent)
        return "none";
    if (!basePresent && headPresent) {
        // A keyring cannot exist without an anchor; validate it for the verdict.
        const head = validateKeyring(headText, headAnchorPresent ? headAnchorText : null);
        if (!head.ok)
            return "malformed-bootstrap";
        return "bootstrap";
    }
    const base = validateKeyring(baseText, baseAnchorPresent ? baseAnchorText : null);
    if (!base.ok)
        return "base-malformed";
    if (!headPresent)
        return "removed";
    const head = validateKeyring(headText, headAnchorPresent ? headAnchorText : null);
    if (!head.ok)
        return "malformed-replacement";
    if (keyringsEqual(base.keyring, head.keyring))
        return "unchanged";
    // The only legitimate change is a strict append-only extension.
    if (isStrictPrefix(base.keyring, head.keyring))
        return "extended";
    return "replaced";
}
/** Re-export for convenience (avoids a second import site). */
export { signingKeyIdForValidKey };
//# sourceMappingURL=keyring.js.map