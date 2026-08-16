/**
 * Strict trust-root parsing and base/head state evaluation (ADR-009 key
 * model). Shared by Core, the GitHub Action (mirrored in
 * `scripts/pr-comment.mjs`) and the GitHub App (imports this module), so a
 * malformed PEM can never receive a fallback identity that is used in a
 * security decision.
 *
 * A trust root is `.drift/public/key.pem`. Its state is determined ONLY by
 * strict PEM parsing:
 *
 *   absent    — the file does not exist (or is empty/whitespace-only).
 *   valid     — parses as an Ed25519 PUBLIC key (asymmetricKeyType
 *               "ed25519", raw size within bounds, canonical SPKI-DER
 *               exportable). Identity = canonical SPKI-DER fingerprint.
 *   malformed — everything else, with a stable error code:
 *                 oversized            — PEM larger than the size bound.
 *                 not-public-key       — a private key PEM, a certificate,
 *                                        or text that never parses as a key.
 *                 parse-error          — PEM-shaped text that cannot be
 *                                        parsed at all.
 *                 unsupported-key-type — a valid public key of a different
 *                                        algorithm (RSA / EC / DSA / x25519
 *                                        / x448 / ...).
 *
 * A malformed trust root NEVER receives a fallback identity (the legacy
 * deterministic textual hash is diagnostics-only and must never produce
 * bootstrap / unchanged / valid / trusted / signing-allowed). Security
 * decisions consume the fingerprint of a *validated* key through
 * `signingKeyIdForValidKey` — never a parse-any-PEM path.
 */
import { createPublicKey, } from "node:crypto";
import { signingKeyIdForValidKey } from "./public.js";
/** Maximum size of a trust-root PEM (a bare Ed25519 SPKI PEM is ~120 bytes). */
export const TRUST_ROOT_MAX_BYTES = 16 * 1024;
const PRIVATE_KEY_MARKER = /PRIVATE KEY/;
const CERTIFICATE_MARKER = /BEGIN CERTIFICATE/;
/**
 * Strictly parse a trust-root PEM into a security decision:
 *
 *   absent     — empty/whitespace-only input.
 *   valid      — an Ed25519 PUBLIC key; fingerprint = canonical SPKI-DER
 *                SHA-256 (LF/CRLF/whitespace formatting never changes it).
 *   malformed  — anything else, with a stable error code. NEVER fabricates a
 *                fallback identity; never accepts a private key, a
 *                certificate, a different algorithm, or an oversized PEM.
 */
export function tryParseTrustRoot(publicKeyPem) {
    const text = String(publicKeyPem ?? "");
    if (text.trim().length === 0)
        return { state: "absent" };
    if (Buffer.byteLength(text, "utf8") > TRUST_ROOT_MAX_BYTES) {
        return {
            state: "malformed",
            errorCode: "oversized",
            message: `trust root exceeds ${TRUST_ROOT_MAX_BYTES} bytes`,
        };
    }
    // A trust root must be a PUBLIC key. Node's `createPublicKey` happily
    // derives a public key from a private-key PEM, so the markers must be
    // checked first — a private key or certificate is never a trust root.
    if (PRIVATE_KEY_MARKER.test(text)) {
        return {
            state: "malformed",
            errorCode: "not-public-key",
            message: "a private key cannot be a repository trust root",
        };
    }
    if (CERTIFICATE_MARKER.test(text)) {
        return {
            state: "malformed",
            errorCode: "not-public-key",
            message: "a certificate cannot be a repository trust root",
        };
    }
    if (!text.includes("PUBLIC KEY")) {
        return {
            state: "malformed",
            errorCode: "not-public-key",
            message: "PEM does not contain a public key",
        };
    }
    let key;
    try {
        key = createPublicKey(text.trim());
    }
    catch {
        return {
            state: "malformed",
            errorCode: "parse-error",
            message: "PEM cannot be parsed as a public key",
        };
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
        return {
            state: "malformed",
            errorCode: "unsupported-key-type",
            message: `key algorithm ${key.asymmetricKeyType ?? "unknown"} is not supported — Drift trust roots must be Ed25519 public keys`,
        };
    }
    // Bounded raw size: a valid Ed25519 SPKI-DER key is 44 bytes; anything far
    // larger is not a genuine Ed25519 key even if OpenSSL labels it so.
    const der = key.export({ type: "spki", format: "der" });
    if (der.byteLength > 128) {
        return {
            state: "malformed",
            errorCode: "oversized",
            message: `SPKI DER is ${der.byteLength} bytes — not a genuine Ed25519 key`,
        };
    }
    return {
        state: "valid",
        publicKey: key,
        fingerprint: signingKeyIdForValidKey(key),
    };
}
/** Backwards-compatible alias of the strict parser. */
export function parseTrustRoot(publicKeyPem) {
    return tryParseTrustRoot(publicKeyPem);
}
/** True when the trust-root text parses as a real Drift public key. */
export function isUsableTrustRoot(publicKeyPem) {
    return tryParseTrustRoot(publicKeyPem).state === "valid";
}
export function evaluateTrustRootChange(baseKey, headKey) {
    const base = tryParseTrustRoot(baseKey);
    const head = tryParseTrustRoot(headKey);
    if (base.state === "malformed")
        return "base-malformed";
    if (base.state === "absent") {
        if (head.state === "absent")
            return "none";
        if (head.state === "valid")
            return "bootstrap";
        return "malformed-bootstrap";
    }
    // base is valid
    if (head.state === "absent")
        return "removed";
    if (head.state === "malformed")
        return "malformed-replacement";
    return base.fingerprint === head.fingerprint ? "unchanged" : "replaced";
}
//# sourceMappingURL=trust-root.js.map