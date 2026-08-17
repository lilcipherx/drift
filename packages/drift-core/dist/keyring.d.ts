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
import { signingKeyIdForValidKey } from "./public.js";
/** Committed keyring file name (relative to `.drift/public/`). */
export declare const KEYRING_PATH = "keyring.json";
/** A single trusted-key entry (append-only within the file). */
export interface KeyringEntry {
    /** Canonical SPKI-DER fingerprint (16 hex chars). */
    fingerprint: string;
    /** Ed25519 PUBLIC key PEM (never a private key). */
    pem: string;
    /**
     * active | revoked | removed — trust decisions read ONLY this:
     *   active   — may sign, authorize changes, and be verified.
     *   revoked  — immediate loss of trust (compromise / lost key); its
     *              signatures are never valid again (state-based trust, like a
     *              certificate revocation list: a compromised key can forge
     *              anything, so nothing it signed can be trusted).
     *   removed  — rotation cleanup after a grace period; same trust effect as
     *              revoked, but the reason/attribution is "rotation" and the
     *              entry stays for the audit history.
     */
    status: "active" | "revoked" | "removed";
    /** Fingerprint of the key that added this key ("" for bootstrap). */
    addedBy: string;
    addedAt: number;
    /** Fingerprint of the key that revoked/removed this key, if any. */
    transitionedBy: string | null;
    transitionedAt: number | null;
    /** reason: "rotation" | "compromise" | "lost" | "other" | null. */
    reason: string | null;
}
export type KeyringAction = "bootstrap" | "add" | "revoke" | "remove";
/** One signed transition of the trust set (append-only). */
export interface KeyringAuditEntry {
    /** 1-based, contiguous — the file is only valid when seq == index+1. */
    seq: number;
    action: KeyringAction;
    /** Fingerprint the action targets (bootstrap: the anchor key). */
    fingerprint: string;
    /** Fingerprint of the key that authorized this change. */
    by: string;
    at: number;
    reason: string | null;
    /** Canonical payload string that `signature` covers. */
    payload: string;
    /** Ed25519 signature (base64) by `by` over `payload`. */
    signature: string;
}
export interface KeyringFile {
    schemaVersion: 1;
    keys: KeyringEntry[];
    audit: KeyringAuditEntry[];
}
/** Validated trust set: the anchor plus every active keyring key. */
export interface TrustSet {
    /** The anchor PEM (from `.drift/public/key.pem`), or null. */
    anchorPem: string | null;
    /** All active keys — every fingerprint here may sign and be verified. */
    active: {
        fingerprint: string;
        pem: string;
    }[];
    /** The raw keyring file, when one exists and validates. */
    keyring: KeyringFile | null;
    /** Malformed state message (fail closed) when the keyring is unusable. */
    malformed: string | null;
    /** True when the keyring file exists (even if malformed). */
    keyringPresent: boolean;
}
/** Strict max size of the committed keyring file. */
export declare const KEYRING_MAX_BYTES: number;
/** Canonical payload a change signs (deterministic, versioned). */
export declare function keyringPayload(seq: number, action: KeyringAction, fingerprint: string, by: string, at: number, reason: string | null): string;
/** Strictly parse one public-key PEM into a validated fingerprint + PEM. */
export declare function parseKeyringKey(pem: string): {
    ok: true;
    fingerprint: string;
    pem: string;
} | {
    ok: false;
    error: string;
};
/** Fingerprint of a PEM that is guaranteed valid (caller checked first). */
export declare function keyringFingerprint(pem: string): string;
/**
 * Validate a keyring file against the anchor PEM. Returns the parsed file on
 * success or a fail-closed error message.
 */
export declare function validateKeyring(raw: string | null | undefined, anchorPem: string | null): {
    ok: true;
    keyring: KeyringFile;
} | {
    ok: false;
    error: string;
};
/**
 * Create a brand-new keyring bootstrapped on the anchor key. The anchor must
 * be present and the caller must hold the anchor's private key (the bootstrap
 * entry is self-signed). Fails closed otherwise.
 */
export declare function createKeyring(anchorPem: string, privateKeyPem: string, at?: number): {
    ok: true;
    keyring: KeyringFile;
} | {
    ok: false;
    error: string;
};
export type KeyringChangeAction = "add" | "revoke" | "remove";
export type KeyringChangeResult = {
    ok: true;
    keyring: KeyringFile;
    entry: KeyringAuditEntry;
} | {
    ok: false;
    error: string;
};
/**
 * Apply a signed change to an existing keyring. The private key must belong
 * to an ACTIVE keyring key (the authorizer). `revoke` allows self-revocation
 * (lost key); `remove` requires a different authorizer (rotation cleanup).
 */
export declare function applyKeyringChange(keyring: KeyringFile, privateKeyPem: string, action: KeyringChangeAction, target: {
    pem?: string;
    fingerprint?: string;
}, reason: string | null, at?: number): KeyringChangeResult;
/** Absolute path of the keyring file for a drift dir. */
export declare function keyringPath(driftDir: string): string;
/**
 * Load and validate the full trust set for a repository. Never throws on a
 * hostile keyring — a malformed keyring yields `malformed` (fail closed).
 * Backward compatibility: no keyring file → trust set is exactly the anchor.
 */
export declare function loadTrustSet(driftDir: string): TrustSet;
/** Write a keyring file atomically (temp + rename, 0644, committed file). */
export declare function writeKeyringFile(driftDir: string, keyring: KeyringFile): void;
/** Look up a key entry (active or revoked) by fingerprint. */
export declare function findKeyringEntry(keyring: KeyringFile, fingerprint: string): KeyringEntry | undefined;
/** Re-export for convenience (avoids a second import site). */
export { signingKeyIdForValidKey };
//# sourceMappingURL=keyring.d.ts.map