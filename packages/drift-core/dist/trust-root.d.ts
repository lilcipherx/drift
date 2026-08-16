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
import { type KeyObject } from "node:crypto";
/** Maximum size of a trust-root PEM (a bare Ed25519 SPKI PEM is ~120 bytes). */
export declare const TRUST_ROOT_MAX_BYTES: number;
/** Parsed trust-root state. `valid` carries the parsed key + canonical
 * SPKI-DER fingerprint; `malformed` carries a stable error code (for
 * diagnostics only — the malformed text hash is NEVER a key identity). */
export type ParsedTrustRoot = {
    state: "absent";
} | {
    state: "valid";
    publicKey: KeyObject;
    fingerprint: string;
} | {
    state: "malformed";
    errorCode: TrustRootMalformedCode;
    message: string;
};
/** Stable error codes for malformed key material (diagnostics only). */
export type TrustRootMalformedCode = "oversized" | "parse-error" | "not-public-key" | "unsupported-key-type";
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
export declare function tryParseTrustRoot(publicKeyPem: string | null | undefined): ParsedTrustRoot;
/** Backwards-compatible alias of the strict parser. */
export declare function parseTrustRoot(publicKeyPem: string | null | undefined): ParsedTrustRoot;
/** True when the trust-root text parses as a real Drift public key. */
export declare function isUsableTrustRoot(publicKeyPem: string | null | undefined): boolean;
/**
 * Full base/head trust-root relationship (the state table every consumer
 * must agree on):
 *
 *   base absent, head absent                  → none
 *   base absent, head valid                   → bootstrap            (neutral)
 *   base absent, head malformed               → malformed-bootstrap  (failure)
 *   base valid,  head valid, same fingerprint → unchanged
 *   base valid,  head valid, diff fingerprint → replaced             (failure)
 *   base valid,  head absent                  → removed              (failure)
 *   base valid,  head malformed               → malformed-replacement(failure)
 *   base malformed (any head)                 → base-malformed       (failure)
 *
 * A malformed base root means the audit cannot establish a valid trust root
 * and must never silently trust the head key — hence `base-malformed`
 * regardless of what the head contains.
 */
export type TrustRootChange = "none" | "unchanged" | "bootstrap" | "replaced" | "removed" | "malformed-bootstrap" | "malformed-replacement" | "base-malformed";
export declare function evaluateTrustRootChange(baseKey: string | null | undefined, headKey: string | null | undefined): TrustRootChange;
//# sourceMappingURL=trust-root.d.ts.map